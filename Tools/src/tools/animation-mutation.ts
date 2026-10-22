import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { withAnimGuards } from "./anim-guard.js";


// CLAUDE-NOTE (2026-10-22, live): a node property that is ALSO an exposed input pin (TwoBoneIK EffectorLocation, Alpha...)
// is compiled from the PIN's default, not the property - writing Node.EffectorLocation alone left the pin at (0,0,0) and
// the hand reached for the floor (hand_r at 88 cm instead of the 140 cm target). After a property write, mirror each
// written value onto the same-named visible input pin (UE text "(X=1,Y=2,Z=3)" -> pin text "1,2,3").
export function pinDefaultFromText(v: string): string {
  const t = v.trim();
  if (/^true$/i.test(t) || /^false$/i.test(t)) return t.toLowerCase();
  const m = /^\((.*)\)$/.exec(t);
  if (m && /^[A-Za-z]+=/.test(m[1])) {
    const vals = m[1].split(",").map((kv) => kv.split("=")[1]);
    if (vals.every((x) => x !== undefined && /^-?[0-9.eE+-]+$/.test(x))) return vals.map((x) => String(Number(x))).join(",");
  }
  return t;
}

async function syncPins(blueprint: string, nodeId: string, props: Record<string, string> | undefined, pins: any[] | undefined): Promise<string[]> {
  if (!props || !pins) return [];
  const inPins = new Set(pins.filter((p) => p.dir === "in").map((p) => p.name));
  const out: string[] = [];
  for (const [path, val] of Object.entries(props)) {
    const leaf = path.split(".").slice(1).join(".");
    if (!leaf || leaf.includes(".") || !inPins.has(leaf)) continue;
    const r = await uePost("/api/set-pin-default", { blueprint, nodeId, pinName: leaf, value: pinDefaultFromText(String(val)) });
    out.push(r?.error ? `pin ${leaf}: ${r.error}` : `pin ${leaf} = ${pinDefaultFromText(String(val))}`);
  }
  return out;
}

export function registerAnimationTools(baseServer: McpServer): void {
  // CLAUDE-NOTE (2026-10-21): every ABP tool below goes through withAnimGuards (asset resolution + compile check).
  const server = withAnimGuards(baseServer);
  // ---------------------------------------------------------------------------
  // create_anim_blueprint
  // ---------------------------------------------------------------------------

  server.tool(
    "create_anim_blueprint",
    "Create a new Animation Blueprint asset with a target skeleton.",
    {
      name: z.string().describe("Animation Blueprint name (e.g. 'ABP_MyCharacter')"),
      packagePath: z.string().default("/Game").describe("Package path (e.g. '/Game/Animations')"),
      skeleton: z.string().describe("Skeleton asset name or path. Use '__create_test_skeleton__' for testing."),
      parentClass: z.string().optional().describe("Parent class (default: AnimInstance)"),
    },
    async ({ name, packagePath, skeleton, parentClass }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { name, packagePath, skeleton };
      if (parentClass) body.parentClass = parentClass;

      const data = await uePost("/api/create-anim-blueprint", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Created Animation Blueprint: ${data.blueprintName || name}`);
      lines.push(`Path: ${data.assetPath || packagePath}`);
      lines.push(`Skeleton: ${data.targetSkeleton || skeleton}`);
      lines.push(`Parent: ${data.parentClass || "AnimInstance"}`);
      if (data.graphs?.length) lines.push(`Graphs: ${data.graphs.join(", ")}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      lines.push(`\nNext steps:`);
      lines.push(`  1. Use add_state_machine to add state machines to the AnimGraph`);
      lines.push(`  2. Use add_anim_state to add states to a state machine`);
      lines.push(`  3. Use add_anim_transition to connect states with transitions`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // add_anim_state
  // ---------------------------------------------------------------------------

  server.tool(
    "add_anim_state",
    "Add a state to a state machine graph in an Animation Blueprint.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().describe("State machine graph name"),
      stateName: z.string().describe("Name for the new state"),
      animationAsset: z.string().optional().describe("Animation sequence asset to assign to the state"),
      posX: z.number().optional().describe("X position in graph"),
      posY: z.number().optional().describe("Y position in graph"),
    },
    async ({ blueprint, graph, stateName, animationAsset, posX, posY }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint, graph, stateName };
      if (animationAsset) body.animationAsset = animationAsset;
      if (posX !== undefined) body.posX = posX;
      if (posY !== undefined) body.posY = posY;

      const data = await uePost("/api/add-anim-state", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Added state "${data.stateName || stateName}" to ${data.graph || graph}`);
      lines.push(`Node ID: ${data.nodeId}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      lines.push(`\nNext steps:`);
      lines.push(`  1. Use add_anim_transition to connect this state to other states`);
      lines.push(`  2. Use set_state_animation to assign an animation to this state`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // remove_anim_state
  // ---------------------------------------------------------------------------

  server.tool(
    "remove_anim_state",
    "Remove a state and its connected transitions from a state machine graph.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().describe("State machine graph name"),
      stateName: z.string().describe("Name of the state to remove"),
    },
    async ({ blueprint, graph, stateName }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/remove-anim-state", { blueprint, graph, stateName });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Removed state "${data.removedState || stateName}"`);
      lines.push(`Removed transitions: ${data.removedTransitions ?? 0}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // add_anim_transition
  // ---------------------------------------------------------------------------

  server.tool(
    "add_anim_transition",
    "Add a transition between two states in a state machine graph.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().describe("State machine graph name"),
      fromState: z.string().describe("Source state name"),
      toState: z.string().describe("Target state name"),
      crossfadeDuration: z.number().optional().describe("Crossfade duration in seconds (default: 0.2)"),
      priority: z.number().optional().describe("Transition priority order"),
      bBidirectional: z.boolean().optional().describe("Whether the transition is bidirectional"),
    },
    async ({ blueprint, graph, fromState, toState, crossfadeDuration, priority, bBidirectional }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint, graph, fromState, toState };
      if (crossfadeDuration !== undefined) body.crossfadeDuration = crossfadeDuration;
      if (priority !== undefined) body.priority = priority;
      if (bBidirectional !== undefined) body.bBidirectional = bBidirectional;

      const data = await uePost("/api/add-anim-transition", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Added transition: ${data.fromState || fromState} → ${data.toState || toState}`);
      lines.push(`Node ID: ${data.nodeId}`);
      lines.push(`Crossfade: ${data.crossfadeDuration ?? 0.2}s`);
      lines.push(`Priority: ${data.priorityOrder ?? 1}`);
      if (data.bBidirectional) lines.push(`Bidirectional: true`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      lines.push(`\nNext steps:`);
      lines.push(`  1. Use set_transition_rule to configure crossfade and priority`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // set_transition_rule
  // ---------------------------------------------------------------------------

  server.tool(
    "set_transition_rule",
    "Update properties on an existing transition between two states.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().describe("State machine graph name"),
      fromState: z.string().describe("Source state name"),
      toState: z.string().describe("Target state name"),
      crossfadeDuration: z.number().optional().describe("Crossfade duration in seconds"),
      blendMode: z.number().optional().describe("Alpha blend option (0=Linear, 1=Cubic, 2=HermiteCubic, 3=Sinusoidal, 4=QuadraticInOut, 5=CubicInOut, 6=QuarticInOut, 7=QuinticInOut, 8=CircularIn, 9=CircularOut, 10=CircularInOut, 11=ExpIn, 12=ExpOut, 13=ExpInOut, 14=Custom)"),
      priorityOrder: z.number().optional().describe("Transition priority order"),
      logicType: z.number().optional().describe("Transition logic type (0=Standard, 1=Custom)"),
      bBidirectional: z.boolean().optional().describe("Whether the transition is bidirectional"),
    },
    async ({ blueprint, graph, fromState, toState, crossfadeDuration, blendMode, priorityOrder, logicType, bBidirectional }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint, graph, fromState, toState };
      if (crossfadeDuration !== undefined) body.crossfadeDuration = crossfadeDuration;
      if (blendMode !== undefined) body.blendMode = blendMode;
      if (priorityOrder !== undefined) body.priorityOrder = priorityOrder;
      if (logicType !== undefined) body.logicType = logicType;
      if (bBidirectional !== undefined) body.bBidirectional = bBidirectional;

      const data = await uePost("/api/set-transition-rule", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Updated transition: ${data.fromState || fromState} → ${data.toState || toState}`);
      lines.push(`Properties changed: ${data.propertiesChanged ?? 0}`);
      lines.push(`Crossfade: ${data.crossfadeDuration}s (blendMode: ${data.blendMode})`);
      lines.push(`Priority: ${data.priorityOrder}`);
      lines.push(`Bidirectional: ${data.bBidirectional}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // add_anim_node
  // ---------------------------------------------------------------------------

  server.tool(
    "add_anim_node",
    "Add an animation node to an AnimGraph: SequencePlayer, BlendSpacePlayer, StateMachine, Slot (montages play " +
      "through it; slotName default DefaultSlot, registered on the skeleton if missing) or PoseBlender (a PoseAsset's " +
      "poses weighted by curves).",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().optional().describe("Target graph name (default: AnimGraph)"),
      nodeType: z.string().describe("SequencePlayer | BlendSpacePlayer | StateMachine | Slot | PoseBlender, or ANY AnimGraph node class (e.g. AnimGraphNode_TwoBoneIK, LayeredBoneBlend, LookAt, ModifyBone, BlendListByBool, CopyPoseFromMesh, ApplyAdditive)."),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe("Node property paths -> UE text values, read back, e.g. {'Node.IKBone.BoneName': 'hand_r', 'Node.EffectorLocation': '(X=10,Y=0,Z=150)'}."),
      animationAsset: z.string().optional().describe("Asset to assign: AnimSequence / BlendSpace / PoseAsset (PoseBlender)"),
      slotName: z.string().optional().describe("Slot node: slot name (default DefaultSlot)."),
      posX: z.number().optional().describe("X position in graph"),
      posY: z.number().optional().describe("Y position in graph"),
    },
    async ({ blueprint, graph, nodeType, animationAsset, slotName, properties, posX, posY }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint, nodeType };
      if (slotName) body.slotName = slotName;
      if (properties) body.properties = properties;
      if (graph) body.graph = graph;
      if (animationAsset) body.animationAsset = animationAsset;
      if (posX !== undefined) body.posX = posX;
      if (posY !== undefined) body.posY = posY;

      const data = await uePost("/api/add-anim-node", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Added ${data.nodeType || nodeType} node to ${data.graph || graph || "AnimGraph"}`);
      lines.push(`Node ID: ${data.nodeId}`);
      if (data.stateMachineGraph) lines.push(`State machine sub-graph: ${data.stateMachineGraph}`);
      if (data.slotName) lines.push(`Slot: ${data.slotName}${data.slotRegistered ? " (registered on the skeleton)" : ""}`);
      if (data.properties) lines.push(`Properties (read back): ${Object.entries(data.properties).map(([k, v]) => `${k} = ${v}`).join("; ")}`);
      const synced = await syncPins(blueprint, data.nodeId, data.properties, data.pins);
      if (synced.length) lines.push(`Exposed pins set to match: ${synced.join("; ")}`);
      if (data.pins) lines.push(`Pins: ${data.pins.map((p: any) => `${p.name} (${p.dir}, ${p.type})`).join(", ")}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      if (nodeType === "StateMachine") {
        lines.push(`\nNext steps:`);
        lines.push(`  1. Use add_anim_state to add states to ${data.stateMachineGraph}`);
        lines.push(`  2. Use add_anim_transition to connect states`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // anim_node_set
  // ---------------------------------------------------------------------------

  // CLAUDE-NOTE (2026-10-22): generic property writes on an existing AnimGraph node (C++ /api/set-anim-node-properties):
  // dotted paths into the node (Node.IKBone.BoneName, Node.Alpha, Node.LayerSetup...), UE text values, each read back
  // after import, then the ABP is recompiled (compile errors -> isError).
  server.tool(
    "anim_node_set",
    "Set properties on an existing Anim Blueprint graph node by its node ID (from add_anim_node / get_blueprint_graph): " +
      "dotted paths into the node with UE text values, e.g. {'Node.IKBone.BoneName': 'hand_r', 'Node.bAllowStretching': true, " +
      "'Node.LayerSetup': '((BranchFilters=((BoneName=\"spine_01\",BlendDepth=0))))'}. Each value is read back; the ABP is recompiled.",
    {
      blueprint: z.string(),
      nodeId: z.string(),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    },
    async ({ blueprint, nodeId, properties }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };
      const data = await uePost("/api/set-anim-node-properties", { blueprint, nodeId, properties });
      if (data.error && !data.properties) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }], isError: true };
      const lines = [`${data.nodeClass}: ${Object.entries(data.properties ?? {}).map(([k, v]) => `${k} = ${v}`).join("; ")}`];
      const synced = await syncPins(blueprint, nodeId, data.properties, data.pins);
      if (synced.length) lines.push(`Exposed pins set to match: ${synced.join("; ")}`);
      if (data.pins) lines.push(`Pins: ${data.pins.map((p: any) => p.name).join(", ")}`);
      lines.push(`Saved: ${data.saved}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // add_state_machine
  // ---------------------------------------------------------------------------

  server.tool(
    "add_state_machine",
    "Add a new state machine to the root AnimGraph of an Animation Blueprint.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      name: z.string().optional().describe("State machine name (default: NewStateMachine)"),
      posX: z.number().optional().describe("X position in graph"),
      posY: z.number().optional().describe("Y position in graph"),
    },
    async ({ blueprint, name, posX, posY }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint };
      if (name) body.name = name;
      if (posX !== undefined) body.posX = posX;
      if (posY !== undefined) body.posY = posY;

      const data = await uePost("/api/add-state-machine", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Added state machine to AnimGraph`);
      lines.push(`Node ID: ${data.nodeId}`);
      if (data.stateMachineGraph) lines.push(`Sub-graph: ${data.stateMachineGraph}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      lines.push(`\nNext steps:`);
      lines.push(`  1. Use add_anim_state to add states to ${data.stateMachineGraph || "the state machine"}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // set_state_animation
  // ---------------------------------------------------------------------------

  server.tool(
    "set_state_animation",
    "Set or replace the animation sequence played by a state in a state machine.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().describe("State machine graph name"),
      stateName: z.string().describe("State name"),
      animationAsset: z.string().describe("Animation sequence asset name or path"),
    },
    async ({ blueprint, graph, stateName, animationAsset }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/set-state-animation", { blueprint, graph, stateName, animationAsset });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Set animation for state "${data.stateName || stateName}"`);
      lines.push(`Animation: ${data.animationAsset || animationAsset}`);
      lines.push(`Created new node: ${data.createdNewNode ?? false}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // CLAUDE-NOTE (2026-10-21): create_blend_space / set_blend_space_samples moved to anim-guard.ts (Python: 1D/2D,
  // merge, validated samples, resample + evaluation check) - the C++ endpoints wiped samples and skipped unresolved
  // animations silently (MCP audit #6).

  // ---------------------------------------------------------------------------
  // set_state_blend_space
  // ---------------------------------------------------------------------------

  server.tool(
    "set_state_blend_space",
    "Place a BlendSpacePlayer node inside an anim state, connect it to the Output Animation Pose, and optionally wire X/Y input pins to named variables.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
      graph: z.string().describe("State machine graph name"),
      stateName: z.string().describe("State name"),
      blendSpace: z.string().describe("Blend Space asset name or path"),
      xVariable: z.string().optional().describe("Blueprint float variable name to wire to X input"),
      yVariable: z.string().optional().describe("Blueprint float variable name to wire to Y input"),
    },
    async ({ blueprint, graph, stateName, blendSpace, xVariable, yVariable }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint, graph, stateName, blendSpace };
      if (xVariable) body.xVariable = xVariable;
      if (yVariable) body.yVariable = yVariable;

      const data = await uePost("/api/set-state-blend-space", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Set blend space for state "${data.stateName || stateName}"`);
      lines.push(`Blend Space: ${data.blendSpace || blendSpace}`);
      lines.push(`Node ID: ${data.nodeId}`);
      if (data.saved !== undefined) lines.push(`Saved: ${data.saved}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // list_anim_slots
  // ---------------------------------------------------------------------------

  server.tool(
    "list_anim_slots",
    "List all montage slot names used in an Animation Blueprint.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
    },
    async ({ blueprint }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/list-anim-slots", { blueprint });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Animation slots in ${data.blueprint || blueprint}: ${data.count ?? 0}`);
      if (data.slots?.length) {
        for (const slot of data.slots) {
          lines.push(`  ${slot}`);
        }
      } else {
        lines.push(`  (no slots found)`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // list_sync_groups
  // ---------------------------------------------------------------------------

  server.tool(
    "list_sync_groups",
    "List all sync group names used in an Animation Blueprint.",
    {
      blueprint: z.string().describe("Animation Blueprint name or path"),
    },
    async ({ blueprint }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/list-sync-groups", { blueprint });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Sync groups in ${data.blueprint || blueprint}: ${data.count ?? 0}`);
      if (data.syncGroups?.length) {
        for (const group of data.syncGroups) {
          lines.push(`  ${group}`);
        }
      } else {
        lines.push(`  (no sync groups found)`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
