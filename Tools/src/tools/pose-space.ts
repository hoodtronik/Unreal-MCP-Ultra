import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { checkFrames } from "./anim-bake.js";

// CLAUDE-NOTE (2026-10-21): pose_space_switch / pose_constrain wrap ControlRigSequencerLibrary.set_control_rig_space
// and add_constraint (Tools/python/ue_space.py) and VERIFY the effect frame by frame, because both calls report
// success without saying what the character does: the switch frame must not pop, and afterwards the control must
// keep its offset in the new space / to the constraint parent. Live (SEQ_Plant, CR_Mannequin_Body): hand_l_ik_ctrl
// switched to body_ctrl rode the body exactly; hand_r_ik_ctrl parent-constrained to a sliding tray followed it to
// 0.00 cm while the hand BONE fell 3-4 cm short (arm at full stretch) - so the bone gap is reported separately.
// Editing a constrained control does not stick (pose_palm: 35 deg error until the constraint was removed).

const LIBS = ["ue_posing.py", "ue_space.py"];
export const POP_TOL_CM = 0.5;
export const FOLLOW_TOL_CM = 0.5;
export const REACH_TOL_CM = 1.0;

type Vec = [number, number, number];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
/** Largest distance of any point from the first one (0 for fewer than two points). Exported for tests. */
export function spread(points: Vec[]): number {
  return points.length < 2 ? 0 : Math.max(...points.map((p) => dist(p, points[0])));
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Scrub twice (bones refresh between calls), then measure in a separate call. */
async function probeAt(seq: string, frame: number, call: string, params: Record<string, unknown>): Promise<PoseResult> {
  await run("scrub(P['s'], P['f'])", { s: seq, f: frame });
  await run("scrub(P['s'], P['f'])", { s: seq, f: frame });
  return run(call, { ...params, s: seq });
}

type Sample = { frame: number; ctrl: Vec; rel: Vec; space_pos: Vec | null; bone?: string; gap?: number };

/** Follow report over samples: offset drift, how far the space/parent moved, worst bone gap. */
export function followReport(samples: Sample[]): { drift: number; moved: number; gap: number; gapFrame: number; bone?: string } {
  const moved = spread(samples.map((s) => s.space_pos ?? s.ctrl));
  let gap = 0;
  let gapFrame = samples[0]?.frame ?? 0;
  for (const s of samples) if ((s.gap ?? 0) > gap) { gap = s.gap ?? 0; gapFrame = s.frame; }
  return { drift: spread(samples.map((s) => s.rel)), moved, gap, gapFrame, bone: samples.find((s) => s.bone)?.bone };
}

function gapLine(f: ReturnType<typeof followReport>, control: string): string | null {
  if (!f.bone || f.gap <= REACH_TOL_CM) return null;
  return `WARNING: bone ${f.bone} is up to ${r2(f.gap)} cm from ${control} (frame ${f.gapFrame}) - the target is out of reach or the limb is in FK; the control follows, the bone does not.`;
}

export function registerPoseSpaceTools(server: McpServer): void {
  server.tool(
    "pose_space_switch",
    "Key a Control Rig SPACE SWITCH (Sequencer space picker): from `frame` on, `control` follows `space` - another " +
      "control/null of the rig (e.g. body_ctrl, chest_space, head_ctrl) or 'world'. E.g. a hand rides the body (hand " +
      "on hip while crouching) or stays put in the world. VERIFIED: no pop at the switch frame, and the control keeps " +
      "its offset in the new space on sampled frames after it; the effector bone's gap to the control is reported.",
    {
      sequence: z.string(),
      binding: z.string(),
      control: z.string().describe("Control to switch, e.g. hand_l_ik_ctrl (switch the limb to IK first, e.g. with pose_reach)."),
      space: z.string().describe("Rig control/null name or 'world'. The error lists the rig-defined spaces."),
      frame: z.number().int().describe("Switch frame (display rate)."),
      check: z.number().int().min(2).max(30).optional().describe("Frames to verify after the switch (default 7)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const p = { b: a.binding, c: a.control, sp: a.space };
      const sp = await run("spaces(P['s'], P['b'], P['c'])", { s: a.sequence, ...p });
      if (!sp.ok) return text(`Error: ${sp.error}`, true);
      const rg = await run("seq_range(P['s'])", { s: a.sequence });
      if (!rg.ok) return text(`Error: ${rg.error}`, true);
      const probe = "space_probe(P['s'], P['b'], P['c'], P['sp'])";
      const before = await probeAt(a.sequence, a.frame, "space_probe(P['s'], P['b'], P['c'])", p);
      if (!before.ok) return text(`Error: ${before.error}`, true);
      const set = await run("set_space(P['s'], P['b'], P['c'], P['sp'], P['f'])", { s: a.sequence, ...p, f: a.frame });
      if (!set.ok) return text(`Error: ${set.error}`, true);
      const samples: Sample[] = [];
      for (const f of checkFrames(a.frame, Math.max(a.frame, rg.end), a.check ?? 7)) {
        const s = await probeAt(a.sequence, f, probe, p);
        if (!s.ok) return text(`Error at frame ${f}: ${s.error}`, true);
        samples.push(s as unknown as Sample);
      }
      const pop = dist(samples[0].ctrl, before.ctrl);
      const fr = followReport(samples);
      const ok = pop <= POP_TOL_CM;
      const lines = [
        set.keyed
          ? `Keyed ${a.control} -> ${a.space} at frame ${a.frame}.`
          : `No key set: ${a.control} is already in ${a.space} at frame ${a.frame} (Unreal skips a same-space key).`,
        `${ok ? "No pop" : "POP"} at the switch frame: ${r2(pop)} cm (tol ${POP_TOL_CM}).`,
        `Frames ${samples.map((s) => s.frame).join(",")}: ${a.space} moved ${r2(fr.moved)} cm; ${a.control}'s offset in it drifted ${r2(fr.drift)} cm` +
          (fr.drift > FOLLOW_TOL_CM ? " - the control has its own keys after the switch, or another switch/constraint overrides it." : "."),
        `Rig-defined spaces of ${a.control}: ${(sp.rig_spaces as string[]).join(", ")}, plus world.`,
      ];
      const g = gapLine(fr, a.control);
      if (g) lines.push(g);
      return text(lines.join("\n"), !ok);
    },
  );

  const parentSchema = z
    .object({
      actor: z.string().optional().describe("Level actor label (e.g. a prop bound or placed in the level)."),
      binding: z.string().optional().describe("Sequencer binding name (its actor, or with control/bone a part of it)."),
      control: z.string().optional().describe("With binding: a Control Rig control of that character (hand-to-hand)."),
      bone: z.string().optional().describe("With binding: a bone/socket of that character's skeletal mesh."),
    })
    .refine((p) => !!p.actor !== !!p.binding, { message: "Give exactly one of actor or binding" });

  server.tool(
    "pose_constrain",
    "Constrain a Control Rig control to a moving parent with a Sequencer ANIMATION CONSTRAINT (parent / translation / " +
      "rotation): a hand on a sliding tray, a door handle, a prop, or another character's hand or bone. Keyed active " +
      "from `frame`. VERIFIED on sampled frames: the control keeps its offset to the parent while the parent moves; the " +
      "effector bone's gap is reported (out of reach shows there, not as a constraint failure). bake=true turns it into " +
      "ordinary control keys and checks they match. POSE THE CONTROL FIRST: the constraint overrides later edits to " +
      "it (pose_palm missed by 35 deg on a constrained hand) - remove, re-pose, re-constrain.",
    {
      sequence: z.string(),
      binding: z.string(),
      control: z.string().describe("Child control, e.g. hand_r_ik_ctrl (limb in IK)."),
      parent: parentSchema.optional().describe("Required unless remove."),
      remove: z.boolean().optional().describe("Remove every constraint on the control (its own keys stay) and stop."),
      type: z.enum(["parent", "translation", "rotation"]).optional().describe("Default parent."),
      maintainOffset: z.boolean().optional().describe("Keep the current offset (default true)."),
      frame: z.number().int().optional().describe("Frame the constraint becomes active (default sequence start)."),
      replace: z.boolean().optional().describe("Remove constraints already on the control first."),
      bake: z.boolean().optional().describe("Bake to keys afterwards (constraint keyed inactive) and verify."),
      check: z.number().int().min(2).max(30).optional().describe("Frames to verify (default 7)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.remove) {
        const u = await run("unconstrain(P['s'], P['b'], P['c'])", { s: a.sequence, b: a.binding, c: a.control });
        if (!u.ok) return text(`Error: ${u.error}`, true);
        return text(`Removed ${u.removed} constraint(s) from ${a.control}; ${u.left} left.`, u.left !== 0);
      }
      if (!a.parent) return text("Error: parent is required (or pass remove: true)", true);
      const parent = a.parent;
      const rg = await run("seq_range(P['s'])", { s: a.sequence });
      if (!rg.ok) return text(`Error: ${rg.error}`, true);
      const frame = a.frame ?? rg.start;
      const type = a.type ?? "parent";
      const c = await run("constrain(P['s'], P['b'], P['c'], P['p'], P['t'], P['m'], P['f'], P['r'])", {
        s: a.sequence, b: a.binding, c: a.control, p: parent, t: type, m: a.maintainOffset ?? true, f: frame, r: !!a.replace,
      });
      if (!c.ok) return text(`Error: ${c.error}`, true);
      const frames = checkFrames(frame, Math.max(frame, rg.end), a.check ?? 7);
      const samples: Sample[] = [];
      for (const f of frames) {
        const s = await probeAt(a.sequence, f, "constraint_probe(P['s'], P['b'], P['c'], P['p'])", { b: a.binding, c: a.control, p: parent });
        if (!s.ok) return text(`Error at frame ${f}: ${s.error}`, true);
        samples.push(s as unknown as Sample);
      }
      const fr = followReport(samples);
      const posChecked = type !== "rotation";
      const ok = !posChecked || fr.drift <= FOLLOW_TOL_CM;
      const who = parent.actor ?? [parent.binding, parent.control ?? parent.bone].filter(Boolean).join(".");
      const lines = [
        `${c.constraint} ${a.control} -> ${who} active from frame ${frame}${c.removed ? ` (replaced ${c.removed})` : ""}; keys ${JSON.stringify(c.keys)}.`,
        posChecked
          ? `${ok ? "Follows" : "DOES NOT FOLLOW"}: frames ${frames.join(",")}, parent moved ${r2(fr.moved)} cm, offset drift ${r2(fr.drift)} cm (tol ${FOLLOW_TOL_CM}).`
          : `Rotation constraint: position not checked; parent moved ${r2(fr.moved)} cm.`,
      ];
      if (posChecked && fr.moved < 1) lines.push("Note: the parent barely moves over these frames, so following is not really tested.");
      const g = gapLine(fr, a.control);
      if (g) lines.push(g);
      if (a.bake && ok) {
        const b = await run("bake_constraints(P['s'], P['b'], P['c'])", { s: a.sequence, b: a.binding, c: a.control });
        if (!b.ok) return text([...lines, `Bake failed: ${b.error ?? "bake_constraint returned False"}`].join("\n"), true);
        let worst = 0;
        for (const s of samples) {
          const q = await probeAt(a.sequence, s.frame, "space_probe(P['s'], P['b'], P['c'])", { b: a.binding, c: a.control });
          if (!q.ok) return text([...lines, `Bake check failed at ${s.frame}: ${q.error}`].join("\n"), true);
          worst = Math.max(worst, dist(q.ctrl, s.ctrl));
        }
        const bok = worst <= FOLLOW_TOL_CM;
        lines.push(`${bok ? "Baked" : "BAKE MISMATCH"}: ${b.baked} constraint(s) to keys; control vs constrained result worst ${r2(worst)} cm.`);
        return text(lines.join("\n"), !bok);
      }
      return text(lines.join("\n"), !ok);
    },
  );

  server.tool(
    "pose_snap",
    "SNAP (Control Rig Snapper) controls onto an actor or a bone over a frame range: keys the controls on every frame " +
      "so they follow it (hand on a lifted tray, foot on a moving platform) - plain keys, no live constraint left. " +
      "keepOffset keeps today's offset at `start`. VERIFIED: offset held on sampled frames, no jump at `start`, bone gap.",
    {
      sequence: z.string(),
      binding: z.string(),
      controls: z.array(z.string()).min(1),
      parent: z.object({ actor: z.string().optional(), binding: z.string().optional(), bone: z.string().optional() })
        .refine((p) => !!p.actor !== !!p.binding, { message: "Give exactly one of actor or binding" }),
      start: z.number().int(),
      end: z.number().int(),
      keepOffset: z.boolean().optional().describe("Default true; false snaps the control onto the parent's pivot."),
      rotation: z.boolean().optional().describe("Also follow rotation (default true)."),
      everyFrame: z.boolean().optional().describe("Key every frame (default true); false keys only the parent's key frames."),
      check: z.number().int().min(2).max(30).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.end <= a.start) return text("Error: end must be after start", true);
      const keep = a.keepOffset ?? true;
      const c0 = a.controls[0];
      // CLAUDE-NOTE (live): keep_offset reads the control's CURRENT evaluated transform - after a scrub to frame 48 it
      // used the frame-48 hand against the frame-0 tray and lifted the hand 30 cm. Scrub to start (separate calls) first.
      const pre = await probeAt(a.sequence, a.start, "constraint_probe(P['s'], P['b'], P['c'], P['p'])", { b: a.binding, c: c0, p: a.parent });
      if (!pre.ok) return text(`Error: ${pre.error}`, true);
      const r = await run("snap(P['s'], P['b'], P['cs'], P['p'], P['a'], P['e'], P['k'], P['r'], P['ef'])", {
        s: a.sequence, b: a.binding, cs: a.controls, p: a.parent, a: a.start, e: a.end, k: keep, r: a.rotation ?? true, ef: a.everyFrame ?? true,
      });
      if (!r.ok) return text(`Error: ${r.error ?? "snap_control_rig returned False"}`, true);
      const samples: Sample[] = [];
      for (const f of checkFrames(a.start, a.end, a.check ?? 7)) {
        const q = await probeAt(a.sequence, f, "constraint_probe(P['s'], P['b'], P['c'], P['p'])", { b: a.binding, c: c0, p: a.parent });
        if (!q.ok) return text(`Error at frame ${f}: ${q.error}`, true);
        samples.push(q as unknown as Sample);
      }
      const fr = followReport(samples);
      const jump = keep ? dist(samples[0].rel, pre.rel) : 0;
      const ok = fr.drift <= FOLLOW_TOL_CM && jump <= POP_TOL_CM;
      const lines = [
        `Snapped ${a.controls.join(", ")} -> ${a.parent.actor ?? a.parent.binding}${a.parent.bone ? "." + a.parent.bone : ""} over ${a.start}-${a.end} (${a.everyFrame === false ? "parent's key frames" : "every frame"}).`,
        `${ok ? "Follows" : "DOES NOT FOLLOW"} (${c0}): parent moved ${r2(fr.moved)} cm, offset drift ${r2(fr.drift)} cm` + (keep ? `, jump at start ${r2(jump)} cm` : "") + ` (tol ${FOLLOW_TOL_CM}).`,
      ];
      const g = gapLine(fr, c0);
      if (g) lines.push(g);
      return text(lines.join("\n"), !ok);
    },
  );
}
