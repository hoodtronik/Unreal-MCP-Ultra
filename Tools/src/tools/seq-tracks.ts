import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { decodePng, imageStats } from "../png.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Sequencer utility tracks (Tools/python/ue_seqtracks.py). Live on a copy of
// build 21: fade keys 0 -> 1 over 20 frames rendered (camera-cut MRQ) luma 157.8 / 110.8 / 94.8 / 55.6 / 0.0 at f0-20
// - but the multi-camera stills path (render_all_cameras) ignores fades. Muting = section inactive (tracks have no
// scriptable mute): the cup's muted transform stopped it moving (262 cm -> 0). Marked frames read back.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_seqtracks.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Fade value at frame f from [frame, value] keys (linear between keys, held outside). Exported for tests. */
export function fadeAt(keys: number[][], f: number): number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (f <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (f <= k[i][0]) return k[i - 1][1] + ((k[i][1] - k[i - 1][1]) * (f - k[i - 1][0])) / (k[i][0] - k[i - 1][0]);
  return k[k.length - 1][1];
}

export function registerSeqTracksTools(server: McpServer): void {
  server.tool(
    "seq_tracks",
    "Sequencer utility tracks: FADE (keys [[frame, 0..1]], 1 = black; renderCheck renders the camera cut and checks " +
      "brightness falls where the fade rises), MARKED FRAMES ([{frame, label}]), and per-binding track state: mute " +
      "(section inactive), lock, rename, colour for a track kind (transform | animation | controlrig | class name). " +
      "All read back; mute also checks the bound actor stopped moving when its transform is muted.",
    {
      sequence: z.string(),
      fade: z.array(z.tuple([z.number().int(), z.number()])).optional(),
      renderCheck: z.boolean().optional().describe("Render the fade's frame range (camera cut, 320x180) and check brightness."),
      marks: z.array(z.object({ frame: z.number().int(), label: z.string() }).strict()).optional(),
      clearMarks: z.boolean().optional(),
      track: z.object({ binding: z.string(), kind: z.string(), mute: z.boolean().optional(), lock: z.boolean().optional(),
        name: z.string().optional(), color: z.array(z.number()).length(3).optional() }).strict().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const lines: string[] = [];
      let bad = 0;
      if (a.fade) {
        const r = await run("fade(P['s'], P['k'])", { s: a.sequence, k: a.fade });
        if (!r.ok) return text(`Fade failed: ${r.error}`, true);
        lines.push(`Fade keys read back: ${JSON.stringify(r.keys)}`);
        if (a.renderCheck) {
          const f0 = Math.min(...a.fade.map((k) => k[0])), f1 = Math.max(...a.fade.map((k) => k[0]));
          const st = await run("render_passes_start(P['s'], ['lit'], None, 320, 180, P['a'], P['b'], 'png')", { s: a.sequence, a: f0, b: f1 + 1 });
          if (!st.ok) return text(`Render failed: ${st.error}`, true);
          for (let i = 0; i < 300; i++) {
            await new Promise((res) => setTimeout(res, 2000));
            const s2 = await run("render_passes_status(P['o'], P['p'])", { o: st.out_dir, p: st.prefix });
            if (s2.ok && !s2.rendering && s2.files > 0) break;
          }
          const files = readdirSync(st.out_dir as string).filter((f) => f.startsWith(`${st.prefix}.`) && f.endsWith(".png")).sort();
          const lum: [number, number][] = files.map((f) => [parseInt(f.split(".").slice(-2)[0], 10), imageStats(decodePng(readFileSync(`${st.out_dir}/${f}`))).mean]);
          const open = lum.filter(([f]) => fadeAt(a.fade!, f) <= 0.01).map(([, l]) => l);
          const base = open.length ? Math.max(...open) : Math.max(...lum.map(([, l]) => l));
          let worst = 0;
          for (const [f, l] of lum) {
            const v = fadeAt(a.fade!, f);
            if (v >= 0.99 && l > 3) { bad++; worst = Math.max(worst, l); }
          }
          const sample = lum.filter((_, i) => i % Math.max(1, Math.floor(lum.length / 6)) === 0).map(([f, l]) => `f${f} ${l.toFixed(1)} (fade ${fadeAt(a.fade!, f).toFixed(2)})`);
          lines.push(`Rendered ${lum.length} frame(s): ${sample.join(", ")}; unfaded ${base.toFixed(1)}${worst ? `  <- NOT BLACK at full fade (${worst.toFixed(1)})` : ""}`);
        }
      }
      if (a.marks || a.clearMarks) {
        const r = await run("marks(P['s'], P['m'], P['c'])", { s: a.sequence, m: a.marks ?? [], c: a.clearMarks ?? false });
        if (!r.ok) return text(`Marks failed: ${r.error}`, true);
        const got = r.marks as { frame: number; label: string }[];
        const missing = (a.marks ?? []).filter((m) => !got.some((g) => g.label === m.label && Math.abs(g.frame / (r.tick_per_frame as number) - m.frame) < 0.5));
        if (missing.length) bad++;
        lines.push(`Marked frames: ${got.map((g) => `${g.label}@${g.frame / (r.tick_per_frame as number)}`).join(", ")}${missing.length ? `  <- MISSING ${missing.map((m) => m.label).join(", ")}` : ""}`);
      }
      if (a.track) {
        const t = a.track;
        const before = t.mute && t.kind === "transform" ? [await run("actor_pos(P['s'], P['b'])", { s: a.sequence, b: t.binding })] : [];
        const r = await run("track_set(P['s'], P['b'], P['k'], P['a'], P['l'], P['n'], P['c'])", { s: a.sequence, b: t.binding, k: t.kind,
          a: t.mute === undefined ? null : !t.mute, l: t.lock ?? null, n: t.name ?? null, c: t.color ?? null });
        if (!r.ok) return text(`Track change failed: ${r.error}`, true);
        for (const tr of r.tracks as any[]) {
          const okMute = t.mute === undefined || tr.active.every((x: boolean) => x === !t.mute);
          const okLock = t.lock === undefined || tr.locked.every((x: boolean) => x === t.lock);
          if (!okMute || !okLock) bad++;
          lines.push(`Track ${tr.track} '${tr.name}': active ${tr.active}, locked ${tr.locked}${okMute && okLock ? "" : "  <- NOT APPLIED"}`);
        }
        if (before.length) {
          // a muted transform must stop the actor moving: sample two frames 20 apart
          await run("scrub(P['s'], 10)", { s: a.sequence }); await run("scrub(P['s'], 10)", { s: a.sequence });
          const p1 = await run("actor_pos(P['s'], P['b'], 30)", { s: a.sequence, b: t.binding });
          const p2 = await run("actor_pos(P['s'], P['b'])", { s: a.sequence, b: t.binding });
          const d = Math.hypot(...(p1.p as number[]).map((v, i) => v - (p2.p as number[])[i]));
          if (d > 0.5) bad++;
          lines.push(`Muted transform: '${t.binding}' moved ${d.toFixed(2)} cm between f10 and f30${d > 0.5 ? "  <- STILL MOVING" : " (stopped)"}`);
        }
      }
      return text([bad ? "TRACK CHECK FAILED:" : "Tracks set and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
