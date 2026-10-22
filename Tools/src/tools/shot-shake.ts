import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): HANDHELD camera shake keyed into the camera's own transform channels
// (Tools/python/ue_shake.py). The native route - a CameraShakeBase Blueprint with a Perlin pattern on a Sequencer
// MovieSceneCameraShakeTrack - built and read back fine but changed nothing measurable: the camera's GetCameraView was
// identical between frames and an MRQ render with it matched one without (0.1 luma = render noise). Keyed noise is
// deterministic, exports with the shot and works on top of existing camera keys (follow / rig moves): bases are read
// per frame BEFORE keying (keys would bend the curve between the original keys), then base + noise is keyed.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_shake.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Deterministic smooth noise in [-1, 1]: three sines with seeded incommensurate frequencies/phases per channel.
 * Exported for tests. */
export function handheldNoise(seed: number, channel: number, t: number, hz: number): number {
  let s = (seed * 9301 + channel * 49297 + 233280) % 233280;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const mults = [1, 2.13, 3.71];
  const amps = [0.6, 0.3, 0.1];
  let v = 0;
  for (let i = 0; i < 3; i++) v += amps[i] * Math.sin(2 * Math.PI * (hz * mults[i] * (0.8 + 0.4 * rnd()) * t + rnd()));
  return v;
}

export function registerShotShakeTools(server: McpServer): void {
  server.tool(
    "shot_camera_shake",
    "Add HANDHELD camera shake to a sequence camera over a frame range by keying smooth noise into its transform " +
      "(on top of whatever the camera already does - static, follow or rig move): `location` cm and `rotation` deg " +
      "amplitudes, `frequency` Hz, `seed`. Verified by reading the camera back (= base + noise on sampled frames). " +
      "Re-running replaces nothing - remove keys first if you want a different shake on the same frames.",
    {
      sequence: z.string(),
      camera: z.string(),
      frames: z.array(z.number().int()).length(2).describe("[start, end] inclusive."),
      location: z.number().min(0).optional().describe("Location amplitude, cm (default 1.5)."),
      rotation: z.number().min(0).optional().describe("Rotation amplitude, deg (default 0.6)."),
      frequency: z.number().positive().optional().describe("Base frequency, Hz (default 1.2)."),
      seed: z.number().int().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const [f0, f1] = a.frames;
      const fr = await run("{'ok': True, 'fps': load_sequence(P['s']).get_display_rate().numerator / load_sequence(P['s']).get_display_rate().denominator}", { s: a.sequence });
      if (!fr.ok) return text(`Error: ${fr.error}`, true);
      const fps = fr.fps as number;
      const frames: number[] = [];
      for (let f = f0; f <= f1; f++) frames.push(f);
      // pass 1: bases (posed frame by frame)
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: f0 });
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: f0 });
      const bases: number[][] = [];
      for (let i = 0; i < frames.length; i++) {
        const r = await run("cam_base(P['s'], P['c'], P['nx'])", { s: a.sequence, c: a.camera, nx: i + 1 < frames.length ? frames[i + 1] : null });
        if (!r.ok) return text(`Error reading the camera at f${frames[i]}: ${r.error}`, true);
        if (r.frame !== frames[i]) return text(`Error: read frame ${r.frame} for f${frames[i]}`, true);
        bases.push(r.v as number[]);
      }
      const L = a.location ?? 1.5, R = a.rotation ?? 0.6, hz = a.frequency ?? 1.2, seed = a.seed ?? 7;
      const amp = [L, L, L, R, R, R * 0.5];
      const values = bases.map((b, i) => b.map((v, c) => v + amp[c] * handheldNoise(seed, c, frames[i] / fps, hz)));
      const k = await run("handheld_key(P['s'], P['c'], P['f'], P['v'])", { s: a.sequence, c: a.camera, f: frames, v: values });
      if (!k.ok) return text(`Error keying: ${k.error}`, true);
      // verify on sampled frames
      const sample = [frames[0], frames[Math.floor(frames.length / 3)], frames[Math.floor((2 * frames.length) / 3)], frames[frames.length - 1]];
      const lines: string[] = [];
      let bad = 0;
      let peakL = 0, peakR = 0;
      values.forEach((v, i) => { peakL = Math.max(peakL, ...v.slice(0, 3).map((x, c) => Math.abs(x - bases[i][c]))); peakR = Math.max(peakR, ...v.slice(3).map((x, c) => Math.abs(x - bases[i][c + 3]))); });
      for (const f of sample) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const r = await run("cam_base(P['s'], P['c'])", { s: a.sequence, c: a.camera });
        const want = values[frames.indexOf(f)];
        const d = Math.max(...(r.v as number[]).map((x, c) => Math.abs(x - want[c])));
        if (!(d <= 0.05)) bad++;
        lines.push(`  f${f}: camera ${(r.v as number[]).slice(0, 3).map((x) => x.toFixed(2)).join(",")} / rot ${(r.v as number[]).slice(3).map((x) => x.toFixed(2)).join(",")} - ${d.toFixed(4)} from base + noise${d <= 0.05 ? "" : "  <- FAIL"}`);
      }
      return text([`${bad ? "SHAKE CHECK FAILED" : "Handheld shake keyed and verified"}: ${a.camera} f${f0}-${f1} (${frames.length} keys), peak ${peakL.toFixed(2)} cm / ${peakR.toFixed(2)} deg at ${hz} Hz, seed ${seed}.`, ...lines].join("\n"), bad > 0);
    },
  );
}
