import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { syncPins } from "./animation-mutation.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): an Aim Offset's samples are additives, so the blend space "pose == clip"
// check cannot verify it. This drives the AimOffset node (AnimGraphNode_RotationOffsetBlendSpace) in a real ABP
// through its X/Y, runs the ABP on a hidden mannequin, and measures the head's gaze AND the body against the node at
// Alpha 0 (the base pose). The body check exists because stale additive data (see ue_anim.bs_write)
// stretched Manny ~4x while the head still turned the right way - a gaze-only check passed it; the eyes caught it.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_aim.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export type GazePoint = { x: number; y: number; yaw: number; pitch: number; pelvis_z?: number; spine_len?: number };

/** Body integrity vs the base pose (Alpha 0): pelvis height and pelvis->head distance must stay put. Exported for tests. */
export function aimBodyChecks(base: { pelvis_z: number; spine_len: number }, pts: GazePoint[], tolCm = 5): string[] {
  const bad: string[] = [];
  for (const p of pts) {
    const dz = Math.abs((p.pelvis_z ?? base.pelvis_z) - base.pelvis_z);
    const dl = Math.abs((p.spine_len ?? base.spine_len) - base.spine_len);
    if (dz > tolCm || dl > Math.max(tolCm, base.spine_len * 0.05))
      bad.push(`(${p.x}, ${p.y}): pelvis height ${p.pelvis_z} vs ${base.pelvis_z}, pelvis->head ${p.spine_len} vs ${base.spine_len} cm`);
  }
  return bad;
}

/** Signed angle difference in degrees (wraps at 360). */
export function angDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/**
 * Axis checks on measured gaze deltas from the (0,0) point: opposite inputs on an axis must move the head in opposite
 * directions by at least `minDeg`, and the other axis must move less than half as much (no cross-talk). Exported for tests.
 */
export function aimAxisChecks(pts: GazePoint[], minDeg = 3): { ok: boolean; lines: string[] } {
  const c = pts.find((p) => p.x === 0 && p.y === 0);
  if (!c) return { ok: false, lines: ["no (0,0) point to measure from"] };
  const lines: string[] = [];
  let ok = true;
  for (const [axis, key, other] of [["x", "yaw", "pitch"], ["y", "pitch", "yaw"]] as const) {
    const neg = pts.filter((p) => p[axis] < 0 && p[axis === "x" ? "y" : "x"] === 0).sort((a, b) => a[axis] - b[axis])[0];
    const pos = pts.filter((p) => p[axis] > 0 && p[axis === "x" ? "y" : "x"] === 0).sort((a, b) => b[axis] - a[axis])[0];
    if (!neg || !pos) continue;
    const dn = angDiff(neg[key], c[key]), dp = angDiff(pos[key], c[key]);
    const xn = Math.abs(angDiff(neg[other], c[other])), xp = Math.abs(angDiff(pos[other], c[other]));
    const opposite = Math.sign(dn) !== Math.sign(dp) && Math.abs(dn) >= minDeg && Math.abs(dp) >= minDeg;
    const clean = xn < Math.abs(dn) / 2 && xp < Math.abs(dp) / 2;
    if (!opposite || !clean) ok = false;
    lines.push(`${axis.toUpperCase()} ${neg[axis]} / ${pos[axis]}: head ${key} ${dn.toFixed(1)} / ${dp.toFixed(1)} deg, ${other} drift ${xn.toFixed(1)} / ${xp.toFixed(1)}` +
      `${opposite ? "" : "  <- NOT OPPOSITE / TOO SMALL"}${clean ? "" : "  <- CROSS-TALK"}`);
  }
  if (!lines.length) return { ok: false, lines: ["need points at +-x (y=0) and/or +-y (x=0)"] };
  return { ok, lines };
}

export function registerAimOffsetTools(server: McpServer): void {
  server.tool(
    "aim_offset_check",
    "VERIFY an Aim Offset (create_blend_space dimensions 'aim2d') in its Anim Blueprint: sets the AimOffset node's " +
      "X / Y (yaw / pitch) to each point, recompiles, runs the ABP on a hidden mannequin and measures the head's gaze. " +
      "Passes when opposite inputs turn the head opposite ways (>= minDeg) with little drift on the other axis AND the " +
      "body matches the base pose (node Alpha 0): pelvis height and pelvis->head length. Leaves the node at Alpha 1, (0,0) or `rest`.",
    {
      blueprint: z.string().describe("Anim Blueprint containing the AimOffset node."),
      nodeId: z.string().describe("AimOffset node ID (AnimGraphNode_RotationOffsetBlendSpace, from add_anim_node)."),
      points: z.array(z.tuple([z.number(), z.number()])).optional().describe("[x, y] inputs; default (0,0), (+-90,0), (0,+-90)."),
      mesh: z.string().optional(),
      bone: z.string().optional().describe("Gaze bone (default head; +Y is gaze on the UE5 mannequin)."),
      minDeg: z.number().optional().describe("Minimum head turn per extreme (default 3)."),
      rest: z.tuple([z.number(), z.number()]).optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const pts = a.points ?? [[0, 0], [-90, 0], [90, 0], [0, 90], [0, -90]];
      if (!pts.some(([x, y]) => x === 0 && y === 0)) pts.unshift([0, 0]);
      const mesh = a.mesh ?? "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
      const out: GazePoint[] = [];
      const props = async (pr: Record<string, number>) => {
        const d = await uePost("/api/set-anim-node-properties", { blueprint: a.blueprint, nodeId: a.nodeId, properties: pr });
        if (d.error && !d.properties) throw new Error(d.error);
        await syncPins(a.blueprint, a.nodeId, d.properties, d.pins);
      };
      const measure = async () => {
        const p = await run("abp_preview('MCP_AOCheck', P['b'], P['m'])", { b: a.blueprint, m: mesh });
        if (!p.ok) throw new Error(p.error);
        await run("head_gaze('MCP_AOCheck', P['bone'])", { bone: a.bone ?? "head" });   // bones update next tick
        const g = await run("head_gaze('MCP_AOCheck', P['bone'])", { bone: a.bone ?? "head" });
        if (!g.ok) throw new Error(g.error);
        return g as any;
      };
      let base: any;
      try {
        await props({ "Node.Alpha": 0 });
        base = await measure();
        await props({ "Node.Alpha": 1 });
        for (const [x, y] of pts) {
          await props({ "Node.X": x, "Node.Y": y });
          const g = await measure();
          out.push({ x, y, yaw: g.yaw, pitch: g.pitch, pelvis_z: g.pelvis_z, spine_len: g.spine_len });
        }
      } catch (e) {
        return text(`Error driving the AimOffset node: ${(e as Error).message}`, true);
      } finally {
        await props({ "Node.Alpha": 1, "Node.X": (a.rest ?? [0, 0])[0], "Node.Y": (a.rest ?? [0, 0])[1] }).catch(() => undefined);
        await run("remove_actor('MCP_AOCheck')", {});
      }
      const v = aimAxisChecks(out, a.minDeg ?? 3);
      const body = aimBodyChecks(base, out);
      if (body.length) v.ok = false;
      const c = out.find((p) => p.x === 0 && p.y === 0)!;
      return text([v.ok ? "Aim offset verified:" : "AIM OFFSET CHECK FAILED:", ...v.lines,
        body.length ? "BODY DISTORTED vs the base pose (Alpha 0) - check the samples' additive base:" : `Body intact vs the base pose (pelvis ${base.pelvis_z} cm, pelvis->head ${base.spine_len} cm).`,
        ...body.map((b) => "  " + b),
        ...out.map((p) => `  (${p.x}, ${p.y}): head yaw ${angDiff(p.yaw, c.yaw).toFixed(1)}, pitch ${angDiff(p.pitch, c.pitch).toFixed(1)} deg from (0,0)`)].join("\n"), !v.ok);
    },
  );
}
