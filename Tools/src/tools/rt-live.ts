import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): RUNTIME retargeting check (Tools/python/ue_rtlive.py). An ABP on the target
// skeleton with AnimGraphNode_RetargetPoseFromMesh (IKRetargeterAsset + bUseAttachedParent, built with
// create_anim_blueprint + add_anim_node) on a target actor ATTACHED to a source mannequin playing a clip. Compared with
// the OFFLINE retarget of the same clip played on a second copy of the target mesh, both paused at the same clip
// time: Manny -> Fab girl (root scale 0.0093) matched within 0.041 cm at 4 times. AnimPose evaluation of the offline
// clip came out ~100x off for this mesh (root scale), so the reference is a real mesh in the level, not AnimPose.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_take.py", "ue_retarget.py", "ue_rtlive.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Largest travel of any role across samples (pelvis-relative) - 0 means the target never moved. Exported for tests. */
export function motionRange(samples: Record<string, number[]>[]): number {
  let best = 0;
  if (!samples.length) return 0;
  for (const role of Object.keys(samples[0])) {
    for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i][role], b = samples[j][role];
      if (a && b) best = Math.max(best, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  return best;
}

export function registerRtLiveTools(server: McpServer): void {
  server.tool(
    "rt_live",
    "RUNTIME RETARGETING: run a target character whose Anim Blueprint copies a source mesh's pose live through an IK " +
      "Retargeter (AnimGraphNode_RetargetPoseFromMesh with bUseAttachedParent - build it with create_anim_blueprint on " +
      "the target skeleton + add_anim_node {nodeType:'AnimGraphNode_RetargetPoseFromMesh', properties:{'Node.IKRetargeterAsset': " +
      "<retargeter>, 'Node.bUseAttachedParent': true}}). Places a source mannequin looping `clip`, attaches the target to " +
      "it and VERIFIES against the offline retarget of the same clip at several clip times (same mesh, paused).",
    {
      abp: z.string().describe("Target Anim Blueprint with the RetargetPoseFromMesh node."),
      targetMesh: z.string(),
      retargeter: z.string(),
      clip: z.string().optional().describe("Source clip (default the Manny walk)."),
      sourceMesh: z.string().optional(),
      location: z.array(z.number()).length(3).optional().describe("Where the source stands (default 0,6000,0)."),
      times: z.array(z.number()).optional().describe("Clip times to compare (default 0.2, 0.6, 1.0, 1.3 s)."),
      keep: z.boolean().optional().describe("Leave the source/target actors running afterwards (default true; the paused reference copy is removed)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const clip = a.clip ?? "/Game/Characters/Mannequins/Anims/Unarmed/Walk/MF_Unarmed_Walk_Fwd";
      const smesh = a.sourceMesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
      const folder = a.abp.replace(/\/[^/]+$/, "");
      const off = await run("retarget([P['c']], P['sm'], P['tm'], P['r'], P['f'], '_RTLiveRef')", { c: clip, sm: smesh, tm: a.targetMesh, r: a.retargeter, f: folder });
      if (!off.ok) return text(`Offline retarget failed: ${off.error}`, true);
      const ref = (off.outputs as string[])[0];
      const s = await run("take_subject('MCP_RtSrc', P['c'], P['m'], tuple(P['l']))", { c: clip, m: smesh, l: a.location ?? [0, 6000, 0] });
      if (!s.ok) return text(`Error placing source: ${s.error}`, true);
      const t = await run("rt_live_setup('MCP_RtSrc', 'MCP_RtTgt', P['b'], P['g'])", { b: a.abp, g: a.targetMesh });
      if (!t.ok) return text(`Error placing target: ${t.error}`, true);
      const lines = [`Source MCP_RtSrc loops ${clip.split("/").pop()}; target MCP_RtTgt (${a.targetMesh.split("/").pop()}) runs ${a.abp.split("/").pop()} attached to it. Reference: offline retarget ${ref}.`];
      let worst = 0, at = "";
      const poses: Record<string, number[]>[] = [];
      for (const tm of a.times ?? [0.2, 0.6, 1.0, 1.3]) {
        const h = await run("rt_live_hold('MCP_RtSrc', 'MCP_RtRef', P['o'], P['t'], P['g'])", { o: ref, t: tm, g: a.targetMesh });
        if (!h.ok) return text(`Error holding t=${tm}: ${h.error}`, true);
        const c = await run("rt_live_compare('MCP_RtSrc', 'MCP_RtTgt', 'MCP_RtRef')", {});
        if (!c.ok) return text(`Error comparing t=${tm}: ${c.error}`, true);
        const cm = c.cm as Record<string, number>;
        const [wb, wv] = Object.entries(cm).reduce((m, e) => (e[1] > m[1] ? e : m), ["-", 0] as [string, number]);
        if (wv > worst) { worst = wv; at = `${wb} at t=${tm}`; }
        poses.push(c.pos as Record<string, number[]>);
        lines.push(`  t=${tm}s: worst ${wv.toFixed(3)} cm (${wb})`);
      }
      const moved = motionRange(poses);
      // resume the source; drop the paused reference copy
      await run("_act('MCP_RtSrc').skeletal_mesh_component.set_play_rate(1.0) or {'ok': True}", {});
      await run("remove_actor('MCP_RtRef')", {});
      if (a.keep === false) { await run("remove_actor('MCP_RtTgt')", {}); await run("remove_actor('MCP_RtSrc')", {}); }
      const bad = worst > 1 || moved < 5;
      return text([bad ? "RUNTIME RETARGET CHECK FAILED:" : "Runtime retarget verified (live == offline):", ...lines,
        `Worst ${worst.toFixed(3)} cm (${at})${worst > 1 ? "  <- LIVE DIFFERS FROM OFFLINE" : ""}; target moved up to ${moved.toFixed(1)} cm between samples${moved < 5 ? "  <- TARGET NOT ANIMATING" : ""}.`].join("\n"), bad);
    },
  );
}
