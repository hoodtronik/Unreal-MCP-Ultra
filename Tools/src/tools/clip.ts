import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { qmul, qAngle } from "./pose-fk.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): clip tools (Tools/python/ue_clip.py). anim_clip_info reads length, frames,
// rate, root motion (extract_root_track_transform at 0 and end: MF_Unarmed_Walk_Fwd 450 cm in 1.5 s = 300 cm/s, the
// same speed anim_walk measures), curves, notifies, sync markers and sampled bone positions. anim_clip_create writes a
// new AnimSequence through the AnimationDataController (every bone at the reference pose, listed bones keyed as
// rotation offsets in their own axes, eased between keys) and verifies each key by evaluating the clip:
// local = ref * offset (A_NodProc head -20 deg at 0.5 s -> 19.99 deg from the reference).

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_clip.py"];
const vec3 = z.array(z.number()).length(3);
export const CLIP_TOL_DEG = 0.1;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Quaternion [x,y,z,w] of a rotator [pitch, yaw, roll] (UE FRotator::Quaternion). Exported for tests. */
export function rotatorQuat(pitch: number, yaw: number, roll: number): number[] {
  const d = Math.PI / 360;
  const SP = Math.sin(pitch * d), CP = Math.cos(pitch * d), SY = Math.sin(yaw * d), CY = Math.cos(yaw * d), SR = Math.sin(roll * d), CR = Math.cos(roll * d);
  return [CR * SP * SY - SR * CP * CY, -CR * SP * CY - SR * CP * SY, CR * CP * SY - SR * SP * CY, CR * CP * CY + SR * SP * SY];
}

export function registerClipTools(server: McpServer): void {
  server.tool(
    "anim_clip_info",
    "Inspect an AnimSequence: length, frames, frame rate, skeleton, root motion (on/off, total root travel and speed), " +
      "curves, notifies (name + time), sync markers, and optionally sampled bone positions (component space incl. root " +
      "motion) at given times.",
    {
      clip: z.string(),
      bones: z.array(z.string()).optional(),
      times: z.array(z.number()).optional().describe("Seconds to sample bones at (default start / middle / end)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("clip_info(P['c'], P['b'], P['t'])", { c: a.clip, b: a.bones ?? null, t: a.times ?? null });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`${r.path}: ${r.length} s, ${r.frames} frames @ ${r.fps} fps, skeleton ${String(r.skeleton).split("/").pop()}`,
        `  root motion ${r.root_motion ? "ON" : "off"}${r.root_delta ? `, root travels ${JSON.stringify(r.root_delta)} cm (${r.root_speed_cm_s} cm/s)` : ""}`,
        `  curves: ${(r.curves as string[]).join(", ") || "none"}`,
        `  notifies: ${(r.notifies as any[]).map((n) => `${n.name}@${n.time}`).join(", ") || "none"}`,
        `  sync markers: ${(r.sync_markers as any[]).map((m) => `${m.name}@${m.time}`).join(", ") || "none"}`];
      for (const [t, b] of Object.entries((r.bones ?? {}) as Record<string, Record<string, number[]>>))
        lines.push(`  t=${t}: ${Object.entries(b).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ")}`);
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "anim_clip_create",
    "Author a NEW AnimSequence from bone keys (no Sequencer): `seconds` at `fps` on a skeleton, every bone at the " +
      "reference pose, the listed bones keyed with rotation offsets [pitch, yaw, roll] deg in the bone's own axes (and " +
      "optional location offsets cm), eased between keys. Each key is verified by evaluating the saved clip. Use for " +
      "procedural gestures (nod, head turn, finger tap) to play in an ABP, montage or sequence.",
    {
      path: z.string().describe("New asset path, e.g. /Game/Anims/A_Nod."),
      skeleton: z.string(),
      seconds: z.number().positive(),
      fps: z.number().int().positive().optional().describe("Default 30 (the project enforces 30-fps-compatible clip rates)."),
      keys: z.record(z.string(), z.array(z.object({ time: z.number(), rotation: vec3.optional(), location: vec3.optional() }).strict()).min(1)),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const fps = a.fps ?? 30;
      const r = await run("clip_create(P['p'], P['s'], P['sec'], P['fps'], P['k'])", { p: a.path, s: a.skeleton, sec: a.seconds, fps, k: a.keys });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`Created ${r.path}: ${r.frames} frames @ ${fps} fps, ${r.tracks} bone tracks, keyed ${(r.keyed as string[]).join(", ")}.`];
      let bad = 0;
      for (const [bone, ks] of Object.entries(a.keys)) {
        for (const k of ks) {
          if (k.time > a.seconds + 1e-6) continue;
          const v = await run("clip_bone_local(P['p'], P['b'], P['t'])", { p: a.path, b: bone, t: k.time });
          if (!v.ok) return text(`Error reading ${bone}@${k.time}: ${v.error}`, true);
          const rot = k.rotation ?? [0, 0, 0];
          const want = qmul(v.ref_q as number[], rotatorQuat(rot[0], rot[1], rot[2]));
          const e = qAngle(want, v.q as number[]);
          const lo = k.location ?? [0, 0, 0];
          const le = Math.hypot(...(v.loc as number[]).map((x, i) => x - (v.ref_loc as number[])[i] - lo[i]));
          const ok = e <= CLIP_TOL_DEG && le <= 0.05;
          if (!ok) bad++;
          lines.push(`  ${bone} @${k.time}s: rot err ${e.toFixed(3)} deg (turned ${qAngle(v.ref_q as number[], v.q as number[]).toFixed(2)} from ref), loc err ${le.toFixed(3)} cm${ok ? "" : "  <- FAIL"}`);
        }
      }
      return text([`${bad ? `CLIP CHECK FAILED (${bad})` : "Verified"}:`, ...lines].join("\n"), bad > 0);
    },
  );
}
