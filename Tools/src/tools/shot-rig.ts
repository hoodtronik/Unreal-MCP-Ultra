import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): camera rigs (Tools/python/ue_rig.py). The rig is a spawnable CameraRig_Rail /
// CameraRig_Crane; the camera rides it through an Attach track on the rig's mount COMPONENT (RailCameraMount /
// CraneCameraMount) with its own transform as the offset; the rig's CurrentPositionOnRail / CranePitch / CraneYaw /
// CraneArmLength are keyed as actor property tracks. Live: the camera stayed on the mount (0 cm) and the rail mount on
// the spline point for the keyed position (0 cm) at keys and between keys; crane pitch -10 -> 35 lifted a 300 cm arm's
// mount 227 cm.

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_props_track.py", "ue_rig.py"];
const PROPS = { position: "CurrentPositionOnRail", pitch: "CranePitch", yaw: "CraneYaw", arm: "CraneArmLength" } as const;
const vec3 = z.array(z.number()).length(3);
const keysIn = z.array(z.object({ frame: z.number().int(), value: z.number() }).strict()).min(1).max(40);

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Linear value between keys at a frame (keys hold outside their range). Exported for tests. */
export function lerpKeys(keys: { frame: number; value: number }[], f: number): number {
  const ks = [...keys].sort((a, b) => a.frame - b.frame);
  if (f <= ks[0].frame) return ks[0].value;
  const n = ks.findIndex((k) => k.frame >= f);
  if (n < 0) return ks[ks.length - 1].value;
  const a = ks[n - 1], b = ks[n];
  if (!a) return b.value;
  return a.value + ((b.value - a.value) * (f - a.frame)) / (b.frame - a.frame);
}

export function registerShotRigTools(server: McpServer): void {
  server.tool(
    "shot_rig",
    "CAMERA RIGS for dolly and crane moves: adds a spawnable rail (spline points, local cm) or crane (arm length) to " +
      "a sequence, attaches an existing sequence camera (shot_camera) to its mount with a relative rotation, keys the " +
      "move (rail: position 0..1; crane: pitch / yaw deg, arm cm; linear) and VERIFIES at keys and between keys that " +
      "the live camera sits on the mount and, for a rail, that the mount is on the spline at the keyed position.",
    {
      sequence: z.string(),
      rig: z.string().describe("Rig binding name (created if missing)."),
      kind: z.enum(["rail", "crane"]),
      camera: z.string().describe("Existing camera binding to mount."),
      location: vec3.optional().describe("Rig location when creating (rail start / crane base)."),
      yaw: z.number().optional().describe("Rig yaw when creating (rail direction)."),
      railPoints: z.array(vec3).min(2).optional().describe("Rail spline points in the rig's local space (cm)."),
      arm: z.number().optional().describe("Crane arm length when creating (cm)."),
      cameraRotation: vec3.optional().describe("Camera rotation relative to the mount [pitch, yaw, roll]."),
      position: keysIn.optional().describe("Rail: CurrentPositionOnRail keys (0..1)."),
      pitch: keysIn.optional(), yawKeys: keysIn.optional(), armKeys: keysIn.optional(),
      aim: z.object({ subject: z.string(), bone: z.string().optional(), screen: z.array(z.number()).length(2).optional(),
        every: z.number().int().min(1).optional() }).strict().optional()
        .describe("Keep the mounted camera aimed at a subject's bone while the rig moves (keys the camera's mount-relative rotation every `every` frames, default 4; checked between keys)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const base = { s: a.sequence };
      const add = await run("rig_add(P['s'], P['n'], P['k'], tuple(P['loc']), P['yaw'], P['pts'], P['arm'])", {
        ...base, n: a.rig, k: a.kind, loc: a.location ?? [0, 0, 0], yaw: a.yaw ?? 0, pts: a.railPoints ?? null, arm: a.arm ?? null });
      if (!add.ok) return text(`Error: ${add.error}`, true);
      const m = await run("rig_mount(P['s'], P['c'], P['n'], P['k'], P['r'] and tuple(P['r']))", { ...base, c: a.camera, n: a.rig, k: a.kind, r: a.cameraRotation ?? null });
      if (!m.ok) return text(`Error mounting: ${m.error}`, true);
      const lines = [`${add.created ? "Added" : "Found"} ${a.kind} '${a.rig}'${add.rail_length ? ` (${add.rail_length} cm, ${add.points} points)` : ""}; '${a.camera}' mounted on ${a.kind === "rail" ? "RailCameraMount" : "CraneCameraMount"}.`];
      const sets: [keyof typeof PROPS, { frame: number; value: number }[] | undefined][] =
        [["position", a.position], ["pitch", a.pitch], ["yaw", a.yawKeys], ["arm", a.armKeys]];
      const frames = new Set<number>();
      for (const [k, keys] of sets) {
        if (!keys) continue;
        if ((k === "position") !== (a.kind === "rail")) return text(`Error: '${k}' keys do not apply to a ${a.kind}.`, true);
        const r = await run("prop_key(P['s'], P['b'], None, P['p'], 'float', P['keys'], 'linear')", { ...base, b: a.rig, p: PROPS[k], keys });
        if (!r.ok) return text(`Error keying ${PROPS[k]}: ${r.error}`, true);
        const ks = keys.map((x) => x.frame).sort((x, y) => x - y);
        ks.forEach((f) => frames.add(f));
        ks.slice(1).forEach((f, i) => frames.add(Math.floor((ks[i] + f) / 2)));
      }
      if (!frames.size) frames.add(0);
      const aimLines: string[] = [];
      let aimBad = 0;
      if (a.aim) {
        const all = [...frames].sort((x, y) => x - y);
        const f0 = all[0], f1 = all[all.length - 1];
        const step = a.aim.every ?? 4;
        const keyF: number[] = [];
        for (let f = f0; f < f1; f += step) keyF.push(f);
        keyF.push(f1);
        for (const f of keyF) {
          await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
          await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
          const k = await run("rig_aim_key(P['s'], P['c'], P['n'], P['k'], P['sub'], P['b'], P['f'], P['sc'])", {
            ...base, c: a.camera, n: a.rig, k: a.kind, sub: a.aim.subject, b: a.aim.bone ?? "spine_03", f, sc: a.aim.screen ?? null });
          if (!k.ok) return text(`Error aiming at f${f}: ${k.error}`, true);
        }
        const mids = keyF.slice(1).map((f, i) => Math.floor((keyF[i] + f) / 2));
        const [tu, tv] = a.aim.screen ?? [0, 0];
        for (const f of mids) {
          await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
          await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
          const c = await runPose("follow_check(P['s'], P['c'], P['sub'], P['b'])", { ...base, c: a.camera, sub: a.aim.subject, b: a.aim.bone ?? "spine_03" },
            ["ue_posing.py", "ue_shot.py", "ue_camfollow.py"]);
          if (!c.ok) return text(`Error checking aim at f${f}: ${c.error}`, true);
          const ok = c.u !== null && Math.abs(c.u - tu) <= 0.15 && Math.abs(c.v - tv) <= 0.15;
          if (!ok) aimBad++;
          aimLines.push(`  aim f${f}: bone at u ${c.u}, v ${c.v} (target ${tu}, ${tv})${ok ? "" : "  <- FAIL"}`);
        }
      }
      let bad = 0;
      for (const f of [...frames].sort((x, y) => x - y)) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
        const st = await run("rig_state(P['s'], P['c'], P['n'], P['k'])", { ...base, c: a.camera, n: a.rig, k: a.kind });
        if (!st.ok) return text(`Error at f${f}: ${st.error}`, true);
        const errs: string[] = [];
        if (st.camera_vs_mount_cm > 0.5) errs.push(`camera ${st.camera_vs_mount_cm} cm off the mount`);
        if (a.kind === "rail") {
          if (st.mount_vs_spline_cm > 0.5) errs.push(`mount ${st.mount_vs_spline_cm} cm off the spline`);
          if (a.position && Math.abs(st.position - lerpKeys(a.position, f)) > 1e-3) errs.push(`position ${st.position}`);
        } else {
          if (a.pitch && Math.abs(st.pitch - lerpKeys(a.pitch, f)) > 0.01) errs.push(`pitch ${st.pitch}`);
          if (a.yawKeys && Math.abs(st.yaw - lerpKeys(a.yawKeys, f)) > 0.01) errs.push(`yaw ${st.yaw}`);
          if (a.armKeys && Math.abs(st.arm - lerpKeys(a.armKeys, f)) > 0.1) errs.push(`arm ${st.arm}`);
        }
        if (errs.length) bad++;
        const detail = a.kind === "rail" ? `position ${st.position}` : `pitch ${st.pitch}, yaw ${st.yaw}, arm ${st.arm}`;
        lines.push(`  f${f}: camera ${JSON.stringify(st.camera)} (${detail})${errs.length ? "  <- " + errs.join("; ") : ""}`);
      }
      return text([`${bad + aimBad ? `RIG CHECK FAILED (${bad + aimBad})` : "Rig move verified"}:`, ...lines, ...aimLines].join("\n"), bad + aimBad > 0);
    },
  );
}
