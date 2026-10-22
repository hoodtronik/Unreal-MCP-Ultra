import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { decodePng, imageStats, regionColour, sharpness, type Image, type Region } from "../png.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): the camera look (Tools/python/ue_look.py) - DoF focused on a subject, white
// balance, saturation / contrast / gain wheels, vignette, bloom, grain - written to the camera template AND the live
// instance (same split as shot_camera). Verified by rendering the cut camera at one frame before and after through
// MRQ (warm-up, no motion blur) and measuring the pixels: sharpness (Laplacian) on the subject vs the rest of the
// frame, chroma, R/B balance, luma std, corner/centre falloff. Calibration and thresholds: see LOOK_CHECKS below.

export const LOOK_LIBS = ["ue_posing.py", "ue_shot.py", "ue_stills.py", "ue_look.py"];
const LIBS = LOOK_LIBS;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Screen box (u,v in [-1,1], v up) -> image region fractions (y down), clamped. Exported for tests. */
export function boxRegion(u: number[], v: number[]): Region {
  const c = (x: number) => Math.min(1, Math.max(0, x));
  return [c((1 + u[0]) / 2), c((1 - v[1]) / 2), c((1 + u[1]) / 2), c((1 - v[0]) / 2)];
}

/** Mean sharpness of the frame OUTSIDE a region, from the full-frame and region means (area-weighted). */
export function outsideSharpness(full: number, inside: number, r: Region): number {
  const a = (r[2] - r[0]) * (r[3] - r[1]);
  return a >= 0.98 ? 0 : +((full - inside * a) / (1 - a)).toFixed(3);
}

type Measure = { colour: ReturnType<typeof regionColour>; std: number; sharp: number; subjSharp: number; bgSharp: number; corners: number; centre: number };

function measure(img: Image, subj: Region | null): Measure {
  const full = sharpness(img);
  const s = subj ? sharpness(img, subj) : 0;
  const corner = (r: Region) => regionColour(img, r).luma;
  return {
    colour: regionColour(img), std: imageStats(img).std, sharp: full, subjSharp: s, bgSharp: subj ? outsideSharpness(full, s, subj) : 0,
    corners: +((corner([0, 0, 0.12, 0.12]) + corner([0.88, 0, 1, 0.12]) + corner([0, 0.88, 0.12, 1]) + corner([0.88, 0.88, 1, 1])) / 4).toFixed(2),
    centre: regionColour(img, [0.4, 0.4, 0.6, 0.6]).luma,
  };
}

export async function still(seq: string, frame: number, w: number, h: number, tag: string, timeoutSec: number): Promise<Image | string> {
  const st = await run("look_render(P['s'], P['f'], P['w'], P['h'], P['t'])", { s: seq, f: frame, w, h, t: tag });
  if (!st.ok) return `render ${tag}: ${st.error}`;
  const deadline = Date.now() + timeoutSec * 1000;
  let saw = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await run("stills_status(P['o'], P['p'])", { o: st.out_dir, p: st.prefix });
    if (!s.ok) return `render ${tag}: ${s.error}`;
    if (s.rendering) saw = true;
    const files = s.files as string[];
    if (!s.rendering && (saw || files.length) && files.length) return decodePng(readFileSync(`${st.out_dir}/${files[0]}`));
  }
  return `render ${tag}: timed out`;
}

export function registerShotLookTools(server: McpServer): void {
  server.tool(
    "shot_look",
    "THE CAMERA LOOK for a sequence camera: depth of field focused on a subject (distance measured from the camera to " +
      "a bone at `frame`), f-stop, white balance (temperature K / tint), saturation, contrast, gain, vignette, bloom, " +
      "film grain. Written to the camera's template and live instance (persists in the sequence). VERIFIED by rendering " +
      "the camera cut at `frame` BEFORE and AFTER (MRQ, warm-up) and measuring the pixels: subject stays sharp while the " +
      "rest softens, chroma / R-B balance / contrast / corner falloff move the way the setting says.",
    {
      sequence: z.string(),
      camera: z.string().describe("Camera binding name (it must own the cut at `frame`)."),
      frame: z.number().int(),
      focus: z.object({ subject: z.string(), bone: z.string().optional(), fstop: z.number().positive().optional() }).optional()
        .describe("Focus on a binding / level actor (bone default head)."),
      focusDistance: z.number().positive().optional().describe("Manual focus distance in cm (instead of focus)."),
      fstop: z.number().positive().optional(),
      whiteTemp: z.number().min(1500).max(15000).optional().describe("White balance temperature in K (default 6500)."),
      whiteTint: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(0).max(2).optional(),
      contrast: z.number().min(0).max(2).optional(),
      gain: z.number().min(0).max(4).optional(),
      vignette: z.number().min(0).max(1).optional(),
      bloom: z.number().min(0).max(8).optional(),
      grain: z.number().min(0).max(1).optional(),
      subject: z.string().optional().describe("Actor whose screen box is 'the subject' for the sharpness check (default focus.subject)."),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      verify: z.boolean().optional().describe("Render before/after and measure (default true)."),
      timeoutSec: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const settings: Record<string, unknown> = {};
      if (a.focus) settings.focus = a.focus;
      if (a.focusDistance !== undefined) settings.focus_distance = a.focusDistance;
      if (a.fstop !== undefined) settings.fstop = a.fstop;
      const map: [keyof typeof a, string][] = [["whiteTemp", "white_temp"], ["whiteTint", "white_tint"], ["saturation", "saturation"],
        ["contrast", "contrast"], ["gain", "gain"], ["vignette", "vignette"], ["bloom", "bloom"], ["grain", "grain"]];
      for (const [k, p] of map) if (a[k] !== undefined) settings[p] = a[k];
      if (!Object.keys(settings).length) return text("Nothing to set.", true);
      for (let i = 0; i < 2; i++) await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frame });   // bones refresh between calls
      const before = await run("look_read(P['s'], P['c'])", { s: a.sequence, c: a.camera });
      if (!before.ok) return text(`Error: ${before.error}`, true);
      const verify = a.verify ?? true;
      const w = a.width ?? 960, h = a.height ?? 540, tmo = a.timeoutSec ?? 300;
      const subjName = a.subject ?? a.focus?.subject;
      let subj: Region | null = null;
      if (subjName) {
        const sb = await run("screen_boxes(P['s'], P['c'], [P['n']])", { s: a.sequence, c: a.camera, n: subjName });
        const bx = sb.ok ? (sb.boxes as Record<string, { u?: number[]; v?: number[] }>)[subjName] : undefined;
        if (bx?.u && bx?.v) subj = boxRegion(bx.u, bx.v);
      }
      const imgA = verify ? await still(a.sequence, a.frame, w, h, "before", tmo) : null;
      if (typeof imgA === "string") return text(`Error: ${imgA}`, true);
      const ap = await run("look_apply(P['s'], P['c'], P['k'])", { s: a.sequence, c: a.camera, k: settings });
      if (!ap.ok) return text(`Error: ${ap.error}`, true);
      const look = ap.look as Record<string, number | string>;
      const lines = [`Look on '${a.camera}': ${Object.entries(look).map(([k, v]) => `${k} ${v}`).join(", ")}.`];
      if (!verify || !imgA) return text(lines.join("\n"));
      const imgB = await still(a.sequence, a.frame, w, h, "after", tmo);
      if (typeof imgB === "string") return text(`Error: ${imgB}`, true);
      const A = measure(imgA, subj), B = measure(imgB, subj);
      const prev = before.look as Record<string, number>;
      let bad = 0;
      const check = (ok: boolean, line: string) => { if (!ok) bad++; lines.push(`  ${line}${ok ? "" : "  <- NOT AS SET"}`); };
      const rr = (x: number, y: number) => (y > 0 ? x / y : 1);
      if (settings.focus || settings.focus_distance !== undefined || settings.fstop !== undefined) {
        if (subj) {
          const kept = rr(B.subjSharp, A.subjSharp), bg = rr(B.bgSharp, A.bgSharp);
          const shallow = (look.fstop as number) <= 4;
          // CLAUDE-NOTE (live, SEQ_Build22 f36, hero at 323 cm, f/1.4): subject 9.95 -> 8.61 (x0.86), rest 1.99 -> 1.59
          // (x0.80) and the eyes agreed (statue / table soft, hero crisp). Before the focus tracks were written the
          // whole frame went soft (subject x0.27) - the check exists to catch exactly that.
          check(kept >= 0.8, `focus: subject sharpness ${A.subjSharp} -> ${B.subjSharp} (x${kept.toFixed(2)}, must stay >= 0.8)`);
          if (shallow && A.bgSharp > 0.3) check(bg <= 0.85, `defocus: rest of frame ${A.bgSharp} -> ${B.bgSharp} (x${bg.toFixed(2)}, f/${look.fstop} should soften it)`);
          else lines.push(`  defocus: rest of frame ${A.bgSharp} -> ${B.bgSharp} (not checked: f/${look.fstop}${A.bgSharp <= 0.3 ? ", featureless background" : ""})`);
        } else lines.push(`  focus: no subject box (pass subject) - frame sharpness ${A.sharp} -> ${B.sharp}`);
      }
      const rb = (m: Measure) => rr(m.colour.r, m.colour.b);
      if (settings.white_temp !== undefined) {
        const t0 = prev.white_temp ?? 6500, t1 = settings.white_temp as number;
        // UE's white balance treats `temp` as the light that should read white: a LOWER temp cools the image.
        const want = t1 < t0 ? -1 : t1 > t0 ? 1 : 0;
        const d = rb(B) - rb(A);
        const line = `white balance ${t0} -> ${t1} K: R/B ${rb(A).toFixed(3)} -> ${rb(B).toFixed(3)}`;
        // CLAUDE-NOTE (live): 6500 -> 3200 K gave R/B 0.958 -> 0.669, 3200 -> 10000 gave 0.669 -> 1.042; with saturation
        // 0.3 in the same call it read 0.958 -> 0.969 (desaturation pulls R/B to 1), so that combination is not judged.
        if (settings.saturation !== undefined) lines.push(`  ${line} (not checked: saturation changed in the same call)`);
        else check(want === 0 || Math.sign(d) === want && Math.abs(d) > 0.02, line);
      }
      if (settings.saturation !== undefined) {
        const s = settings.saturation as number, p = prev.saturation ?? 1, k = rr(B.colour.chroma, A.colour.chroma);
        check(s < p ? k < 1 - (p - s) * 0.3 : s > p ? k > 1 + (s - p) * 0.1 : true, `saturation ${p} -> ${s}: chroma ${A.colour.chroma} -> ${B.colour.chroma} (x${k.toFixed(2)})`);
      }
      if (settings.contrast !== undefined) {
        const c = settings.contrast as number, p = prev.contrast ?? 1, k = rr(B.std, A.std);
        check(c < p ? k < 0.97 : c > p ? k > 1.03 : true, `contrast ${p} -> ${c}: luma std ${A.std} -> ${B.std} (x${k.toFixed(2)})`);
      }
      if (settings.gain !== undefined) {
        const g = settings.gain as number, p = prev.gain ?? 1, k = rr(B.colour.luma, A.colour.luma);
        check(g < p ? k < 0.97 : g > p ? k > 1.03 : true, `gain ${p} -> ${g}: mean luma ${A.colour.luma} -> ${B.colour.luma} (x${k.toFixed(2)})`);
      }
      if (settings.vignette !== undefined) {
        const v = settings.vignette as number, p = prev.vignette ?? 0.4;
        const fa = rr(A.corners, A.centre), fb = rr(B.corners, B.centre);
        if (A.centre < 5) lines.push(`  vignette ${p} -> ${v}: centre too dark to measure falloff`);
        else check(v > p ? fb < fa - 0.02 : v < p ? fb > fa + 0.02 : true, `vignette ${p} -> ${v}: corner/centre ${fa.toFixed(3)} -> ${fb.toFixed(3)}`);
      }
      for (const k of ["bloom", "grain", "white_tint"]) if (settings[k] !== undefined) lines.push(`  ${k} ${settings[k]}: set (read back ${look[k]}); not measured`);
      lines.push(`  frames: ${w}x${h}, f${a.frame}, mean luma ${A.colour.luma} -> ${B.colour.luma}`);
      return text([bad ? "LOOK CHECK FAILED:" : "Look applied and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
