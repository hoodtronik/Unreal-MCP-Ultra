import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { decodePng, imageStats, lumaDiff } from "../png.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Movie Render Queue with several passes (Tools/python/ue_shot.py
// render_passes_start). Checked from the files: frames per pass, pixel statistics per PNG pass and its difference from
// the lit pass (SEQ_Lights: unlit 49.5 / normal 53.2 / lighting-only 2.5 luma from lit), saturated data passes (8-bit
// depth = 2 colours -> use EXR), EXR layers read from the multilayer header, and the WAV (MoviePipelineWaveOutput)
// measured for where sound starts/stops (master: music to 4.98 s then -180 dB; 1 kHz ping exactly at 1.0 s = f24).

const LIBS = ["ue_posing.py", "ue_shot.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Layer names in a multilayer EXR, from the header's channel list. Exported for tests. */
export function exrLayers(buf: Buffer): string[] {
  if (buf.readUInt32LE(0) !== 20000630) throw new Error("not an EXR");
  let pos = 8;
  const layers = new Set<string>();
  while (pos < buf.length) {
    const nEnd = buf.indexOf(0, pos);
    const name = buf.toString("latin1", pos, nEnd);
    if (!name) break;
    const tEnd = buf.indexOf(0, nEnd + 1);
    const type = buf.toString("latin1", nEnd + 1, tEnd);
    const size = buf.readInt32LE(tEnd + 1);
    const v = tEnd + 5;
    if (type === "chlist") {
      let q = v;
      while (q < v + size && buf[q] !== 0) {
        const e = buf.indexOf(0, q);
        const ch = buf.toString("latin1", q, e);
        layers.add(ch.includes(".") ? ch.slice(0, ch.lastIndexOf(".")) : "(rgba)");
        q = e + 1 + 16;
      }
    }
    pos = v + size;
  }
  return [...layers];
}

/** Sound span of a 16-bit PCM WAV: duration and first/last 50 ms window above -60 dBFS. Exported for tests. */
export function wavSpan(buf: Buffer): { seconds: number; rate: number; channels: number; soundFrom: number | null; soundTo: number | null } {
  let pos = 12, rate = 0, channels = 0, bits = 0, dataPos = -1, dataLen = 0;
  while (pos < buf.length - 8) {
    const id = buf.toString("ascii", pos, pos + 4), len = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    if (id === "data") { dataPos = pos + 8; dataLen = len; break; }
    pos += 8 + len + (len % 2);
  }
  if (dataPos < 0 || bits !== 16) throw new Error("unsupported WAV");
  const frames = Math.floor(dataLen / (2 * channels));
  const win = Math.max(1, Math.floor(rate * 0.05));
  let from: number | null = null, to: number | null = null;
  for (let f = 0; f < frames; f += win) {
    let s = 0, n = 0;
    for (let i = f; i < Math.min(frames, f + win); i++) { const v = buf.readInt16LE(dataPos + i * 2 * channels) / 32768; s += v * v; n++; }
    const db = 20 * Math.log10(Math.sqrt(s / Math.max(1, n)) + 1e-9);
    if (db > -60) { if (from === null) from = f / rate; to = Math.min(frames, f + win) / rate; }
  }
  return { seconds: +(frames / rate).toFixed(3), rate, channels, soundFrom: from === null ? null : +from.toFixed(2), soundTo: to === null ? null : +to.toFixed(2) };
}

export function registerRenderPassTools(server: McpServer): void {
  server.tool(
    "shot_render_passes",
    "Render a sequence through Movie Render Queue with several PASSES and check them from the files: lit, unlit, " +
      "detail_lighting, lighting_only, reflections, path_tracer, and post-process data passes depth / normal / motion; " +
      "format png | exr (EXR is one multilayer file per frame - use it for depth); anti-aliasing sample counts; audio " +
      "(WAV, measured and muxed into an MP4 with the lit pass). Reports frames per pass, pixel stats and how far each " +
      "pass differs from lit, flags saturated passes and missing frames.",
    {
      sequence: z.string(),
      passes: z.array(z.enum(["lit", "unlit", "detail_lighting", "lighting_only", "reflections", "path_tracer", "depth", "normal", "motion"])).min(1),
      format: z.enum(["png", "exr", "jpg"]).optional(),
      width: z.number().int().optional(), height: z.number().int().optional(),
      start: z.number().int().optional(), end: z.number().int().optional().describe("Exclusive end frame."),
      spatialSamples: z.number().int().min(1).optional(), temporalSamples: z.number().int().min(1).optional(),
      warmup: z.number().int().min(0).optional(),
      audio: z.boolean().optional().describe("Also write the sequence audio (WAV) and mux it into the MP4."),
      timeoutSec: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const fmt = a.format ?? "png";
      const st = await run("render_passes_start(P['s'], P['p'], None, P['w'], P['h'], P['st'], P['en'], P['f'], P['sp'], P['tp'], P['wu'], P['au'])", {
        s: a.sequence, p: a.passes, w: a.width ?? 960, h: a.height ?? 540, st: a.start ?? null, en: a.end ?? null, f: fmt,
        sp: a.spatialSamples ?? null, tp: a.temporalSamples ?? null, wu: a.warmup ?? null, au: !!a.audio });
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
      const lines = [`Rendered ${st.prefix} to ${st.out_dir} (${fmt}, ${st.expected_frames} frame(s), passes ${st.passes.join(", ")}).`];
      let bad = 0;
      const files = existsSync(st.out_dir) ? readdirSync(st.out_dir) : [];
      if (fmt === "exr") {
        const exrs = files.filter((f) => f.endsWith(".exr")).sort();
        if (exrs.length < st.expected_frames) { bad++; lines.push(`  MISSING EXR FRAMES: ${exrs.length}/${st.expected_frames}`); }
        if (exrs.length) {
          const layers = exrLayers(readFileSync(join(st.out_dir, exrs[0])));
          lines.push(`  ${exrs.length} multilayer EXR(s); layers: ${layers.join(", ")}`);
          const want = st.passes.filter((p: string) => p !== "lit").map((p: string) => ({ unlit: "Unlit", detail_lighting: "DetailLightingOnly", lighting_only: "LightingOnly", reflections: "ReflectionsOnly", path_tracer: "PathTracer", depth: "WorldDepth", normal: "WorldNormal", motion: "MotionVectors" } as Record<string, string>)[p]);
          const missing = want.filter((w: string) => !layers.some((l) => l.includes(w)));
          if (missing.length) { bad++; lines.push(`  MISSING LAYERS: ${missing.join(", ")}`); }
        }
      } else {
        const ext = `.${fmt}`;
        const lit = groups["FinalImage"];
        const mid = (g: { first: string; last: string }) => {
          const f0 = Number(g.first.split(".").slice(-2)[0]), f1 = Number(g.last.split(".").slice(-2)[0]);
          return Math.floor((f0 + f1) / 2);
        };
        const litImg = lit && fmt === "png" ? decodePng(readFileSync(join(st.out_dir, `${st.prefix}.FinalImage.${String(mid(lit)).padStart(4, "0")}${ext}`))) : null;
        for (const [name, g] of Object.entries(groups)) {
          if (name === "wav" || name === "Audio") continue;
          const short = g.count < st.expected_frames;
          if (short) bad++;
          let extra = "";
          if (fmt === "png") {
            const img = decodePng(readFileSync(join(st.out_dir, `${st.prefix}.${name}.${String(mid(g)).padStart(4, "0")}${ext}`)));
            const s = imageStats(img);
            const d = litImg && name !== "FinalImage" ? lumaDiff(img, litImg) : null;
            extra = ` | mean ${s.mean}, std ${s.std}, clipped ${(s.clipped * 100).toFixed(1)}%${d !== null ? `, differs from lit by ${d}` : ""}`;
            if (s.colours <= 4) { bad++; extra += `  <- SATURATED (${s.colours} colours) - render data passes as EXR`; }
            else if (d !== null && d < 0.5) extra += "  (identical to lit?)";
          }
          lines.push(`  ${name}: ${g.count}/${st.expected_frames} frames${short ? "  <- MISSING FRAMES" : ""}${extra}`);
        }
      }
      const wavName = files.find((f) => f.endsWith(".wav"));
      if (a.audio) {
        if (!wavName) { bad++; lines.push("  NO AUDIO FILE written."); }
        else {
          const w = wavSpan(readFileSync(join(st.out_dir, wavName)));
          lines.push(`  audio ${wavName}: ${w.seconds} s, ${w.rate} Hz x${w.channels}; sound from ${w.soundFrom} s to ${w.soundTo} s`);
          if (w.soundFrom === null) { bad++; lines.push("  AUDIO IS SILENT."); }
        }
      }
      if (fmt === "png" && groups["FinalImage"]) {
        const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
        const fps = `${st.fps[0]}/${st.fps[1]}`;
        const first = Number(groups["FinalImage"].first.split(".").slice(-2)[0]);
        const mp4 = join(st.out_dir, `${st.prefix}.mp4`);
        const args = ["-y", "-loglevel", "error", "-framerate", fps, "-start_number", String(first), "-i", join(st.out_dir, `${st.prefix}.FinalImage.%04d.png`)];
        if (a.audio && wavName) args.push("-i", join(st.out_dir, wavName), "-c:a", "aac", "-b:a", "160k");
        args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4);
        const enc = spawnSync(ffmpeg, args, { encoding: "utf-8" });
        lines.push(enc.error || enc.status !== 0 ? `  MP4 not encoded (${enc.error?.message ?? enc.stderr?.trim()})` : `  MP4: ${mp4}${a.audio && wavName ? " (with audio)" : ""}`);
      }
      return text([`${bad ? `RENDER CHECK FAILED (${bad})` : "Render passes verified"}:`, ...lines].join("\n"), bad > 0);
    },
  );
}
