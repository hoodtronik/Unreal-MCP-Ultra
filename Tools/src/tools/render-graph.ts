import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { decodePng, type Image } from "../png.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Movie Render Graph (Tools/python/ue_mrg.py): globals (resolution - its
// ProfileName must be "Custom" or 1080p wins - and output folder), a beauty render layer and a CLEAN-PLATE render
// layer (collection = IsSpawnable query, modifier = hidden) rendered by MRQ with job.set_graph_preset. Live on
// SEQ_Constrain f25: walker removed (mean diff 172 inside its mask), background unchanged (0.58 mean outside; a bloom
// fringe remains) - ONLY with locked exposure: with auto exposure the plate re-adapted and 43k background pixels
// shifted, which this check reports as an exposure shift.

const LIBS = ["ue_posing.py", "ue_mrg.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Beauty vs clean plate: fraction of pixels that changed (> thr) and the mean change of the REST (background
 * shift; ~0 when exposure is locked). Exported for tests. */
export function plateDiff(a: Image, b: Image, thr = 10): { changed: number; backgroundShift: number } {
  const n = a.width * a.height;
  let ch = 0, rest = 0, restN = 0;
  for (let i = 0; i < n; i++) {
    const ia = i * a.channels, ib = i * b.channels;
    const d = (Math.abs(a.data[ia] - b.data[ib]) + Math.abs(a.data[ia + 1] - b.data[ib + 1]) + Math.abs(a.data[ia + 2] - b.data[ib + 2])) / 3;
    if (d > thr) ch++; else { rest += d; restN++; }
  }
  return { changed: ch / n, backgroundShift: restN ? rest / restN : 0 };
}

export function registerRenderGraphTools(server: McpServer): void {
  server.tool(
    "shot_render_graph",
    "MOVIE RENDER GRAPH: builds a graph config asset (resolution, output folder) with a BEAUTY layer and a CLEAN-PLATE " +
      "layer (everything the sequence spawns - characters, props - hidden by a collection + modifier) and renders the " +
      "sequence through it. Clean plates are for compositing / AI-video backgrounds. VERIFIED per sampled frame: frames " +
      "of both layers exist, something was removed, and the background did not shift (lock the camera's exposure with " +
      "shot_camera exposure - auto exposure re-adapts in the plate).",
    {
      sequence: z.string(),
      graph: z.string().describe("Graph asset path to (re)create, e.g. /Game/Render/MRG_CleanPlate."),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      cleanPlate: z.boolean().optional().describe("Add the clean-plate layer (default true)."),
      samples: z.number().int().min(1).max(20).optional().describe("Frames compared (default 4)."),
      timeoutSec: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const name = a.sequence.split("/").pop()!;
      const b = await run("mrg_build(P['g'], P['w'], P['h'], default_out(P['n']), P['c'])", { g: a.graph, n: name, w: a.width ?? 960, h: a.height ?? 540, c: a.cleanPlate ?? true });
      if (!b.ok) return text(`Error building the graph: ${b.error}`, true);
      const st = await run("mrg_render_start(P['s'], P['g'])", { s: a.sequence, g: a.graph });
      if (!st.ok) return text(`Error: ${st.error}`, true);
      const od = st.out_dir as string;
      const deadline = Date.now() + (a.timeoutSec ?? 900) * 1000;
      let rendering = true;
      while (Date.now() < deadline && rendering) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await run("{'ok': True, 'r': unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem).is_rendering()}", {});
        rendering = !!s.r;
      }
      const lines = [`Graph ${a.graph}: branches ${(b.branches as string[]).join(", ")}.`];
      let files: string[] = [];
      try { files = readdirSync(od).filter((f) => f.endsWith(".png") && f.startsWith(name + ".")); } catch { /* none */ }
      const layer = (f: string) => f.split(".").slice(1, -2).join(".");
      const byLayer: Record<string, string[]> = {};
      for (const f of files) (byLayer[layer(f)] ??= []).push(f);
      lines.push(`Rendered to ${od}: ${Object.entries(byLayer).map(([k, v]) => `${k} ${v.length}`).join(", ") || "NOTHING"}.`);
      let bad = files.length ? 0 : 1;
      const beautyKey = Object.keys(byLayer).find((k) => k.endsWith("DefaultLayer"));
      const plateKey = Object.keys(byLayer).find((k) => k.endsWith("CleanPlate"));
      if ((a.cleanPlate ?? true) && beautyKey && plateKey) {
        const frames = byLayer[beautyKey].map((f) => f.split(".").slice(-2)[0]).sort();
        const n = a.samples ?? 4;
        const pick = Array.from({ length: Math.min(n, frames.length) }, (_, i) => frames[Math.floor(((i + 0.5) * frames.length) / Math.min(n, frames.length))]);
        for (const fr of pick) {
          const bi = decodePng(readFileSync(`${od}/${name}.${beautyKey}.${fr}.png`));
          const pi = decodePng(readFileSync(`${od}/${name}.${plateKey}.${fr}.png`));
          const d = plateDiff(bi, pi);
          const none = d.changed < 0.0005, shift = d.backgroundShift > 1.5;
          if (shift) bad++;
          lines.push(`  f${fr}: ${(100 * d.changed).toFixed(1)}% of pixels removed/changed; background shift ${d.backgroundShift.toFixed(2)} luma${none ? "  (nothing spawned in view)" : ""}${shift ? "  <- EXPOSURE SHIFT: lock the camera exposure" : ""}`);
        }
      } else if (a.cleanPlate ?? true) { bad++; lines.push("Clean-plate or beauty layer missing from the output."); }
      return text([bad ? "RENDER GRAPH CHECK FAILED:" : "Render graph rendered and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
