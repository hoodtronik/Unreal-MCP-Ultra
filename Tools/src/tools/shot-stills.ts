import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { decodePng, imageStats, lumaDiff, type Image } from "../png.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): multi-camera stills (Tools/python/ue_stills.py): one MRQ job per frame with
// render_all_cameras, so EVERY camera in the sequence renders, not only the camera cut. Single-frame jobs need warm-up
// and no motion blur (the look-at camera's first still was smeared). Files carry the PIE camera actor names
// (CineCameraActor_20...); they are mapped back to binding names in template order (reported as such). The config
// can be saved as an MRQ preset asset (resolution / passes / cameras / format; no frame range) and reused.

const LIBS = ["ue_posing.py", "ue_stills.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Group "<prefix>.<camera>.<frame>.png" names: camera -> frame -> file. Cameras sorted by numeric suffix. Exported for tests. */
export function groupStills(files: string[], prefix: string): { cameras: string[]; byCam: Record<string, Record<number, string>> } {
  const byCam: Record<string, Record<number, string>> = {};
  for (const f of files) {
    if (!f.startsWith(prefix + ".") || !f.endsWith(".png")) continue;
    const parts = f.slice(prefix.length + 1, -4).split(".");
    if (parts.length < 2) continue;
    const frame = parseInt(parts[parts.length - 1], 10);
    const cam = parts.slice(0, -1).join(".");
    (byCam[cam] ??= {})[frame] = f;
  }
  const num = (s: string) => { const m = s.match(/_(\d+)$/); return m ? parseInt(m[1], 10) : 0; };
  return { cameras: Object.keys(byCam).sort((a, b) => num(a) - num(b)), byCam };
}

export function registerShotStillsTools(server: McpServer): void {
  server.tool(
    "shot_stills",
    "STILLS FROM EVERY CAMERA in a sequence at chosen frames (storyboard angles, reference frames for AI video) via " +
      "Movie Render Queue - not only the active camera cut. Warm-up frames and no motion blur so single frames are " +
      "clean. savePreset stores the render config (resolution, passes, all-cameras, PNG) as an MRQ preset asset; preset " +
      "renders with a saved one. VERIFIED from the files: every camera x frame present at the expected size, not blank, " +
      "and different cameras really differ.",
    {
      sequence: z.string(),
      frames: z.array(z.number().int()).min(1).max(20),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      preset: z.string().optional().describe("MRQ config preset asset to render with."),
      savePreset: z.string().optional().describe("Save this render's config as a preset asset at this path."),
      timeoutSec: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      let want: number[] | null = null;
      if (a.preset) {
        const pi = await run("preset_info(P['p'])", { p: a.preset });
        if (!pi.ok) return text(`Error reading preset: ${pi.error}`, true);
        want = pi.resolution as number[];
      }
      const st = await run("stills_start(P['s'], P['f'], P['w'], P['h'], None, P['pr'], P['sp'])", {
        s: a.sequence, f: a.frames, w: a.width ?? 1280, h: a.height ?? 720, pr: a.preset ?? null, sp: a.savePreset ?? null });
      if (!st.ok) return text(`Error: ${st.error}`, true);
      want ??= [a.width ?? 1280, a.height ?? 720];
      const deadline = Date.now() + (a.timeoutSec ?? 900) * 1000;
      let s2: PoseResult = { ok: false };
      let saw = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        s2 = await run("stills_status(P['o'], P['p'])", { o: st.out_dir, p: st.prefix });
        if (!s2.ok) return text(`Error: ${s2.error}`, true);
        if (s2.rendering) saw = true;
        if (!s2.rendering && (saw || (s2.files as string[]).length > 0) && (s2.files as string[]).length > 0) break;
      }
      const g = groupStills(s2.files as string[], st.prefix as string);
      const names = st.cameras as string[];
      const label = (c: string, i: number) => (names[i] ? `${names[i]} (${c}, by spawn order)` : c);
      const lines = [`Rendered ${g.cameras.length} camera(s) x ${a.frames.length} frame(s) to ${st.out_dir}${st.preset_saved ? `; preset saved: ${st.preset_saved}` : ""}${a.preset ? `; preset used: ${a.preset}` : ""}.`];
      let bad = 0;
      if (names.length && g.cameras.length !== names.length) { bad++; lines.push(`  ${names.length} camera binding(s) but ${g.cameras.length} rendered  <- MISSING CAMERAS`); }
      for (const fr of a.frames) {
        const imgs: (Image | null)[] = [];
        const row: string[] = [];
        g.cameras.forEach((c, i) => {
          const f = g.byCam[c][fr];
          if (!f) { bad++; row.push(`${label(c, i)} MISSING`); imgs.push(null); return; }
          const img = decodePng(readFileSync(`${st.out_dir}/${f}`));
          const s = imageStats(img);
          const sizeOk = img.width === want![0] && img.height === want![1];
          const blank = s.std < 2;
          if (!sizeOk || blank) bad++;
          row.push(`${label(c, i)} ${img.width}x${img.height} mean ${s.mean} std ${s.std}${sizeOk ? "" : "  <- WRONG SIZE"}${blank ? "  <- BLANK" : ""}`);
          imgs.push(img);
        });
        let minDiff = Infinity;
        for (let i = 0; i < imgs.length; i++) for (let j = i + 1; j < imgs.length; j++) if (imgs[i] && imgs[j]) minDiff = Math.min(minDiff, lumaDiff(imgs[i]!, imgs[j]!));
        if (imgs.length > 1 && minDiff < 1) bad++;
        lines.push(`  f${fr}: ${row.join("; ")}${imgs.length > 1 ? `; closest pair differs by ${minDiff.toFixed(1)} luma${minDiff < 1 ? "  <- CAMERAS IDENTICAL" : ""}` : ""}`);
      }
      return text([bad ? "STILLS CHECK FAILED:" : "Stills rendered and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
