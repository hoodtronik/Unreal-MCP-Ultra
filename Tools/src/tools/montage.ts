import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22): anim montages (Tools/python/ue_montage.py + /api/montage-read|edit in
// BlueprintMCPHandlers_Montage.cpp). Python creates the montage (AnimMontageFactory) and plays it, but cannot see
// slot tracks / segments / sections - the C++ endpoints write and read those. anim_montage_play verifies playback the
// way it renders: an ABP with a Slot node runs on a hidden editor mannequin, the montage is parked (paused) at each
// position, and the rendered pose is compared with the segment's clip at the time that position maps to (live: 0 cm
// at 0.6 s and 2.0 s of a wave montage, idle 76 cm away; after stop the idle is back at 0.02 cm).

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_abp.py", "ue_montage.py"];
const MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
const HIDDEN_LABEL = "MCP_MontageCheck";
export const MONTAGE_POSE_TOL_CM = 0.5;

export type Segment = { anim: string; startPos: number; animStart: number; animEnd: number; rate: number; loops: number; length: number };

/** Which clip and clip time a montage position plays (segments in track order). Exported for tests. */
export function montageTimeAt(segments: Segment[], pos: number): { anim: string; t: number } | null {
  for (const s of segments) {
    if (pos < s.startPos - 1e-6 || pos > s.startPos + s.length + 1e-6) continue;
    const span = s.animEnd - s.animStart;
    let local = (pos - s.startPos) * s.rate;            // clip seconds since the segment started
    if (span > 0 && local > span + 1e-6) local = local % span; // looping segment
    return { anim: s.anim.split(".")[0], t: Math.min(s.animEnd, s.animStart + local) };
  }
  return null;
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}
const short = (p: string) => p.split(".")[0].split("/").pop();

function describe(m: any): string[] {
  const lines = [`${m.montage.split(".")[0]}: ${Number(m.length).toFixed(3)} s, blend in ${m.blendIn} / out ${m.blendOut} s`];
  for (const t of m.tracks) {
    lines.push(`  slot ${t.slot}: ` + t.segments.map((s: Segment) =>
      `${short(s.anim)} [${s.animStart.toFixed(2)}-${s.animEnd.toFixed(2)}]${s.rate !== 1 ? ` x${s.rate}` : ""}${s.loops > 1 ? ` loops ${s.loops}` : ""} @${s.startPos.toFixed(2)}`).join(" | "));
  }
  lines.push(`  sections: ${m.sections.map((c: any) => `${c.name}@${Number(c.start).toFixed(2)}${c.next && c.next !== "None" ? `->${c.next}` : " (end)"}`).join(", ")}`);
  return lines;
}

const segIn = z.object({
  anim: z.string().describe("AnimSequence path."),
  animStart: z.number().optional(), animEnd: z.number().optional(),
  rate: z.number().optional(), loops: z.number().int().optional(),
}).strict();
const secIn = z.object({ name: z.string(), start: z.number(), next: z.string().optional().describe("Section to play next ('' = stop here, own name = loop). Default: the following section.") }).strict();

export function registerMontageTools(server: McpServer): void {
  server.tool(
    "anim_montage",
    "Create, edit or read an ANIM MONTAGE: clips laid end to end on a slot track (trim with animStart/animEnd, play " +
      "rate, loops), named sections with their order (e.g. Start -> Loop (loops) -> End), slot name and blend times. " +
      "Everything is read back from the saved asset and checked against the request. Play it with anim_montage_play " +
      "(needs an Anim Blueprint with a Slot node: add_anim_node nodeType 'Slot').",
    {
      action: z.enum(["create", "edit", "read"]),
      montage: z.string().describe("Montage object path, e.g. /Game/Anims/AM_Wave."),
      clips: z.array(segIn).optional().describe("create/edit: the slot track's clips in order (replaces the track)."),
      slot: z.string().optional().describe("Slot name (default DefaultSlot)."),
      sections: z.array(secIn).optional().describe("Replace all sections (one must start at 0)."),
      blendIn: z.number().optional(), blendOut: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.action === "read") {
        const r = await uePost("/api/montage-read", { montage: a.montage });
        if (r.error) return text(`Error: ${r.error}`, true);
        return text(describe(r).join("\n"));
      }
      if (a.action === "create") {
        if (!a.clips?.length) return text("Error: create needs clips.", true);
        const c = await run("montage_create(P['p'], P['c'])", { p: a.montage, c: a.clips[0].anim });
        if (!c.ok) return text(`Error: ${c.error}`, true);
      }
      if (a.sections && !a.sections.some((s) => Math.abs(s.start) < 1e-6)) return text("Error: one section must start at 0.", true);
      const body: Record<string, unknown> = { montage: a.montage };
      if (a.clips?.length) body.segments = a.clips;
      if (a.slot) body.slot = a.slot;
      if (a.sections?.length) body.sections = a.sections;
      if (a.blendIn !== undefined) body.blendIn = a.blendIn;
      if (a.blendOut !== undefined) body.blendOut = a.blendOut;
      const r = await uePost("/api/montage-edit", body);
      if (r.error) return text(`Error: ${r.error}`, true);
      const back = await uePost("/api/montage-read", { montage: a.montage });
      if (back.error) return text(`Error reading back: ${back.error}`, true);
      // Check the saved asset against the request.
      const bad: string[] = [];
      const segs: Segment[] = back.tracks[0]?.segments ?? [];
      if (a.clips?.length) {
        if (segs.length !== a.clips.length) bad.push(`${segs.length} segments, asked ${a.clips.length}`);
        a.clips.forEach((c, i) => {
          const s = segs[i];
          if (!s) return;
          if (short(s.anim) !== short(c.anim)) bad.push(`segment ${i} is ${short(s.anim)}`);
          if (c.animStart !== undefined && Math.abs(s.animStart - c.animStart) > 1e-3) bad.push(`segment ${i} starts at ${s.animStart}`);
          if (c.animEnd !== undefined && Math.abs(s.animEnd - c.animEnd) > 1e-3) bad.push(`segment ${i} ends at ${s.animEnd}`);
        });
        const total = segs.reduce((x, s) => x + s.length, 0);
        if (Math.abs(total - back.length) > 1e-3) bad.push(`length ${back.length} != segments ${total.toFixed(3)}`);
      }
      if (a.slot && back.tracks[0]?.slot !== a.slot) bad.push(`slot is ${back.tracks[0]?.slot}`);
      for (const s of a.sections ?? []) {
        const got = back.sections.find((c: any) => c.name === s.name);
        if (!got) bad.push(`section ${s.name} missing`);
        else if (Math.abs(got.start - s.start) > 1e-3) bad.push(`section ${s.name} at ${got.start}`);
        else if (s.next !== undefined && (got.next === "None" ? "" : got.next) !== s.next) bad.push(`section ${s.name} -> ${got.next}`);
      }
      if (a.blendIn !== undefined && Math.abs(back.blendIn - a.blendIn) > 1e-4) bad.push(`blend in ${back.blendIn}`);
      if (a.blendOut !== undefined && Math.abs(back.blendOut - a.blendOut) > 1e-4) bad.push(`blend out ${back.blendOut}`);
      return text([`${a.action === "create" ? "Created" : "Edited"} montage (saved). ${bad.length ? "MISMATCH: " + bad.join("; ") : "Verified against the request."}`,
        ...describe(back)].join("\n"), bad.length > 0);
    },
  );

  server.tool(
    "anim_montage_play",
    "Play a montage through an Anim Blueprint's Slot on a hidden editor mannequin and VERIFY the rendered pose: at " +
      "each montage position the pose must match the clip time that position maps to (segments, trims, rates, loops). " +
      "Optionally jump to sections (position must land on the section start) and check that after stopping the " +
      "pose returns to the ABP's own animation (`base` clip).",
    {
      blueprint: z.string().describe("Anim Blueprint with a Slot node for the montage's slot."),
      montage: z.string(),
      positions: z.array(z.number()).min(1).max(20).optional().describe("Montage seconds to check (default 5 across the length)."),
      sections: z.array(z.string()).optional().describe("Sections to jump to and check."),
      base: z.string().optional().describe("Clip the ABP plays without the montage (checked after stop)."),
      mesh: z.string().optional(),
      toleranceCm: z.number().optional(),
      place: z.object({ label: z.string(), location: z.array(z.number()).length(3), facing: z.number().optional(), hold: z.number().optional().describe("Montage position to leave it parked at (default the last checked).") }).optional()
        .describe("Run on a VISIBLE level mannequin (kept, parked) instead of the hidden one - for captures."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const tol = a.toleranceCm ?? MONTAGE_POSE_TOL_CM;
      const m = await uePost("/api/montage-read", { montage: a.montage });
      if (m.error) return text(`Error: ${m.error}`, true);
      const segs: Segment[] = m.tracks[0]?.segments ?? [];
      const LABEL = a.place?.label ?? HIDDEN_LABEL;
      const sp = await run("abp_preview(P['l'], P['b'], P['m'], tuple(P['loc']))", { l: LABEL, b: a.blueprint, m: a.mesh ?? MESH, loc: a.place?.location ?? [0, 0, -5000] });
      if (!sp.ok) return text(`Error: ${sp.error}`, true);
      if (a.place?.facing !== undefined) await run("abp_face(P['l'], P['f'])", { l: LABEL, f: a.place.facing });
      const L = Number(m.length);
      const positions = a.positions ?? [0.1, 0.3, 0.5, 0.7, 0.9].map((k) => +(k * L).toFixed(3));
      const lines: string[] = [];
      let bad = 0;
      for (const pos of positions) {
        const want = montageTimeAt(segs, pos);
        if (!want) { lines.push(`  ${pos}s: outside the montage`); bad++; continue; }
        const h = await run("montage_hold(P['l'], P['m'], P['p'])", { l: LABEL, m: a.montage, p: pos });
        if (!h.ok) return text(`Error: ${h.error}`, true);
        // CLAUDE-NOTE (live): the first hold lands inside the blend-in (slot weight 0.36 -> hand 42 cm off the clip);
        // the blend keeps advancing while paused, so wait until the slot is fully weighted before measuring.
        let st = await run("montage_state(P['l'], P['m'])", { l: LABEL, m: a.montage });
        for (let k = 0; k < 20 && !(st.slot_weight > 0.99); k++) {
          await new Promise((res) => setTimeout(res, 100));
          st = await run("montage_state(P['l'], P['m'])", { l: LABEL, m: a.montage });
        }
        const pv = await run("pose_vs_clip(P['l'], P['c'], P['t'])", { l: LABEL, c: want.anim, t: want.t });
        if (!pv.ok) return text(`Error: ${pv.error}`, true);
        const ok = pv.cm <= tol && Math.abs(st.position - pos) < 0.02 && st.slot_weight > 0.99;
        if (!ok) bad++;
        lines.push(`  ${pos.toFixed(2)}s -> ${short(want.anim)} @${want.t.toFixed(3)}s: ${pv.cm.toFixed(3)} cm (${pv.bone}); position ${st.position}, section ${st.section}, slot weight ${st.slot_weight}${ok ? "" : "  <- FAIL"}`);
      }
      for (const name of a.sections ?? []) {
        const sec = m.sections.find((c: any) => c.name === name);
        if (!sec) { lines.push(`  section ${name}: not in the montage`); bad++; continue; }
        await run("montage_jump(P['l'], P['m'], P['s'])", { l: LABEL, m: a.montage, s: name });
        await run("{'ok': True}", {});
        const st = await run("montage_state(P['l'], P['m'])", { l: LABEL, m: a.montage });
        const ok = st.section === name && Math.abs(st.position - sec.start) < 0.05;
        if (!ok) bad++;
        lines.push(`  jump ${name}: position ${st.position} (section start ${Number(sec.start).toFixed(3)}), current section ${st.section}${ok ? "" : "  <- FAIL"}`);
      }
      if (a.base) {
        await run("montage_stop(P['l'])", { l: LABEL });
        await run("{'ok': True}", {});
        const cm = await run("clip_match(P['l'], [P['c']])", { l: LABEL, c: a.base });
        const d = cm.ok ? cm.clips[a.base].cm : NaN;
        const ok = d <= 2;
        if (!ok) bad++;
        lines.push(`  after stop: ${short(a.base)} ${d} cm${ok ? "" : "  <- FAIL"}`);
      }
      if (a.place) {
        const hold = a.place.hold ?? positions[positions.length - 1];
        await run("montage_hold(P['l'], P['m'], P['p'])", { l: LABEL, m: a.montage, p: hold });
        lines.push(`  '${LABEL}' left at ${JSON.stringify(a.place.location)}, parked at ${hold}s.`);
      }
      if (lines.some((l) => /slot weight 0(\.0+)?(,|\s|$)/.test(l))) {
        lines.push(`  Slot weight 0: ${short(a.blueprint)} has no Slot node for '${m.tracks[0]?.slot}' feeding its output (add_anim_node nodeType 'Slot').`);
      }
      return text([`${bad ? `MONTAGE PLAYBACK FAILED (${bad})` : "Montage playback verified"}: ${short(a.montage)} through ${short(a.blueprint)} (tol ${tol} cm).`, ...describe(m), ...lines].join("\n"), bad > 0);
    },
  );
}
