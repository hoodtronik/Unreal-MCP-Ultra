import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

// CLAUDE-NOTE (2026-10-21): Character POSING tools (Control Rig in Sequencer). Like pcg.ts they run through the
// existing /api/run-python bridge - no C++ - so they work on the shipped DLL without a rebuild. The Python lives
// in Tools/python/ue_posing.py (a real file so it can be probed by hand) and is prepended to every call.
//
// Two live-measured rules (UE 5.6.1) shape every tool here:
//  * Sequencer applies a Control Rig pose on the editor TICK. A bone read in the same run_python call as the
//    write returns the old pose. The plugin runs one queued request per tick, so every writer here does its
//    write in one request and its readback in a SECOND request, and sets ok from that readback.
//  * The UE5 mannequin mesh faces +Y at actor yaw 0. Facing is therefore MEASURED (shoulders + toes) and
//    corrected, never trusted from the actor yaw. The old previz lib had this 180 deg wrong in two places
//    that cancelled out in its own round-trip check.

const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools and dist/tools both sit two levels under Tools/.
const PY_DIR = resolve(HERE, "../../python");

const libCache = new Map<string, string>();
function pyLib(file: string): string {
  let src = libCache.get(file);
  if (src === undefined) {
    src = readFileSync(resolve(PY_DIR, file), "utf-8");
    libCache.set(file, src);
  }
  return src;
}

const DEFAULT_MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
const DEFAULT_RIG = "/Game/Characters/Mannequins/Rigs/CR_Mannequin_Body";
const SENTINEL = "__POSE__";

/** Build a script: posing lib + params (base64 JSON as P) + one call whose dict result is emitted. */
export function posingScript(call: string, params: Record<string, unknown>, libFile: string | string[] = "ue_posing.py"): string {
  const b64 = Buffer.from(JSON.stringify(params), "utf-8").toString("base64");
  // CLAUDE-NOTE (2026-10-21, live): UE's ExecPythonCommand (ExecuteFile mode) treats a command containing ".py"
  // followed by whitespace as "<file> <args>" and tries to load it ("Could not load Python file '.../import
  // unreal<newline># ue_posing.py'"). The lib's comments mention its own file name, so the lib travels
  // base64-encoded and is exec()'d - the command text then contains nothing that heuristic can match.
  const files = Array.isArray(libFile) ? libFile : [libFile];
  const lib = Buffer.from(files.map(pyLib).join("\n\n"), "utf-8").toString("base64");
  return `import unreal, json as _json, base64 as _b64
exec(_b64.b64decode("${lib}").decode("utf-8"), globals())
P = _json.loads(_b64.b64decode("${b64}").decode("utf-8"))
try:
    _res = ${call}
except Exception as _e:
    _res = {"ok": False, "error": "%s: %s" % (type(_e).__name__, _e)}
print("${SENTINEL}" + _json.dumps(_res))
`;
}

export type PoseResult = { ok: boolean; error?: string; [k: string]: any };

export function parsePoseOutput(out: string): PoseResult {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(SENTINEL));
  if (!line) return { ok: false, error: `No result emitted. Raw output: ${out.slice(0, 2000) || "(empty)"}` };
  try {
    return JSON.parse(line.slice(SENTINEL.length)) as PoseResult;
  } catch {
    return { ok: false, error: `Unparseable result: ${line.slice(0, 500)}` };
  }
}

export async function runPose(call: string, params: Record<string, unknown>, libFile: string | string[] = "ue_posing.py"): Promise<PoseResult> {
  const data = await uePost("/api/run-python", { code: posingScript(call, params, libFile) });
  if (data.error) return { ok: false, error: data.error };
  const out = typeof data.output === "string" ? data.output : "";
  // A script that never ran (syntax error, file heuristic) reports success=false with the reason in result.
  if (data.success === false && !out.includes(SENTINEL)) return { ok: false, error: `run_python failed: ${data.result ?? "(no reason)"}` };
  return parsePoseOutput(out);
}

/** Smallest signed difference between two angles, degrees. */
export function angleDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** Visual facing from a read_pose result: shoulders, else toes. */
export function facingOf(r: PoseResult): number | null {
  const f = r.facing ?? {};
  if (typeof f.shoulders === "number") return f.shoulders;
  if (typeof f.toes === "number") return f.toes;
  return null;
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Compare a requested control write with its readback. Returns a list of mismatch strings (empty = applied). */
export function controlMismatches(req: ControlWrite, got: any, tol = { cm: 0.05, deg: 0.1 }): string[] {
  const bad: string[] = [];
  if (!got) return ["no readback"];
  if (req.location && got.location && dist(req.location, got.location) > tol.cm)
    bad.push(`location ${JSON.stringify(got.location)} != ${JSON.stringify(req.location)}`);
  if (req.rotation && got.rotation) {
    const d = req.rotation.map((v, i) => Math.abs(angleDiff(v, got.rotation[i])));
    if (Math.max(...d) > tol.deg) bad.push(`rotation ${JSON.stringify(got.rotation)} != ${JSON.stringify(req.rotation)}`);
  }
  if (req.value !== undefined && got.value !== undefined) {
    const ok = typeof req.value === "boolean" ? Boolean(got.value) === req.value : Math.abs(Number(got.value) - Number(req.value)) < 1e-3;
    if (!ok) bad.push(`value ${got.value} != ${req.value}`);
  }
  return bad;
}

type ControlWrite = {
  control: string;
  location?: number[];
  rotation?: number[];
  scale?: number[];
  value?: number | boolean;
  world?: boolean;
};

const vec3 = z.array(z.number()).length(3);
const seqArg = z.string().describe("LevelSequence package path, e.g. '/Game/Previz/SEQ_0010'. Opened in Sequencer automatically (Control Rig reads/writes need it open).");
const bindingArg = z.string().describe("Display name of the character binding in the sequence (as given to pose_setup_character).");

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function fmtContacts(r: PoseResult): string[] {
  const lines = [`Skin vs floor z=${r.floor_z}: mesh lowest ${r.mesh_min_z} cm${r.penetration > 0 ? ` (penetration ${r.penetration} cm)` : ""}, ${r.vertices} verts.`];
  for (const [k, v] of Object.entries(r.regions ?? {}) as [string, any][])
    lines.push(`  ${k}: ${v.state} (${v.height >= 0 ? "+" : ""}${v.height} cm at ${JSON.stringify(v.lowest)})`);
  return lines;
}

function fmtPose(r: PoseResult): string[] {
  const lines: string[] = [];
  if (r.facing) lines.push(`Facing (measured): shoulders ${r.facing.shoulders ?? "-"}°, toes ${r.facing.toes ?? "-"}°`);
  if (r.lowest_foot_z !== undefined && r.lowest_foot_z !== null) lines.push(`Lowest foot z: ${r.lowest_foot_z} cm`);
  if (r.bones) for (const [b, p] of Object.entries(r.bones)) lines.push(`  ${b}: ${p ? JSON.stringify(p) : "(not found)"}`);
  return lines;
}

export function registerPosingTools(server: McpServer): void {
  server.tool(
    "pose_setup_character",
    "Put a posable character into a LevelSequence: creates the sequence if missing, adds the skeletal mesh as a " +
      "SPAWNABLE with a Control Rig track, optionally holds one frame of an animation clip as the starting pose, " +
      "and aims it by the direction it VISUALLY faces (measured from shoulders/toes on the next tick and corrected, " +
      "because the UE5 mannequin mesh faces +Y at actor yaw 0). Defaults: Manny + CR_Mannequin_Body. Idempotent per " +
      "binding name. Next: pose_set_controls / pose_reach, then pose_read or viewport_capture.",
    {
      sequence: seqArg,
      binding: z.string().describe("Name for the character binding, e.g. 'Hero'."),
      mesh: z.string().optional().describe(`SkeletalMesh path. Default ${DEFAULT_MESH}.`),
      rig: z.string().optional().describe(`Control Rig Blueprint path. Default ${DEFAULT_RIG}.`),
      location: vec3.optional().describe("World location [x,y,z] cm. Default [0,0,0]."),
      facing: z.number().optional().describe("World yaw (deg) the character should visually FACE: 0=+X, 90=+Y, -90=-Y, 180=-X."),
      clip: z.string().optional().describe("AnimSequence to take the starting pose from (same skeleton as the mesh)."),
      clipFrame: z.number().int().optional().describe("Frame of the clip to hold (clip frame rate). Default 0."),
      frame: z.number().int().optional().describe("Sequence frame to key the pose at. Default 0."),
      fps: z.number().int().optional().describe("Display rate when creating the sequence. Default 24."),
      end: z.number().int().optional().describe("Playback end frame when creating the sequence. Default 48."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const p = {
        seq_path: a.sequence, name: a.binding, mesh: a.mesh ?? DEFAULT_MESH, rig_bp: a.rig ?? DEFAULT_RIG, rig_explicit: a.rig !== undefined,
        location: a.location ?? [0, 0, 0], facing: a.facing ?? null, fps: a.fps ?? 24, end: a.end ?? 48,
        clip: a.clip ?? null, clip_frame: a.clipFrame ?? 0, frame: a.frame ?? 0,
      };
      const s = await runPose("setup_character(**P)", p);
      if (!s.ok) return text(`Error: ${s.error}`, true);
      const lines = [
        `${s.created ? "Added" : "Reused"} '${a.binding}' in ${s.sequence} with ${s.rig} (${s.controls} controls).`,
      ];
      if (s.clip_baked) lines.push(`Held ${s.clip_baked.clip} frame ${s.clip_baked.clip_frame} at frame ${s.clip_baked.at_frame} (${s.clip_baked.keys} keys).`);
      // Readback on a later tick; correct facing once from the measurement if asked.
      let r = await runPose("read_pose(P['seq'], P['b'], P['f'])", { seq: a.sequence, b: a.binding, f: a.frame ?? 0 });
      if (!r.ok) return text([...lines, `Readback failed: ${r.error}`].join("\n"), true);
      if (a.facing !== undefined) {
        const got = facingOf(r);
        if (got !== null && Math.abs(angleDiff(a.facing, got)) > 2) {
          const yaw = r.actor.yaw + angleDiff(a.facing, got);
          const c = await runPose("set_actor_yaw(load_sequence(P['seq']), find_binding(load_sequence(P['seq']), P['b']), P['yaw'])",
            { seq: a.sequence, b: a.binding, yaw });
          if (!c.ok) return text([...lines, `Facing correction failed: ${c.error}`].join("\n"), true);
          r = await runPose("read_pose(P['seq'], P['b'], P['f'])", { seq: a.sequence, b: a.binding, f: a.frame ?? 0 });
          lines.push(`Facing corrected by ${angleDiff(a.facing, got).toFixed(1)}° (clip hip twist) -> actor yaw ${yaw.toFixed(1)}.`);
        }
        const fin = facingOf(r);
        const off = fin === null ? null : angleDiff(a.facing, fin);
        lines.push(`Facing: wanted ${a.facing}°, measured ${fin}° (${off === null ? "unmeasured" : `off ${off.toFixed(1)}°`}).`);
        if (off === null || Math.abs(off) > 5) return text([...lines, ...fmtPose(r)].join("\n"), true);
      }
      lines.push(...fmtPose(r));
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "pose_list_controls",
    "List a character's Control Rig controls with their types (EULER_TRANSFORM, FLOAT, BOOL, ...). Use the type to " +
      "decide what to send to pose_set_controls: transforms take location/rotation, FLOAT/BOOL/INTEGER take value. " +
      "CR_Mannequin_Body has 148 controls; filter with 'contains' (e.g. 'arm_l', 'switch', 'ik').",
    {
      sequence: seqArg,
      binding: bindingArg,
      contains: z.string().optional().describe("Case-insensitive substring filter on control names."),
      type: z.string().optional().describe("Only controls of this type, e.g. 'EULER_TRANSFORM' or 'BOOL'."),
      limit: z.number().int().optional().describe("Max rows (default 200)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await runPose("list_controls(P['seq'], P['b'], P['c'], P['t'], P['n'])",
        { seq: a.sequence, b: a.binding, c: a.contains ?? null, t: a.type ?? null, n: a.limit ?? 200 });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`${r.count} control(s)${r.truncated ? " (truncated)" : ""}:`];
      for (const [n, t] of r.controls) lines.push(`  ${n}  ${t}`);
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "pose_set_controls",
    "Pose a character: key several Control Rig controls at one frame, then READ THEM BACK on the next editor tick " +
      "and report per-control whether the value stuck (the wrong typed setter is a silent no-op in UE, so this is " +
      "checked, not assumed). Transform controls take location [x,y,z] cm and/or rotation [pitch,yaw,roll] deg in " +
      "control-local space, or world space with world=true; FLOAT/BOOL/INTEGER controls take value. Also returns " +
      "posed bone positions + measured facing so you can judge the pose numerically before looking at it.",
    {
      sequence: seqArg,
      binding: bindingArg,
      frame: z.number().int().optional().describe("Sequence frame to key at (display rate). Default 0."),
      controls: z.array(z.object({
        control: z.string(),
        location: vec3.optional(),
        rotation: vec3.optional().describe("[pitch, yaw, roll] degrees"),
        scale: vec3.optional(),
        value: z.union([z.number(), z.boolean()]).optional(),
        world: z.boolean().optional().describe("Interpret location/rotation in WORLD space."),
      }).strict()).min(1),
      bones: z.array(z.string()).optional().describe("Bones/roles to report after the write (default pelvis, head, hands, feet)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const frame = a.frame ?? 0;
      const w = await runPose("set_controls(P['seq'], P['b'], P['f'], P['c'])", { seq: a.sequence, b: a.binding, f: frame, c: a.controls });
      if (!w.ok) return text(`Error: ${w.error}`, true);
      const anyWorld = a.controls.some((c) => c.world);
      const r = await runPose("read_pose(P['seq'], P['b'], P['f'], P['bones'], P['ctl'], P['w'])", {
        seq: a.sequence, b: a.binding, f: frame, bones: a.bones ?? null, ctl: a.controls.map((c) => c.control), w: anyWorld,
      });
      if (!r.ok) return text(`Wrote ${w.written.length} control(s) but readback failed: ${r.error}`, true);
      const lines: string[] = [];
      let failures = 0;
      for (const c of a.controls) {
        const bad = controlMismatches(c as ControlWrite, r.controls?.[c.control]);
        if (bad.length) failures++;
        lines.push(`${bad.length ? "NOT APPLIED" : "ok"}  ${c.control}${bad.length ? "  " + bad.join("; ") : ""}`);
      }
      lines.unshift(`Frame ${frame}: ${a.controls.length - failures}/${a.controls.length} control(s) verified by readback.`);
      lines.push(...fmtPose(r));
      return text(lines.join("\n"), failures > 0);
    },
  );

  server.tool(
    "pose_read",
    "Read a posed character back: WORLD positions of bones (names or roles: pelvis, head, hand_l, hand_r, foot_l, " +
      "foot_r, ball_l/r, upperarm_l/r - resolved on prefixed skeletons like mixamorig/girl02_*), measured facing " +
      "(shoulder line and toe direction, convention-free), lowest foot height (ground contact), actor transform, " +
      "and optional control values. Read-only. Call it on a LATER call than any pose write - the pose applies on the tick.",
    {
      sequence: seqArg,
      binding: bindingArg,
      frame: z.number().int().optional().describe("Scrub here first (then the result is marked stale - call again)."),
      bones: z.array(z.string()).optional(),
      controls: z.array(z.string()).optional().describe("Control values to include."),
      worldControls: z.boolean().optional().describe("Report control values in world space."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await runPose("read_pose(P['seq'], P['b'], P['f'], P['bones'], P['ctl'], P['w'])", {
        seq: a.sequence, b: a.binding, f: a.frame ?? null, bones: a.bones ?? null, ctl: a.controls ?? null, w: a.worldControls ?? false,
      });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`'${a.binding}' at frame ${r.frame}${r.stale ? " (STALE: scrubbed in this call - read again)" : ""}; actor ${JSON.stringify(r.actor)}`];
      lines.push(...fmtPose(r));
      if (r.controls) for (const [n, v] of Object.entries(r.controls)) lines.push(`  ${n}: ${JSON.stringify(v)}`);
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "pose_reach",
    "Make a hand or foot reach a world point with IK: switches the limb's FK/IK switch to IK, keys its IK control " +
      "at the target, then reads the bone back on the next tick and reports the miss distance. Target is [x,y,z] " +
      "or {actor:'Label'} / {actor, bone} / {actor, offset}. ok only if the bone lands within tolerance - an " +
      "out-of-reach target reports the gap instead of pretending. Supports CR_Mannequin_Body-style rigs.",
    {
      sequence: seqArg,
      binding: bindingArg,
      effector: z.enum(["hand_l", "hand_r", "foot_l", "foot_r"]),
      target: z.union([vec3, z.object({ actor: z.string(), bone: z.string().optional(), offset: vec3.optional() }).strict()]),
      rotation: vec3.optional().describe("Optional WORLD rotation [pitch,yaw,roll] for the IK control."),
      frame: z.number().int().optional(),
      toleranceCm: z.number().optional().describe("Max bone-to-target distance to count as reached. Default 1 cm."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const frame = a.frame ?? 0;
      const w = await runPose("reach(P['seq'], P['b'], P['e'], target_point(P['t']), P['f'], P['r'])",
        { seq: a.sequence, b: a.binding, e: a.effector, t: a.target, f: frame, r: a.rotation ?? null });
      if (!w.ok) return text(`Error: ${w.error}`, true);
      const bonesWanted = [a.effector, ...(w.limb_root ? [w.limb_root] : [])];
      const r = await runPose("read_pose(P['seq'], P['b'], P['f'], P['bones'])", { seq: a.sequence, b: a.binding, f: frame, bones: bonesWanted });
      if (!r.ok) return text(`Keyed ${w.control} but readback failed: ${r.error}`, true);
      const bone = r.bones?.[a.effector];
      const miss = bone ? dist(bone, w.target) : Infinity;
      const tol = a.toleranceCm ?? 1;
      const ok = miss <= tol;
      const lines = [
        `${ok ? "Reached" : "NOT reached"}: ${a.effector} at ${JSON.stringify(bone)}, target ${JSON.stringify(w.target.map((v: number) => +v.toFixed(3)))}, miss ${miss.toFixed(3)} cm (tolerance ${tol}).`,
        `Keyed ${w.control} (world)${w.switch ? ` + ${w.switch}=IK` : " (rig has no FK/IK switch)"} at frame ${frame}.`,
      ];
      const root = w.limb_root ? r.bones?.[w.limb_root] : null;
      if (root && w.limb_length) {
        const need = dist(root, w.target);
        lines.push(`Reach budget: ${w.limb_root} -> target ${need.toFixed(1)} cm vs limb length ${w.limb_length} cm` +
          (need > w.limb_length
            ? ` - OUT OF REACH by ${(need - w.limb_length).toFixed(1)} cm: move the body (body_ctrl) closer or the target in.`
            : "."));
      }
      return text([...lines, ...fmtPose(r)].join("\n"), !ok);
    },
  );

  server.tool(
    "anim_preview",
    "Show one moment of an animation clip on a level SkeletalMeshActor (spawned from 'mesh' if the label is new) " +
      "and READ the posed bones back on the next tick - for judging a clip or a retarget by eye and by numbers " +
      "without Sequencer. Facing is the direction the character visually faces (mesh +Y offset handled).",
    {
      actor: z.string().describe("Actor label (created if missing)."),
      anim: z.string().describe("AnimSequence path; its skeleton must match the actor's mesh."),
      time: z.number().optional().describe("Seconds into the clip. Default 0."),
      mesh: z.string().optional().describe("SkeletalMesh to spawn/assign."),
      location: vec3.optional(),
      facing: z.number().optional().describe("World yaw the character should visually face."),
      bones: z.array(z.string()).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const w = await runPose("preview_anim(P['l'], P['anim'], P['t'], P['mesh'], P['loc'], P['face'])",
        { l: a.actor, anim: a.anim, t: a.time ?? 0, mesh: a.mesh ?? null, loc: a.location ?? null, face: a.facing ?? null });
      if (!w.ok) return text(`Error: ${w.error}`, true);
      const r = await runPose("read_actor_pose(P['l'], P['bones'])", { l: a.actor, bones: a.bones ?? null });
      if (!r.ok) return text(`Applied but readback failed: ${r.error}`, true);
      const applied = r.anim && r.anim.split(".")[0] === a.anim && (r.position === null || Math.abs(r.position - (a.time ?? 0)) < 1e-3);
      return text([
        `${applied ? "Showing" : "NOT APPLIED:"} ${a.anim} at ${a.time ?? 0}s / ${w.length}s on '${a.actor}'${w.created ? " (spawned)" : ""}.`,
        ...fmtPose(r),
      ].join("\n"), !applied);
    },
  );


  server.tool(
    "pose_look_at",
    "Aim a character's head (gaze) at a point, a level actor, or another character's bone in the same sequence " +
      "(e.g. {binding:'Manny', bone:'head'} for an eye-line, {binding:'Manny', bone:'hand_r'} to watch a hand-off). " +
      "Rotates the head control in world space by the measured gaze error, re-reads the gaze on the next tick and " +
      "iterates until within tolerance. Gaze = head bone +Y axis (UE5 mannequin / MetaHuman convention). Warns " +
      "when the target is so far off the body's facing that the torso should turn too.",
    {
      sequence: seqArg,
      binding: bindingArg,
      target: z.union([vec3, z.object({
        binding: z.string().optional(), actor: z.string().optional(), bone: z.string().optional(), offset: vec3.optional(),
      }).strict()]),
      frame: z.number().int().optional(),
      control: z.string().optional().describe("Control to rotate (default head_ctrl)."),
      toleranceDeg: z.number().optional().describe("Gaze error accepted (default 2 deg)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const frame = a.frame ?? 0;
      const t = await runPose("{'ok': True, 'p': seq_target(P['seq'], P['t'])}", { seq: a.sequence, t: a.target });
      if (!t.ok) return text(`Error: ${t.error}`, true);
      const tol = a.toleranceDeg ?? 2;
      await runPose("scrub(P['seq'], P['f'])", { seq: a.sequence, f: frame });   // measure at the keyed frame (see pose_palm)
      const lines: string[] = [];
      let g: PoseResult = { ok: false };
      let warning = "";
      for (let i = 0; i < 4; i++) {
        g = await runPose("gaze(P['seq'], P['b'], P['t'])", { seq: a.sequence, b: a.binding, t: t.p });
        if (!g.ok) return text(`Error: ${g.error}`, true);
        if (i === 0) lines.push(`Gaze error before: ${g.error_deg} deg.`);
        if (g.error_deg <= tol) break;
        const s = await runPose("look_at_step(P['seq'], P['b'], P['t'], P['f'], P['c'])",
          { seq: a.sequence, b: a.binding, t: t.p, f: frame, c: a.control ?? "head_ctrl" });
        if (!s.ok) return text([...lines, `Error: ${s.error}`].join("\n"), true);
        if (s.warning) warning = s.warning;
      }
      const ok = g.error_deg <= tol;
      lines.push(`${ok ? "Looking at" : "NOT looking at"} ${JSON.stringify(t.p.map((v: number) => +v.toFixed(2)))}: gaze error ${g.error_deg} deg ` +
        `(gaze yaw ${g.gaze_yaw}, pitch ${g.gaze_pitch}; head turned ${g.head_turn_vs_body} deg from the body).`);
      if (warning) lines.push(`Warning: ${warning}`);
      return text(lines.join("\n"), !ok);
    },
  );


  server.tool(
    "pose_ground_check",
    "Ground contact from the POSED SKIN (not bone centres): copies the character's current posed mesh (GeometryScript) " +
      "and reports, per body part (foot_l/r, knee_l/r, hand_l/r, seat), the lowest skin point relative to the floor - " +
      "PENETRATING, contact (within tolerance) or above - plus the whole mesh's lowest point. A kneeling knee joint at " +
      "z=-1 cm looked fine as a bone but was 6 cm of skin under the floor. Read-only; call on a later call than a pose write.",
    {
      sequence: seqArg,
      binding: bindingArg,
      floorZ: z.number().optional().describe("Floor height in cm (default 0)."),
      toleranceCm: z.number().optional().describe("Within this of the floor = contact (default 1)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await runPose("mesh_contacts(P['seq'], P['b'], P['floor'], P['tol'])",
        { seq: a.sequence, b: a.binding, floor: a.floorZ ?? 0, tol: a.toleranceCm ?? 1 });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      return text(fmtContacts(r).join("\n"));
    },
  );

  server.tool(
    "pose_ground_fix",
    "Move a body control (default body_ctrl, world Z) until one body part's lowest SKIN point sits at the floor: e.g. " +
      "region 'knee_r' for a kneel, 'seat' for sitting on the ground, 'foot_l' to plant a foot. Iterates write -> " +
      "next-tick skin readback (up to 6 steps) and reports every region afterwards, so you see whether fixing one " +
      "contact pushed another part through the floor. Limbs on IK stay where their IK controls are.",
    {
      sequence: seqArg,
      binding: bindingArg,
      region: z.enum(["foot_l", "foot_r", "knee_l", "knee_r", "hand_l", "hand_r", "seat"]),
      targetHeight: z.number().optional().describe("Wanted height of that part's lowest skin point above the floor (default 0)."),
      control: z.string().optional().describe("Control to move vertically (default body_ctrl)."),
      floorZ: z.number().optional(),
      frame: z.number().int().optional(),
      toleranceCm: z.number().optional().describe("Accepted error (default 0.5 cm)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const floor = a.floorZ ?? 0, want = a.targetHeight ?? 0, tol = a.toleranceCm ?? 0.5;
      const lines: string[] = [];
      let r: PoseResult = { ok: false };
      let moved = 0;
      for (let i = 0; i < 7; i++) {
        r = await runPose("mesh_contacts(P['seq'], P['b'], P['floor'])", { seq: a.sequence, b: a.binding, floor });
        if (!r.ok) return text(`Error: ${r.error}`, true);
        const reg = r.regions?.[a.region];
        if (!reg) return text(`Region '${a.region}' has no skin within 25 cm of the floor - move it near the floor first (e.g. pose_set_controls).`, true);
        if (i === 0) lines.push(`${a.region} lowest skin at ${reg.height} cm before.`);
        const dz = want - reg.height;
        if (Math.abs(dz) <= tol || i === 6) break;
        const n = await runPose("nudge_control_z(P['seq'], P['b'], P['c'], P['dz'], P['f'])",
          { seq: a.sequence, b: a.binding, c: a.control ?? "body_ctrl", dz, f: a.frame ?? 0 });
        if (!n.ok) return text([...lines, `Error: ${n.error}`].join("\n"), true);
        moved += dz;
      }
      const fin = r.regions[a.region].height;
      const ok = Math.abs(fin - want) <= tol;
      lines.push(`${ok ? "Fixed" : "NOT fixed"}: ${a.region} at ${fin} cm (wanted ${want}); moved ${a.control ?? "body_ctrl"} ${moved >= 0 ? "+" : ""}${moved.toFixed(2)} cm in Z.`);
      lines.push(...fmtContacts(r));
      return text(lines.join("\n"), !ok);
    },
  );


  server.tool(
    "pose_set_interpolation",
    "Set how a character's Control Rig keys interpolate: 'smooth' (cubic auto - pose-to-pose motion), 'linear', or " +
      "'constant' (stepped, held poses for animatics). Clip bakes from pose_setup_character are constant, so a pose " +
      "keyed later SNAPS at its frame until the moving controls are made smooth. Optionally only some controls.",
    {
      sequence: seqArg,
      binding: bindingArg,
      mode: z.enum(["smooth", "linear", "constant"]),
      controls: z.array(z.string()).optional().describe("Only these controls (default all)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await runPose("set_interpolation(P['seq'], P['b'], P['m'], P['c'])", { seq: a.sequence, b: a.binding, m: a.mode, c: a.controls ?? null });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const k = await runPose("key_frames(P['seq'], P['b'], P['c'])", { seq: a.sequence, b: a.binding, c: a.controls ?? null });
      return text(`Set ${r.keys} key(s) to ${r.mode}. Keyed frames: ${k.ok ? k.frames.join(", ") : "?"}.`, r.keys === 0);
    },
  );

  server.tool(
    "pose_motion_report",
    "Play a character's animation frame by frame (scrub, then read on the next tick) and measure bone motion: path " +
      "length, largest single-frame step and POPS (a frame whose step is far above its neighbours - a snapped key, " +
      "an FK/IK switch flip). Use after keying pose-to-pose animation and before rendering.",
    {
      sequence: seqArg,
      binding: bindingArg,
      start: z.number().int(),
      end: z.number().int().describe("Last frame (inclusive)."),
      step: z.number().int().optional().describe("Frame step (default 1)."),
      bones: z.array(z.string()).optional().describe("Default hand_l, hand_r, head, pelvis, foot_l, foot_r."),
      popCm: z.number().optional().describe("A step counts as a pop when > this many cm AND > 2x both neighbouring steps (default 4)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const bones = a.bones ?? ["hand_l", "hand_r", "head", "pelvis", "foot_l", "foot_r"];
      const stepF = a.step ?? 1;
      const track: Record<string, number[][]> = Object.fromEntries(bones.map((b) => [b, []]));
      const frames: number[] = [];
      for (let f = a.start; f <= a.end; f += stepF) {
        const s = await runPose("scrub(P['seq'], P['f'])", { seq: a.sequence, f });
        if (!s.ok) return text(`Error: ${s.error}`, true);
        // CLAUDE-NOTE (2026-10-21, live): one read after a scrub is occasionally a tick early (a smooth wave showed a
        // 10.8 cm "pop" at f19 that two re-reads did not reproduce). Read until two consecutive reads agree.
        let r = await runPose("bones_now(P['seq'], P['b'], P['bones'])", { seq: a.sequence, b: a.binding, bones });
        for (let k = 0; k < 4 && r.ok; k++) {
          const r2 = await runPose("bones_now(P['seq'], P['b'], P['bones'])", { seq: a.sequence, b: a.binding, bones });
          if (!r2.ok || JSON.stringify(r2.bones) === JSON.stringify(r.bones)) break;
          r = r2;
        }
        if (!r.ok) return text(`Error: ${r.error}`, true);
        frames.push(f);
        for (const b of bones) track[b].push(r.bones[b] ?? [NaN, NaN, NaN]);
      }
      const lines = [`${frames.length} frame(s) ${a.start}..${a.end} step ${stepF}:`];
      let pops = 0;
      for (const b of bones) {
        const pts = track[b];
        const steps = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]));
        if (!steps.length || steps.some(Number.isNaN)) { lines.push(`  ${b}: not found`); continue; }
        const sorted = [...steps].sort((x, y) => x - y);
        const median = sorted[Math.floor(sorted.length / 2)];
        const maxI = steps.indexOf(Math.max(...steps));
        // CLAUDE-NOTE (2026-10-21, live): "> 3x median" flagged a fast but smooth arm raise (elbow 9 cm/frame while the
        // hand also moved 8.6). A pop is a SPIKE: a step much larger than both neighbouring steps.
        const popAt = steps.map((d, i) => ({ d, f: frames[i + 1], n: Math.max(steps[i - 1] ?? 0, steps[i + 1] ?? 0) }))
          .filter((x) => x.d > (a.popCm ?? 4) && x.d > 2 * Math.max(x.n, 0.3));
        pops += popAt.length;
        lines.push(`  ${b}: path ${steps.reduce((x, y) => x + y, 0).toFixed(1)} cm, max step ${steps[maxI].toFixed(2)} cm at f${frames[maxI + 1]}, median ${median.toFixed(2)}` +
          (popAt.length ? ` - POPS at ${popAt.map((x) => `f${x.f} (${x.d.toFixed(1)} cm)`).join(", ")}` : ""));
      }
      lines.push(pops ? `${pops} pop(s) found.` : "No pops.");
      return text(lines.join("\n"), pops > 0);
    },
  );


  server.tool(
    "pose_hand",
    "Shape a hand: 'open' (flat), 'relaxed', 'fist' or 'point' (index out), keyed on the finger controls at a frame, " +
      "then MEASURED: per-finger chord ratio knuckle->tip joint (1.0 straight, lower = curled). Clip bakes often leave " +
      "half-closed hands that read as fists on camera - open the hand for waves, presentations and reaches.",
    {
      sequence: seqArg,
      binding: bindingArg,
      side: z.enum(["l", "r"]),
      shape: z.enum(["open", "relaxed", "fist", "point"]),
      frame: z.number().int().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const before = await runPose("hand_curl(P['seq'], P['b'], P['s'])", { seq: a.sequence, b: a.binding, s: a.side });
      const w = await runPose("hand_shape(P['seq'], P['b'], P['s'], P['shape'], P['f'])", { seq: a.sequence, b: a.binding, s: a.side, shape: a.shape, f: a.frame ?? 0 });
      if (!w.ok) return text(`Error: ${w.error}`, true);
      const r = await runPose("hand_curl(P['seq'], P['b'], P['s'])", { seq: a.sequence, b: a.binding, s: a.side });
      if (!r.ok) return text(`Keyed ${w.controls} finger controls but readback failed: ${r.error}`, true);
      const ratios = Object.values(r.chord_ratio as Record<string, number>);
      const mean = ratios.reduce((x, y) => x + y, 0) / Math.max(1, ratios.length);
      const ok = a.shape === "open" ? mean > 0.95 : a.shape === "fist" ? mean < 0.85 : true;
      return text([
        `${ok ? "Shaped" : "SHAPE NOT REACHED:"} ${a.side} hand '${a.shape}' (${w.controls} controls at frame ${a.frame ?? 0}).`,
        `Chord ratio (1 = straight): before ${JSON.stringify(before.chord_ratio ?? {})}, after ${JSON.stringify(r.chord_ratio)}.`,
      ].join("\n"), !ok);
    },
  );


  server.tool(
    "pose_palm",
    "Turn a hand so its PALM faces a point, a level actor, another character's bone or a camera binding (e.g. a wave " +
      "to camera: {binding:'Cam'}; a stop gesture at a person). Rotates the hand's IK control about the wrist by the " +
      "measured palm-normal error and iterates on the next-tick readback. The arm must be on IK (pose_reach first). " +
      "Palm normal is measured from the finger and knuckle bones, mirrored per side.",
    {
      sequence: seqArg,
      binding: bindingArg,
      side: z.enum(["l", "r"]),
      target: z.union([vec3, z.object({ binding: z.string().optional(), actor: z.string().optional(), bone: z.string().optional(), offset: vec3.optional() }).strict()]),
      frame: z.number().int().optional(),
      toleranceDeg: z.number().optional().describe("Default 3 deg."),
      fingers: vec3.optional().describe("World direction the fingers should point (kept perpendicular to the palm). Default [0,0,1] = up (wave); e.g. the facing direction to hold a cup upright."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const t = await runPose("{'ok': True, 'p': seq_target(P['seq'], P['t'])}", { seq: a.sequence, t: a.target });
      if (!t.ok) return text(`Error: ${t.error}`, true);
      const tol = a.toleranceDeg ?? 3;
      // CLAUDE-NOTE (2026-10-21, live): measure AT the frame being keyed. Without this scrub the first read measured
      // whatever frame was current (the previous call's), so frames 20-38 of a wave "already faced" the camera.
      await runPose("scrub(P['seq'], P['f'])", { seq: a.sequence, f: a.frame ?? 0 });
      let p: PoseResult = { ok: false };
      let first = NaN;
      for (let i = 0; i < 5; i++) {
        // always take at least one full-orientation step so the finger direction is set even when the palm already faces
        p = await runPose("palm(P['seq'], P['b'], P['s'], P['t'], P['fd'])", { seq: a.sequence, b: a.binding, s: a.side, t: t.p, fd: a.fingers ?? null });
        if (!p.ok) return text(`Error: ${p.error}`, true);
        if (i === 0) first = p.error_deg;
        if (p.error_deg <= tol && i > 0) break;
        const s2 = await runPose("palm_step(P['seq'], P['b'], P['s'], P['t'], P['f'], P['fd'])", { seq: a.sequence, b: a.binding, s: a.side, t: t.p, f: a.frame ?? 0, fd: a.fingers ?? [0, 0, 1] });
        if (!s2.ok) return text(`Error: ${s2.error}`, true);
      }
      const ok = p.error_deg <= tol;
      return text(`${ok ? "Palm faces" : "Palm does NOT face"} ${JSON.stringify(t.p.map((v: number) => +v.toFixed(1)))}: error ${first} -> ${p.error_deg} deg (palm ${JSON.stringify(p.palm)}); fingers ${a.fingers ? `${p.fingers_err_deg} deg from ${JSON.stringify(a.fingers)}` : `${p.fingers_up_deg} deg from straight up`}.`, !ok);
    },
  );

}
