import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): "statues" on a PoseableMeshComponent (Tools/python/ue_poseable.py, actor
// /Game/_MCPLab/Poseable/BP_MCPPoseable made with create_blueprint + add_component). Copying build 21's walker at f30:
// root-relative 0 cm on every bone, frozen when the source moves on; additive bone edits measured 40.0 / 60.0 deg for
// 40 / 60. The walk's root motion sits in the root bone, so the root translation is zeroed to stand the statue where
// placed. Poseable poses are not saved with the level (runtime state) - re-run after a reload.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_poseable.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function registerPoseStatueTools(server: McpServer): void {
  server.tool(
    "pose_statue",
    "Freeze a character's CURRENT pose into a 'statue' (PoseableMeshComponent actor) at a location - from a level actor " +
      "or a sequence binding at `frame` - with optional additive bone edits ({bone, rotation:[pitch,yaw,roll]} on top of the " +
      "copied pose). For background crowds / reference poses without rigs or animation. VERIFIED: bones equal the source " +
      "(root-relative), edits turned by the asked angle, the statue stays put when the source moves on.",
    {
      label: z.string().describe("Statue actor label (reused if it exists)."),
      source: z.string().describe("Level actor label, or binding name with `sequence`."),
      sequence: z.string().optional(),
      frame: z.number().int().optional(),
      location: z.array(z.number()).length(3),
      yaw: z.number().optional(),
      edits: z.array(z.object({ bone: z.string(), rotation: z.array(z.number()).length(3) }).strict()).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.sequence && a.frame !== undefined) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frame });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frame });
      }
      // copy first WITHOUT edits so the copy itself can be checked, then apply edits
      const m = await run("statue_make(P['l'], P['src'], P['s'], tuple(P['loc']), P['y'])", { l: a.label, src: a.source, s: a.sequence ?? null, loc: a.location, y: a.yaw ?? null });
      if (!m.ok) return text(`Error: ${m.error}`, true);
      const c = await run("statue_compare(P['l'], P['src'], P['s'])", { l: a.label, src: a.source, s: a.sequence ?? null });
      if (!c.ok) return text(`Error: ${c.error}`, true);
      const worst = Math.max(...Object.values(c.cm as Record<string, number>));
      let bad = worst > 0.5 ? 1 : 0;
      const lines = [`Copied ${a.source}${a.sequence ? ` (frame ${a.frame ?? "current"})` : ""} -> '${a.label}': worst bone ${worst} cm root-relative${worst > 0.5 ? "  <- COPY DIFFERS" : ""}.`];
      if (a.edits?.length) {
        const e = await run("statue_make(P['l'], P['src'], P['s'], tuple(P['loc']), P['y'], edits=P['e'])", { l: a.label, src: a.source, s: a.sequence ?? null, loc: a.location, y: a.yaw ?? null, e: a.edits });
        if (!e.ok) return text(`Error applying edits: ${e.error}`, true);
        for (const ed of a.edits) {
          const want = Math.hypot(...ed.rotation) > 0 ? Math.max(...ed.rotation.map(Math.abs)) : 0;
          const got = (e.turned as Record<string, number>)[ed.bone];
          const ok = ed.rotation.filter((x) => x !== 0).length > 1 || Math.abs(got - want) <= 1;   // single-axis edits checked exactly
          if (!ok) bad++;
          lines.push(`  edit ${ed.bone} ${JSON.stringify(ed.rotation)}: turned ${got} deg${ok ? "" : "  <- NOT APPLIED AS ASKED"}`);
        }
      }
      const w = await run("statue_where(P['l'])", { l: a.label });
      if (w.ok) lines.push(`Statue at ${JSON.stringify(w.actor)}, pelvis ${JSON.stringify(w.pelvis)}.`);
      return text([bad ? "STATUE CHECK FAILED:" : "Statue posed and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
