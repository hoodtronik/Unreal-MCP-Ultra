import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): Control Rig POSE LIBRARY for Sequencer characters (Tools/python/ue_poselib.py). Poses are
// ControlRigPoseAssets (what the Animation-mode Poses tool uses) plus a bone snapshot in the asset's metadata, so an
// apply verifies itself: same mesh -> every bone must land on the snapshot (live: 0.0 cm), other mesh -> the
// per-bone difference is reported as proportions. pose_mirror flips a character's current pose left<->right and
// checks every rendered bone against the mirror image of the pose it started from (ue_poselib.py mirroring notes).

const LIBS = ["ue_posing.py", "ue_poselib.py"];
export const SAME_MESH_TOL_CM = 0.5;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Per-bone distance between two actor-space bone maps. Exported for tests. */
export function boneDiff(a: Record<string, number[]>, b: Record<string, number[]>): { max: number; worst: string | null; per: Record<string, number>; compared: number } {
  const per: Record<string, number> = {};
  let max = -1;
  let worst: string | null = null;
  for (const [k, p] of Object.entries(a)) {
    const q = b[k];
    if (!q) continue;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    per[k] = +d.toFixed(2);
    if (d > max) { max = d; worst = k; }
  }
  return { max: +Math.max(0, max).toFixed(2), worst, per, compared: Object.keys(per).length };
}

export const MIRROR_TOL_CM = 0.5;
// unskinned IK target bones (ik_hand_gun, ik_foot_root...) follow one side and have no partner
const MIRROR_SKIP = /^ik_/;

/** Worst bone of a mirrored pose vs the mirror image it should match. Exported for tests. */
export function mirrorCheck(want: Record<string, number[]>, now: Record<string, number[]>, reflected: string[] = []) {
  const keep = (m: Record<string, number[]>) => Object.fromEntries(Object.entries(m).filter(([k]) => !MIRROR_SKIP.test(k)));
  const d = boneDiff(keep(want), keep(now));
  // CLAUDE-NOTE: a reflected bone (negative scale determinant) renders inside-out while its POSITION is still right -
  // the first live mirror passed at 0.04 cm with 20 such bones; only the capture showed it
  return {
    ...d,
    reflected,
    ok: d.compared > 0 && d.compared === Object.keys(keep(want)).length && d.max <= MIRROR_TOL_CM && reflected.length === 0,
  };
}

/** Mirror the binding's current pose at `frame` in place; returns report lines + ok. */
export async function mirrorPose(seq: string, binding: string, frame: number): Promise<{ ok: boolean; lines: string[] }> {
  await settle(seq, frame);
  const want = await run("rig_bones(P['s'], P['b'], True)", { s: seq, b: binding });
  const tg = await run("mirror_targets(P['s'], P['b'])", { s: seq, b: binding });
  if (!want.ok || !tg.ok) return { ok: false, lines: [`Error: ${want.error ?? tg.error}`] };
  let chk = { ok: false, max: -1, worst: null as string | null, compared: 0, reflected: [] as string[] };
  for (let pass = 1; pass <= 3; pass++) {
    const w = await run("mirror_write(P['s'], P['b'], P['f'], P['t'])", { s: seq, b: binding, f: frame, t: tg.targets });
    if (!w.ok) return { ok: false, lines: [`Error: ${w.error}`] };
    await settle(seq, frame);
    const now = await run("rig_bones(P['s'], P['b'])", { s: seq, b: binding });
    if (!now.ok) return { ok: false, lines: [`Readback failed: ${now.error}`] };
    chk = mirrorCheck(want.bones, now.bones, now.reflected ?? []);
    if (chk.ok) break;
  }
  return {
    ok: chk.ok,
    lines: [
      `${chk.ok ? "Mirrored" : "MIRROR MISMATCH"}: ${tg.targets.length} controls keyed at frame ${frame}; ${chk.compared} rendered bones vs ` +
        `the mirror image, worst ${chk.worst} ${chk.max} cm (tol ${MIRROR_TOL_CM}); ` +
        `${chk.reflected.length ? `${chk.reflected.length} REFLECTED (inside-out) bones: ${chk.reflected.slice(0, 6).join(", ")}` : "no reflected bones"}. ` +
        `Arms and legs are keyed in FK.`,
    ],
  };
}

async function settle(seq: string, frame: number) {
  await run("scrub(P['s'], P['f'])", { s: seq, f: frame });
  await run("scrub(P['s'], P['f'])", { s: seq, f: frame });
}

export function registerPoseLibraryTools(server: McpServer): void {
  server.tool(
    "pose_library_save",
    "Save a Sequencer character's Control Rig pose at a frame as a ControlRigPoseAsset (usable in the Animation-mode " +
      "Poses tool too), with a bone snapshot so later applies can verify themselves.",
    {
      sequence: z.string(),
      binding: z.string(),
      frame: z.number().int(),
      asset: z.string().describe("Pose asset path to create/overwrite, e.g. /Game/Poses/CRP_Wave."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      await settle(a.sequence, a.frame);
      const r = await run("poselib_save(P['s'], P['b'], P['a'])", { s: a.sequence, b: a.binding, a: a.asset });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      if (r.frame !== a.frame) return text(`Saved, but the rig was read at frame ${r.frame}, not ${a.frame} - save again.`, true);
      return text(`${r.created ? "Created" : "Overwrote"} ${r.asset}: ${r.controls} controls from ${a.binding} at frame ${r.frame}; ${r.bones} bones snapshotted.`);
    },
  );

  server.tool(
    "pose_mirror",
    "Flip a Sequencer character's Control Rig pose left<->right at a frame (keys every control), then VERIFY: every " +
      "rendered bone must land on the mirror image of the starting pose (tol 0.5 cm). Arms and legs end up in FK. " +
      "Use for 'same pose, other hand' or symmetric pairs of characters.",
    { sequence: z.string(), binding: z.string(), frame: z.number().int().optional() },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const m = await mirrorPose(a.sequence, a.binding, a.frame ?? 0);
      return text(m.lines.join("\n"), !m.ok);
    },
  );

  server.tool(
    "pose_library_apply",
    "Key a saved pose asset onto a Sequencer character at a frame (all stored controls, or only 'controls'), then " +
      "VERIFY against the bone snapshot taken at save time: same mesh -> every bone within 0.5 cm; another mesh -> " +
      "the per-bone difference is reported (proportions). Pose a character in seconds from a library, or copy a pose " +
      "from one shot/character to another.",
    {
      sequence: z.string(),
      binding: z.string(),
      asset: z.string(),
      frame: z.number().int().optional(),
      controls: z.array(z.string()).optional().describe("Only these controls (e.g. one arm + hand)."),
      mirror: z.boolean().optional().describe("Apply the pose flipped left<->right (verified against the mirror image)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.mirror && a.controls?.length) return text("mirror applies to the whole pose - omit 'controls'.", true);
      const f = a.frame ?? 0;
      const w = await run("poselib_apply(P['s'], P['b'], P['a'], P['f'], P['c'])", { s: a.sequence, b: a.binding, a: a.asset, f, c: a.controls ?? null });
      if (!w.ok) return text(`Error: ${w.error}`, true);
      const lines = [`Keyed ${w.keyed} control(s) from ${a.asset} on ${a.binding} at frame ${f}${w.skipped?.length ? `; skipped ${w.skipped.join(", ")}` : ""}.`];
      const snap = await run("poselib_snapshot(P['a'])", { a: a.asset });
      if (!snap.ok || !snap.bones) return text([...lines, "No bone snapshot on this asset (saved outside pose_library_save) - not verified."].join("\n"));
      await settle(a.sequence, f);
      const now = await run("bones_local(P['s'], P['b'])", { s: a.sequence, b: a.binding });
      const mesh = await run("mesh_of(P['s'], P['b'])", { s: a.sequence, b: a.binding });
      if (!now.ok || !mesh.ok) return text([...lines, `Readback failed: ${now.error ?? mesh.error}`].join("\n"), true);
      const d = boneDiff(snap.bones, now.bones);
      const same = mesh.mesh === snap.mesh;
      if (a.mirror) {
        // the unmirrored apply must be right before its mirror image can be the reference
        if (same && !(d.compared > 0 && d.max <= SAME_MESH_TOL_CM)) return text([...lines, `POSE MISMATCH before mirroring: worst ${d.worst} ${d.max} cm.`].join("\n"), true);
        const m = await mirrorPose(a.sequence, a.binding, f);
        return text([...lines, ...m.lines].join("\n"), !m.ok);
      }
      if (a.controls?.length) {
        lines.push(`Partial pose: bone snapshot comparison skipped (max difference ${d.max} cm at ${d.worst}).`);
        return text(lines.join("\n"));
      }
      if (same) {
        // a comparison that matched no bones must not read as a perfect match
        const ok = d.compared >= Object.keys(snap.bones).length && d.compared > 0 && d.max <= SAME_MESH_TOL_CM;
        lines.push(`${ok ? "Verified" : "POSE MISMATCH"}: same mesh as the source (${snap.source}); ${d.compared} bones compared, worst ${d.worst} ${d.max} cm (tol ${SAME_MESH_TOL_CM}).`);
        return text(lines.join("\n"), !ok);
      }
      lines.push(`Different mesh (${mesh.mesh.split("/").pop()} vs ${String(snap.mesh).split("/").pop()}): bone differences reflect proportions - worst ${d.worst} ${d.max} cm; ${JSON.stringify(d.per)}.`);
      return text(lines.join("\n"));
    },
  );
}
