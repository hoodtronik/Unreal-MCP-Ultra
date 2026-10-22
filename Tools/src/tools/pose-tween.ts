import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): pose_tween wraps the Control Rig Tween tool (ControlRigSequencerLibrary.
// tween_control_rig, Tools/python/ue_tween.py), which only reports a bool. The tool checks every tweened control
// against prev + (next - prev) * (v + 1) / 2 per channel (the formula measured live) and that it got a key, then
// reads the rendered bones on a separate call (bones refresh between calls).

const LIBS = ["ue_posing.py", "ue_tween.py"];
export const TWEEN_TOL = 0.01; // cm / deg per channel

/** Fraction of the way from the previous key to the next one for a tween value in [-1, 1]. Exported for tests. */
export function tweenFraction(v: number): number {
  return (v + 1) / 2;
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function registerPoseTweenTools(server: McpServer): void {
  server.tool(
    "pose_tween",
    "Key a BREAKDOWN (in-between) pose at `frame` with the Control Rig Tween tool: each control is blended between " +
      "its previous and next key. value -1 = previous pose, 0 = halfway, 1 = next pose (0.5 = 75% of the way, " +
      "favouring the next pose). Default: every control keyed on both sides of the frame. VERIFIED per control " +
      "against the blend formula and that a key was set; reports where the hands/head end up.",
    {
      sequence: z.string(),
      binding: z.string(),
      frame: z.number().int(),
      value: z.number().min(-1).max(1),
      controls: z.array(z.string()).optional().describe("Only these controls (default: all keyed before and after frame)."),
      bones: z.array(z.string()).optional().describe("Bones/roles to report (default pelvis, head, hands)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("tween(P['s'], P['b'], P['f'], P['v'], P['c'])", {
        s: a.sequence, b: a.binding, f: a.frame, v: a.value, c: a.controls ?? null,
      });
      if (!r.ok) return text(`Error: ${r.error ?? "tween_control_rig returned False"}`, true);
      const ctl = r.controls as Record<string, { prev: number; next: number; err: number; span: number }>;
      const n = Object.keys(ctl).length;
      const bad = Object.entries(ctl).filter(([, c]) => c.err > TWEEN_TOL);
      const ok = bad.length === 0 && r.keyed === r.changing;
      const lines = [
        `Tween ${a.value} at frame ${a.frame} (${Math.round(r.t * 1000) / 10}% of the way prev -> next): ${n} control(s), ${r.changing} with different neighbour poses; ${r.keyed}/${r.changing} of those keyed (unchanged ones need no key).`,
        `${bad.length ? "MISMATCH" : "Verified"}: worst ${r.worst} vs prev + (next - prev) * t${bad.length ? ` - ${bad.slice(0, 6).map(([k, c]) => `${k} ${c.err}`).join(", ")}` : ""}.`,
      ];
      if (r.skipped) lines.push(`Skipped ${r.skipped} control(s) without keys on both sides (or bool/int): ${(r.skipped_names as string[]).join(", ")}${r.skipped > 12 ? ", ..." : ""}.`);
      const spans = Object.entries(ctl).filter(([, c]) => c.span > 1e-3).slice(0, 8);
      if (spans.length) lines.push(`Changing: ${spans.map(([k, c]) => `${k} (${c.prev}->${c.next})`).join(", ")}.`);
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frame });
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frame });
      const bn = await run("bones_now(P['s'], P['b'], P['n'])", { s: a.sequence, b: a.binding, n: a.bones ?? ["pelvis", "head", "hand_l", "hand_r"] });
      if (bn.ok) for (const [k, v] of Object.entries(bn.bones as Record<string, number[] | null>)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
      return text(lines.join("\n"), !ok);
    },
  );
}
