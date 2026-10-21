import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): previz SHOT tools - a CineCamera per shot (spawnable, real lens, camera cut), aimed at
// a MEASURED bone relative to the subject's measured facing, with a framing check that projects bones through
// the lens, and a capture that proves the viewport is looking through the cut before returning the frame.
// Live finding behind the design: editing a spawnable camera's template does not reach the instance Sequencer
// already spawned (viewport stayed 35 mm / manual focus = blurred while the template said 50 mm / no DoF), so
// the python side edits both and reads the lens back from the live instance.

const LIBS = ["ue_posing.py", "ue_shot.py"];
const vec3 = z.array(z.number()).length(3);

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

function fmtFraming(f: PoseResult): string[] {
  const lines = [`Lens ${f.focal_length} mm (hfov ${f.hfov} deg); subject turned ${f.subject_to_camera_deg} deg from facing the camera.`];
  for (const [b, v] of Object.entries(f.bones ?? {}) as [string, any][]) {
    lines.push(v.behind_camera ? `  ${b}: BEHIND camera` : `  ${b}: ${v.in_frame ? "in frame" : "OUT of frame"} at u=${v.u}, v=${v.v} (${v.dist} cm)`);
  }
  return lines;
}

export function registerShotTools(server: McpServer): void {
  server.tool(
    "shot_camera",
    "Create or update a shot camera in a LevelSequence: spawnable CineCamera with a real lens (focal length, " +
      "filmback preset or sensor mm), depth of field off by default (previz), and its camera-cut section. Optionally " +
      "AIM it at a subject's measured bone: distance, azimuth around the subject's MEASURED facing (0 = in front, +90 " +
      "= its left, 180 = behind), rise above the bone. Then reports framing: where each subject bone lands in the " +
      "frame (u,v in [-1,1] = visible) and how far the subject is turned from the camera. Idempotent per camera name.",
    {
      sequence: z.string(),
      name: z.string().describe("Camera binding name, e.g. 'ShotCam'."),
      focalLength: z.number().optional().describe("mm, e.g. 24 wide, 35, 50, 85 close-up."),
      filmback: z.string().optional().describe("Preset name, e.g. '16:9 Digital Film', 'Full Frame DSLR', 'Super 35mm'. Unknown names are rejected."),
      sensor: z.array(z.number()).length(2).optional().describe("[width, height] mm instead of a preset."),
      location: vec3.optional().describe("World location (ignored when aim is given)."),
      rotation: vec3.optional().describe("[pitch, yaw, roll] deg (ignored when aim is given)."),
      cut: z.array(z.number().int()).length(2).optional().describe("Camera-cut range [start, end) in frames; default the playback range."),
      aim: z.object({
        subject: z.string().describe("Character binding to frame."),
        bone: z.string().optional().describe("Bone or role to aim at (default 'head'; 'pelvis' for a full shot)."),
        distance: z.number().optional().describe("cm from the bone (default 300)."),
        azimuth: z.number().optional().describe("deg around the subject's facing (default 0 = straight on)."),
        rise: z.number().optional().describe("cm above the bone (default 0)."),
      }).strict().optional(),
      depthOfField: z.boolean().optional().describe("Keep the camera's focus/DoF (default false = sharp)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const c = await run("camera(P['seq'], P['name'], P['loc'], P['rot'], P['fl'], P['fb'], P['sensor'], P['cut'], P['sharp'])", {
        seq: a.sequence, name: a.name, loc: a.aim ? null : a.location ?? null, rot: a.aim ? null : a.rotation ?? null,
        fl: a.focalLength ?? null, fb: a.filmback ?? null, sensor: a.sensor ?? null, cut: a.cut ?? null, sharp: !a.depthOfField,
      });
      if (!c.ok) return text(`Error: ${c.error}`, true);
      const lines = [`${c.created ? "Created" : "Updated"} '${a.name}': ${c.focal_length} mm, sensor ${c.sensor.join("x")} mm, focus ${c.focus}, cut ${c.cut[0]}-${c.cut[1]}.`];
      let subject = a.aim?.subject;
      if (a.aim) {
        const m = await run("aim(P['seq'], P['cam'], P['subj'], P['bone'], P['d'], P['az'], P['rise'])", {
          seq: a.sequence, cam: a.name, subj: a.aim.subject, bone: a.aim.bone ?? "head",
          d: a.aim.distance ?? 300, az: a.aim.azimuth ?? 0, rise: a.aim.rise ?? 0,
        });
        if (!m.ok) return text([...lines, `Aim failed: ${m.error}`].join("\n"), true);
        lines.push(`Aimed at ${a.aim.subject}.${m.bone} ${JSON.stringify(m.bone_location)} from ${JSON.stringify(m.location)}, rot ${JSON.stringify(m.rotation)} (subject faces ${m.subject_facing} deg).`);
      }
      if (subject) {
        const f = await run("framing(P['seq'], P['cam'], P['subj'])", { seq: a.sequence, cam: a.name, subj: subject });
        if (!f.ok) return text([...lines, `Framing check failed: ${f.error}`].join("\n"), true);
        lines.push(...fmtFraming(f));
        const aimed = f.bones?.[a.aim?.bone ?? "head"];
        if (aimed && (!aimed.in_frame || Math.abs(aimed.u) > 0.05 || Math.abs(aimed.v) > 0.05))
          return text([...lines, "Aimed bone is not at frame centre - framing check FAILED."].join("\n"), true);
      }
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "shot_frame_check",
    "Read-only framing check for a shot camera: projects a character's bones (or roles) through the camera's LIVE " +
      "lens and reports u,v per bone (|u|,|v| <= 1 = in frame, 0,0 = centre), distance, and how far the subject is " +
      "turned from the camera (0 = facing it, 180 = back to camera). Use it to judge composition numerically before capturing.",
    {
      sequence: z.string(),
      camera: z.string(),
      subject: z.string(),
      bones: z.array(z.string()).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const f = await run("framing(P['seq'], P['cam'], P['subj'], P['bones'])", { seq: a.sequence, cam: a.camera, subj: a.subject, bones: a.bones ?? null });
      if (!f.ok) return text(`Error: ${f.error}`, true);
      return text(fmtFraming(f).join("\n"));
    },
  );

  server.tool(
    "shot_capture",
    "Capture a clean frame of a sequence THROUGH its camera cut: locks the viewport to the cut, clears Control Rig " +
      "selection, game view (no gizmos), scrubs to the frame, verifies the viewport camera really matches the cut " +
      "camera, waits for the render to settle, and returns the image inline (optionally saved). isError if the " +
      "viewport is not looking through the shot camera.",
    {
      sequence: z.string(),
      frame: z.number().int().optional(),
      maxSize: z.number().min(64).max(2048).optional().describe("Longest edge, default 1024."),
      saveToDisk: z.boolean().optional(),
      filename: z.string().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const frame = a.frame ?? 0;
      const lt = await run("look_through(P['seq'], P['f'])", { seq: a.sequence, f: frame });
      if (!lt.ok) return text(`Error: ${lt.error}`, true);
      // Spawnable transforms and Control Rig poses land on the next tick(s): settle across requests.
      let check: PoseResult = { ok: false };
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 250));
        check = await run("viewport_vs_cut(P['seq'], P['f'])", { seq: a.sequence, f: frame });
        if (check.ok) break;
      }
      let previous = "";
      for (let i = 0, stable = 0; i < 20 && stable < 2; i++) {
        const probe = await uePost("/api/viewport-capture", { target: "level", maxSize: 128, ...(previous ? { sinceDigest: previous } : {}) });
        if (probe.error) break;
        stable = previous && probe.unchanged ? stable + 1 : 0;
        previous = probe.digest;
        await new Promise((r) => setTimeout(r, 300));
      }
      const data = await uePost("/api/viewport-capture", {
        target: "level", maxSize: a.maxSize ?? 1024, ...(a.saveToDisk ? { saveToDisk: true } : {}), ...(a.filename ? { filename: a.filename } : {}),
      });
      if (data.error) return text(`Error: ${data.error}`, true);
      const lines = [
        `Frame ${frame} through '${check.camera ?? "?"}': ${data.width}x${data.height}` +
          (check.ok ? " - viewport matches the cut camera." : ` - viewport NOT on the cut camera (${check.error ?? `offset ${check.viewport_offset_cm} cm, yaw diff ${check.viewport_yaw_diff}`}).`),
      ];
      if (data.fullPath) lines.push(`Saved: ${data.fullPath}`);
      const content: any[] = [{ type: "text" as const, text: lines.join("\n") }];
      if (typeof data.imageBase64 === "string" && data.imageBase64.length)
        content.push({ type: "image" as const, data: data.imageBase64, mimeType: data.mimeType ?? "image/png" });
      return { content, ...(check.ok ? {} : { isError: true }) };
    },
  );
}
