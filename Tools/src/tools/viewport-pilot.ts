import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): camera piloting (Tools/python/ue_pilot.py). The sync is camera -> viewport
// only: moving the view while piloting snaps back, so moveTo moves the CAMERA (keys for a sequence camera, which is
// re-posed from its track every tick; a direct move for a level actor) and the check is that the piloted view follows.

const LIBS = ["ue_posing.py", "ue_pilot.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Largest location (cm) and rotation (deg, wrapped) difference between two {location, rotation}. Exported for tests. */
export function xformGap(a: { location: number[]; rotation: number[] }, b: { location: number[]; rotation: number[] }): { cm: number; deg: number } {
  const cm = Math.hypot(...a.location.map((v, i) => v - b.location[i]));
  const deg = Math.max(...a.rotation.map((v, i) => Math.abs(((((v - b.rotation[i]) % 360) + 540) % 360) - 180)));
  return { cm, deg };
}

export function registerViewportPilotTools(server: McpServer): void {
  server.tool(
    "viewport_pilot",
    "PILOT a camera in the level viewport (look through it, as the editor's 'Pilot' does) - a sequence camera binding " +
      "(with `sequence`) or a level actor - optionally move it (`moveTo`: keyed at `frame` for a sequence camera, moved " +
      "directly for a level actor) or `eject`. VERIFIED: the viewport's transform equals the camera's after the change.",
    {
      camera: z.string().optional().describe("Camera binding name (with sequence) or level actor label."),
      sequence: z.string().optional(),
      moveTo: z.object({ location: z.array(z.number()).length(3), rotation: z.array(z.number()).length(3).optional(), frame: z.number().int().optional() }).strict().optional(),
      eject: z.boolean().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.eject) {
        const r = await run("eject()", {});
        return r.ok && !r.pilot ? text("Ejected: the viewport is free again.") : text(`Eject failed: ${r.error ?? `still piloting ${r.pilot}`}`, true);
      }
      if (!a.camera) return text("camera is required", true);
      const p = await run("pilot(P['s'], P['c'])", { s: a.sequence ?? null, c: a.camera });
      if (!p.ok) return text(`Error: ${p.error}`, true);
      const lines: string[] = [];
      if (a.moveTo) {
        const m = await run("pilot_move(P['s'], P['c'], P['l'], P['r'], P['f'])", { s: a.sequence ?? null, c: a.camera, l: a.moveTo.location, r: a.moveTo.rotation ?? null, f: a.moveTo.frame ?? 0 });
        if (!m.ok) return text(`Error moving: ${m.error}`, true);
        lines.push(`Camera ${m.how}.`);
      }
      await run("pilot_state(P['s'], P['c'])", { s: a.sequence ?? null, c: a.camera });   // viewport syncs on the next tick
      const st = await run("pilot_state(P['s'], P['c'])", { s: a.sequence ?? null, c: a.camera });
      if (!st.ok) return text(`Error: ${st.error}`, true);
      const gap = xformGap(st.view as any, st.actor as any);
      let bad = !st.piloting || gap.cm > 0.5 || gap.deg > 0.5;
      if (a.moveTo) {
        const want = { location: a.moveTo.location, rotation: a.moveTo.rotation ?? (st.actor as any).rotation };
        const g2 = xformGap(st.actor as any, want);
        if (g2.cm > 0.5 || g2.deg > 0.5) { bad = true; lines.push(`Camera is at ${JSON.stringify(st.actor)}, asked ${JSON.stringify(want)}  <- NOT MOVED`); }
      }
      lines.unshift(`${st.piloting ? "Piloting" : "NOT piloting"} '${a.camera}' (pilot actor ${st.pilot}); camera ${JSON.stringify((st.actor as any).location)} rot ${JSON.stringify((st.actor as any).rotation)}; viewport differs by ${gap.cm.toFixed(2)} cm / ${gap.deg.toFixed(2)} deg.`);
      return text([bad ? "PILOT CHECK FAILED:" : "Viewport piloting verified:", ...lines].join("\n"), bad);
    },
  );
}
