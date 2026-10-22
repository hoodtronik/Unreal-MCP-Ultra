import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): animation sequence editing on a COPY (Tools/python/ue_animedit.py). Live on
// the Manny walk: named notifies (AnimNotify_PlayMontageNotify / ...Window, the names montages react to), sync marker,
// float curve (accessor and AnimPose runtime evaluation agree: 0.5 at 0.375 s between keys 0 and 1), rate scale 0.5,
// crop frames 10-30 exact vs the source shifted by 10 (0.0001 cm) once sampling was RAW and un-retargeted.

const LIBS = ["ue_posing.py", "ue_animedit.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Linear interpolation of [t, v] keys (the default for add_float_curve_keys, measured live). Exported for tests. */
export function lerpKeys(keys: [number, number][], t: number): number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t <= k[i][0]) {
    const [t0, v0] = k[i - 1], [t1, v1] = k[i];
    return v0 + ((v1 - v0) * (t - t0)) / Math.max(t1 - t0, 1e-9);
  }
  return k[k.length - 1][1];
}

export function registerAnimEditTools(server: McpServer): void {
  server.tool(
    "anim_edit",
    "EDIT an animation clip (on a copy): crop to a frame range, add named notifies / notify windows (the names " +
      "montages and Blueprints react to, e.g. Footstep_L), sync markers, float curves (keys [[time, value]]) and the " +
      "rate scale. Crop runs first, so times are on the cropped clip. VERIFIED: everything read back; curves evaluated " +
      "between keys through the runtime pose path; the crop compared with the source shifted by `first`.",
    {
      source: z.string(),
      out: z.string().describe("Path of the edited copy (the source is never modified)."),
      crop: z.object({ first: z.number().int(), last: z.number().int() }).strict().optional().describe("Keep frames first..last (inclusive)."),
      notifies: z.array(z.object({ time: z.number(), name: z.string(), duration: z.number().optional(), track: z.string().optional() }).strict()).optional(),
      syncMarkers: z.array(z.object({ time: z.number(), name: z.string() }).strict()).optional(),
      curves: z.array(z.object({ name: z.string(), keys: z.array(z.tuple([z.number(), z.number()])).min(1) }).strict()).optional(),
      rate: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.out === a.source) return text("out must differ from source (edits go on a copy)", true);
      const c = await run("anim_copy(P['s'], P['d'])", { s: a.source, d: a.out });
      if (!c.ok) return text(`Error: ${c.error}`, true);
      const lines: string[] = [`Copied ${a.source} -> ${a.out}.`];
      let bad = 0;
      if (a.crop) {
        const r = await run("crop(P['d'], P['f'], P['l'])", { d: a.out, f: a.crop.first, l: a.crop.last });
        if (!r.ok) return text(`Crop failed: ${r.error}`, true);
        const n = (r.frames as number);
        const fr = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n];
        const v = await run("pose_shift_check(P['s'], P['d'], P['o'], P['fr'])", { s: a.source, d: a.out, o: a.crop.first, fr });
        if (!v.ok) return text(`Crop check failed: ${v.error}`, true);
        const worst = Math.max(...(v.frames as [number, number][]).map((x) => x[1]));
        if (worst > 0.05) bad++;
        lines.push(`Crop ${a.crop.first}-${a.crop.last}: ${n} frames, ${r.length} s; vs source shifted by ${a.crop.first}: worst ${worst} cm${worst > 0.05 ? "  <- CROP DOES NOT MATCH" : ""}`);
      }
      for (const n of a.notifies ?? []) {
        const r = await run("add_notify(P['d'], P['t'], P['n'], P['tr'], P['du'])", { d: a.out, t: n.time, n: n.name, tr: n.track ?? "MCP", du: n.duration ?? null });
        if (!r.ok) return text(`Notify ${n.name} failed: ${r.error}`, true);
      }
      for (const m of a.syncMarkers ?? []) {
        const r = await run("add_sync_marker(P['d'], P['t'], P['n'])", { d: a.out, t: m.time, n: m.name });
        if (!r.ok) return text(`Sync marker ${m.name} failed: ${r.error}`, true);
      }
      for (const cv of a.curves ?? []) {
        const r = await run("add_float_curve(P['d'], P['n'], P['t'], P['v'])", { d: a.out, n: cv.name, t: cv.keys.map((k) => k[0]), v: cv.keys.map((k) => k[1]) });
        if (!r.ok) return text(`Curve ${cv.name} failed: ${r.error}`, true);
      }
      if (a.rate !== undefined) {
        const r = await run("set_rate(P['d'], P['r'])", { d: a.out, r: a.rate });
        if (!r.ok) return text(`Rate failed: ${r.error}`, true);
      }
      // read back; curves evaluated at keys and midpoints
      const times = new Set<number>();
      for (const cv of a.curves ?? []) {
        const k = [...cv.keys].sort((x, y) => x[0] - y[0]);
        k.forEach((x, i) => { times.add(x[0]); if (i) times.add((k[i - 1][0] + x[0]) / 2); });
      }
      // CLAUDE-NOTE (live): an AnimPose evaluated at EXACTLY the clip end read a curve as 0 (accessor 0.2) - the end
      // wraps - so key times at/after the end are sampled 1 ms inside it.
      const len0 = (await run("anim_read(P['d'])", { d: a.out })).length as number;
      const rd = await run("anim_read(P['d'], P['t'])", { d: a.out, t: [...times].map((t) => (t >= len0 - 1e-3 ? len0 - 1e-3 : t)) });
      if (!rd.ok) return text(`Read back failed: ${rd.error}`, true);
      lines.push(`Length ${rd.length} s, ${rd.frames} frames, rate ${rd.rate}${a.rate !== undefined && Math.abs((rd.rate as number) - a.rate) > 1e-4 ? "  <- RATE NOT SET" : ""}`);
      if (a.rate !== undefined && Math.abs((rd.rate as number) - a.rate) > 1e-4) bad++;
      const ev = rd.notifies as { name: string; time: number; duration: number; class: string }[];
      for (const n of a.notifies ?? []) {
        const hit = ev.find((e) => e.name === n.name && Math.abs(e.time - n.time) < 1e-3 && Math.abs(e.duration - (n.duration ?? 0)) < 1e-3);
        if (!hit) bad++;
        lines.push(`  notify ${n.name} @${n.time}${n.duration ? ` for ${n.duration} s` : ""}: ${hit ? `read back (${hit.class})` : "MISSING"}`);
        if (n.time > (rd.length as number)) { bad++; lines.push("    <- after the end of the clip"); }
      }
      const sm = rd.sync_markers as { name: string; time: number }[];
      for (const m of a.syncMarkers ?? []) {
        const hit = sm.some((x) => x.name === m.name && Math.abs(x.time - m.time) < 1e-3);
        if (!hit) bad++;
        lines.push(`  sync marker ${m.name} @${m.time}: ${hit ? "read back" : "MISSING"}`);
      }
      const crv = rd.curves as Record<string, { keys: [number, number][]; eval?: [number, number, number][] }>;
      for (const cv of a.curves ?? []) {
        const got = crv[cv.name];
        if (!got) { bad++; lines.push(`  curve ${cv.name}: MISSING`); continue; }
        let worst = 0;
        for (const [t, acc, pose] of got.eval ?? []) worst = Math.max(worst, Math.abs(acc - lerpKeys(cv.keys, t)), Math.abs(pose - acc));
        if (worst > 0.01) bad++;
        lines.push(`  curve ${cv.name}: ${got.keys.length} keys; evaluated at ${(got.eval ?? []).length} times, worst error ${worst.toFixed(4)} (runtime pose vs accessor vs linear)${worst > 0.01 ? "  <- CURVE WRONG" : ""}`);
      }
      return text([bad ? "ANIM EDIT CHECK FAILED:" : "Clip edited and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
