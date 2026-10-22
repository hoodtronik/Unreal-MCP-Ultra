import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22): pose_layer puts an ADDITIVE (layered) Control Rig on a character that plays a clip, so
// mocap / a walk can be edited without replacing it (Tools/python/ue_layer.py). The reference is the clip itself,
// read by muting the layer (live: muted == clip at 0.000 cm on all 89 bones). Comparison is per body region in
// component space (positions) and parent-bone space (rotations), so a moving walker compares frame to frame.

const LIBS = ["ue_posing.py", "ue_tween.py", "ue_layer.py"];
const DEFAULT_RIG = "/Game/Characters/Mannequins/Rigs/CR_Mannequin_Body";
export const LAYER_TOL_CM = 0.05;
// A region counts as edited when a bone moves past the cm tolerance OR turns past this (a head turn is rotation only).
export const LAYER_TOL_DEG = 1;

type Bones = Record<string, { c: number[]; q: number[] }>;
export type RegionDiff = Record<string, { cm: number; deg: number; bone: string }>;

/** Body region of a bone name (Mannequin naming). Exported for tests. */
export function boneRegion(name: string): string {
  const n = name.toLowerCase();
  if (/^(thigh|calf|foot|ball)/.test(n)) return "legs";
  if (/^(pelvis|spine)/.test(n)) return "spine";
  if (/^(neck|head)/.test(n)) return "head";
  if (/^(clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky|wrist|elbow)/.test(n)) {
    if (/_l$|_l_|_l\b/.test(n)) return "arm_l";
    if (/_r$|_r_|_r\b/.test(n)) return "arm_r";
  }
  return "other";
}

function quatDeg(p: number[], q: number[]): number {
  const d = Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
}

/** Largest position / rotation difference per region between the clip and the layered pose. Exported for tests. */
export function regionDiff(clip: Bones, layer: Bones): RegionDiff {
  const out: RegionDiff = {};
  for (const [name, a] of Object.entries(clip)) {
    const b = layer[name];
    if (!b) continue;
    const r = boneRegion(name);
    const cm = Math.hypot(...a.c.map((v, i) => v - b.c[i]));
    const deg = quatDeg(a.q, b.q);
    const cur = out[r] ?? { cm: 0, deg: 0, bone: "" };
    if (cm > cur.cm) { cur.cm = cm; cur.bone = name; }
    cur.deg = Math.max(cur.deg, deg);
    out[r] = cur;
  }
  return out;
}

/** Regions whose bones the layer moves or turns on any frame. Exported for tests. */
export function editedRegions(diffs: RegionDiff[], tolCm = LAYER_TOL_CM, tolDeg = LAYER_TOL_DEG): string[] {
  return ["legs", "spine", "head", "arm_l", "arm_r", "other"].filter((r) =>
    diffs.some((d) => (d[r]?.cm ?? 0) > tolCm || (d[r]?.deg ?? 0) > tolDeg));
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Read every bone at each frame (one request per frame after a settled first scrub). */
async function readFrames(seq: string, binding: string, frames: number[]): Promise<Bones[] | string> {
  await run("scrub(P['s'], P['f'])", { s: seq, f: frames[0] });
  await run("scrub(P['s'], P['f'])", { s: seq, f: frames[0] });
  const out: Bones[] = [];
  for (let i = 0; i < frames.length; i++) {
    const nx = i + 1 < frames.length ? frames[i + 1] : null;
    const r = await run("bones_local(P['s'], P['b'], None, P['nx'])", { s: seq, b: binding, nx });
    if (!r.ok) return `frame ${frames[i]}: ${r.error}`;
    if (r.frame !== frames[i]) return `frame ${frames[i]} read at frame ${r.frame}`;
    out.push(r.bones as Bones);
  }
  return out;
}

/** Clip (layer muted) vs layered pose at each frame. */
async function compare(seq: string, binding: string, frames: number[]): Promise<RegionDiff[] | string> {
  const m = await run("layer_active(P['s'], P['b'], False)", { s: seq, b: binding });
  if (!m.ok) return m.error ?? "mute failed";
  const clip = await readFrames(seq, binding, frames);
  const u = await run("layer_active(P['s'], P['b'], True)", { s: seq, b: binding });
  if (!u.ok) return u.error ?? "unmute failed";
  if (typeof clip === "string") return clip;
  const lay = await readFrames(seq, binding, frames);
  if (typeof lay === "string") return lay;
  return frames.map((_, i) => regionDiff(clip[i], lay[i]));
}

const REGIONS = ["legs", "spine", "head", "arm_l", "arm_r", "other"];

function describe(frames: number[], diffs: RegionDiff[]): string[] {
  return frames.map((f, i) => `  f${f}: ` + REGIONS.filter((r) => diffs[i][r]).map((r) => {
    const d = diffs[i][r];
    return `${r} ${d.cm.toFixed(3)} cm/${d.deg.toFixed(1)}°`;
  }).join(", "));
}

export function registerPoseLayerTools(server: McpServer): void {
  server.tool(
    "pose_layer",
    "ADDITIVE Control Rig layer over a character that plays a clip (anim_walk, mocap): edit the animation without " +
      "replacing it - e.g. a head turn to camera or a wave while walking. action 'add' creates the layered rig, keys " +
      "the legs to FK so the layer passes the clip through (verified against the clip on sampled frames); then use " +
      "pose_look_at / pose_reach / pose_palm / pose_set_controls on the same binding (their values become offsets). " +
      "'zero' keys zero offsets (= the clip) at frames to BOUND an edit (a lone key holds across the whole clip). " +
      "'check' reports per body region how far the layer moves bones from the clip; `keep` regions must stay on it.",
    {
      sequence: z.string(),
      binding: z.string().describe("Character binding playing a clip (no absolute Control Rig track)."),
      action: z.enum(["add", "zero", "check"]),
      rig: z.string().optional().describe(`Control Rig Blueprint for 'add'. Default ${DEFAULT_RIG}.`),
      frames: z.array(z.number().int()).min(1).max(40).optional().describe("'zero': frames to key; 'add'/'check': frames to compare (default 5 across the playback range)."),
      controls: z.array(z.string()).optional().describe("'zero': only these controls (default every transform control keyed on the layer)."),
      keep: z.array(z.enum(["legs", "spine", "head", "arm_l", "arm_r"])).optional().describe("'check': regions that must stay on the clip (default ['legs'])."),
      toleranceCm: z.number().optional().describe(`Default ${LAYER_TOL_CM} cm.`),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const tol = a.toleranceCm ?? LAYER_TOL_CM;
      const base = { s: a.sequence, b: a.binding };
      let frames = a.action === "zero" ? (a.frames ?? []) : a.frames;
      if (!frames || !frames.length) {
        if (a.action === "zero") return text("Error: 'zero' needs frames.", true);
        const rg = await run("layer_range(P['s'])", base);
        if (!rg.ok) return text(`Error: ${rg.error}`, true);
        const s0 = rg.start as number, e0 = Math.max(s0, (rg.end as number) - 1);
        frames = [0, 1, 2, 3, 4].map((k) => Math.round(s0 + ((e0 - s0) * k) / 4));
        frames = [...new Set(frames)];
      }
      const lines: string[] = [];
      if (a.action === "add") {
        const r = await run("add_layer(P['s'], P['b'], P['rig'], P['f'])", { ...base, rig: a.rig ?? DEFAULT_RIG, f: frames[0] });
        if (!r.ok) return text(`Error: ${r.error}`, true);
        const pt = await run("layer_passthrough(P['s'], P['b'], P['f'])", { ...base, f: frames[0] });
        if (!pt.ok) return text(`Error keying the pass-through: ${pt.error}`, true);
        const missing = (pt.fk as string[]).filter((c) => !(pt.keyed as string[]).includes(c));
        lines.push(`${r.created ? "Added" : "Found"} layered ${r.rig} on '${a.binding}' (${r.controls} controls); legs keyed to FK at f${frames[0]}: ` +
          `${(pt.keyed as string[]).join(", ") || "none"}${missing.length ? ` - NOT KEYED: ${missing.join(", ")}` : ""}.`);
      } else if (a.action === "zero") {
        const r = await run("layer_zero(P['s'], P['b'], P['f'], P['c'])", { ...base, f: frames, c: a.controls ?? null });
        if (!r.ok) return text(`Error: ${r.error}`, true);
        lines.push(`Zero offsets keyed at f${frames.join(", f")} on ${(r.controls as string[]).length} control(s): ${(r.controls as string[]).slice(0, 10).join(", ")}${(r.controls as string[]).length > 10 ? ", ..." : ""}.`);
      }
      const diffs = await compare(a.sequence, a.binding, frames);
      if (typeof diffs === "string") return text(`${lines.join("\n")}\nComparison failed: ${diffs}`, true);
      // 'add' and full 'zero': the whole body must match the clip; 'check' / partial zero: only the kept regions.
      const keep = a.action === "check" || (a.action === "zero" && a.controls) ? (a.keep ?? ["legs"]) : REGIONS;
      const worst = Math.max(...diffs.flatMap((d) => keep.filter((r) => d[r]).map((r) => d[r].cm)));
      const changed = editedRegions(diffs, tol);
      const ok = worst <= tol;
      const scope = keep === REGIONS ? "whole body" : keep.join(", ");
      lines.push(
        `${ok ? "Verified" : "OFF THE CLIP:"} ${scope} vs the clip (layer muted) on ${frames.length} frame(s): worst ${worst.toFixed(3)} cm (tol ${tol}).` +
          ` Regions the layer moves: ${changed.join(", ") || "none"}.`,
        ...describe(frames, diffs),
      );
      return text(lines.join("\n"), !ok);
    },
  );
}
