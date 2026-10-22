import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): keyed follow camera (Tools/python/ue_camfollow.py). Per key frame the subject is
// scrubbed (bones update between calls), the camera's transform keyed to aim at the bone (pan: fixed position; truck:
// bone + offset, height locked) and the focus distance keyed. Checked on IN-BETWEEN frames through the live camera:
// SEQ_Follow walker, keys every 4 frames - pan |u|,|v| <= 0.093, focus within 1%; truck <= 0.066, focus 0.4%.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_camfollow.py"];
export const FOLLOW_UV_TOL = 0.15;
export const FOCUS_TOL = 0.03;
const vec3 = z.array(z.number()).length(3);

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Key frames from start to end (inclusive) every n, always including end. Exported for tests. */
export function keyFrames(start: number, end: number, every: number): number[] {
  const out: number[] = [];
  for (let f = start; f < end; f += Math.max(1, every)) out.push(f);
  out.push(end);
  return out;
}

/** Midpoints between consecutive key frames (where interpolation error is largest). Exported for tests. */
export function midFrames(keys: number[]): number[] {
  return keys.slice(1).map((k, i) => Math.floor((keys[i] + k) / 2)).filter((f, i, a) => a.indexOf(f) === i);
}

export function registerShotFollowTools(server: McpServer): void {
  server.tool(
    "shot_camera_follow",
    "Make a sequence camera FOLLOW a moving character: keys the camera every `every` frames over `frames` to aim at " +
      "the subject's bone - mode 'pan' (camera stays at `location`, turns) or 'truck' (camera travels at bone + `offset`, " +
      "height locked) - and pulls focus (manual focus distance keyed to the bone; optional aperture for shallow depth " +
      "of field). VERIFIED on the in-between frames through the live camera: the bone stays near frame centre and in " +
      "focus. Create the camera and its cut with shot_camera first.",
    {
      sequence: z.string(),
      camera: z.string(),
      subject: z.string(),
      bone: z.string().optional().describe("Default spine_03."),
      mode: z.enum(["pan", "truck"]),
      location: vec3.optional().describe("pan: camera position (default: where it is)."),
      offset: vec3.optional().describe("truck: camera = bone + offset (world cm)."),
      frames: z.array(z.number().int()).length(2).describe("[start, end] frames to key (inclusive)."),
      every: z.number().int().min(1).optional().describe("Key spacing in frames (default 4)."),
      screen: z.array(z.number()).length(2).optional().describe("Where the bone sits in frame, [u, v] in -1..1 (0,0 = centre; v -0.25 leaves headroom when aiming at the chest; u leads the subject)."),
      focus: z.boolean().optional().describe("Key the focus distance (default true)."),
      aperture: z.number().optional().describe("f-stop, e.g. 2.8 for a soft background."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const base = { s: a.sequence, c: a.camera, sub: a.subject, b: a.bone ?? "spine_03" };
      const focus = a.focus ?? true;
      if (focus || a.aperture) {
        const su = await run("follow_setup(P['s'], P['c'], P['ap'])", { ...base, ap: a.aperture ?? null });
        if (!su.ok) return text(`Error: ${su.error}`, true);
      }
      const keys = keyFrames(a.frames[0], a.frames[1], a.every ?? 4);
      let prev: number | null = null;
      let lockZ: number | null = null;
      const keyed: string[] = [];
      for (const f of keys) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const r = await run("follow_key(P['s'], P['c'], P['sub'], P['b'], P['f'], P['m'], P['o'], P['l'], P['lead'], P['fo'], P['py'], P['lz'], P['sc'])", {
          ...base, f, m: a.mode, o: a.offset ?? null, l: a.location ?? null, lead: 0, fo: focus, py: prev, lz: lockZ, sc: a.screen ?? null });
        if (!r.ok) return text(`Error keying f${f}: ${r.error}`, true);
        prev = r.yaw;
        if (a.mode === "truck" && lockZ === null) lockZ = r.location[2];
        keyed.push(`f${f} [${r.location.map((v: number) => v.toFixed(0)).join(",")}] yaw ${r.yaw.toFixed(1)}${focus ? ` focus ${r.focus_cm.toFixed(0)}` : ""}`);
      }
      const checks = midFrames(keys);
      const lines: string[] = [];
      let bad = 0;
      for (const f of checks) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const c = await run("follow_check(P['s'], P['c'], P['sub'], P['b'])", base);
        if (!c.ok) return text(`Error checking f${f}: ${c.error}`, true);
        const [tu, tv] = a.screen ?? [0, 0];
        const uvOk = c.u !== null && Math.abs(c.u - tu) <= FOLLOW_UV_TOL && Math.abs(c.v - tv) <= FOLLOW_UV_TOL;
        const fe = focus ? Math.abs(c.focus - c.dist) / c.dist : 0;
        const ok = uvOk && fe <= FOCUS_TOL && c.frame === f;
        if (!ok) bad++;
        lines.push(`  f${c.frame}: bone at u ${c.u}, v ${c.v}; ${c.dist} cm away${focus ? `, focus ${c.focus} (${(fe * 100).toFixed(1)}%)` : ""}${ok ? "" : "  <- FAIL"}`);
      }
      return text([`${bad ? `FOLLOW CHECK FAILED (${bad})` : "Follow verified"}: ${a.camera} ${a.mode} on ${a.subject}.${base.b}, ${keys.length} keys, checked ${checks.length} in-between frames (target ${JSON.stringify(a.screen ?? [0, 0])}, tol ${FOLLOW_UV_TOL}, focus ${FOCUS_TOL * 100}%).`,
        `  keys: ${keyed.join(" | ")}`, ...lines].join("\n"), bad > 0);
    },
  );
}
