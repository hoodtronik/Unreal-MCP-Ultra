import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): shot assembly (Tools/python/ue_master.py). A master LevelSequence with a
// Cinematic Shots track holds each shot sequence as a section; `offset` trims a shot's head (stored as ticks:
// 6 frames = 6000 at a 24000 tick rate). The check opens the master, locks the viewport to its cuts, scrubs each
// frame and compares the viewport camera with the camera that frame's SHOT selects at its LOCAL frame
// (local = master - section start + shot start + offset). Live: 5/5 frames exact across 3 shots and 2 cuts per shot;
// a walker in the trimmed shot sat at local frame 18 at master 60 (y -75 cm, untrimmed would be -150).

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_master.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}
const short = (p: string) => (p || "").split(".")[0].split("/").pop();

export type ShotSec = { sequence: string; start: number; end: number; offset: number };

/** Which shot plays at a master frame and the shot's local frame. offsetFrames = section offset in display frames.
 * Exported for tests. */
export function shotAt(shots: (ShotSec & { shotStart?: number })[], frame: number, ticksPerFrame = 1000) {
  const s = shots.find((x) => x.start <= frame && frame < x.end);
  if (!s) return null;
  return { sequence: s.sequence, local: frame - s.start + (s.shotStart ?? 0) + Math.round(s.offset / ticksPerFrame) };
}

function describe(m: any): string[] {
  const lines = [`${short(m.master)}: ${m.fps} fps, frames ${m.start}-${m.end}`];
  for (const s of m.shots) lines.push(`  shot ${s.shot || short(s.sequence)}: ${short(s.sequence)} [${s.start}-${s.end})${s.offset ? ` head trim ${s.offset} ticks` : ""}`);
  for (const a of m.audio) lines.push(`  audio ${a.track}: ${short(a.sound)} [${a.start}-${a.end}) ${a.duration_s} s${a.volume != null ? ` vol ${a.volume}` : ""}`);
  return lines;
}

const shotIn = z.object({
  sequence: z.string().describe("Shot LevelSequence path."),
  name: z.string().optional().describe("Shot name, e.g. sh010."),
  start: z.number().int().optional().describe("Master frame (default: right after the previous shot)."),
  length: z.number().int().optional().describe("Frames (default the shot's playback range)."),
  offset: z.number().int().optional().describe("Trim this many frames off the shot's head."),
}).strict();

export function registerMasterTools(server: McpServer): void {
  server.tool(
    "seq_master",
    "Assemble shots on a MASTER sequence (Cinematic Shots track) and verify the cut: 'build' lays shot sequences end " +
      "to end (or at `start`), with length / head-trim `offset`, and sets the master range; 'read' lists shots and audio; " +
      "'check' scrubs master frames with the viewport locked to the cuts and verifies the viewport is looking through " +
      "the camera each shot's own camera-cut track selects at the mapped local frame (default: the middle of each shot).",
    {
      action: z.enum(["build", "read", "check"]),
      master: z.string().describe("Master sequence path (created on build)."),
      shots: z.array(shotIn).optional(),
      fps: z.number().int().optional(),
      frames: z.array(z.number().int()).optional().describe("check: master frames."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.action === "build") {
        if (!a.shots?.length) return text("Error: build needs shots.", true);
        const r = await run("master_build(P['m'], P['s'], P['f'])", { m: a.master, s: a.shots, f: a.fps ?? 24 });
        if (!r.ok) return text(`Error: ${r.error}`, true);
        const bad: string[] = [];
        if (r.shots.length !== a.shots.length) bad.push(`${r.shots.length} shot sections, asked ${a.shots.length}`);
        r.shots.forEach((s: any, i: number) => {
          const want = a.shots![i];
          if (short(s.sequence) !== short(want.sequence)) bad.push(`shot ${i} is ${short(s.sequence)}`);
          if (want.length && s.end - s.start !== want.length) bad.push(`shot ${i} length ${s.end - s.start}`);
          if (i > 0 && want.start === undefined && s.start !== r.shots[i - 1].end) bad.push(`gap/overlap before shot ${i}`);
        });
        return text([`${bad.length ? "MISMATCH: " + bad.join("; ") : "Built and verified"} (saved).`, ...describe(r)].join("\n"), bad.length > 0);
      }
      const info = await run("master_info(P['m'])", { m: a.master });
      if (!info.ok) return text(`Error: ${info.error}`, true);
      if (a.action === "read") return text(describe(info).join("\n"));
      const frames = a.frames ?? info.shots.map((s: any) => Math.floor((s.start + s.end) / 2));
      const lines = describe(info);
      let bad = 0;
      for (const f of frames) {
        await run("master_view(P['m'], P['f'])", { m: a.master, f });
        await run("master_view(P['m'], P['f'])", { m: a.master, f });
        const c = await run("master_cam_at(P['m'], P['f'])", { m: a.master, f });
        if (!c.ok) return text(`Error: ${c.error}`, true);
        if (!c.shot) { lines.push(`  f${f}: no shot`); bad++; continue; }
        if (!c.camera) { lines.push(`  f${f}: ${short(c.shot)} local ${c.local_frame}: the shot has no camera cut there`); bad++; continue; }
        const d = Math.hypot(...c.viewport.map((v: number, i: number) => v - c.camera_location[i]));
        const dy = Math.abs(((c.viewport_yaw - c.camera_yaw + 540) % 360) - 180);
        const ok = d < 1 && dy < 0.5;
        if (!ok) bad++;
        lines.push(`  f${f}: ${short(c.shot)} local ${c.local_frame} -> ${c.camera}; viewport ${d.toFixed(2)} cm / ${dy.toFixed(2)} deg from it${ok ? "" : "  <- FAIL"}`);
      }
      return text([`${bad ? `CUT CHECK FAILED (${bad})` : "Cut verified"} on ${frames.length} master frame(s):`, ...lines].join("\n"), bad > 0);
    },
  );

  server.tool(
    "seq_audio",
    "Lay scratch audio on a sequence (usually the master): one named track per layer (Dialogue / Music / SFX), a " +
      "section at `start` sized to the sound's duration, volume. Read back from the saved asset.",
    {
      sequence: z.string(),
      track: z.string().describe("Track name, e.g. Music."),
      sound: z.string().describe("SoundWave / SoundCue path."),
      start: z.number().int().optional(),
      volume: z.number().min(0).optional(),
      replace: z.boolean().optional().describe("Clear the track's existing sections first."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("audio_add(P['s'], P['t'], P['snd'], P['st'], P['v'], P['r'])", {
        s: a.sequence, t: a.track, snd: a.sound, st: a.start ?? 0, v: a.volume ?? 1, r: !!a.replace });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const info = await run("master_info(P['m'])", { m: a.sequence });
      const secs = (info.audio ?? []).filter((x: any) => x.track === a.track && short(x.sound) === short(a.sound) && x.start === (a.start ?? 0));
      const s = secs[0];
      const ok = !!s && s.end - s.start === r.frames && (a.volume === undefined || Math.abs(s.volume - a.volume) < 1e-3);
      return text([`${ok ? "Added and verified" : "AUDIO READBACK MISMATCH"}: ${a.track} <- ${short(a.sound)} at f${a.start ?? 0} (${r.frames} frames).`, ...describe(info)].join("\n"), !ok);
    },
  );
}
