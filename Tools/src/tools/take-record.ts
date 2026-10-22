import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Take Recorder through TakeRecorderBlueprintLibrary.start_recording with its
// OWN parameters (no countdown, takes under /Game/_MCPLab/Takes) so the project's take settings are untouched
// (Tools/python/ue_take.py). Live: a level mannequin looping the walk, recorded 3 s -> a take sequence (sub-sequence
// with spawn + transform + skeletal animation tracks) and an 87-frame AnimSequence whose poses match the clip within
// 0.4-2.0 cm, the clip time advancing 0.45 s per 0.45 s of take (real-time rate 1.0).

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_take.py"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Playback rate implied by successive best-match clip times of a looping clip (wraps). Exported for tests. */
export function impliedRate(samples: { t: number; clip_t: number }[], clipLen: number): number {
  const r: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    let dc = samples[i].clip_t - samples[i - 1].clip_t;
    while (dc < -clipLen / 2) dc += clipLen;
    while (dc > clipLen / 2) dc -= clipLen;
    if (dt > 0) r.push(dc / dt);
  }
  r.sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : NaN;
}

export function registerTakeRecordTools(server: McpServer): void {
  server.tool(
    "take_record",
    "TAKE RECORDER: record live level actors (their animation and movement) for `seconds` into a new take sequence + " +
      "AnimSequence assets - capture something running in the editor (an ABP, a looping clip, physics) as editable " +
      "keys/clips. `subject` first places a mannequin looping a clip to record. With `compareClip` the recorded animation " +
      "is checked pose-by-pose against that clip (pose error and real-time rate). Uses its own settings (no countdown, " +
      "takes under `root`); the project's Take Recorder settings are not changed.",
    {
      actors: z.array(z.string()).min(1).describe("Level actor labels to record."),
      seconds: z.number().min(0.5).max(60),
      slate: z.string().optional(),
      take: z.number().int().optional(),
      root: z.string().optional().describe("Save folder (default /Game/_MCPLab/Takes)."),
      subject: z.object({ label: z.string(), clip: z.string(), location: z.array(z.number()).length(3).optional(), mesh: z.string().optional() }).strict().optional()
        .describe("Place a level mannequin looping `clip` first (its label must be in actors)."),
      compareClip: z.string().optional().describe("Check the first recorded animation against this (looping) clip."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.subject) {
        const s = await run("take_subject(P['l'], P['c'], P['m'], tuple(P['p']))", { l: a.subject.label, c: a.subject.clip,
          m: a.subject.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple", p: a.subject.location ?? [0, 0, 0] });
        if (!s.ok) return text(`Error placing subject: ${s.error}`, true);
      }
      const st = await run("take_start(P['a'], P['s'], P['t'], P['r'])", { a: a.actors, s: a.slate ?? "MCP", t: a.take ?? 1, r: a.root ?? "/Game/_MCPLab/Takes" });
      if (!st.ok) return text(`Error: ${st.error}`, true);
      await sleep(a.seconds * 1000);
      const sp = await run("take_stop()", {});
      if (!sp.ok || !sp.sequence) return text(`Error stopping: ${sp.error ?? "no take sequence"}`, true);
      const info = await run("take_info(P['s'])", { s: sp.sequence });
      if (!info.ok) return text(`Recorded ${sp.sequence} but could not read it: ${info.error}`, true);
      const anims = info.anims as any[];
      const rg = info.range as number[];
      const lines = [`Recorded ${sp.sequence} (${a.seconds} s of ${(st.sources as string[]).join(", ")}), frames ${rg[0]}-${rg[1]} (timecode-based: scrub from ${rg[0]}):`,
        ...(info.bindings as any[]).map((b) => `  ${b.sequence} / ${b.name}: ${b.tracks.join(", ")}`),
        ...anims.map((x) => `  animation ${x.path}: ${x.length} s, ${x.frames} frames`)];
      let bad = 0;
      for (const x of anims) if (Math.abs(x.length - a.seconds) > Math.max(0.75, a.seconds * 0.25)) { bad++; lines.push(`  <- ${x.length} s recorded for ${a.seconds} s`); }
      if (a.compareClip) {
        if (!anims.length) { bad++; lines.push("No animation was recorded to compare."); }
        else {
          const c = await run("anim_vs_clip(P['r'], P['c'])", { r: anims[0].path, c: a.compareClip });
          if (!c.ok) return text([...lines, `Compare failed: ${c.error}`].join("\n"), true);
          const sm = c.samples as { t: number; clip_t: number; cm: number }[];
          const worst = Math.max(...sm.map((x) => x.cm));
          const rate = impliedRate(sm, c.clip_length as number);
          const okPose = worst <= 3, okRate = Math.abs(rate - 1) <= 0.1;
          if (!okPose || !okRate) bad++;
          lines.push(`Vs ${a.compareClip.split("/").pop()}: worst pose error ${worst.toFixed(2)} cm over ${sm.length} samples${okPose ? "" : "  <- POSES DIFFER"}; playback rate ${rate.toFixed(3)}${okRate ? "" : "  <- NOT REAL TIME"}`);
        }
      }
      return text([bad ? "TAKE CHECK FAILED:" : "Take recorded and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
