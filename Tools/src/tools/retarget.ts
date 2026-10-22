import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): IK Rig / IK Retargeter / Pose Asset tools over the run_python bridge
// (Tools/python/ue_retarget.py). Verified live on UE 5.6.1 retargeting Manny -> a Fab character with a custom
// 'girl02_*' skeleton and a scaled glTF root. retarget_animations VERIFIES its output from the animation data
// (limb motion vs. source + rendered pelvis height) instead of trusting duplicate_and_retarget's return. The
// metric was calibrated on known answers: self-compare 0.0 / 0.0, good retarget 3.4 deg / 0.0, known-broken
// (pelvis collapsed by the root scale) height diff 1.185, wrong clip 11.8 deg.

const LIB = "ue_retarget.py";
const MAX_MOTION_ERR_DEG = 6;
const MAX_HEIGHT_DIFF = 0.05;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIB);
}

/** Verdict for one compare() result. Exported for tests. */
export function retargetVerdict(c: PoseResult): { ok: boolean; reasons: string[] } {
  if (!c.ok) return { ok: false, reasons: [c.error ?? "compare failed"] };
  const reasons: string[] = [];
  if (c.mean_motion_err_deg > MAX_MOTION_ERR_DEG)
    reasons.push(`limbs move differently from the source (mean ${c.mean_motion_err_deg} deg > ${MAX_MOTION_ERR_DEG})`);
  if (c.pelvis_height_max_diff > MAX_HEIGHT_DIFF)
    reasons.push(`pelvis height off by ${(c.pelvis_height_max_diff * 100).toFixed(0)}% of leg height (sunk/floating - scaled root or wrong retarget root?)`);
  return { ok: reasons.length === 0, reasons };
}

export function registerRetargetTools(server: McpServer): void {
  server.tool(
    "ikrig_create",
    "Create (or reuse) an IK Rig for a skeletal mesh with retarget chains. Epic-template skeletons (Manny/Quinn, " +
      "MetaHuman, ...) use UE's auto definition + auto full-body IK. Custom skeletons, where auto fails, are mapped " +
      "by bone-name stem against templateRig (strips prefixes like 'mixamorig_' / 'girl02_' and export indices like " +
      "'_048'). Reports chains, IK goals and the skeleton's root scale (non-1 root scale breaks pelvis retargeting; " +
      "retarget_setup compensates).",
    {
      mesh: z.string().describe("SkeletalMesh path."),
      path: z.string().describe("IK Rig asset path to create, e.g. '/Game/Retarget/IK_Hero'."),
      templateRig: z.string().optional().describe("IK Rig to copy chain names/bone stems from when auto fails (e.g. a Manny IK Rig made with this tool)."),
      prefix: z.string().optional().describe("Bone-name prefix to strip when mapping by name, if not auto-detected."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("create_ik_rig(P['mesh'], P['path'], P['tpl'], P['prefix'])",
        { mesh: a.mesh, path: a.path, tpl: a.templateRig ?? null, prefix: a.prefix ?? null });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [
        `${r.created ? "Created" : "Reused"} ${r.rig} (${r.method}): root '${r.retarget_root}', ${r.chains.length} chains, ` +
          `${r.goals.length} IK goals, ${r.solvers} solver(s). Root scale ${r.root_scale}${Math.abs(r.root_scale - 1) > 1e-3 ? " - NON-UNIT (scaled import)" : ""}.`,
      ];
      for (const c of r.chains) lines.push(`  ${c.chain}: ${c.start} -> ${c.end}${c.goal !== "None" ? `  goal ${c.goal}` : ""}`);
      if (r.unmapped?.length) lines.push(`Not mapped (no matching bones): ${r.unmapped.join(", ")}`);
      return text(lines.join("\n"), r.chains.length === 0);
    },
  );

  server.tool(
    "retarget_setup",
    "Create (or update) an IK Retargeter between two IK Rigs: default op stack, chains auto-mapped by name, preview " +
      "meshes, and - when the target skeleton has a scaled root bone (Fab/glTF imports) - the Pelvis Motion op " +
      "scaled by 1/root scale, without which the retargeted character sinks into the floor (measured: pelvis at " +
      "1 cm instead of 106). Reports the chain map and any unmapped target chains.",
    {
      path: z.string().describe("Retargeter asset path, e.g. '/Game/Retarget/RTG_Manny_To_Hero'."),
      sourceRig: z.string(),
      targetRig: z.string(),
      sourceMesh: z.string().optional(),
      targetMesh: z.string().optional().describe("Needed for the scaled-root check."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("create_retargeter(P['path'], P['s'], P['t'], P['sm'], P['tm'])",
        { path: a.path, s: a.sourceRig, t: a.targetRig, sm: a.sourceMesh ?? null, tm: a.targetMesh ?? null });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`${r.created ? "Created" : "Updated"} ${r.retargeter}. Ops: ${r.ops.join(" > ")}.`];
      const mapped = Object.entries(r.chain_map as Record<string, string>);
      lines.push(`Chains mapped: ${mapped.length - r.unmapped_target_chains.length}/${mapped.length}` +
        (r.unmapped_target_chains.length ? ` (unmapped: ${r.unmapped_target_chains.join(", ")})` : ""));
      if (r.root_scale_compensation) lines.push(`Scaled target root ${r.root_scale_compensation.root_scale.toFixed(6)} -> Pelvis Motion scale ${r.root_scale_compensation.pelvis_scale}.`);
      if (!a.targetMesh) lines.push("No targetMesh given: scaled-root check skipped.");
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "retarget_animations",
    "Retarget animation clips through an IK Retargeter into a folder, then VERIFY each output from its animation " +
      "data: per-limb motion error vs. the source (facing and A/T-pose reference differences removed) and rendered " +
      "pelvis height relative to each skeleton's reference. ok only if mean motion error <= 6 deg and pelvis height " +
      "within 5%. (UE's batch retarget writes to /Game root regardless of folder; outputs are moved to outFolder.)",
    {
      anims: z.array(z.string()).min(1).max(50),
      sourceMesh: z.string(),
      targetMesh: z.string(),
      retargeter: z.string(),
      outFolder: z.string().describe("Destination folder, e.g. '/Game/Retarget/Anims'."),
      suffix: z.string().optional().describe("Name suffix for outputs (default '_RTG'). Existing outputs are replaced."),
      samples: z.number().int().min(1).max(30).optional().describe("Frames sampled per clip for verification (default 5)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("retarget(P['anims'], P['sm'], P['tm'], P['rtg'], P['out'], P['suffix'])",
        { anims: a.anims, sm: a.sourceMesh, tm: a.targetMesh, rtg: a.retargeter, out: a.outFolder, suffix: a.suffix ?? "_RTG" });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines: string[] = [];
      let bad = 0;
      for (let i = 0; i < a.anims.length; i++) {
        const out = r.outputs[i];
        if (!out) { bad++; lines.push(`FAILED  ${a.anims[i]}: no output`); continue; }
        const c = await run("compare(P['s'], P['t'], P['sm'], P['tm'], P['n'])",
          { s: a.anims[i], t: out, sm: a.sourceMesh, tm: a.targetMesh, n: a.samples ?? 5 });
        const v = retargetVerdict(c);
        if (!v.ok) bad++;
        // CLAUDE-NOTE: feet relative to the pelvis vs the height-scaled source - what leg IK goals fix (informational).
        const f = await run("foot_fidelity(P['s'], P['t'], P['sm'], P['tm'])", { s: a.anims[i], t: out, sm: a.sourceMesh, tm: a.targetMesh });
        lines.push(`${v.ok ? "ok" : "BAD"}  ${out}  motion err ${c.mean_motion_err_deg ?? "?"} deg, pelvis height diff ${c.pelvis_height_max_diff ?? "?"}` +
          (f.ok ? `, feet ${f.foot_err_mean} cm mean / ${f.foot_err_max} max from the scaled source` : "") +
          (v.reasons.length ? `  - ${v.reasons.join("; ")}` : ""));
      }
      lines.unshift(`Retargeted ${r.outputs.length}/${a.anims.length} clip(s); ${a.anims.length - bad} verified.`);
      const ik = await run("ik_status(P['rtg'])", { rtg: a.retargeter });
      if (ik.ok) lines.splice(1, 0, ik.ik_active
        ? `Leg/arm IK active: goals ${ik.goals.join(", ")} on chains ${ik.ik_chains.join(", ")}.`
        : `Leg IK OFF: the target IK Rig has ${ik.goals.length} goal(s) and ${ik.solvers} solver(s) - limbs are FK only (custom skeletons get no goals; see the feet error).`);
      return text(lines.join("\n"), bad > 0);
    },
  );

  server.tool(
    "pose_asset_create",
    "Create a Pose Asset from an AnimSequence (one pose per frame - bake/pose a short clip first) and optionally " +
      "rename its poses in order. Pose assets drive pose blending in Anim Blueprints and pose libraries.",
    {
      anim: z.string().describe("Source AnimSequence path (each frame becomes a pose)."),
      path: z.string().describe("New PoseAsset path; must not exist."),
      poseNames: z.array(z.string()).optional().describe("New names for poses 0..n-1 (extra poses keep Pose_N)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("create_pose_asset(P['anim'], P['path'], P['names'])", { anim: a.anim, path: a.path, names: a.poseNames ?? null });
      if (!r.ok) return text(`Error: ${r.error ?? "no poses created"}`, true);
      return text(`Created ${r.pose_asset} with ${r.count} pose(s): ${r.poses.slice(0, 30).join(", ")}${r.count > 30 ? ", ..." : ""}` +
        (r.renamed.length ? `\nRenamed ${r.renamed.length}.` : ""));
    },
  );
}
