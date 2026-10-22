import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): subsequences (Tools/python/ue_subseq.py). SEQ_Constrain placed in SEQ_Parent at
// 50: the walker in the parent at f75 / f90 sat exactly where the child alone puts it at f25 / f40, and before 50 it is
// not spawned. Child bindings are resolved by focusing the sub-section (they are not in the level actor list).

const LIBS = ["ue_posing.py", "ue_subseq.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}
const scrub = async (s: string, f: number) => { await run("scrub(P['s'], P['f'])", { s, f }); await run("scrub(P['s'], P['f'])", { s, f }); };

export function registerSeqSubsequenceTools(server: McpServer): void {
  server.tool(
    "seq_subsequence",
    "Put a child level sequence inside a parent (Subsequences track) starting at `start` - e.g. a character's action " +
      "sequence dropped into a scene sequence, or layering several. VERIFIED with a child `binding`: at two parent frames " +
      "inside the section its actor matches the child played alone at (frame - start), and before `start` it is absent.",
    {
      parent: z.string().describe("Parent sequence (created if missing)."),
      child: z.string(),
      start: z.number().int(),
      binding: z.string().optional().describe("A child actor binding to verify the time mapping with (recommended)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("sub_add(P['p'], P['c'], P['s'])", { p: a.parent, c: a.child, s: a.start });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`${a.child.split("/").pop()} placed in ${a.parent.split("/").pop()} at ${JSON.stringify(r.range)} (child ${r.child_length} frames; parent end ${r.parent_end}).`];
      if (!a.binding) return text(lines.join("\n"));
      let bad = 0;
      const n = r.child_length as number;
      for (const local of [Math.floor(n / 3), Math.floor((2 * n) / 3)]) {
        await scrub(a.parent, a.start + local);
        const ip = await run("sub_actor(P['p'], P['c'], P['b'])", { p: a.parent, c: a.child, b: a.binding });
        await scrub(a.child, local);
        const cp = await run("child_actor(P['c'], P['b'])", { c: a.child, b: a.binding });
        if (!ip.ok || !cp.ok) return text(`Error: ${ip.error ?? cp.error}`, true);
        const d = ip.p ? Math.hypot(...(ip.p as number[]).map((v, i) => v - (cp.p as number[])[i])) : Infinity;
        if (!(d <= 0.5)) bad++;
        lines.push(`  parent f${a.start + local} vs child f${local}: '${a.binding}' ${ip.p ? `differs by ${d.toFixed(3)} cm` : "NOT SPAWNED"}${d <= 0.5 ? "" : "  <- MAPPING WRONG"}`);
      }
      if (a.start > 0) {
        await scrub(a.parent, a.start - 1);
        const pre = await run("sub_actor(P['p'], P['c'], P['b'])", { p: a.parent, c: a.child, b: a.binding });
        const absent = pre.ok && !pre.p;
        if (!absent) bad++;
        lines.push(`  parent f${a.start - 1} (before the section): '${a.binding}' ${absent ? "absent, as expected" : "PRESENT"}`);
      }
      return text([bad ? "SUBSEQUENCE CHECK FAILED:" : "Subsequence placed and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
