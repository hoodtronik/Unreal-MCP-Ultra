import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Control Rig AUTHORING (Tools/python/ue_crauthor.py): bones imported from a
// mesh, one control per effector (Epic names: hand_r_ik_ctrl, foot_l_ik_ctrl, head_ctrl, pelvis_ctrl), a forward solve
// (pelvis follows its control, Full Body IK pulls the effectors) and a backward solve (controls = bones) so clips bake
// onto it. Live on Manny: rest pose held, hand_r reach missed 0.094 cm with the shoulders twisting 7.7 deg (a real
// full-body solve), feet and the other hand held; pelvis -26 cm crouched with feet planted. A walk frame baked through
// the backward solve matched the clip as closely as Epic's CR_Mannequin_Body at the effectors (hands 4.0/3.5, feet
// 3.0/2.6 cm - the bake/compare baseline) once PBIK had 200 iterations (20: feet 9.2 cm); elbows/shoulders 10-15 cm
// off (no pole or shoulder controls) vs 4-5 on Epic's rig.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_crauthor.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const worst = (m: Record<string, number>) => Object.entries(m).reduce((w, [k, v]) => (v > w[1] ? [k, v] as [string, number] : w), ["-", 0] as [string, number]);

export function registerCrAuthorTools(server: McpServer): void {
  server.tool(
    "cr_build",
    "AUTHOR a Control Rig asset for any skeletal mesh: imports the bones, adds a control per effector bone (default " +
      "hand_l/r, foot_l/r, head + pelvis; Epic-style names so pose_reach / pose_set_controls work), a forward solve with " +
      "Full Body IK and a backward solve (so clips bake onto the rig). VERIFIED in a scratch sequence: rest pose held, " +
      "a hand reach lands within 1 cm while the feet stay put, and (with `clip`) a baked clip frame vs the clip. " +
      "Use the rig with pose_setup_character {rig}.",
    {
      path: z.string().describe("New Control Rig asset path, e.g. /Game/Rigs/CR_Hero."),
      mesh: z.string().optional().describe("SkeletalMesh (default SKM_Manny_Simple)."),
      effectors: z.array(z.string()).optional().describe("Effector bones (default hand_l, hand_r, foot_l, foot_r, head)."),
      root: z.string().optional().describe("Root bone of the IK, pinned to its control (default pelvis)."),
      iterations: z.number().int().min(1).max(1000).optional().describe("Full Body IK iterations (default 200; 20 left feet 9 cm off a baked clip)."),
      overwrite: z.boolean().optional(),
      clip: z.string().optional().describe("Also bake this clip frame through the backward solve and compare with the clip."),
      clipFrame: z.number().int().optional(),
      verify: z.boolean().optional().describe("Default true."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const mesh = a.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
      const r = await run("cr_build(P['p'], P['m'], P['e'], P['r'], P['o'], P['i'])", {
        p: a.path, m: mesh, e: a.effectors ?? null, r: a.root ?? "pelvis", o: a.overwrite ?? false, i: a.iterations ?? 200 });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const lines = [`Built ${r.path}: ${r.bones} bones, controls ${(r.controls as string[]).join(", ")}; ${(r.nodes as any[]).length} graph nodes, ${r.links} links (forward + backward solve).`];
      if (a.verify === false) return text(lines.join("\n"));
      const seq = a.path.replace(/\/[^/]+$/, "") + "/SEQ_" + a.path.split("/").pop() + "_Check";
      let bad = 0;
      try {
        const s = await run("setup_character(P['s'], 'Check', P['m'], P['p'], (0, 0, 0), None, 24, 24)", { s: seq, m: mesh, p: a.path });
        if (!s.ok) return text([...lines, `Check setup failed: ${s.error}`].join("\n"), true);
        if (s.rig !== (a.path.split("/").pop() + "_C")) return text([...lines, `Check binding got rig ${s.rig}, not the new rig`].join("\n"), true);
        const scrub = async () => { await run("scrub(P['s'], 1)", { s: seq }); await run("scrub(P['s'], 0)", { s: seq }); };
        await scrub();
        const rest = await run("rest_vs_ref(P['s'], 'Check')", { s: seq });
        if (!rest.ok) throw new Error(rest.error);
        // CLAUDE-NOTE (live): with the sequence CLOSED the binding's template reads the reference pose (0 cm everywhere),
        // so the check runs while its scratch sequence is open; calibrated on a crouched binding: pelvis 25.9 cm.
        if (!Object.keys(rest.cm as object).length) throw new Error("rest check measured no bones");
        const [rb, rv] = worst(rest.cm as Record<string, number>);
        if (rv > 1) bad++;
        lines.push(`Rest pose vs reference: worst ${rv} cm (${rb})${rv > 1 ? "  <- FAIL" : ""}`);
        const p0 = await run("read_pose(P['s'], 'Check', 0, ['hand_r', 'hand_l', 'foot_l', 'foot_r'])", { s: seq });
        const b0 = p0.bones as Record<string, number[]>;
        const eff = (a.effectors ?? ["hand_r"]).includes("hand_r") ? "hand_r" : null;
        if (eff) {
          const tgt = [b0.hand_r[0], b0.hand_r[1], b0.hand_r[2] + 30];
          const w = await run("reach(P['s'], 'Check', 'hand_r', P['t'], 0, None)", { s: seq, t: tgt });
          if (!w.ok) throw new Error(w.error);
          await scrub();
          const p1 = await run("read_pose(P['s'], 'Check', 0, ['hand_r', 'hand_l', 'foot_l', 'foot_r'])", { s: seq });
          const b1 = p1.bones as Record<string, number[]>;
          const miss = dist(b1.hand_r, tgt);
          const held = Math.max(...["hand_l", "foot_l", "foot_r"].map((k) => dist(b1[k], b0[k])));
          if (miss > 1 || held > 1) bad++;
          lines.push(`Reach hand_r +30 cm up: miss ${miss.toFixed(3)} cm; other effectors moved ${held.toFixed(3)} cm${miss > 1 || held > 1 ? "  <- FAIL" : ""}`);
        }
        if (a.clip) {
          const bk = await run("bake_clip_frame(load_sequence(P['s']), find_binding(load_sequence(P['s']), 'Check'), P['c'], P['f'], 0) and {'ok': True}", { s: seq, c: a.clip, f: a.clipFrame ?? 0 });
          if (!bk.ok) throw new Error(bk.error);
          await scrub();
          const cmp = await run("rig_vs_clip(P['s'], 'Check', P['c'], P['f'])", { s: seq, c: a.clip, f: a.clipFrame ?? 0 });
          if (!cmp.ok) throw new Error(cmp.error);
          const cm = cmp.cm as Record<string, number>;
          const effs = (a.effectors ?? ["hand_l", "hand_r", "foot_l", "foot_r", "head"]).filter((k) => k in cm);
          const [eb, ev] = worst(Object.fromEntries(effs.map((k) => [k, cm[k]])));
          const [ob, ov] = worst(cm);
          lines.push(`Clip ${a.clip.split("/").pop()} frame ${a.clipFrame ?? 0} baked through the backward solve (pelvis-relative): effectors worst ${ev} cm (${eb}); all bones worst ${ov} cm (${ob}); root motion carried in the pelvis: ${cmp.root_motion_cm} cm.`);
        }
      } catch (e) {
        bad++;
        lines.push(`Check error: ${(e as Error).message}`);
      } finally {
        await run("drop_sequence(P['s'])", { s: seq });
      }
      return text([bad ? "CONTROL RIG CHECK FAILED:" : "Control Rig built and verified:", ...lines].join("\n"), bad > 0);
    },
  );

  // CLAUDE-NOTE (2026-10-22, live 5.6.1): MODULAR Control Rig from Epic's Control Rig Modules (Root, Spine, Neck,
  // Shoulder/Arm/Leg left + mirrored right) for the UE5 mannequin skeleton - 56 controls, rest pose 0 cm from the
  // reference (spine_03 0.14), FK arm keyed through the section channels moved the hand 44 cm with the other hand
  // still; thigh_l_fk yaw 40 lifted the foot 55 cm, head_ctrl yaw 40 turned the gaze 40.0 deg. Modules come up in FK;
  // IK switching (module config) is not mapped yet.
  server.tool(
    "cr_build_modular",
    "Build a MODULAR Control Rig (Epic's Control Rig Modules: Root, Spine, Neck, shoulders, arms, legs; right side " +
      "mirrored) for a UE5-mannequin-skeleton mesh. Controls are named Module/control (e.g. Arm_r/upperarm_r_fk_ctrl, " +
      "Spine/hips_ctrl); pose them with pose_set_controls in LOCAL values (world writes are not supported on modular " +
      "controls). VERIFIED in a scratch sequence: control count, rest pose vs the reference, and an FK arm write moving the hand.",
    {
      path: z.string(),
      mesh: z.string().optional(),
      overwrite: z.boolean().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const mesh = a.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
      const r = await run("cr_build_modular(P['p'], P['m'], P['o'])", { p: a.path, m: mesh, o: a.overwrite ?? false });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const conn = r.connected as Record<string, boolean>;
      const failed = Object.entries(conn).filter(([, v]) => !v).map(([k]) => k);
      const ctrls = r.controls as string[];
      const lines = [`Built ${r.path}: ${ctrls.length} controls; ${Object.keys(conn).length} connectors set${failed.length ? ` (FAILED: ${failed.join(", ")})` : ""}; mirrored ${(r.mirrored as string[]).join(", ")}.`];
      let bad = failed.length ? 1 : 0;
      const seq = a.path.replace(/\/[^/]+$/, "") + "/SEQ_" + a.path.split("/").pop() + "_Check";
      try {
        const s = await run("setup_character(P['s'], 'Check', P['m'], P['p'], (0, 0, 0), None, 24, 24)", { s: seq, m: mesh, p: a.path });
        if (!s.ok) throw new Error(s.error);
        if (s.controls !== ctrls.length) { bad++; lines.push(`Live rig has ${s.controls} controls, built ${ctrls.length}  <- MISMATCH`); }
        const scrub = async () => { await run("scrub(P['s'], 1)", { s: seq }); await run("scrub(P['s'], 0)", { s: seq }); };
        await scrub();
        const rest = await run("rest_vs_ref(P['s'], 'Check')", { s: seq });
        if (!rest.ok || !Object.keys(rest.cm as object).length) throw new Error(rest.error ?? "rest check measured nothing");
        const rv = Math.max(...Object.values(rest.cm as Record<string, number>));
        if (rv > 1) bad++;
        lines.push(`Rest pose vs reference: worst ${rv} cm${rv > 1 ? "  <- FAIL" : ""}`);
        const p0 = await run("read_pose(P['s'], 'Check', 0, ['hand_r', 'hand_l'])", { s: seq });
        const w = await run("set_controls(P['s'], 'Check', 0, [{'control': 'Arm_r/upperarm_r_fk_ctrl', 'rotation': [60, 0, 0]}])", { s: seq });
        if (!w.ok) throw new Error(w.error);
        await scrub();
        const p1 = await run("read_pose(P['s'], 'Check', 0, ['hand_r', 'hand_l'])", { s: seq });
        const b0 = p0.bones as Record<string, number[]>, b1 = p1.bones as Record<string, number[]>;
        const moved = dist(b0.hand_r, b1.hand_r), other = dist(b0.hand_l, b1.hand_l);
        if (moved < 10 || other > 0.5) bad++;
        lines.push(`FK write Arm_r/upperarm_r_fk_ctrl pitch 60: hand_r moved ${moved.toFixed(1)} cm, hand_l ${other.toFixed(2)} cm${moved < 10 || other > 0.5 ? "  <- FAIL" : ""}`);
      } catch (e) {
        bad++;
        lines.push(`Check error: ${(e as Error).message}`);
      } finally {
        await run("drop_sequence(P['s'])", { s: seq });
      }
      return text([bad ? "MODULAR RIG CHECK FAILED:" : "Modular Control Rig built and verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
