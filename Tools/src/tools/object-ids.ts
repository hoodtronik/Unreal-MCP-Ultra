import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { decodePng, type Image } from "../png.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): object ID / segmentation pass without the MRQ mask plugin
// (Tools/python/ue_objid.py): Custom Depth Stencil id per binding (set on the spawnable TEMPLATE too - MRQ renders in
// PIE from templates; the first render was all black because only the editor instance had it), a post-process
// material mapping id -> flat palette colour, r.CustomDepth=3 for this render only. Live, SEQ_Constrain f24-26:
// exactly 3 colours in the pass - black, walker red 18249 px, cup green 373 px - aligned with the lit frame.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_objid.py"];

// same table as ue_objid.PALETTE (0..1 -> 0..255)
export const PALETTE: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255],
  [255, 128, 0], [128, 0, 255], [0, 255, 128], [255, 0, 128], [128, 255, 0], [0, 128, 255]];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Pixels per palette id (index+1), background (black) and "other" colours (blending/tonemapping). Exported for tests. */
export function idCounts(img: Image, n: number, tol = 6): { ids: number[]; background: number; other: number } {
  const ids = new Array(n).fill(0);
  let background = 0, other = 0;
  const ch = img.channels;
  for (let i = 0; i < img.width * img.height; i++) {
    const r = img.data[i * ch], g = img.data[i * ch + 1], b = img.data[i * ch + 2];
    if (r <= tol && g <= tol && b <= tol) { background++; continue; }
    let hit = -1;
    for (let k = 0; k < n; k++) {
      const p = PALETTE[k % PALETTE.length];
      if (Math.abs(r - p[0]) <= tol && Math.abs(g - p[1]) <= tol && Math.abs(b - p[2]) <= tol) { hit = k; break; }
    }
    if (hit >= 0) ids[hit]++; else other++;
  }
  return { ids, background, other };
}

export function registerObjectIdTools(server: McpServer): void {
  server.tool(
    "shot_object_ids",
    "OBJECT ID / SEGMENTATION pass for AI-video control: renders the shot through Movie Render Queue with a flat-colour " +
      "mask per listed binding (characters, props) next to the lit frames - id 1 red, 2 green, 3 blue, 4 yellow, 5 " +
      "magenta, 6 cyan, ... on black. Uses custom-depth stencil ids (set on the bindings' spawnable templates) and a " +
      "post-process material; r.CustomDepth=3 only for this render. VERIFIED from the PNGs: pixels per id per frame, " +
      "and no colours outside the palette.",
    {
      sequence: z.string(),
      objects: z.array(z.string()).min(1).max(12).describe("Bindings (or level actor labels) in id order."),
      start: z.number().int().optional(),
      end: z.number().int().optional().describe("Exclusive end frame."),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      material: z.string().optional().describe("ID material path (created if missing; default next to the sequence)."),
      timeoutSec: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const mat = a.material ?? a.sequence.replace(/\/[^/]+$/, "") + "/M_MCP_ObjectId";
      const m = await run("ensure_material(P['m']) and {'ok': True}", { m: mat });
      if (!m.ok) return text(`Error creating the ID material: ${m.error}`, true);
      const ids = await run("assign_ids(P['s'], P['o'])", { s: a.sequence, o: a.objects });
      if (!ids.ok) return text(`Error: ${ids.error}`, true);
      const st = await run("render_ids_start(P['s'], P['m'], P['w'], P['h'], P['st'], P['en'])", {
        s: a.sequence, m: mat, w: a.width ?? 960, h: a.height ?? 540, st: a.start ?? null, en: a.end ?? null });
      if (!st.ok) return text(`Error: ${st.error}`, true);
      const deadline = Date.now() + (a.timeoutSec ?? 900) * 1000;
      let s2: PoseResult = { ok: false };
      let saw = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        s2 = await run("render_passes_status(P['o'], P['p'])", { o: st.out_dir, p: st.prefix });
        if (!s2.ok) return text(`Error: ${s2.error}`, true);
        if (s2.rendering) saw = true;
        if (!s2.rendering && (saw || s2.files > 0) && s2.files > 0) break;
      }
      const groups = s2.groups as Record<string, { count: number; first: string; last: string }>;
      const idKey = Object.keys(groups).find((k) => k.includes("ObjectId"));
      const lines = [`Rendered ${st.prefix} to ${st.out_dir}: ${Object.entries(groups).map(([k, v]) => `${k} ${v.count}`).join(", ")}.`,
        `IDs: ${(ids.ids as any[]).map((x) => `${x.id} ${x.name} rgb(${x.color.map((c: number) => Math.round(c * 255)).join(",")}) [${x.components} comp]`).join("; ")}`];
      if (!idKey) return text([...lines, "NO OBJECT ID PASS WAS WRITTEN"].join("\n"), true);
      const first = parseInt(groups[idKey].first.split(".").slice(-2)[0], 10);
      const n = a.objects.length;
      const seen = new Array(n).fill(0);
      let bad = 0;
      for (let f = first; f < first + groups[idKey].count; f++) {
        const fn = `${st.out_dir}/${st.prefix}.${idKey}.${String(f).padStart(4, "0")}.png`;
        let img: Image;
        try { img = decodePng(readFileSync(fn)); } catch (e) { bad++; lines.push(`  f${f}: unreadable (${(e as Error).message})`); continue; }
        const c = idCounts(img, n);
        const total = img.width * img.height;
        c.ids.forEach((v, i) => { if (v > 0) seen[i]++; });
        const otherPct = (100 * c.other) / total;
        if (otherPct > 0.5) bad++;
        lines.push(`  f${f}: ${c.ids.map((v, i) => `${a.objects[i]} ${v}px`).join(", ")}; background ${(100 * c.background / total).toFixed(1)}%; off-palette ${otherPct.toFixed(2)}%${otherPct > 0.5 ? "  <- NOT FLAT (blended or tonemapped)" : ""}`);
      }
      const never = a.objects.filter((_, i) => seen[i] === 0);
      if (never.length) { bad++; lines.push(`NEVER IN THE MASK: ${never.join(", ")} (off screen, hidden, or the id did not reach the render)`); }
      return text([bad ? "OBJECT ID CHECK FAILED:" : "Object ID pass verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
