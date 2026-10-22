import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22): pose_fk drives the AUTO FK Control Rig (FKControlRig), which works on any skeleton -
// the custom-skeleton characters (Fab girl, 99 bones incl. face) that CR_Mannequin_Body-based pose_* tools cannot
// pose (Tools/python/ue_fk.py). Values are offsets on the base pose: local = base * ctrl. The base is read by muting
// the rig (reference pose in replace mode, the clip in additive mode) and every keyed bone is checked against it.

const LIBS = ["ue_posing.py", "ue_walk.py", "ue_fk.py"];
export const FK_TOL_DEG = 0.1;
const AIM_TOL_DEG = 0.5;
const AIM_STEPS = 4;
const vec3 = z.array(z.number()).length(3);

/** Hamilton product of quaternions [x,y,z,w]: a*b applies b in a's frame. Exported for tests. */
export function qmul(a: number[], b: number[]): number[] {
  const [x1, y1, z1, w1] = a, [x2, y2, z2, w2] = b;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}

/** Angle (deg) between two unit quaternions. Exported for tests. */
export function qAngle(a: number[], b: number[]): number {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
}

/** Error (deg) of a measured local rotation against base * ctrl. Exported for tests. */
export function fkError(base: number[], ctrl: number[], measured: number[]): number {
  return qAngle(qmul(base, ctrl), measured);
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}
async function readAt(seq: string, binding: string, frame: number, bones: string[]): Promise<PoseResult> {
  await run("scrub(P['s'], P['f'])", { s: seq, f: frame });
  await run("scrub(P['s'], P['f'])", { s: seq, f: frame });
  return run("bone_locals(P['s'], P['b'], P['n'])", { s: seq, b: binding, n: bones });
}

export function registerPoseFkTools(server: McpServer): void {
  server.tool(
    "pose_fk",
    "Pose ANY skeleton bone by bone with Unreal's auto FK Control Rig - characters without a Control Rig of their " +
      "own (imported/Fab characters), including FACE bones (jaw, lips, brows, eyelids) when the skeleton has them. " +
      "'add' puts the FK rig on a character binding (mode 'replace' = pose from the reference pose; 'additive' = " +
      "offsets on top of a playing clip). 'set' keys rotations [pitch,yaw,roll] deg in each bone's own axes as OFFSETS " +
      "from the base pose at `frame` (and `locations` in cm); bones by full name or a short token ('jaw', 'upperarm_r'); " +
      "verified per bone against base * offset (base read by muting the rig). Bone axes differ per bone, so for limbs " +
      "use 'aim': point a bone at a world point (solved, keyed, re-measured until within 0.5 deg). 'list' shows the bones.",
    {
      sequence: z.string(),
      binding: z.string(),
      action: z.enum(["add", "set", "aim", "list"]),
      mode: z.enum(["replace", "additive"]).optional().describe("'add': default replace."),
      frame: z.number().int().optional().describe("'set': frame to key. Default 0."),
      rotations: z.record(z.string(), vec3).optional().describe("'set': {bone: [pitch, yaw, roll]} offsets in degrees."),
      locations: z.record(z.string(), vec3).optional().describe("'set': {bone: [x, y, z]} offsets in WORLD cm along the parent bone's axes (face bones: lip corners, brows)."),
      aims: z.record(z.string(), vec3).optional().describe("'aim': {bone: world point} - turn each bone (in the given order, e.g. upperarm then lowerarm) so its child bone points at the point."),
      contains: z.string().optional().describe("'list': filter."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const base = { s: a.sequence, b: a.binding };
      if (a.action === "add") {
        const r = await run("add_fk(P['s'], P['b'], P['m'])", { ...base, m: a.mode ?? "replace" });
        if (!r.ok) return text(`Error: ${r.error ?? "apply mode not set"}`, true);
        const want = (a.mode ?? "replace").toUpperCase();
        const ok = r.mode === want;
        return text(`${r.created ? "Added" : "Found"} FK Control Rig on '${a.binding}': ${r.controls} bone controls, mode ${r.mode}` +
          `${(r.stripped as string[]).length ? ` (removed auto-added ${(r.stripped as string[]).join(", ")})` : ""}.${ok ? "" : ` MODE NOT SET (wanted ${want}).`}`, !ok);
      }
      if (a.action === "list") {
        const r = await run("fk_list(P['s'], P['b'], P['c'])", { ...base, c: a.contains ?? null });
        if (!r.ok) return text(`Error: ${r.error}`, true);
        return text(`${r.count} bone(s) (mode ${r.mode}): ${(r.bones as string[]).join(", ")}`);
      }
      const f = a.frame ?? 0;
      if (a.action === "aim") {
        if (!a.aims || !Object.keys(a.aims).length) return text("Error: 'aim' needs aims.", true);
        const lines: string[] = [];
        let bad = 0;
        // CLAUDE-NOTE: one solve per call (the pose only updates between calls), re-measured until the child bone points
        // at the target; parents first, since a parent turn moves everything below it.
        for (const [bone, tgt] of Object.entries(a.aims)) {
          let e0 = NaN, e = NaN, steps = 0, info: PoseResult | null = null;
          for (; steps < AIM_STEPS; steps++) {
            const st = await run("fk_aim(P['s'], P['b'], P['f'], P['k'], P['t'])", { ...base, f, k: bone, t: tgt });
            if (!st.ok) return text(`Error aiming ${bone}: ${st.error}`, true);
            if (steps === 0) e0 = st.error_deg;
            await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
            await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
            info = await run("fk_dir_error(P['s'], P['b'], P['k'], P['t'])", { ...base, k: bone, t: tgt });
            if (!info.ok) return text(`Error measuring ${bone}: ${info.error}`, true);
            e = info.error_deg;
            if (e <= AIM_TOL_DEG) break;
          }
          if (!(e <= AIM_TOL_DEG)) bad++;
          lines.push(`  ${bone} (${info?.bone} -> ${info?.child}): ${e0.toFixed(2)} -> ${e.toFixed(3)} deg in ${Math.min(steps + 1, AIM_STEPS)} step(s)`);
        }
        return text([`${bad ? "AIM NOT REACHED for " + bad + " bone(s):" : "Aimed"} ${Object.keys(a.aims).length} bone(s) at f${f} (tol ${AIM_TOL_DEG} deg).`, ...lines].join("\n"), bad > 0);
      }
      if (!Object.keys(a.rotations ?? {}).length && !Object.keys(a.locations ?? {}).length) return text("Error: 'set' needs rotations and/or locations.", true);
      const s = await run("fk_set(P['s'], P['b'], P['f'], P['r'], P['l'])", { ...base, f, r: a.rotations ?? null, l: a.locations ?? null });
      if (!s.ok) return text(`Error: ${s.error}`, true);
      const ctrls = s.controls as Record<string, string>;
      const bones = Object.values(ctrls).map((c) => c.replace(/_CONTROL$/, ""));
      const m = await run("fk_active(P['s'], P['b'], False)", base);
      if (!m.ok) return text(`Error muting the rig: ${m.error}`, true);
      const b0 = await readAt(a.sequence, a.binding, f, bones);
      await run("fk_active(P['s'], P['b'], True)", base);
      if (!b0.ok) return text(`Error reading the base pose: ${b0.error}`, true);
      const b1 = await readAt(a.sequence, a.binding, f, bones);
      if (!b1.ok) return text(`Error reading the pose: ${b1.error}`, true);
      const q = s.quats as Record<string, number[]>;
      const rows = Object.entries(ctrls).map(([k, c]) => {
        const bn = c.replace(/_CONTROL$/, "");
        const e = fkError(b0.bones[bn].q, q[c], b1.bones[bn].q);
        const turned = qAngle(b0.bones[bn].q, b1.bones[bn].q);
        const moved = Math.hypot(...(b1.bones[bn].w as number[]).map((v, i) => v - b0.bones[bn].w[i]));
        return { k, bn, e, turned, moved, w: b1.bones[bn].w as number[] };
      });
      const worst = Math.max(...rows.map((r) => r.e));
      const ok = worst <= FK_TOL_DEG && b1.frame === f;
      const lines = [
        `Keyed ${rows.length} bone(s) at f${f}. ${ok ? "Verified" : "MISMATCH:"} worst ${worst.toFixed(3)} deg vs base * offset (tol ${FK_TOL_DEG}).`,
        ...rows.map((r) => `  ${r.k} -> ${r.bn}: turned ${r.turned.toFixed(2)} deg, moved ${r.moved.toFixed(2)} cm from the base, err ${r.e.toFixed(3)}; world ${JSON.stringify(r.w)}`),
      ];
      return text(lines.join("\n"), !ok);
    },
  );
}
