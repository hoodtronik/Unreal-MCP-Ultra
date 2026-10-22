import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22): motion trails (Tools/python/ue_trail.py). The editor's own motion-trail display is a
// viewport overlay that captures and renders do not see and that nothing can measure, so the trail is SAMPLED (one
// scrub per frame - bones update between calls) and reported as numbers (path length, speeds, pops = a frame step far
// above the median), and optionally DRAWN as tinted marker spheres in the level (folder MCP_Trails) so it shows in
// captures. Remove them with action 'clear' before final renders.

const LIBS = ["ue_posing.py", "ue_trail.py"];
const vec3 = z.array(z.number()).length(3);

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export type TrailStats = { length: number; maxStep: number; medianStep: number; pops: number[]; peakSpeed: number; meanSpeed: number };

/** Path statistics of per-frame points; a pop is a step > popRatio x the median step (and > 1 cm). Exported for tests. */
export function trailStats(points: number[][], frames: number[], fps: number, popRatio = 4): TrailStats {
  const steps = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1], p[2] - points[i][2]));
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const pops = steps.map((s, i) => (s > Math.max(1, popRatio * median) ? frames[i + 1] : -1)).filter((f) => f >= 0);
  const length = steps.reduce((a, b) => a + b, 0);
  const maxStep = Math.max(0, ...steps);
  return { length: +length.toFixed(2), maxStep: +maxStep.toFixed(2), medianStep: +median.toFixed(3), pops,
    peakSpeed: +(maxStep * fps).toFixed(1), meanSpeed: +((length / Math.max(1, steps.length)) * fps).toFixed(1) };
}

export function registerPoseTrailTools(server: McpServer): void {
  server.tool(
    "pose_trail",
    "MOTION TRAIL of a character's bone over a frame range: samples the world path frame by frame and reports path " +
      "length, mean / peak speed and POPS (frames where the step is far above the median - a snapping key). With draw " +
      "it leaves tinted marker spheres along the path in the level (folder MCP_Trails) so the trail shows in captures; " +
      "'clear' removes them.",
    {
      action: z.enum(["trail", "clear"]).optional(),
      sequence: z.string().optional(),
      binding: z.string().optional(),
      bone: z.string().optional().describe("Bone or role, e.g. hand_r, head, pelvis."),
      frames: z.array(z.number().int()).length(2).optional().describe("[start, end] inclusive."),
      every: z.number().int().min(1).optional().describe("Sample every n frames (default 1)."),
      draw: z.boolean().optional(),
      color: vec3.optional(), radius: z.number().optional(),
      name: z.string().optional().describe("Trail name (marker label prefix). Default <binding>_<bone>."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.action === "clear") {
        const r = await run("trail_clear(P['n'])", { n: a.name ?? null });
        return r.ok ? text(`Removed ${r.removed} trail marker(s).`) : text(`Error: ${r.error}`, true);
      }
      if (!a.sequence || !a.binding || !a.bone || !a.frames) return text("Error: trail needs sequence, binding, bone and frames.", true);
      const step = a.every ?? 1;
      const frames: number[] = [];
      for (let f = a.frames[0]; f <= a.frames[1]; f += step) frames.push(f);
      const fr = await run("{'ok': True, 'fps': load_sequence(P['s']).get_display_rate().numerator / load_sequence(P['s']).get_display_rate().denominator}", { s: a.sequence });
      if (!fr.ok) return text(`Error: ${fr.error}`, true);
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: frames[0] });
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: frames[0] });
      const pts: number[][] = [];
      let real = a.bone;
      for (let i = 0; i < frames.length; i++) {
        const r = await run("trail_point(P['s'], P['b'], P['bone'], P['nx'])", { s: a.sequence, b: a.binding, bone: a.bone, nx: i + 1 < frames.length ? frames[i + 1] : null });
        if (!r.ok) return text(`Error at f${frames[i]}: ${r.error}`, true);
        if (r.frame !== frames[i]) return text(`Error: read frame ${r.frame} for f${frames[i]}`, true);
        pts.push(r.p as number[]);
        real = r.bone;
      }
      const st = trailStats(pts, frames, (fr.fps as number) / step);
      const lines = [`Trail ${a.binding}.${real} f${a.frames[0]}-${a.frames[1]} (${frames.length} samples): path ${st.length} cm, mean ${st.meanSpeed} cm/s, peak ${st.peakSpeed} cm/s (step ${st.maxStep} cm, median ${st.medianStep}).`,
        st.pops.length ? `  POPS at frame(s) ${st.pops.join(", ")} (step > 4x median)` : "  No pops (no step above 4x the median).",
        `  start ${JSON.stringify(pts[0])} -> end ${JSON.stringify(pts[pts.length - 1])}`];
      if (a.draw) {
        const name = a.name ?? `Trail_${a.binding}_${real}`;
        const d = await run("trail_draw(P['n'], P['p'], P['r'], tuple(P['c']))", { n: name, p: pts, r: a.radius ?? 1.5, c: a.color ?? [1, 0.3, 0.1] });
        if (!d.ok) return text(`${lines.join("\n")}\nError drawing: ${d.error}`, true);
        lines.push(`  Drew ${d.markers} markers '${name}_NNN' (folder MCP_Trails) - pose_trail action 'clear' removes them.`);
      }
      return text(lines.join("\n"));
    },
  );
}
