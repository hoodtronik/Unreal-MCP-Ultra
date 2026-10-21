import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): anim_bake turns a Sequencer performance (Control Rig keys, clips, constraints - whatever
// drives the skeleton) into an AnimSequence through SequencerTools.export_anim_sequence (Tools/python/ue_bake.py),
// then VERIFIES it: at sampled frames every bone of the rendered character (component space) vs the clip at the
// same time. Live: SEQ_Wave baked 89 bones, worst 0.39 cm (pinky tip between 30 fps samples); the empty clip it
// replaced read 12-60 cm. The project forces 30 fps clips, so a 24 fps shot is recorded at 30 (timing in seconds).

const LIBS = ["ue_posing.py", "ue_bake.py"];
export const BAKE_TOL_CM = 1.0;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** n frames spread over [start, end] inclusive, always including both ends. Exported for tests. */
export function checkFrames(start: number, end: number, n: number): number[] {
  if (end <= start || n <= 1) return [start];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round(start + ((end - start) * i) / (n - 1)));
  return [...out].sort((a, b) => a - b);
}

export function registerAnimBakeTools(server: McpServer): void {
  server.tool(
    "anim_bake",
    "Bake a Sequencer character's performance (Control Rig poses/keys or anything else driving its skeleton) into an " +
      "AnimSequence asset, then VERIFY it: at sampled frames every rendered bone must match the clip within 1 cm. " +
      "Turns posed/keyed previz into a reusable clip for Anim Blueprints, montages, retargeting or other shots.",
    {
      sequence: z.string(),
      binding: z.string(),
      anim: z.string().describe("AnimSequence path to create, e.g. /Game/Anims/A_Wave."),
      overwrite: z.boolean().optional().describe("Re-bake into an existing AnimSequence."),
      check: z.number().int().min(2).max(60).optional().describe("Frames to verify (default 9, spread over the range)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const b = await run("bake_to_anim(P['s'], P['b'], P['a'], P['o'])", { s: a.sequence, b: a.binding, a: a.anim, o: !!a.overwrite });
      if (!b.ok) return text(`Error: ${b.error}`, true);
      const lines = [`Baked ${a.binding} of ${a.sequence} (frames ${b.start}-${b.end} @ ${b.seq_fps} fps) -> ${b.anim}: ${b.length.toFixed(3)} s, ${b.frames} frames @ ${b.fps} fps, skeleton ${b.skeleton.split("/").pop()}.`];
      if (b.fps !== b.seq_fps) lines.push(`Recorded at ${b.fps} fps (the project only allows clip rates compatible with it); timing is identical in seconds.`);
      let worst = { cm: -1, bone: "", frame: 0 };
      let bones = 0;
      for (const f of checkFrames(b.start, b.end, a.check ?? 9)) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const c = await run("bake_compare(P['s'], P['b'], P['a'], P['f'])", { s: a.sequence, b: a.binding, a: b.anim, f });
        if (!c.ok) return text([...lines, `Verification failed at frame ${f}: ${c.error}`].join("\n"), true);
        bones = c.bones;
        if (c.worst > worst.cm) worst = { cm: c.worst, bone: c.worst_bone, frame: f };
      }
      const ok = b.ok && worst.cm >= 0 && worst.cm <= BAKE_TOL_CM && bones > 0;
      lines.push(`${ok ? "Verified" : "BAKE MISMATCH"}: ${bones} bones at ${checkFrames(b.start, b.end, a.check ?? 9).length} frames vs the rendered character, worst ${worst.bone} ${worst.cm} cm at frame ${worst.frame} (tol ${BAKE_TOL_CM}).`);
      return text(lines.join("\n"), !ok);
    },
  );
}
