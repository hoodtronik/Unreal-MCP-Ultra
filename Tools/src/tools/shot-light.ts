import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { imageStats, regionColour, type Region } from "../png.js";
import { runPose, type PoseResult } from "./posing.js";
import { boxRegion, still } from "./shot-look.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): lighting a subject relative to the SHOT CAMERA (Tools/python/ue_lightrig.py):
// key / fill / rim by azimuth (0 = from the camera, +90 = camera right, 180 = behind) and elevation, aimed at a bone.
// Spawnable light in the sequence; position and aim go into its transform track (the template location alone is
// overridden by the track). Verified on before/after MRQ stills of the cut camera: the subject brightens, the side
// facing the light brightens more, and a coloured / temperature light shifts the subject's colour the right way.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_stills.py", "ue_look.py", "ue_props_track.py", "ue_lightrig.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Left / right halves of a region. Exported for tests. */
export function halves(r: Region): [Region, Region] {
  const m = (r[0] + r[2]) / 2;
  return [[r[0], r[1], m, r[3]], [m, r[1], r[2], r[3]]];
}

export function registerShotLightTools(server: McpServer): void {
  server.tool(
    "shot_light",
    "LIGHT A SUBJECT FOR THE SHOT: a spot / point / rect light in the sequence placed around a subject RELATIVE TO THE " +
      "CAMERA - azimuth 0 = from the camera, +45 = classic key from camera-right, -60 = fill from the left, 160-180 = " +
      "rim from behind - at an elevation and distance, aimed at a bone, with intensity, colour [r,g,b] or temperature " +
      "(K), spot cone [inner, outer] and size (source radius / rect width,height). Re-running with the same name moves " +
      "it. VERIFIED on before/after renders of the cut camera at `frame`: aim error, the subject brightens, the lit " +
      "side brightens more than the other, colour / temperature shifts the subject's colour. remove=true deletes it.",
    {
      sequence: z.string(),
      name: z.string().describe("Light binding name, e.g. Key, Fill, Rim."),
      subject: z.string(),
      camera: z.string(),
      frame: z.number().int(),
      kind: z.enum(["spot", "point", "rect"]).optional(),
      bone: z.string().optional().describe("Aim / measure point (default head)."),
      azimuth: z.number().min(-180).max(180).optional().describe("Degrees from the camera side; + = camera right (default 45)."),
      elevation: z.number().min(-60).max(89).optional().describe("Default 30."),
      distance: z.number().positive().optional().describe("cm from the subject point (default 250)."),
      intensity: z.number().nonnegative().optional().describe("In the light's units (5.6 default candelas for spot/point, cd/ rect)."),
      color: z.array(z.number().min(0)).length(3).optional(),
      temperature: z.number().min(1700).max(12000).optional(),
      cone: z.array(z.number().min(0).max(80)).length(2).optional(),
      size: z.array(z.number().nonnegative()).min(1).max(2).optional(),
      shadows: z.boolean().optional(),
      remove: z.boolean().optional(),
      verify: z.boolean().optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.remove) {
        const r = await run("light_remove(P['s'], P['n'])", { s: a.sequence, n: a.name });
        return r.ok ? text(`Removed light '${a.name}'.`) : text(`Error: ${r.error}`, true);
      }
      for (let i = 0; i < 2; i++) await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frame });
      const verify = a.verify ?? true;
      const w = a.width ?? 960, h = a.height ?? 540;
      const sb = await run("screen_boxes(P['s'], P['c'], [P['n']])", { s: a.sequence, c: a.camera, n: a.subject });
      const bx = sb.ok ? (sb.boxes as Record<string, { u?: number[]; v?: number[] }>)[a.subject] : undefined;
      if (verify && !(bx?.u && bx?.v)) return text(`Error: '${a.subject}' is not in front of '${a.camera}' at f${a.frame}`, true);
      // CLAUDE-NOTE: the screen box spans the whole skeleton (v can run off-frame); clamp to the visible frame
      const subj = bx?.u && bx?.v ? boxRegion(bx.u, bx.v) : null;
      const imgA = verify ? await still(a.sequence, a.frame, w, h, "light_before", 300) : null;
      if (typeof imgA === "string") return text(`Error: ${imgA}`, true);
      const r = await run(
        "light_place(P['s'], P['n'], P['sub'], P['c'], P['k'], P['b'], P['az'], P['el'], P['d'], P['i'], P['col'], P['t'], P['cone'], P['size'], P['sh'])",
        { s: a.sequence, n: a.name, sub: a.subject, c: a.camera, k: a.kind ?? "spot", b: a.bone ?? "head", az: a.azimuth ?? 45,
          el: a.elevation ?? 30, d: a.distance ?? 250, i: a.intensity ?? null, col: a.color ?? null, t: a.temperature ?? null,
          cone: a.cone ?? null, size: a.size ?? null, sh: a.shadows ?? true });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`'${a.name}' ${r.kind} at ${JSON.stringify(r.location)}, ${r.distance} cm from ${a.subject}.${a.bone ?? "head"}, ` +
        `${r.intensity} ${r.units}${r.temperature ? `, ${r.temperature} K` : ""}${r.cone ? `, cone ${JSON.stringify(r.cone)}` : ""}.`];
      let bad = 0;
      const check = (ok: boolean, line: string) => { if (!ok) bad++; lines.push(`  ${line}${ok ? "" : "  <- NOT AS SET"}`); };
      check((r.aim_error_deg as number) <= 1, `aim error ${r.aim_error_deg} deg`);
      if (!verify || !imgA || !subj) return text([bad ? "LIGHT CHECK FAILED:" : "Light placed:", ...lines].join("\n"), bad > 0);
      const imgB = await still(a.sequence, a.frame, w, h, "light_after", 300);
      if (typeof imgB === "string") return text(`Error: ${imgB}`, true);
      const cA = regionColour(imgA, subj), cB = regionColour(imgB, subj);
      const az = a.azimuth ?? 45;
      const rim = Math.abs(az) >= 135;
      const dl = +(cB.luma - cA.luma).toFixed(2);
      if (rim) lines.push(`  rim: subject luma ${cA.luma} -> ${cB.luma} (${dl >= 0 ? "+" : ""}${dl}; a back light mostly lights edges - judge by eye)`);
      else check(dl >= 2, `subject luma ${cA.luma} -> ${cB.luma} (${dl >= 0 ? "+" : ""}${dl}, must rise >= 2)`);
      if (!rim && Math.abs(az) >= 20) {
        const [L, R] = halves(subj);
        const dL = regionColour(imgB, L).luma - regionColour(imgA, L).luma, dR = regionColour(imgB, R).luma - regionColour(imgA, R).luma;
        const want = az > 0 ? "right" : "left";
        check(az > 0 ? dR > dL : dL > dR, `side: screen-left +${dL.toFixed(1)}, screen-right +${dR.toFixed(1)} (light from camera ${want})`);
      }
      const rb = (c: { r: number; b: number }) => c.r / Math.max(1, c.b);
      if (a.temperature !== undefined && !rim && a.temperature !== 6500) {
        const warm = a.temperature < 6500;
        check(warm ? rb(cB) > rb(cA) : rb(cB) < rb(cA), `temperature ${a.temperature} K: subject R/B ${rb(cA).toFixed(3)} -> ${rb(cB).toFixed(3)} (${warm ? "warmer" : "cooler"})`);
      }
      if (a.color && !rim) {
        const ch = ["r", "g", "b"] as const;
        const top = ch[a.color.indexOf(Math.max(...a.color))];
        const share = (c: { r: number; g: number; b: number }) => c[top] / Math.max(1, c.r + c.g + c.b);
        check(share(cB) > share(cA), `colour ${JSON.stringify(a.color)}: subject ${top} share ${share(cA).toFixed(3)} -> ${share(cB).toFixed(3)}`);
      }
      const clip = imageStats(imgB, subj).clipped;
      lines.push(`  subject clipped ${(clip * 100).toFixed(1)}%${clip > 0.05 ? "  (blown highlights: lower intensity or exposure)" : ""}`);
      return text([bad ? "LIGHT CHECK FAILED:" : "Light placed and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
