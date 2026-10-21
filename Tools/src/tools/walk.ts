import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): LOCOMOTION in a LevelSequence (Tools/python/ue_walk.py). A character walks a path with
// an in-place (root-locked copy) locomotion clip while transform keys carry it at the clip's measured root speed;
// the foot report then proves the planted feet do not skate. Live findings behind the design (UE 5.6.1):
//  * add_spawnable_from_instance auto-adds the mesh's default animating rig (CR_Mannequin_Body). Its track
//    overrides the clip, so the walker slid along in reference pose with every anim-section property reading
//    back correctly - only the per-frame foot positions showed it. The walk strips that track.
//  * Clip speed = root displacement / length (MF_Unarmed_Walk_Fwd: 300 cm/s); planted balls then drift
//    ~0.3 cm/frame (foot roll) vs 4+ cm/frame at a wrong speed (calibration below).

const LIBS = ["ue_posing.py", "ue_walk.py"];
const vec3 = z.array(z.number()).length(3);
const DEFAULT_CLIP = "/Game/Characters/Mannequins/Anims/Unarmed/Walk/MF_Unarmed_Walk_Fwd";
const DEFAULT_MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
export const CONTACT_CM = 1.5;      // ball within this of its lowest height over the window = planted
export const SKATE_MEAN_CM = 0.8;   // mean planted slide per frame allowed
export const SKATE_MAX_CM = 2.0;    // worst single planted frame allowed

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export type FootFrame = { frame: number; bones: Record<string, number[]> };
export type FootSkate = { side: string; planted: number; mean: number; max: number; maxAt: number | null; lowest: number; stances: number };

/** Contact runs, merging gaps of <= 2 frames (contact flickers at the threshold during the heel-toe roll) and
 * keeping runs of >= 3 frames. Exported for tests. */
export function countStances(down: boolean[]): number {
  const runs: [number, number][] = [];
  down.forEach((d, i) => {
    if (!d) return;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= 3) last[1] = i;
    else runs.push([i, i]);
  });
  return runs.filter(([a, b]) => b - a + 1 >= 3).length;
}

/** Planted-foot slide per side from per-frame world positions of ball_l/ball_r (contact = ball near its lowest z).
 * Exported for tests. */
export function footSkate(frames: FootFrame[], contactCm = CONTACT_CM): FootSkate[] {
  const out: FootSkate[] = [];
  for (const side of ["l", "r"]) {
    const key = `ball_${side}`;
    const pts = frames.filter((f) => f.bones[key]).map((f) => ({ frame: f.frame, p: f.bones[key] }));
    if (pts.length < 2) continue;
    const lowest = Math.min(...pts.map((x) => x.p[2]));
    const down = pts.map((x) => x.p[2] <= lowest + contactCm);
    const steps: { d: number; at: number }[] = [];
    let stances = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && down[i] && down[i - 1] && pts[i].frame === pts[i - 1].frame + 1)
        steps.push({ d: Math.hypot(pts[i].p[0] - pts[i - 1].p[0], pts[i].p[1] - pts[i - 1].p[1]), at: pts[i].frame });
    }
    stances = countStances(down);
    const mean = steps.length ? steps.reduce((s, x) => s + x.d, 0) / steps.length : 0;
    const worst = steps.reduce<{ d: number; at: number } | null>((m, x) => (!m || x.d > m.d ? x : m), null);
    out.push({ side, planted: steps.length, mean: +mean.toFixed(2), max: +(worst?.d ?? 0).toFixed(2), maxAt: worst?.at ?? null, lowest: +lowest.toFixed(2), stances });
  }
  return out;
}

export const LOCK_CM = 1.5; // planted slide per frame above the straight-walk residual (max 1.16) gets locked

/** Cumulative actor offsets that cancel planted-ball slides above LOCK_CM, merged with a previous pass:
 * {frame: [dx, dy]} (cumulative, applied from that frame on). Exported for tests. */
export function lockOffsets(frames: FootFrame[], prev: Record<string, number[]> = {}, contactCm = CONTACT_CM, lockCm = LOCK_CM): Record<string, number[]> {
  const deltas: Record<number, number[]> = {};
  let last = [0, 0];
  for (const f of Object.keys(prev).map(Number).sort((x, y) => x - y)) {
    deltas[f] = [prev[f][0] - last[0], prev[f][1] - last[1]];
    last = prev[f];
  }
  for (const side of ["l", "r"]) {
    const key = `ball_${side}`;
    const pts = frames.filter((f) => f.bones[key]);
    if (pts.length < 2) continue;
    const lowest = Math.min(...pts.map((x) => x.bones[key][2]));
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      if (b.frame !== a.frame + 1 || a.bones[key][2] > lowest + contactCm || b.bones[key][2] > lowest + contactCm) continue;
      const dx = b.bones[key][0] - a.bones[key][0], dy = b.bones[key][1] - a.bones[key][1];
      if (Math.hypot(dx, dy) <= lockCm) continue;
      const c = deltas[b.frame] ?? [0, 0];
      deltas[b.frame] = [c[0] - dx, c[1] - dy];
    }
  }
  const out: Record<string, number[]> = {};
  let acc = [0, 0];
  for (const f of Object.keys(deltas).map(Number).sort((x, y) => x - y)) {
    acc = [acc[0] + deltas[f][0], acc[1] + deltas[f][1]];
    out[String(f)] = [+acc[0].toFixed(3), +acc[1].toFixed(3)];
  }
  return out;
}

async function readFeet(seq: string, binding: string, start: number, end: number): Promise<FootFrame[] | string> {
  await run("scrub(P['s'], P['f'])", { s: seq, f: start });
  await run("scrub(P['s'], P['f'])", { s: seq, f: start }); // the first scrub can land a tick late
  const rows: FootFrame[] = [];
  for (let f = start; f <= end; f++) {
    const r = await run("feet_now(P['s'], P['n'], P['nx'])", { s: seq, n: binding, nx: f < end ? f + 1 : null });
    if (!r.ok) return `frame ${f}: ${r.error}`;
    if (r.frame !== f) return `read frame ${r.frame} while expecting ${f} (stale evaluation)`;
    rows.push({ frame: r.frame, bones: r.bones });
  }
  return rows;
}

function verdict(sk: FootSkate[], floorZ: number): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = sk.length === 2;
  for (const s of sk) {
    const good = s.planted > 0 && s.mean <= SKATE_MEAN_CM && s.max <= SKATE_MAX_CM;
    const floor = s.lowest - floorZ;
    ok &&= good && Math.abs(floor) <= 2.5;
    lines.push(`  ${s.side === "l" ? "left " : "right"}: ${s.stances} stance(s), ${s.planted} planted frames, slide mean ${s.mean} / max ${s.max} cm/frame` +
      `${s.maxAt != null ? ` (f${s.maxAt})` : ""}; lowest ball ${floor >= 0 ? "+" : ""}${floor.toFixed(2)} cm vs floor${good ? "" : "  <- SKATING"}${Math.abs(floor) > 2.5 ? "  <- FLOAT/SINK" : ""}`);
  }
  return { ok, lines };
}

export function registerWalkTools(server: McpServer): void {
  server.tool(
    "anim_walk",
    "Walk a character along a path in a LevelSequence: plays a locomotion clip in place (root-locked copy saved " +
      "beside the sequence) and keys the actor through the waypoints at the clip's MEASURED root speed (or 'speed'), " +
      "turning to face each leg of the path. Creates the binding (no Control Rig - a rig track would override the " +
      "clip) if missing, extends playback to fit, then VERIFIES with the per-frame foot report: planted feet must " +
      "not skate and must sit on the floor. Returns the frame it reaches each waypoint (for blocking dialogue/cuts).",
    {
      sequence: z.string(),
      binding: z.string().describe("Walker binding name (created if missing)."),
      path: z.array(vec3).min(2).describe("World waypoints [x,y,z]; z = floor height under the feet."),
      clip: z.string().optional().describe(`Locomotion AnimSequence with root motion. Default ${DEFAULT_CLIP}.`),
      mesh: z.string().optional().describe(`SkeletalMesh when creating. Default ${DEFAULT_MESH}.`),
      startFrame: z.number().int().optional(),
      speed: z.number().optional().describe("cm/s override (feet will skate if it differs from the clip)."),
      playRate: z.number().optional().describe("Clip play rate; travel speed scales with it. Default 1."),
      turnFrames: z.number().optional().describe("Frames to turn at each corner. Default 6."),
      verify: z.boolean().optional().describe("Run the foot report over the walk (default true)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const params = { s: a.sequence, b: a.binding, path: a.path, clip: a.clip ?? DEFAULT_CLIP, mesh: a.mesh ?? DEFAULT_MESH, f0: a.startFrame ?? 0,
        v: a.speed ?? null, turn: a.turnFrames ?? 6, rate: a.playRate ?? 1 };
      const call = "walk(P['s'], P['b'], P['path'], P['clip'], P['mesh'], P['f0'], P['v'], P['turn'], P['rate'], 0, P['off'])";
      let w = await run(call, { ...params, off: {} });
      if (!w.ok) return text(`Error: ${w.error}`, true);
      const lines = [
        `${w.created ? "Created" : "Updated"} walker '${a.binding}': ${w.clip} at ${w.speed_cm_s} cm/s (clip root speed ${w.clip_speed_cm_s})` +
          `${w.removed_tracks?.length ? `; removed auto-added ${w.removed_tracks.join(", ")} track` : ""}.`,
        `Reaches waypoints at frames ${JSON.stringify(w.arrive_frames)}; headings ${JSON.stringify(w.yaws)} deg; ends f${w.end_frame}.`,
      ];
      if (a.verify === false) return text(lines.join("\n"));
      const start = Math.ceil(w.arrive_frames[0]);
      // the clip section ends at arrival (exclusive), so the last walking frame is end_frame - 1
      const end = Math.min(w.end_frame - 1, start + 150);
      let feet = await readFeet(a.sequence, a.binding, start, end);
      if (typeof feet === "string") return text(`${lines.join("\n")}\nFoot readback failed: ${feet}`, true);
      // foot lock: up to 3 passes while a planted ball still slides (corners: the body turns about its origin)
      let off: Record<string, number[]> = {};
      for (let pass = 0; pass < 3; pass++) {
        const next = lockOffsets(feet, off);
        if (JSON.stringify(next) === JSON.stringify(off)) break;
        off = next;
        w = await run(call, { ...params, off });
        if (!w.ok) return text(`Error: ${w.error}`, true);
        feet = await readFeet(a.sequence, a.binding, start, end);
        if (typeof feet === "string") return text(`${lines.join("\n")}\nFoot readback failed: ${feet}`, true);
        lines.push(`Foot lock pass ${pass + 1}: ${Object.keys(off).length} corrected frame(s); path shifted ${JSON.stringify(w.end_offset)} cm by the end.`);
      }
      const v = verdict(footSkate(feet), a.path[0][2]);
      lines.push(`${v.ok ? "Feet planted" : "FOOT CHECK FAILED"} over f${start}-${end}:`, ...v.lines);
      return text(lines.join("\n"), !v.ok);
    },
  );

  server.tool(
    "anim_foot_report",
    "Per-frame foot readback for any animated character in a sequence (clip, Control Rig or walk): finds the frames " +
      "each ball/toe is planted and measures how far it slides while planted (skating) and whether it floats or " +
      "sinks against the floor. One request per frame.",
    {
      sequence: z.string(),
      binding: z.string(),
      start: z.number().int(),
      end: z.number().int(),
      floorZ: z.number().optional().describe("Floor height, default 0."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.end - a.start > 300) return text("Range too long (max 300 frames per call).", true);
      const feet = await readFeet(a.sequence, a.binding, a.start, a.end);
      if (typeof feet === "string") return text(`Foot readback failed: ${feet}`, true);
      const v = verdict(footSkate(feet), a.floorZ ?? 0);
      return text([`${v.ok ? "Feet planted" : "FOOT CHECK FAILED"} over f${a.start}-${a.end}:`, ...v.lines].join("\n"), !v.ok);
    },
  );
}
