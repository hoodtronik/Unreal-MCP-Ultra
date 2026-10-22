import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { syncPins } from "./animation-mutation.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): generic MEASUREMENT of any AnimGraph node (Tools/python/ue_aim.py
// bones_state): sweep a node's properties (each step = anim_node_set + recompile), run the ABP on a hidden mannequin
// and read bone positions and axis directions per step, reported as deltas from the first step. Used to turn
// "node addable" into measured behaviour (ModifyBone, LookAt, blends) - see the skill table for the numbers.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_aim.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const len = (a: number[]) => Math.hypot(...a);
/** Angle in degrees between two unit-ish vectors. Exported for tests. */
export function angleDeg(a: number[], b: number[]): number {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.max(len(a) * len(b), 1e-9);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

export function registerAnimNodeMeasureTools(server: McpServer): void {
  server.tool(
    "anim_node_measure",
    "MEASURE what an AnimGraph node does: for each step of `sweep` (property sets applied to the node with " +
      "anim_node_set semantics), recompile, run the ABP on a hidden mannequin and read `bones` (world position and " +
      "+X/+Y axis directions). Reports each step's change from the first: position delta (cm) and axis rotation (deg). " +
      "`expect` [{step, bone, minCm?, maxCm?, minDeg?, maxDeg?}] turns it into a pass/fail check.",
    {
      blueprint: z.string(),
      nodeId: z.string(),
      sweep: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).min(2).max(10),
      bones: z.array(z.string()).min(1).max(10),
      mesh: z.string().optional(),
      expect: z.array(z.object({ step: z.number().int(), bone: z.string(), minCm: z.number().optional(), maxCm: z.number().optional(),
        minDeg: z.number().optional(), maxDeg: z.number().optional(),
        at: z.array(z.number()).length(3).optional().describe("Expected WORLD position of the bone (preview mannequin stands at 0,0,-5000, yaw 0)."),
        tolCm: z.number().optional() }).strict()).optional(),
      rest: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Properties to leave on the node afterwards (default: the first step)."),
      aim: z.object({ bone: z.string(), axis: z.enum(["x", "y"]), targetProperty: z.string(), maxDeg: z.number().optional() }).strict().optional()
        .describe("Aim check for look-at style nodes: angle between the bone's axis and the direction to the WORLD point in targetProperty ('(X=..,Y=..,Z=..)', carried over between steps)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const mesh = a.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
      const set = async (pr: Record<string, unknown>) => {
        const d = await uePost("/api/set-anim-node-properties", { blueprint: a.blueprint, nodeId: a.nodeId, properties: pr });
        if (d.error && !d.properties) throw new Error(d.error);
        await syncPins(a.blueprint, a.nodeId, d.properties, d.pins);
      };
      const states: Record<string, { p: number[]; x: number[]; y: number[] }>[] = [];
      try {
        for (const step of a.sweep) {
          await set(step);
          const p = await run("abp_preview('MCP_NodeMeasure', P['b'], P['m'])", { b: a.blueprint, m: mesh });
          if (!p.ok) throw new Error(p.error);
          await run("bones_state('MCP_NodeMeasure', P['bn'])", { bn: a.bones });
          const s = await run("bones_state('MCP_NodeMeasure', P['bn'])", { bn: a.bones });
          if (!s.ok) throw new Error(s.error);
          states.push(s.bones as any);
        }
      } catch (e) {
        return text(`Error: ${(e as Error).message}`, true);
      } finally {
        await set(a.rest ?? a.sweep[0]).catch(() => undefined);
        await run("remove_actor('MCP_NodeMeasure')", {});
      }
      const lines: string[] = [];
      let bad = 0;
      let tgt: number[] | null = null;
      a.sweep.forEach((step, i) => {
        if (a.aim) {
          const v = step[a.aim.targetProperty];
          if (typeof v === "string") {
            const m = v.match(/X=([-\d.]+),\s*Y=([-\d.]+),\s*Z=([-\d.]+)/);
            if (m) tgt = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
          }
        }
        const parts = a.bones.map((b) => {
          const d = len(sub(states[i][b].p, states[0][b].p));
          const r = Math.max(angleDeg(states[i][b].x, states[0][b].x), angleDeg(states[i][b].y, states[0][b].y));
          let flag = "";
          for (const e of (a.expect ?? []).filter((x) => x.step === i && x.bone === b)) {
            const miss = e.at ? len(sub(states[i][b].p, e.at)) : 0;
            const fail = (e.minCm !== undefined && d < e.minCm) || (e.maxCm !== undefined && d > e.maxCm) ||
              (e.minDeg !== undefined && r < e.minDeg) || (e.maxDeg !== undefined && r > e.maxDeg) || (e.at !== undefined && miss > (e.tolCm ?? 1));
            if (fail) { bad++; flag = "  <- UNEXPECTED"; } else flag = "  (as expected)";
            if (e.at) flag = ` ${miss.toFixed(2)} cm from target${flag}`;
          }
          return `${b} moved ${d.toFixed(2)} cm, turned ${r.toFixed(1)} deg${flag}`;
        });
        if (a.aim && tgt && states[i][a.aim.bone]) {
          const st = states[i][a.aim.bone];
          const errDeg = angleDeg(st[a.aim.axis], sub(tgt, st.p));
          const lim = a.aim.maxDeg ?? 5;
          const active = step["Node.Alpha"] === undefined ? true : Number(step["Node.Alpha"]) > 0;
          const fail = active && i > 0 && errDeg > lim;
          if (fail) bad++;
          parts.push(`aim error ${errDeg.toFixed(1)} deg${fail ? "  <- NOT AIMING" : ""}`);
        }
        lines.push(`  step ${i} ${JSON.stringify(step)}: ${parts.join("; ")}`);
      });
      return text([a.expect || a.aim ? (bad ? `NODE CHECK FAILED (${bad}):` : "Node behaviour verified:") : "Node measured:", ...lines].join("\n"), bad > 0);
    },
  );
}
