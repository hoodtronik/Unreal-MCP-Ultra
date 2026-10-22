import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Sequencer constraints between ACTORS (Tools/python/ue_constrain.py) - a cup
// constrained (parent) to a walker's hand_r, active 20-40: before 20 it sat where keyed, 20-40 it kept a fixed offset to
// the hand (0.000 cm drift, through a clip cut at 36), after 40 it stayed where released. Sequencer compensates by
// itself: set_constraint_active_key added hold keys on the child (19/20 and 39/40) so neither the grab nor the release
// pops. Verified here by sampling around every key and through the active spans.

const LIBS = ["ue_posing.py", "ue_props.py", "ue_constrain.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export type PairSample = { frame: number; child: number[]; parent: number[]; rel: number[]; rel_rot: number[] };
const d3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Active state at frame f from [frame, active] keys (inactive before the first key). */
export function activeAt(keys: [number, boolean][], f: number): boolean {
  let s = false;
  for (const [k, v] of [...keys].sort((x, y) => x[0] - y[0])) if (k <= f) s = v;
  return s;
}

/** Frames to sample: 2 either side of each key plus every `step` frames inside active spans. Exported for tests. */
export function sampleFrames(keys: [number, boolean][], end: number, step = 6): number[] {
  const fs = new Set<number>();
  for (const [k] of keys) for (let f = k - 2; f <= k + 2; f++) if (f >= 0 && f <= end) fs.add(f);
  for (let f = 0; f <= end; f += step) if (activeAt(keys, f)) fs.add(f);
  return [...fs].sort((a, b) => a - b);
}

/**
 * Checks: while active the child keeps its offset to the parent (parent: parent-space offset; translation: world
 * offset; look_at: child's X axis aims at the parent); between consecutive sampled frames the child never jumps more
 * than the parent moved (+1 cm) - a grab/release pop shows there. Exported for tests.
 */
export function constraintChecks(type: string, keys: [number, boolean][], s: PairSample[], tolCm = 0.5): { bad: number; lines: string[] } {
  const lines: string[] = [];
  let bad = 0;
  const act = s.filter((x) => activeAt(keys, x.frame));
  if (act.length && type !== "look_at") {
    const ref = type === "translation" ? act[0].child.map((v, i) => v - act[0].parent[i]) : act[0].rel;
    const drift = Math.max(...act.map((x) => d3(type === "translation" ? x.child.map((v, i) => v - x.parent[i]) : x.rel, ref)));
    if (drift > tolCm) bad++;
    lines.push(`Active on ${act.length} sampled frame(s): offset drift ${drift.toFixed(3)} cm${drift > tolCm ? "  <- NOT FOLLOWING" : ""}`);
  }
  if (act.length && type === "look_at") {
    // rel_rot is not meaningful for aim; the TS caller fills rel with the aim error in degrees in rel[0]
    const err = Math.max(...act.map((x) => x.rel[0]));
    if (err > 1) bad++;
    lines.push(`Active on ${act.length} sampled frame(s): aim error up to ${err.toFixed(2)} deg${err > 1 ? "  <- NOT AIMING" : ""}`);
  }
  for (let i = 1; i < s.length; i++) {
    if (s[i].frame !== s[i - 1].frame + 1) continue;
    const cs = d3(s[i].child, s[i - 1].child), ps = d3(s[i].parent, s[i - 1].parent);
    if (cs > ps + 1 && type !== "look_at") {
      bad++;
      lines.push(`  POP at f${s[i].frame}: child moved ${cs.toFixed(1)} cm while the parent moved ${ps.toFixed(1)}`);
    }
  }
  return { bad, lines };
}

export function registerSeqConstrainTools(server: McpServer): void {
  server.tool(
    "seq_constrain",
    "Constrain an ACTOR binding (prop, camera, light) to another binding / level actor or one of its BONES or sockets " +
      "with a Sequencer constraint - parent (pick up and carry a cup), translation (follow without turning) or look_at " +
      "(a camera or light that keeps pointing at a moving bone) - keyed ACTIVE on and off: e.g. keys [{frame:20,active:true}, " +
      "{frame:40,active:false}] grabs at 20 and lets go at 40 (Sequencer adds the compensation keys, so the prop stays where " +
      "it was released). VERIFIED by sampling: offset held while active, no pop at any key. remove=true deletes the child's constraints.",
    {
      sequence: z.string(),
      child: z.string().describe("Binding to constrain (prop / camera / light)."),
      parent: z.string().optional().describe("Binding or level actor label (required unless remove)."),
      bone: z.string().optional().describe("Bone or socket of the parent, e.g. hand_r, head."),
      type: z.enum(["parent", "translation", "look_at"]).optional().describe("Default parent."),
      keys: z.array(z.object({ frame: z.number().int(), active: z.boolean() }).strict()).optional()
        .describe("Active keys; default on from frame 0."),
      maintainOffset: z.boolean().optional().describe("Keep the current offset (default true; look_at default false = the child's +X aims exactly at the target)."),
      end: z.number().int().optional().describe("Last frame to sample (default last key + 12)."),
      remove: z.boolean().optional(),
      bake: z.boolean().optional().describe("With remove: bake the active spans into world keys first (default true)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.remove) {
        // bake=true (default): the child's path must be the same before and after (sampled every 2 frames to `end`)
        const end = a.end ?? 72;
        const fl = Array.from({ length: Math.floor(end / 2) + 1 }, (_, i) => i * 2);
        const track = async () => {
          const out: number[][] = [];
          await run("scrub(P['s'], 0)", { s: a.sequence });
          await run("scrub(P['s'], 0)", { s: a.sequence });
          for (let i = 0; i < fl.length; i++) {
            const p = await run("sample_pair(P['s'], P['c'], P['c'], None, P['nx'])", { s: a.sequence, c: a.child, nx: i + 1 < fl.length ? fl[i + 1] : null });
            if (!p.ok) throw new Error(p.error);
            out.push(p.child as number[]);
          }
          return out;
        };
        try {
          const before = a.bake === false ? null : await track();
          const r = await run("unconstrain(P['s'], P['c'], P['b'])", { s: a.sequence, c: a.child, b: a.bake ?? true });
          if (!r.ok) return text(`Error: ${r.error}`, true);
          if (!before) return text(`Removed ${r.removed} constraint(s) from '${a.child}' WITHOUT baking (keys written while it was active are in the parent's space).`);
          const after = await track();
          const dev = Math.max(...before.map((p, i) => d3(p, after[i])));
          return text(`${dev > 0.5 ? "BAKE CHANGED THE PATH" : "Baked and removed"} ${r.removed} constraint(s) from '${a.child}': path before vs after, worst ${dev.toFixed(3)} cm over frames 0-${end}.`, dev > 0.5);
        } catch (e) {
          return text(`Error: ${(e as Error).message}`, true);
        }
      }
      if (!a.parent) return text("parent is required", true);
      const type = a.type ?? "parent";
      const c = await run("constrain(P['s'], P['c'], P['p'], P['b'], P['t'], P['m'], P['k'])", {
        s: a.sequence, c: a.child, p: a.parent, b: a.bone ?? null, t: type, m: a.maintainOffset ?? (type !== "look_at"), k: a.keys ?? null });
      if (!c.ok) return text(`Error: ${c.error}`, true);
      const keys = (c.keys as [number, boolean][]);
      const lines = [`${c.type} '${a.child}' -> '${a.parent}'${a.bone ? "." + a.bone : ""}; active keys read back: ${keys.map(([f, v]) => `f${f} ${v ? "on" : "off"}`).join(", ") || "NONE"}`];
      const want = a.keys ?? [{ frame: 0, active: true }];
      const missing = want.filter((k) => !keys.some(([f, v]) => f === k.frame && v === k.active) && !(k.frame === 0 && !k.active));
      if (missing.length) return text([...lines, `KEYS NOT WRITTEN: ${missing.map((k) => `f${k.frame}`).join(", ")}`].join("\n"), true);
      const end = a.end ?? Math.max(...keys.map(([f]) => f), 0) + 12;
      const fl = sampleFrames(keys, end);
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: fl[0] });
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: fl[0] });
      const samples: PairSample[] = [];
      for (let i = 0; i < fl.length; i++) {
        const p = await run("sample_pair(P['s'], P['c'], P['p'], P['b'], P['nx'], P['aim'])", {
          s: a.sequence, c: a.child, p: a.parent, b: a.bone ?? null, nx: i + 1 < fl.length ? fl[i + 1] : null, aim: type === "look_at" });
        if (!p.ok) return text(`Error sampling f${fl[i]}: ${p.error}`, true);
        samples.push(p as unknown as PairSample);
      }
      const v = constraintChecks(type, keys, samples);
      return text([v.bad ? `CONSTRAINT CHECK FAILED (${v.bad}):` : "Constraint verified:", ...lines, ...v.lines,
        `Sampled ${samples.length} frame(s) ${fl[0]}-${fl[fl.length - 1]}.`].join("\n"), v.bad > 0);
    },
  );
}
