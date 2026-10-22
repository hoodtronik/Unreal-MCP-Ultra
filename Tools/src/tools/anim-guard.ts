import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, ueGet, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): fixes for the Anim Blueprint / Blend Space hot spots of the MCP audit (#6, #8) without
// rebuilding the plugin DLL (the editor holds it):
//  * Every ABP mutation tool registered through withAnimGuards() resolves its animation/blend-space argument in
//    Python first (exists, right class, same skeleton as the ABP) and passes the plugin the package path - the
//    C++ silently skipped unresolved assets and still returned success. Afterwards it compiles the ABP through
//    /api/validate-blueprint and reports compiler errors as isError (the C++ never checked AnimBP->Status).
//  * Blend spaces are written in Python (1D or 2D, replace or merge, validated, read back) and then RESAMPLED by
//    opening/closing the Blend Space editor - Python-written samples otherwise evaluate to the reference pose -
//    and verified by evaluating the asset at every sample point against the sample clip.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_abp.py"];
const MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
export const MATCH_CM = 0.5; // pose at a sample point vs the sample clip (live: 0.000 when resampled, ~40 cm when not)

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string, isError = false): Result {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Which argument of which ABP tool names an animation asset, and the classes it must be. */
const ASSET_ARGS: Record<string, { arg: string; kinds: (a: any) => string[] }> = {
  add_anim_state: { arg: "animationAsset", kinds: () => ["AnimSequence"] },
  set_state_animation: { arg: "animationAsset", kinds: () => ["AnimSequence"] },
  set_state_blend_space: { arg: "blendSpace", kinds: () => ["BlendSpace"] },
  add_anim_node: {
    arg: "animationAsset",
    kinds: (a) => (a.nodeType === "BlendSpacePlayer" ? ["BlendSpace"] : a.nodeType === "PoseBlender" ? ["PoseAsset"] : ["AnimSequence"]),
  },
};
const COMPILE_AFTER = new Set(["add_anim_state", "remove_anim_state", "add_anim_transition", "set_transition_rule", "add_anim_node", "anim_node_set",
  "add_state_machine", "set_state_animation", "set_state_blend_space"]);

// CLAUDE-NOTE (2026-10-21, live): an ABP built with add_state_machine + add_anim_state compiled with only WARNINGS
// ("Output Pose: Result was visible but ignored", "Entry node ... is not connected to state") and played the
// reference pose. Those warnings mean an unwired graph, so they count as errors here - and so does a transition
// whose Can Enter Transition is unconnected ("will never be taken"; live, round 9).
export const UNWIRED = /visible but ignored|is not connected to state|no entry state connection|will never be taken/i;
// CLAUDE-NOTE (2026-10-22, live): "visible but ignored" also fires for NON-pose pins that a node legitimately leaves
// unconnected - RetargetPoseFromMesh's Source (mesh component) when bUseAttachedParent is on. That ABP animated
// (live == offline retarget within 0.041 cm) while anim_bp_check called it an unwired graph. Mesh-component pins
// are excluded; pose pins still count.
export const NOT_POSE_PIN = /:\s*(Source|Source Mesh Component)\s+was visible but ignored/i;

function msg(e: any): string {
  return typeof e === "string" ? e : `${e.source === "log" ? "[log] " : ""}${e.graph ? `[${e.graph}] ` : ""}${e.nodeTitle ? `${e.nodeTitle}: ` : ""}${e.message}`;
}

/** Lines of a validate-blueprint answer + whether it has errors (unwired-graph warnings included). Exported for tests. */
export function compileSummary(data: any, expected: RegExp[] = []): { ok: boolean; lines: string[] } {
  if (data?.error) return { ok: false, lines: [`Compile check failed: ${data.error}`] };
  const errs: string[] = (data?.errors ?? []).map(msg);
  // node-level warnings only; the same text repeats as [log] lines
  const all: string[] = (data?.warnings ?? []).map(msg).filter((w: string) => UNWIRED.test(w) && !NOT_POSE_PIN.test(w) && !w.startsWith("[log]"));
  // what the step just created cannot be wired yet (empty machine / empty state): reported, not an error
  const pending = all.filter((w) => expected.some((r) => r.test(w)));
  const unwired = all.filter((w) => !pending.includes(w));
  // the plugin marks a machine with no entry state invalid; when that is all, the step is just incomplete
  const ok = errs.length === 0 && unwired.length === 0 && (data?.isValid !== false || pending.length > 0);
  const lines = [`Compile: ${ok ? (pending.length ? "OK (incomplete)" : "OK") : errs.length ? "ERRORS" : "UNWIRED GRAPH"}${data?.warningCount ? ` (${data.warningCount} warning(s))` : ""}`];
  for (const e of [...errs, ...unwired].slice(0, 10)) lines.push(`  x ${e.replace(/\s+/g, " ")}`);
  for (const e of pending.slice(0, 4)) lines.push(`  incomplete (expected until the next step): ${e.replace(/\s+/g, " ")}`);
  return { ok, lines };
}

/** Warnings the step itself leaves pending: a new machine has no states yet, a new state without an asset has no player. */
function expectedFor(name: string, a: any, body: string): RegExp[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (name === "add_state_machine") {
    const m = /Sub-graph: (.+)/.exec(body)?.[1]?.trim();
    return m ? [new RegExp(`no entry state connection in\\s+${esc(m)}`, "i"), new RegExp(`Entry node\\s+${esc(m)}\\s+is not connected`, "i")] : [];
  }
  if (name === "add_anim_state" && !a.animationAsset) return [new RegExp(`^\\[${esc(a.stateName)}\\] Output Animation Pose`, "i")];
  // CLAUDE-NOTE (2026-10-22, live): a new Slot / Pose Blender node has a Source input that the next step wires
  // (a state machine or pose into it) - reported as pending, not an error.
  // Generic nodes (IK, layered blend, look-at...) also leave their pose inputs for the next step to wire.
  if (name === "add_anim_node" && !["SequencePlayer", "BlendSpacePlayer", "StateMachine"].includes(a.nodeType)) return [/was\s+visible\s+but\s+ignored/i];
  return [];
}

type GNode = { id: string; class: string; pins?: { name: string; connections?: unknown[] }[] };

async function graphNodes(bp: string, graph: string): Promise<GNode[] | null> {
  const d = await ueGet("/api/graph", { name: bp, graph });
  return d && Array.isArray(d.nodes) ? d.nodes : null;
}

function pinOf(n: GNode | undefined, name: string) {
  return n?.pins?.find((p) => p.name === name);
}

async function connect(bp: string, from: string, fromPin: string, to: string, toPin: string): Promise<string> {
  const r = await uePost("/api/connect-pins", { blueprint: bp, sourceNodeId: from, sourcePinName: fromPin, targetNodeId: to, targetPinName: toPin });
  return r?.error && !r?.success ? `could not wire ${fromPin} -> ${toPin}: ${r.error}` : "";
}

/** Wire what the plugin leaves dangling: new machine/node -> Output Pose, Entry -> first state, sequence player
 * -> state output pose (add_anim_state added the player unwired; set_state_blend_space wires its own). */
async function autowire(name: string, a: any, body: string): Promise<string[]> {
  const out: string[] = [];
  const bp = a.blueprint;
  const nodeId = /Node ID: ([0-9A-F]{32})/i.exec(body)?.[1];
  const inRoot = name === "add_state_machine" || (name === "add_anim_node" && (!a.graph || a.graph === "AnimGraph"));
  if (inRoot && nodeId && a.connectToOutput !== false) {
    const g = await graphNodes(bp, "AnimGraph");
    const root = g?.find((n) => n.class === "AnimGraphNode_Root");
    if (root && !pinOf(root, "Result")?.connections?.length) {
      const e = await connect(bp, nodeId, "Pose", root.id, "Result");
      out.push(e ? `Wiring: ${e}` : "Wired: new node -> Output Pose.");
    }
  }
  if (name === "add_state_machine" && a.name) {
    const m = /Sub-graph: (.+)/.exec(body)?.[1]?.trim();
    if (m && m !== a.name) out.push(`NOTE: the plugin ignored name '${a.name}'; the state machine graph is '${m}' - use that name.`);
  }
  if (name === "add_anim_state" && nodeId) {
    const g = await graphNodes(bp, a.graph);
    const entry = g?.find((n) => n.class === "AnimStateEntryNode");
    if (entry && !pinOf(entry, "Entry")?.connections?.length) {
      const e = await connect(bp, entry.id, "Entry", nodeId, "In");
      out.push(e ? `Wiring: ${e}` : `Wired: Entry -> '${a.stateName}' (default state).`);
    }
  }
  if ((name === "add_anim_state" && a.animationAsset) || name === "set_state_animation") {
    const g = await graphNodes(bp, a.stateName);
    const res = g?.find((n) => n.class === "AnimGraphNode_StateResult");
    const player = g?.find((n) => n.class === "AnimGraphNode_SequencePlayer" && !pinOf(n, "Pose")?.connections?.length);
    if (res && player && !pinOf(res, "Result")?.connections?.length) {
      const e = await connect(bp, player.id, "Pose", res.id, "Result");
      out.push(e ? `Wiring: ${e}` : `Wired: sequence player -> '${a.stateName}' output pose.`);
    }
  }
  return out;
}

/** Wrap an McpServer so ABP tools get the asset guard + compile check. */
export function withAnimGuards(server: McpServer): McpServer {
  const tool = (server.tool as any).bind(server);
  const proxy = Object.create(server);
  proxy.tool = (name: string, desc: string, schema: any, handler: (a: any, extra: any) => Promise<Result>) => {
    const guard = ASSET_ARGS[name];
    const wrapped = async (a: any, extra: any): Promise<Result> => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const args = { ...a };
      const notes: string[] = [];
      if (a.blueprint && (guard || COMPILE_AFTER.has(name))) {
        const bp = await run("resolve_abp(P['bp'])", { bp: a.blueprint });
        if (!bp.ok) return text(`Error: ${bp.error}`, true);
        args.blueprint = bp.path;
        if (guard && a[guard.arg]) {
          const chk = await run("check_anim(P['a'], P['k'], P['bp'])", { a: a[guard.arg], k: guard.kinds(a), bp: bp.path });
          if (!chk.ok) return text(`Error: ${chk.error} (nothing was changed)`, true);
          args[guard.arg] = chk.path;
          notes.push(`Asset: ${chk.path} (${chk.class}, skeleton ${chk.skeleton.split("/").pop()})`);
        }
      }
      const r = await handler(args, extra);
      let body = r.content.map((c) => c.text).join("\n");
      if (r.isError || /^Error/m.test(body)) return { ...r, isError: true };
      // CLAUDE-NOTE (2026-10-21, live): the C++ reads add_state_machine's name but never applies it - every machine
      // came out "New State Machine". Rename the new graph the way the editor does (BlueprintEditorLibrary.rename_graph).
      const sub = name === "add_state_machine" && a.name ? /Sub-graph: (.+)/.exec(body)?.[1]?.trim() : undefined;
      if (sub && sub !== a.name) {
        const rn = await run("sm_rename(P['b'], P['o'], P['n'])", { b: args.blueprint, o: sub, n: a.name });
        if (!rn.ok) return text(`${body}\nCould not apply the name '${a.name}': ${rn.error}`, true);
        body = body.split(sub).join(rn.name);
        if (rn.name !== a.name) notes.push(`Name '${a.name}' was taken; the machine is '${rn.name}'.`);
      }
      if (!COMPILE_AFTER.has(name) || !args.blueprint) return notes.length ? text([body, ...notes].join("\n")) : r;
      notes.push(...(await autowire(name, args, body)));
      const v = compileSummary(await uePost("/api/validate-blueprint", { blueprint: args.blueprint }), expectedFor(name, args, body));
      return text([body, ...notes, ...v.lines].join("\n"), !v.ok);
    };
    const more = name === "add_state_machine" || name === "add_anim_node"
      ? { connectToOutput: z.boolean().optional().describe("Wire the new node to the AnimGraph Output Pose when that is free (default true).") }
      : {};
    return tool(name, desc, { ...schema, ...more }, wrapped);
  };
  return proxy as McpServer;
}

const vec2 = z.object({
  animationAsset: z.string().describe("AnimSequence name or path"),
  x: z.number(),
  y: z.number().optional().describe("Second axis (2D only)"),
  rateScale: z.number().optional(),
});

async function verifyBlendSpace(path: string): Promise<{ ok: boolean; lines: string[] }> {
  const rd = await run("bs_read(P['p'])", { p: path });
  if (!rd.ok) return { ok: false, lines: [`Readback failed: ${rd.error}`] };
  const lines: string[] = [];
  let ok = rd.samples.length > 0;
  if (!ok) lines.push("NO SAMPLES - the blend space evaluates to the reference pose.");
  for (const s of rd.samples) {
    await run("bs_preview('MCP_BSCheck', P['p'], P['x'], P['y'], P['m'], (0, 0, -5000))", { p: path, x: s.x, y: s.y, m: MESH });
    const a = await run("pose_signature('MCP_BSCheck')", {});
    await run("preview_anim('MCP_BSClip', P['a'], 0.0, P['m'], (0, 300, -5000))", { a: s.anim, m: MESH });
    const b = await run("pose_signature('MCP_BSClip')", {});
    if (!a.ok || !b.ok) return { ok: false, lines: [`Evaluation failed: ${a.error ?? b.error}`] };
    let worst = 0;
    for (const [k, v] of Object.entries(a.bones as Record<string, number[]>)) {
      const w = (b.bones as Record<string, number[]>)[k];
      if (w) worst = Math.max(worst, Math.hypot(v[0] - w[0], v[1] - w[1], v[2] - w[2]));
    }
    const good = worst <= MATCH_CM;
    ok &&= good;
    lines.push(`  (${s.x}${rd.dimensions === 2 ? `, ${s.y}` : ""}) ${s.anim.split("/").pop()}: pose differs from the clip by ${worst.toFixed(2)} cm${good ? "" : "  <- NOT EVALUATING THIS SAMPLE"}`);
  }
  await run("remove_actor('MCP_BSCheck')", {});
  await run("remove_actor('MCP_BSClip')", {});
  return { ok, lines };
}

export function registerBlendSpaceTools(server: McpServer): void {
  server.tool(
    "create_blend_space",
    "Create a Blend Space asset (1D or 2D) for a skeleton. Idempotent: an existing asset at the path is reused.",
    {
      name: z.string().describe("Blend Space name (e.g. 'BS_Locomotion')"),
      packagePath: z.string().default("/Game").describe("Package path (e.g. '/Game/Animations')"),
      skeleton: z.string().describe("Skeleton asset name or path"),
      dimensions: z.union([z.literal(1), z.literal(2), z.literal("aim1d"), z.literal("aim2d")]).optional()
        .describe("1 = BlendSpace1D, 2 = 2D (default), 'aim2d' / 'aim1d' = Aim Offset (additive yaw/pitch; set_blend_space_samples makes its samples mesh-space rotation-offset additives)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("bs_create(P['n'], P['pp'], P['sk'], P['d'])", { n: a.name, pp: a.packagePath, sk: a.skeleton, d: a.dimensions ?? 2 });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      const kind = String(r.class ?? "").startsWith("AimOffset") ? "Aim Offset" : "Blend Space";
      return text(`${r.created ? "Created" : "Reused"} ${r.dimensions}D ${kind} ${r.path}.\nNext: set_blend_space_samples (it resamples and verifies).`);
    },
  );

  server.tool(
    "set_blend_space_samples",
    "Set the axes and animation samples of a Blend Space (1D: x only; 2D: x,y). mode 'replace' (default) swaps the " +
      "whole sample set; 'merge' keeps existing samples except ones at the same coordinates. Every animation must " +
      "resolve and use the blend space's skeleton and every point must lie inside the axes, else NOTHING is written. " +
      "Then rebuilds the runtime blend data (as the Blend Space editor does) and VERIFIES by evaluating the asset at " +
      "each sample point against that sample's clip.",
    {
      blendSpace: z.string().describe("Blend Space asset name or path"),
      axisXName: z.string().optional(),
      axisXMin: z.number().optional(),
      axisXMax: z.number().optional(),
      axisXGrid: z.number().int().optional().describe("Grid divisions on X"),
      axisYName: z.string().optional(),
      axisYMin: z.number().optional(),
      axisYMax: z.number().optional(),
      axisYGrid: z.number().int().optional(),
      samples: z.array(vec2).describe("Animation samples with coordinates"),
      mode: z.enum(["replace", "merge"]).optional(),
      verify: z.boolean().optional().describe("Evaluate each sample point (default true)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const axes = [
        { name: a.axisXName, min: a.axisXMin, max: a.axisXMax, grid: a.axisXGrid },
        { name: a.axisYName, min: a.axisYMin, max: a.axisYMax, grid: a.axisYGrid },
      ];
      const samples = a.samples.map((s) => ({ anim: s.animationAsset, x: s.x, y: s.y ?? 0, rate: s.rateScale ?? 1 }));
      const w = await run("bs_write(P['p'], P['s'], P['ax'], P['mode'])", { p: a.blendSpace, s: samples, ax: axes, mode: a.mode ?? "replace" });
      if (!w.ok) return text(`Error: ${w.error} (nothing was written)`, true);
      const rs = await run("bs_resample(P['p'])", { p: w.path });
      if (!rs.ok) return text(`Wrote samples but could not resample: ${rs.error}`, true);
      const lines = [
        `${w.path} (${w.dimensions}D): ${w.samples.length} sample(s) after ${a.mode ?? "replace"}; axes ${w.axes.map((x: any) => `${x.name || "?"} [${x.min}, ${x.max}] grid ${x.grid}`).join(", ")}.`,
      ];
      if (a.verify === false) return text(lines.join("\n"));
      if (w.aim) {
        // CLAUDE-NOTE (2026-10-22, live): aim offset samples are additive, so "pose == clip" does not apply. Verified
        // instead by driving an AimOffset node (add_anim_node AnimGraphNode_RotationOffsetBlendSpace, anim_node_set /
        // anim_bp_drive on its X/Y): then aim_offset_check (gaze per axis + body vs the base pose).
        lines.push("Aim offset: samples are mesh-space rotation-offset additives (converted if needed). The per-sample clip check does not apply to additives - verify by driving an AimOffset node in an ABP and measuring the head.");
        return text(lines.join("\n"));
      }
      const v = await verifyBlendSpace(w.path);
      lines.push(v.ok ? "Verified - every sample point evaluates to its clip:" : "BLEND SPACE CHECK FAILED:", ...v.lines);
      return text(lines.join("\n"), !v.ok);
    },
  );

  server.tool(
    "anim_bp_check",
    "Verify an Animation Blueprint really animates: compiles it (unwired-graph warnings count as errors), runs it on a " +
      "hidden preview mannequin and compares the pose with the reference pose. An ABP that compiles but plays nothing " +
      "(state machine not wired to Output Pose, no entry state, player not wired to a state's output) fails here.",
    { blueprint: z.string(), mesh: z.string().optional().describe(`Preview SkeletalMesh (default ${MESH}).`) },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const bp = await run("resolve_abp(P['bp'])", { bp: a.blueprint });
      if (!bp.ok) return text(`Error: ${bp.error}`, true);
      const v = compileSummary(await uePost("/api/validate-blueprint", { blueprint: bp.path }));
      const m = a.mesh ?? MESH;
      const p1 = await run("abp_preview('MCP_ABPCheck', P['bp'], P['m'])", { bp: bp.path, m });
      const p2 = await run("ref_preview('MCP_ABPRef', P['m'])", { m });
      if (!p1.ok || !p2.ok) return text(`Error: ${p1.error ?? p2.error}`, true);
      const sa = await run("pose_signature('MCP_ABPCheck')", {});
      const sb = await run("pose_signature('MCP_ABPRef')", {});
      await run("remove_actor('MCP_ABPCheck')", {});
      await run("remove_actor('MCP_ABPRef')", {});
      if (!sa.ok || !sb.ok) return text(`Error: ${sa.error ?? sb.error}`, true);
      let moved = 0;
      for (const [k, p] of Object.entries(sa.bones as Record<string, number[]>)) {
        const q = (sb.bones as Record<string, number[]>)[k];
        if (q) moved = Math.max(moved, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
      const animates = moved > 2;
      return text([`${bp.path} (skeleton ${bp.skeleton.split("/").pop()}):`, ...v.lines,
        `${animates ? "Animates" : "PLAYS THE REFERENCE POSE"}: bones up to ${moved.toFixed(1)} cm from the reference pose.`].join("\n"), !(v.ok && animates));
    },
  );

  server.tool(
    "blend_space_check",
    "Read a Blend Space (axes, samples) and verify it really evaluates: holds the asset at each sample point on a " +
      "hidden preview mannequin and compares the pose with the sample clip. Catches empty or un-resampled blend spaces " +
      "(they play the reference pose).",
    { blendSpace: z.string() },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const rd = await run("bs_read(P['p'])", { p: a.blendSpace });
      if (!rd.ok) return text(`Error: ${rd.error}`, true);
      const v = await verifyBlendSpace(rd.path);
      return text([`${rd.path} (${rd.dimensions}D, skeleton ${rd.skeleton.split("/").pop()}): axes ${rd.axes.map((x: any) => `${x.name || "?"} [${x.min}, ${x.max}]`).join(", ")}`,
        v.ok ? "Evaluates correctly:" : "BLEND SPACE CHECK FAILED:", ...v.lines].join("\n"), !v.ok);
    },
  );
}
