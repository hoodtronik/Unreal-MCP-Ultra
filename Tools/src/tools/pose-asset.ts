import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Pose Assets from Python (PoseAssetFactory: one pose per key of the source clip,
// Pose_0..N; rename_pose) and the Pose Blender check (Tools/python/ue_poseasset.py). The Pose Blender reads curves named
// after the poses; a "driver" clip (a copy of a base clip with constant curves) feeds them. Measured on PA_Wave (from a
// 2.5 s wave): weight 1 on WaveHigh (= key 18) -> body == wave @0.6 s at 0.000 cm; weight 0 -> the idle (0.02 cm);
// weight 0.5 is NOT half-way (hand 36 cm from the pose, 63 cm from idle): a non-additive pose asset blends partial
// weights toward something other than the source - only weight 0 / 1 are checked as exact.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_abp.py", "ue_montage.py", "ue_poseasset.py"];
const MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
const LABEL = "MCP_PoseAssetCheck";
export const POSE_TOL_CM = 0.5;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}
const short = (p: string) => (p || "").split(".")[0].split("/").pop();

/** What a check can expect: one pose at full weight (others 0), all zero (the base), or partial. Exported for tests. */
export function expectedTarget(weights: Record<string, number>): { kind: "pose"; pose: string } | { kind: "base" } | { kind: "partial" } {
  const active = Object.entries(weights).filter(([, w]) => w > 1e-6);
  if (active.length === 0) return { kind: "base" };
  if (active.length === 1 && active[0][1] >= 0.999) return { kind: "pose", pose: active[0][0] };
  return { kind: "partial" };
}

export function registerPoseAssetTools(server: McpServer): void {
  server.tool(
    "pose_asset",
    "POSE ASSETS: 'create' samples a clip into a Pose Asset (one pose per key, Pose_0..N, or `names` for the first " +
      "ones); 'read' lists poses; 'rename' renames poses ({old: new}); 'check' drives a Pose Blender ABP and verifies the " +
      "rendered body: writes `weights` {pose: 0..1} as curves on the `driver` clip (a copy of `base`, created if missing) " +
      "that the ABP's sequence player feeds into a Pose Blender (add_anim_node PoseBlender + SequencePlayer, then " +
      "connect Pose -> SourcePose). Weight 1 on one pose must give that source frame; all 0 the base clip.",
    {
      action: z.enum(["create", "read", "rename", "check"]),
      path: z.string().describe("Pose Asset path."),
      clip: z.string().optional().describe("create: source AnimSequence."),
      names: z.array(z.string()).optional().describe("create: names for the first poses."),
      renames: z.record(z.string(), z.string()).optional().describe("rename: {old: new}."),
      blueprint: z.string().optional().describe("check: ABP with SequencePlayer(driver) -> PoseBlender(this asset) -> Output."),
      driver: z.string().optional().describe("check: driver clip path the ABP plays (curves are written here)."),
      base: z.string().optional().describe("check: clip the driver is copied from (default MM_Idle) - the expected pose at weight 0."),
      weights: z.record(z.string(), z.number().min(0).max(1)).optional().describe("check: {pose: weight}."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.action !== "check") {
        const r = a.action === "create"
          ? await run("pa_create(P['p'], P['c'], P['n'])", { p: a.path, c: a.clip, n: a.names ?? null })
          : a.action === "rename"
            ? await run("pa_rename(P['p'], P['r'])", { p: a.path, r: a.renames ?? {} })
            : await run("pa_info(P['p'])", { p: a.path });
        if (!r.ok) return text(`Error: ${r.error}`, true);
        const names = r.names as string[];
        const missing = r.poses <= 40 ? Object.values(a.renames ?? {}).filter((n) => !names.includes(n)) : [];
        return text([`${short(r.path)}: ${r.poses} poses${r.additive ? " (additive)" : ""}, skeleton ${short(r.skeleton)}`,
          `  ${names.join(", ")}${r.poses > 40 ? ", ..." : ""}`,
          ...(missing.length ? [`  RENAME NOT APPLIED: ${missing.join(", ")}`] : [])].join("\n"), missing.length > 0);
      }
      if (!a.blueprint || !a.driver || !a.weights) return text("Error: check needs blueprint, driver and weights.", true);
      const base = a.base ?? "/Game/Characters/Mannequins/Anims/Unarmed/MM_Idle";
      const d = await run("curve_driver(P['d'], P['b'], P['w'])", { d: a.driver, b: base, w: a.weights });
      if (!d.ok) return text(`Error: ${d.error}`, true);
      const sp = await run("abp_preview(P['l'], P['bp'], P['m'], (0, 300, -5000))", { l: LABEL, bp: a.blueprint, m: MESH });
      if (!sp.ok) return text(`Error: ${sp.error}`, true);
      await run("{'ok': True}", {});
      const want = expectedTarget(a.weights);
      const lines = [`Driver ${short(a.driver)} curves ${JSON.stringify(d.curves)}; ${short(a.blueprint)} on a hidden mannequin.`];
      let ok = true;
      if (want.kind === "pose") {
        const pt = await run("pa_pose_time(P['p'], P['n'])", { p: a.path, n: want.pose });
        if (!pt.ok) return text(`Error: ${pt.error}`, true);
        const pv = await run("pose_vs_clip(P['l'], P['c'], P['t'])", { l: LABEL, c: pt.source, t: pt.t });
        ok = pv.ok && pv.cm <= POSE_TOL_CM;
        lines.push(`${ok ? "Verified" : "MISMATCH"}: body vs ${short(pt.source)} @${pt.t}s (pose ${want.pose} = key ${pt.index}): ${pv.cm} cm (${pv.bone}).`);
      } else {
        const cm = await run("clip_match(P['l'], [P['c']])", { l: LABEL, c: base });
        const v = cm.ok ? cm.clips[base].cm : NaN;
        if (want.kind === "base") {
          ok = v <= 2;
          lines.push(`${ok ? "Verified" : "MISMATCH"}: all weights 0 -> body on the base ${short(base)} (${v} cm).`);
        } else {
          lines.push(`Partial weights - not checked as exact (a non-additive pose asset does not blend linearly with the source); base ${short(base)} is ${v} cm away.`);
        }
      }
      return text(lines.join("\n"), !ok);
    },
  );
}
