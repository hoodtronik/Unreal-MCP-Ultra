import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live): build 22 passed every numeric check but the render showed a background statue
// standing right behind the hero. This projects each figure's bones (or bounds) through the shot camera's LIVE
// transform and reports screen overlaps with the subject and who is in front (Tools/python/ue_shot.py screen_boxes).

const LIBS = ["ue_posing.py", "ue_shot.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export type Box = { u: number[]; v: number[]; dist: number };
/** Fraction of box b's on-screen area (clipped to the frame) covered by box a. Exported for tests. */
export function overlapOf(a: Box, b: Box): number {
  const clip = (r: number[]) => [Math.max(-1, r[0]), Math.min(1, r[1])];
  const [bu, bv] = [clip(b.u), clip(b.v)];
  const area = Math.max(0, bu[1] - bu[0]) * Math.max(0, bv[1] - bv[0]);
  if (area <= 0) return 0;
  const iu = Math.max(0, Math.min(a.u[1], bu[1]) - Math.max(a.u[0], bu[0]));
  const iv = Math.max(0, Math.min(a.v[1], bv[1]) - Math.max(a.v[0], bv[0]));
  return (iu * iv) / area;
}

export function registerShotSightlineTools(server: McpServer): void {
  server.tool(
    "shot_sightlines",
    "SIGHTLINE check for a shot: at each frame, project the subject and other figures/props through the sequence " +
      "camera and report screen overlaps - a figure IN FRONT covering the subject (blocked shot, fails) or a background " +
      "figure hidden BEHIND the subject (staging warning: move it). Uses the camera's live transform (look-at constraints included).",
    {
      sequence: z.string(),
      camera: z.string(),
      subject: z.string(),
      others: z.array(z.string()).min(1).max(20).describe("Bindings or level actor labels to check against the subject."),
      frames: z.array(z.number().int()).min(1).max(20),
      threshold: z.number().optional().describe("Overlap fraction (of the other's on-screen box) to report (default 0.25)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const thr = a.threshold ?? 0.25;
      const lines: string[] = [];
      let blocked = 0, hidden = 0;
      for (const f of a.frames) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f }); await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const r = await run("screen_boxes(P['s'], P['c'], P['n'])", { s: a.sequence, c: a.camera, n: [a.subject, ...a.others] });
        if (!r.ok) return text(`Error at f${f}: ${r.error}`, true);
        const bx = r.boxes as Record<string, any>;
        const sb = bx[a.subject];
        if (!sb || sb.missing || sb.behind_camera) { lines.push(`  f${f}: subject not visible (${JSON.stringify(sb)})`); continue; }
        const notes: string[] = [];
        for (const o of a.others) {
          const ob = bx[o];
          if (!ob || ob.missing || ob.behind_camera) continue;
          // CLAUDE-NOTE (live): a table beside the hero (336 vs 318 cm median distance) is neither in front nor behind -
          // within 30 cm of the subject's depth an overlap is reported as "beside", not flagged
          if (Math.abs(ob.dist - sb.dist) < 30) {
            const cov = Math.max(overlapOf(ob, sb), overlapOf(sb, ob));
            if (cov >= thr) notes.push(`${o} beside the subject (same depth), ${(100 * cov).toFixed(0)}% overlap`);
          } else if (ob.dist < sb.dist) {
            const cov = overlapOf(ob, sb);
            if (cov >= thr) { blocked++; notes.push(`${o} IN FRONT covers ${(100 * cov).toFixed(0)}% of the subject  <- BLOCKED`); }
          } else {
            const cov = overlapOf(sb, ob);
            if (cov >= thr) { hidden++; notes.push(`${o} behind, ${(100 * cov).toFixed(0)}% of it hidden by the subject  <- move it`); }
          }
        }
        lines.push(`  f${f}: ${notes.length ? notes.join("; ") : "clear"}`);
      }
      const head = blocked ? `SIGHTLINES BLOCKED (${blocked}):` : hidden ? `Sightlines: subject clear, ${hidden} background overlap(s):` : "Sightlines clear:";
      return text([head, ...lines].join("\n"), blocked > 0);
    },
  );
}
