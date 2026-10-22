import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): keyed property tracks on an actor or a component binding
// (Tools/python/ue_props_track.py), verified by reading the LIVE object at the key frames (and, for linear / constant
// keys, at the midpoints). Light colour is an 8-bit sRGB FColor on the component: a linear 0.4 key reads back as 170,
// so expected colours are converted linear -> sRGB before comparing (light 'Key' in SEQ_Lights: 500 -> 4250 -> 8000,
// colour (0.4,0.6,1.0) -> (170,203,255)).

const LIBS = ["ue_posing.py", "ue_props_track.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

type Val = number | boolean | number[];
type Key = { frame: number; value: Val };

/** Linear (sRGB-encoded) 8-bit value of a linear colour channel, as UE's FLinearColor::ToFColor(true). Exported for tests. */
export function toSrgb8(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** Expected value at a frame for linear / constant keys (auto keys only at key frames). Exported for tests. */
export function expectedAt(keys: Key[], frame: number, interp: "linear" | "constant" | "auto"): Val | null {
  const ks = [...keys].sort((a, b) => a.frame - b.frame);
  const exact = ks.find((k) => k.frame === frame);
  if (exact) return exact.value;
  if (interp === "auto") return null;
  const prev = [...ks].reverse().find((k) => k.frame < frame);
  const next = ks.find((k) => k.frame > frame);
  if (!prev) return ks[0].value;
  if (!next || interp === "constant" || typeof prev.value === "boolean") return prev.value;
  const t = (frame - prev.frame) / (next.frame - prev.frame);
  if (Array.isArray(prev.value)) return prev.value.map((v, i) => v + ((next.value as number[])[i] - v) * t);
  return (prev.value as number) + ((next.value as number) - (prev.value as number)) * t;
}

/** Compare a read value with the expected one; colours read as 0-255 are compared in sRGB. Exported for tests. */
export function matches(read: Val, want: Val, tol = 0.01): boolean {
  if (typeof want === "boolean" || typeof read === "boolean") return read === want;
  if (Array.isArray(want)) {
    const r = read as number[];
    const eightBit = r.some((x) => x > 1.5);
    const w = eightBit ? want.map((c) => toSrgb8(c)) : want;
    return w.every((x, i) => Math.abs(r[i] - x) <= (eightBit ? 1 : Math.max(tol, Math.abs(x) * tol)));
  }
  return Math.abs((read as number) - want) <= Math.max(tol, Math.abs(want) * tol);
}

const valIn = z.union([z.number(), z.boolean(), z.array(z.number()).min(3).max(4)]);

export function registerSeqPropertyTools(server: McpServer): void {
  server.tool(
    "seq_light",
    "Add a LIGHT to a sequence as a spawnable (point / spot / rect) at a location with a starting intensity and colour " +
      "[r,g,b] (linear 0-1). Animate it with seq_property (component 'LightComponent0', property 'Intensity' float or " +
      "'LightColor' color).",
    {
      sequence: z.string(), name: z.string(), kind: z.enum(["point", "spot", "rect"]).optional(),
      location: z.array(z.number()).length(3), intensity: z.number().optional(), color: z.array(z.number()).length(3).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("light_add(P['s'], P['n'], P['k'], tuple(P['l']), P['i'], P['c'] and tuple(P['c']))",
        { s: a.sequence, n: a.name, k: a.kind ?? "point", l: a.location, i: a.intensity ?? null, c: a.color ?? null });
      return r.ok ? text(`${r.created ? "Added" : "Found"} light '${a.name}' (${a.kind ?? "point"}).`) : text(`Error: ${r.error}`, true);
    },
  );

  server.tool(
    "seq_property",
    "KEY ANY PROPERTY of a sequence binding or one of its components over time (light intensity / colour, a " +
      "component's visibility, a float/bool/colour/vector property): kind float | bool | color | vector, keys " +
      "[{frame, value}], interpolation auto | linear | constant. VERIFIED by reading the live object at each key frame " +
      "(and the midpoints for linear / constant keys). Property names as in C++ (e.g. 'Intensity', 'LightColor', " +
      "'bVisible', 'FocusSettings.ManualFocusDistance').",
    {
      sequence: z.string(),
      binding: z.string(),
      component: z.string().optional().describe("Component name on the bound actor, e.g. LightComponent0."),
      property: z.string(),
      kind: z.enum(["float", "bool", "color", "vector"]),
      keys: z.array(z.object({ frame: z.number().int(), value: valIn }).strict()).min(1).max(40),
      interpolation: z.enum(["auto", "linear", "constant"]).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const interp = a.interpolation ?? "auto";
      const r = await run("prop_key(P['s'], P['b'], P['c'], P['p'], P['k'], P['keys'], P['i'])",
        { s: a.sequence, b: a.binding, c: a.component ?? null, p: a.property, k: a.kind, keys: a.keys, i: interp });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const kf = a.keys.map((k) => k.frame).sort((x, y) => x - y);
      const mids = interp === "auto" ? [] : kf.slice(1).map((f, i) => Math.floor((kf[i] + f) / 2)).filter((f) => !kf.includes(f));
      const lines: string[] = [];
      let bad = 0;
      for (const f of [...kf, ...mids]) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const rd = await run("prop_read(P['s'], P['b'], P['c'], P['p'])", { s: a.sequence, b: a.binding, c: a.component ?? null, p: a.property });
        if (!rd.ok) return text(`Error reading ${a.property}: ${rd.error}`, true);
        const want = expectedAt(a.keys as Key[], f, interp);
        const ok = want === null || matches(rd.value, want);
        if (!ok) bad++;
        lines.push(`  f${f}${kf.includes(f) ? "" : " (between keys)"}: ${JSON.stringify(rd.value)}${want !== null ? ` expected ${JSON.stringify(want)}` : ""}${ok ? "" : "  <- FAIL"}`);
      }
      const target = `${a.binding}${a.component ? "." + a.component : ""}.${a.property}`;
      return text([`${bad ? `PROPERTY CHECK FAILED (${bad})` : "Keyed and verified"}: ${target} (${r.track}, ${a.keys.length} keys, ${interp}).`, ...lines].join("\n"), bad > 0);
    },
  );
}
