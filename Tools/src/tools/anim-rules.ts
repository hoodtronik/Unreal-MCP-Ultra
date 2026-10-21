import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, ueGet, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";
import { compileSummary } from "./anim-guard.js";

// CLAUDE-NOTE (2026-10-21): state-machine RULES and a RUNTIME check for Anim Blueprints (Tools/python/ue_abp.py).
//  * anim_transition_rule wires "<variable> <op> <value>" into a transition's Can Enter Transition. The existing
//    set_transition_rule only set crossfade/priority, and add_node could not reach any transition but the first:
//    every rule graph was named "Transition" (ue_abp.py notes). The tool names each rule graph "<From> to <To>".
//  * anim_bp_drive runs the ABP (hidden editor preview, or in PIE), sets variables step by step and reports which
//    state's clip the rendered skeleton matches (root-relative bones vs the clip sampled at 120 fps; live: playing
//    state 0.01-0.9 cm, other state 24-68 cm). Python cannot read the active state, so the pose is the readback.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_abp.py"];
const MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
const LABEL = "MCP_Drive";
// CLAUDE-NOTE (live, round 9): playing state 0.0-2.6 cm (PIE jog/walk read between frames), nearest OTHER state
// never under 18 cm over 3 clips - 5 cm keeps a wide margin both ways.
export const STATE_MATCH_CM = 5;
export const AMBIGUOUS_CM = 2;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const OPS = [">", ">=", "<", "<=", "==", "!=", "true", "false"] as const;
export type Op = (typeof OPS)[number];

/** KismetMathLibrary function for a comparison (null = wire the bool straight in). Exported for tests. */
export function ruleFunction(op: Op, type: "bool" | "int" | "float"): { fn: string | null; error?: string } {
  if (type === "bool") {
    if (op === "true") return { fn: null };
    if (op === "false") return { fn: "Not_PreBool" };
    return { fn: null, error: "a bool variable takes op 'true' or 'false'" };
  }
  if (op === "true" || op === "false") return { fn: null, error: `a ${type} variable needs a comparison (${OPS.slice(0, 6).join(" ")}) and a value` };
  const suffix = type === "int" ? "IntInt" : "DoubleDouble";
  const name = { ">": "Greater", ">=": "GreaterEqual", "<": "Less", "<=": "LessEqual", "==": "EqualEqual", "!=": "NotEqual" }[op];
  return { fn: `${name}_${suffix}` };
}

/** Join tr_mark's crossfade markers with the graph reader's transitions. Exported for tests. */
export function joinMarks(marks: { name: string; crossfade: number; mark: number }[], nodes: any[]) {
  return marks.map((m) => {
    const t = nodes.find((n) => n.nodeType === "AnimTransition" && Math.abs(Number(n.crossfadeDuration) - m.mark) < 1e-3);
    return { ...m, from: t?.fromState as string | undefined, to: t?.toState as string | undefined };
  });
}

/** Best-matching state for one clip_match answer. Exported for tests. */
export function decideState(stateClips: Record<string, string>, clips: Record<string, { cm: number }>) {
  const ranked = Object.entries(stateClips)
    .map(([state, clip]) => ({ state, cm: clips[clip]?.cm ?? Infinity }))
    .sort((a, b) => a.cm - b.cm);
  const best = ranked[0];
  // CLAUDE-NOTE (live): a baked wave's first frame sat 4.3 cm from the idle clip; with PIE read jitter up to 2.6 cm
  // two states that close must be reported as ambiguous, not decided by a coin flip.
  const ambiguous = !!best && ranked.length > 1 && ranked[1].cm - best.cm < AMBIGUOUS_CM;
  return { state: best && best.cm <= STATE_MATCH_CM && !ambiguous ? best.state : null, ranked, ambiguous };
}

async function graph(bp: string, name: string): Promise<any> {
  return ueGet("/api/graph", { name: bp, graph: name });
}

/** Name every rule graph of a state machine "<From> to <To>"; returns the transitions. */
async function nameRuleGraphs(bp: string, sm: string): Promise<{ ok: boolean; error?: string; transitions: any[] }> {
  const marks = await run("tr_mark(P['b'], P['s'])", { b: bp, s: sm });
  if (!marks.ok) return { ok: false, error: marks.error, transitions: [] };
  let joined = marks.nodes.map((m: any) => ({ ...m }));
  try {
    const g = await graph(bp, sm);
    if (g.error) return { ok: false, error: g.error, transitions: [] };
    joined = joinMarks(marks.nodes, g.nodes ?? []);
  } finally {
    // always restores the real crossfades, even when the join failed
    const r = await run("tr_rename(P['b'], P['s'], P['j'])", { b: bp, s: sm, j: joined });
    if (!r.ok) return { ok: false, error: `could not restore/rename transitions: ${r.error}`, transitions: [] };
  }
  return { ok: true, transitions: joined.filter((j: any) => j.from) };
}

async function stateClips(bp: string, sm: string): Promise<{ clips: Record<string, string>; skipped: string[]; error?: string }> {
  const g = await graph(bp, sm);
  if (g.error) return { clips: {}, skipped: [], error: g.error };
  const clips: Record<string, string> = {};
  const skipped: string[] = [];
  for (const n of g.nodes ?? []) {
    if (n.nodeType !== "AnimState") continue;
    const sg = await graph(bp, n.stateName);
    const players = (sg.nodes ?? []).filter((x: any) => x.nodeType === "AnimSequencePlayer" && x.animationAssetPath);
    if (players.length === 1) clips[n.stateName] = String(players[0].animationAssetPath).split(".")[0];
    else skipped.push(n.stateName);
  }
  return { clips, skipped };
}

export function registerAnimRuleTools(server: McpServer): void {
  server.tool(
    "anim_transition_rule",
    "Set WHEN an Anim Blueprint state-machine transition fires: wires '<variable> <op> <value>' into the transition's " +
      "Can Enter Transition (float/int: > >= < <= == !=; bool: true/false), compiles, and reads the rule back. Names " +
      "every rule graph '<From> to <To>' and makes the variable instance-editable so anim_bp_drive can test it.",
    {
      blueprint: z.string(),
      stateMachine: z.string().describe("State machine graph name (as listed by get_blueprint_summary)."),
      from: z.string(),
      to: z.string(),
      variable: z.string().describe("Member variable (bool, int or float) - add it with add_variable first."),
      op: z.enum(OPS),
      value: z.number().optional().describe("Comparison value (float/int rules)."),
      replace: z.boolean().optional().describe("Replace an existing rule on this transition."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const bp = await run("resolve_abp(P['b'])", { b: a.blueprint });
      if (!bp.ok) return text(`Error: ${bp.error}`, true);
      const vt = await run("abp_var_type(P['b'], P['v'])", { b: bp.path, v: a.variable });
      if (!vt.ok) return text(`Error: ${vt.error}`, true);
      const rf = ruleFunction(a.op, vt.type);
      if (rf.error) return text(`Error: ${rf.error}.`, true);
      if (rf.fn && rf.fn !== "Not_PreBool" && a.value === undefined) return text("Error: this rule needs a value.", true);

      const named = await nameRuleGraphs(bp.path, a.stateMachine);
      if (!named.ok) return text(`Error: ${named.error}`, true);
      const tr = named.transitions.find((t) => t.from === a.from && t.to === a.to);
      if (!tr) return text(`Error: no transition ${a.from} -> ${a.to}. Transitions: ${named.transitions.map((t) => `${t.from} -> ${t.to}`).join(", ") || "none"}.`, true);
      const rg = `${a.from} to ${a.to}`;

      const g = await graph(bp.path, rg);
      const result = (g.nodes ?? []).find((n: any) => n.class === "AnimGraphNode_TransitionResult");
      if (!result) return text(`Error: rule graph '${rg}' has no result node.`, true);
      const others = (g.nodes ?? []).filter((n: any) => n !== result);
      if (others.length && !a.replace) return text(`Error: ${rg} already has a rule (${others.length} node(s)) - pass replace:true to overwrite it.`, true);
      for (const n of others) {
        const d = await uePost("/api/delete-node", { blueprint: bp.path, nodeId: n.id });
        if (d.error) return text(`Error removing the old rule: ${d.error}`, true);
      }

      const add = (body: Record<string, unknown>) => uePost("/api/add-node", { blueprint: bp.path, graph: rg, ...body });
      const v = await add({ nodeType: "VariableGet", variableName: a.variable, posX: -500, posY: 0 });
      if (v.error || !v.nodeId) return text(`Error adding the ${a.variable} getter: ${v.error ?? "no node id"}`, true);
      let src = { id: v.nodeId as string, pin: a.variable };
      if (rf.fn) {
        const f = await add({ nodeType: "CallFunction", functionName: rf.fn, className: "KismetMathLibrary", posX: -250, posY: 0 });
        if (f.error || !f.nodeId) return text(`Error adding ${rf.fn}: ${f.error ?? "no node id"}`, true);
        const c = await uePost("/api/connect-pins", { blueprint: bp.path, sourceNodeId: v.nodeId, sourcePinName: a.variable, targetNodeId: f.nodeId, targetPinName: "A" });
        if (c.error) return text(`Error wiring ${a.variable} -> ${rf.fn}.A: ${c.error}`, true);
        if (a.value !== undefined && rf.fn !== "Not_PreBool") {
          const val = vt.type === "int" ? String(Math.round(a.value)) : String(a.value);
          const s = await uePost("/api/set-pin-default", { blueprint: bp.path, nodeId: f.nodeId, pinName: "B", value: val });
          if (s.error) return text(`Error setting the comparison value: ${s.error}`, true);
        }
        src = { id: f.nodeId, pin: "ReturnValue" };
      }
      const c = await uePost("/api/connect-pins", { blueprint: bp.path, sourceNodeId: src.id, sourcePinName: src.pin, targetNodeId: result.id, targetPinName: "bCanEnterTransition" });
      if (c.error) return text(`Error wiring the rule into Can Enter Transition: ${c.error}`, true);

      const ex = await run("abp_expose(P['b'], [P['v']])", { b: bp.path, v: a.variable });
      const comp = compileSummary(await uePost("/api/validate-blueprint", { blueprint: bp.path }));
      // read the rule back: the result pin must now be driven
      const back = await graph(bp.path, rg);
      const pin = (back.nodes ?? []).find((n: any) => n.class === "AnimGraphNode_TransitionResult")?.pins?.find((p: any) => p.name === "bCanEnterTransition");
      const wired = (pin?.connections ?? []).length === 1;
      const never = comp.lines.some((l) => l.includes(rg) && /never be taken/i.test(l));
      const desc = vt.type === "bool" ? `${a.variable} is ${a.op}` : `${a.variable} ${a.op} ${a.value}`;
      const ok = wired && !never && ex.ok;
      return text([
        `${ok ? "Rule set" : "RULE NOT WIRED"}: ${a.from} -> ${a.to} when ${desc} (rule graph '${rg}', ${rf.fn ?? "direct bool"}).`,
        ...comp.lines,
        ex.ok ? `${a.variable} is instance-editable (anim_bp_drive can set it).` : `Could not expose ${a.variable}: ${ex.error}`,
        `Test it at runtime with anim_bp_drive.`,
      ].join("\n"), !ok);
    },
  );

  server.tool(
    "anim_bp_drive",
    "Run an Anim Blueprint and drive its variables step by step - in a hidden editor preview or in PIE - and report " +
      "which state the character is in after each step, from the rendered pose (bones vs each state's clip). Use " +
      "'expect' to make it a test: a step whose state differs fails. Proves transitions fire at runtime, not just compile.",
    {
      blueprint: z.string(),
      stateMachine: z.string(),
      steps: z.array(z.object({
        set: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
        expect: z.string().optional().describe("State expected after this step."),
        wait: z.number().optional().describe("Seconds to let it run before reading (default 1.0)."),
      })).min(1),
      pie: z.boolean().optional().describe("Run in Play-In-Editor (the actor is placed in the open level, PIE started and stopped)."),
      mesh: z.string().optional(),
      place: z.object({ label: z.string(), location: z.array(z.number()).length(3), facing: z.number().optional() }).optional()
        .describe("Editor only: run on a VISIBLE character at this spot and leave it there (for captures/renders)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const bp = await run("resolve_abp(P['b'])", { b: a.blueprint });
      if (!bp.ok) return text(`Error: ${bp.error}`, true);
      const sc = await stateClips(bp.path, a.stateMachine);
      if (sc.error) return text(`Error: ${sc.error}`, true);
      if (!Object.keys(sc.clips).length) return text("Error: no state has a single sequence player - nothing to recognise states by.", true);
      const comp = compileSummary(await uePost("/api/validate-blueprint", { blueprint: bp.path }));
      const lines = [`${bp.path} [${a.pie ? "PIE" : "editor preview"}]:`, ...comp.lines,
        `States by clip: ${Object.entries(sc.clips).map(([s, c]) => `${s}=${c.split("/").pop()}`).join(", ")}${sc.skipped.length ? `; not recognisable (no single clip): ${sc.skipped.join(", ")}` : ""}.`];
      const pie = !!a.pie;
      if (pie && a.place) return text("Error: place is for editor runs (a PIE copy disappears when PIE stops).", true);
      const label = a.place?.label ?? LABEL;
      const loc = a.place?.location ?? (pie ? [0, -400, 0] : [0, 0, -5000]);
      const sp = await run("abp_preview(P['l'], P['b'], P['m'], tuple(P['loc']))", { l: label, b: bp.path, m: a.mesh ?? MESH, loc });
      if (!sp.ok) return text(`Error: ${sp.error}`, true);
      if (a.place?.facing !== undefined) await run("abp_face(P['l'], P['f'])", { l: label, f: a.place.facing });
      let ok = comp.ok;
      try {
        if (pie) {
          const st = await uePost("/api/start-pie", {});
          if (st.error) return text(`Error starting PIE: ${st.error}`, true);
          let found = false;
          for (let i = 0; i < 40 && !found; i++) {
            await sleep(250);
            found = !!(await run("pie_has(P['l'])", { l: label })).found;
          }
          if (!found) return text([...lines, "PIE started but the test actor never appeared in the game world."].join("\n"), true);
        }
        await sleep(500);
        const clipList = [...new Set(Object.values(sc.clips))];
        const read = async () => {
          const m = await run("clip_match(P['l'], P['c'], 120.0, P['p'])", { l: label, c: clipList, p: pie });
          if (!m.ok) throw new Error(m.error);
          return decideState(sc.clips, m.clips);
        };
        const fmt = (d: ReturnType<typeof decideState>) => d.ranked.map((r) => `${r.state} ${r.cm.toFixed(1)}`).join(", ");
        const d0 = await read();
        lines.push(`Start: ${d0.state ?? (d0.ambiguous ? "AMBIGUOUS" : "NO STATE MATCHES")} (cm per state: ${fmt(d0)})`);
        for (const [i, s] of a.steps.entries()) {
          if (s.set && Object.keys(s.set).length) {
            const w = await run("abp_set_vars(P['l'], P['v'], P['p'])", { l: label, v: s.set, p: pie });
            if (!w.ok) {
              lines.push(`Step ${i + 1}: could not set ${JSON.stringify(s.set)}: ${w.error}${/edited on instances/.test(w.error ?? "") ? " (anim_transition_rule exposes rule variables; or tick 'Instance Editable')" : ""}`);
              ok = false;
              break;
            }
          }
          await sleep(1000 * (s.wait ?? 1.0));
          const d = await read();
          const good = s.expect === undefined || d.state === s.expect;
          ok &&= good && d.state !== null;
          lines.push(`Step ${i + 1} ${s.set ? JSON.stringify(s.set) : "(wait)"} -> ${d.state ?? (d.ambiguous ? "AMBIGUOUS (two states' clips match)" : "NO STATE MATCHES")}${s.expect !== undefined ? (good ? " (expected)" : `  <- EXPECTED ${s.expect}`) : ""} (cm per state: ${fmt(d)})`);
        }
      } catch (e: any) {
        lines.push(`Error: ${e?.message ?? e}`);
        ok = false;
      } finally {
        if (pie) await uePost("/api/stop-pie", {});
        if (!a.place) await run("remove_actor(P['l'])", { l: label });
      }
      return text(lines.join("\n"), !ok);
    },
  );
}
