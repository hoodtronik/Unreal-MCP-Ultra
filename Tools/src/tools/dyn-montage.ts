import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): dynamic montages (play_slot_animation_as_dynamic_montage): a plain clip on a
// Slot without a montage asset. ABP idle -> DefaultSlot -> Output with A_Wave_Baked: pose == clip 0.001 cm at 0.8 /
// 1.6 s (idle was 75.9 cm away); montage_stop returned the base pose (80 cm from the wave) - stop_slot_animation did not.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_abp.py", "ue_montage.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function registerDynMontageTools(server: McpServer): void {
  server.tool(
    "anim_dynamic_montage",
    "Play a plain CLIP through an Anim Blueprint's Slot as a DYNAMIC montage (no montage asset - quick one-off actions: " +
      "a wave, a nod). VERIFIED on a hidden mannequin running the ABP: the pose equals the clip at each checked time, and " +
      "after stopping the pose leaves the clip (back to the ABP's base).",
    {
      blueprint: z.string().describe("Anim Blueprint with a Slot node."),
      clip: z.string(),
      slot: z.string().optional().describe("Slot name (default DefaultSlot)."),
      positions: z.array(z.number()).min(1).max(10).optional().describe("Clip seconds to check (default 3 across the clip)."),
      mesh: z.string().optional(),
      toleranceCm: z.number().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const tol = a.toleranceCm ?? 0.5;
      const pv = await run("abp_preview('MCP_DynCheck', P['b'], P['m'])", { b: a.blueprint, m: a.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple" });
      if (!pv.ok) return text(`Error: ${pv.error}`, true);
      const lines: string[] = [];
      let bad = 0;
      try {
        const info = await run("{'ok': True, 'len': resolve_anim(P['c'], ('AnimSequence',)).get_play_length()}", { c: a.clip });
        if (!info.ok) throw new Error(info.error);
        const L = info.len as number;
        const ts = a.positions ?? [L * 0.25, L * 0.5, L * 0.75];
        const before = await run("pose_vs_clip('MCP_DynCheck', P['c'], P['t'])", { c: a.clip, t: ts[0] });
        lines.push(`Base pose vs the clip at ${ts[0].toFixed(2)} s: ${before.cm} cm (before playing).`);
        for (const t of ts) {
          const p = await run("dyn_play('MCP_DynCheck', P['c'], P['t'], P['s'])", { c: a.clip, t, s: a.slot ?? "DefaultSlot" });
          if (!p.ok) throw new Error(p.error);
          const v = await run("pose_vs_clip('MCP_DynCheck', P['c'], P['t'])", { c: a.clip, t });
          const ok = (v.cm as number) <= tol;
          if (!ok) bad++;
          lines.push(`  ${p.montage} at ${t.toFixed(2)} s: pose vs clip ${v.cm} cm (${v.bone})${ok ? "" : "  <- NOT PLAYING THE CLIP"}`);
        }
        await run("dyn_stop('MCP_DynCheck')", {});
        await run("pose_vs_clip('MCP_DynCheck', P['c'], P['t'])", { c: a.clip, t: ts[ts.length - 1] });
        const after = await run("pose_vs_clip('MCP_DynCheck', P['c'], P['t'])", { c: a.clip, t: ts[ts.length - 1] });
        const left = (after.cm as number) > Math.max(5, tol * 4);
        if (!left) bad++;
        lines.push(`After stop: ${after.cm} cm from the clip${left ? " (back to the base)" : "  <- STILL SHOWING THE CLIP"}`);
      } catch (e) {
        bad++;
        lines.push(`Error: ${(e as Error).message}`);
      } finally {
        await run("remove_actor('MCP_DynCheck')", {});
      }
      return text([bad ? "DYNAMIC MONTAGE CHECK FAILED:" : "Dynamic montage verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
