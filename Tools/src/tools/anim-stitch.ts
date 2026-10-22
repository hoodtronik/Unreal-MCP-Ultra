import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { trailStats } from "./pose-trail.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): stitching root-motion clips on one Sequencer character
// (Tools/python/ue_stitch.py). The Mannequin locomotion clips have force_root_lock, so a plain anim section plays them
// in place; the track's swap_root_bone = Actor moves the actor by the clip's root motion - but every new section
// restarts at its own origin (walk -> walk cut popped back 438 cm). Each section's start_location / rotation offset is
// set to the root travel and turn accumulated before it (extract_root_track_transform), which made the cuts seamless:
// 11.7 cm step at the walk -> walk cut (walk frames ~12 cm), 4.6 cm at walk -> jog, 1511 cm covered.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_walk.py", "ue_stitch.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function registerAnimStitchTools(server: McpServer): void {
  server.tool(
    "anim_stitch",
    "Play several ROOT-MOTION clips back to back on one character in a sequence (walk, walk, jog, turn...) so each " +
      "continues where the previous ended: root motion drives the actor (swap root bone = Actor) and each section's " +
      "start offsets carry the travel and turn of the clips before it. VERIFIED by tracking the pelvis across every cut: " +
      "the step at a cut must look like a normal frame (no pop).",
    {
      sequence: z.string().describe("Sequence (created if missing)."),
      binding: z.string(),
      clips: z.array(z.string()).min(1).describe("AnimSequence paths with root motion, in order."),
      location: z.array(z.number()).length(3).optional().describe("Where the character starts."),
      mesh: z.string().optional(),
      start: z.number().int().optional(),
      blend: z.number().int().min(0).max(24).optional().describe("Frames to cross-fade each cut (overlapping sections with ease out/in). 0 = hard cut. Default 6."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const c = await run("load_sequence(P['s'], open_it=True, create=True, fps=24, end=48) and {'ok': True}", { s: a.sequence });
      if (!c.ok) return text(`Error: ${c.error}`, true);
      const blend = a.blend ?? 6;
      const r = await run("stitch(P['s'], P['b'], P['c'], P['st'], P['m'], tuple(P['l']), True, 'ACTOR', P['bl'])", { bl: blend,
        s: a.sequence, b: a.binding, c: a.clips.map((x) => ({ clip: x })), st: a.start ?? 0,
        m: a.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple", l: a.location ?? [0, 0, 0] });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const secs = r.sections as any[];
      const lines = [`Stitched ${secs.length} clip(s) on '${a.binding}' (frames ${secs[0].range[0]}-${r.end}):`,
        ...secs.map((s) => `  ${s.clip} [${s.range[0]}-${s.range[1]}) travel ${JSON.stringify(s.root_travel)} turn ${s.turn}; start offset ${JSON.stringify(s.offset)}`)];
      // pelvis track around each cut (3 frames before, 2 after) + a stretch inside the first clip for the median step
      const frames = new Set<number>();
      for (let f = secs[0].range[0]; f < Math.min(secs[0].range[1], secs[0].range[0] + 12); f++) frames.add(f);
      for (const s of secs.slice(1)) for (let f = s.range[0] - 3; f <= s.range[0] + blend + 3; f++) frames.add(f);
      const fl = [...frames].sort((x, y) => x - y);
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: fl[0] });
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: fl[0] });
      const pts: Record<number, number[]> = {};
      for (let i = 0; i < fl.length; i++) {
        const p = await run("bone_world(P['s'], P['b'], 'pelvis', P['nx'])", { s: a.sequence, b: a.binding, nx: i + 1 < fl.length ? fl[i + 1] : null });
        if (!p.ok) return text(`Error at f${fl[i]}: ${p.error}`, true);
        pts[p.frame] = p.p as number[];
      }
      const inside = fl.filter((f) => f < secs[0].range[0] + 12 && pts[f]);
      const med = trailStats(inside.map((f) => pts[f]), inside, 24).medianStep;
      let bad = 0;
      const step = (f: number) => (pts[f] && pts[f - 1] ? Math.hypot(...pts[f].map((v, i) => v - pts[f - 1][i])) : NaN);
      for (const s of secs.slice(1)) {
        const f0 = s.range[0];
        // CLAUDE-NOTE (live): a walk -> jog cut legitimately doubles the step (12 -> 25 cm/frame); a pop is a step well
        // above BOTH the outgoing and the incoming speed, checked through the whole cross-fade.
        const before = [f0 - 2, f0 - 1].map(step).filter((x) => !isNaN(x));
        const after = [f0 + blend + 2, f0 + blend + 3].map(step).filter((x) => !isNaN(x));
        const avg = (xs: number[]) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : med);
        const ref = Math.max(avg(before), avg(after));
        let worst = 0, at = f0;
        for (let f = f0; f <= f0 + blend + 1; f++) { const st = step(f); if (st > worst) { worst = st; at = f; } }
        const pop = worst > Math.max(1.4 * ref, ref + 6);
        if (pop) bad++;
        lines.push(`  cut at f${f0}${blend ? ` (${blend}-frame blend)` : ""}: largest pelvis step ${worst.toFixed(2)} cm at f${at}; speed before ${avg(before).toFixed(1)}, after ${avg(after).toFixed(1)} cm/frame${pop ? "  <- POP" : ""}`);
      }
      return text([`${bad ? `STITCH POPS (${bad})` : "Stitch verified (no pops)"}:`, ...lines].join("\n"), bad > 0);
    },
  );
}
