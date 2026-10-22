import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): curve editing on sequence channels (Tools/python/ue_curve.py): key
// interpolation (constant / linear / cubic), tangent mode (auto / user / break), pre/post infinity (constant, linear,
// cycle, cycle_with_offset, oscillate) on transform or property channels. Verified by reading the modes back and, with
// `expect`, by the live value at frames (e.g. after the last key). Live: a prop keyed 0 -> 90 deg yaw over 24 frames
// with linear keys + post-infinity cycle_with_offset turned 135 / 180 / 225 deg at frames 36 / 48 / 60.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_props_track.py", "ue_curve.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Angle-aware difference for rotation channels (wraps at 360). Exported for tests. */
export function channelDiff(channel: string, a: number, b: number): number {
  if (channel.startsWith("Rotation")) return Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return Math.abs(a - b);
}

export function registerSeqCurveTools(server: McpServer): void {
  server.tool(
    "seq_curve",
    "CURVE EDITING on a binding's channels (Sequencer curve editor): key interpolation constant | linear | cubic, " +
      "tangent mode auto | user | break, and pre/post-infinity constant | linear | cycle | cycle_with_offset | oscillate " +
      "(loops without more keys: a spinning fan, a swinging sign). Target the Transform track (channels Location.X, " +
      "Rotation.Z...) or a property track (`property` path, e.g. 'Intensity' with component 'LightComponent0'). Modes " +
      "are read back; `expect` [{frame, channel, value}] checks the live value (e.g. past the last key).",
    {
      sequence: z.string(),
      binding: z.string(),
      component: z.string().optional(),
      property: z.string().optional().describe("Property path; default the Transform track."),
      channels: z.array(z.string()).optional().describe("Channel names (default all), e.g. ['Rotation.Z']."),
      interpolation: z.enum(["constant", "linear", "cubic"]).optional(),
      tangent: z.enum(["auto", "user", "break"]).optional(),
      preInfinity: z.enum(["constant", "linear", "cycle", "cycle_with_offset", "oscillate"]).optional(),
      postInfinity: z.enum(["constant", "linear", "cycle", "cycle_with_offset", "oscillate"]).optional(),
      expect: z.array(z.object({ frame: z.number().int(), channel: z.string(), value: z.number() }).strict()).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("curve_set(P['s'], P['b'], P['c'], P['p'], P['ch'], P['i'], P['t'], P['pre'], P['post'])", {
        s: a.sequence, b: a.binding, c: a.component ?? null, p: a.property ?? "Transform", ch: a.channels ?? null,
        i: a.interpolation ?? null, t: a.tangent ?? null, pre: a.preInfinity ?? null, post: a.postInfinity ?? null });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const ex = (s: string | undefined) => (s ? `RCCE_${s.toUpperCase()}` : null);
      let bad = 0;
      const lines = (r.channels as any[]).map((c) => {
        const errs: string[] = [];
        if (a.interpolation && !(c.interp.length === 1 && c.interp[0] === `RCIM_${a.interpolation.toUpperCase()}`)) errs.push(`interp ${c.interp}`);
        if (a.tangent && a.interpolation !== "linear" && a.interpolation !== "constant" && !(c.tangent.length === 1 && c.tangent[0] === `RCTM_${a.tangent.toUpperCase()}`)) errs.push(`tangent ${c.tangent}`);
        if (a.preInfinity && c.pre !== ex(a.preInfinity)) errs.push(`pre ${c.pre}`);
        if (a.postInfinity && c.post !== ex(a.postInfinity)) errs.push(`post ${c.post}`);
        if (errs.length) bad++;
        return `  ${c.channel}: ${c.keys} keys, ${c.interp.join("/")}${c.tangent.length ? ` ${c.tangent.join("/")}` : ""}, pre ${c.pre}, post ${c.post}${errs.length ? "  <- " + errs.join("; ") : ""}`;
      });
      for (const e of a.expect ?? []) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f: e.frame });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f: e.frame });
        const v = await run("channel_live(P['s'], P['b'], P['c'], P['p'], P['ch'])", { s: a.sequence, b: a.binding, c: a.component ?? null, p: a.property ?? "Transform", ch: e.channel });
        if (!v.ok) return text(`Error reading ${e.channel}@${e.frame}: ${v.error}`, true);
        const d = channelDiff(e.channel, v.value, e.value);
        const ok = d <= Math.max(0.01, Math.abs(e.value) * 0.001);
        if (!ok) bad++;
        lines.push(`  f${e.frame} ${e.channel}: live ${v.value}, expected ${e.value}${ok ? "" : "  <- FAIL"}`);
      }
      return text([`${bad ? `CURVE CHECK FAILED (${bad})` : "Curves set and verified"} on ${a.binding}${a.component ? "." + a.component : ""} ${a.property ?? "Transform"}:`, ...lines].join("\n"), bad > 0);
    },
  );
}
