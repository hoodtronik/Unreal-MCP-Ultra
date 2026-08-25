import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

// CLAUDE-NOTE: batch graph authoring. The single-node tools (add_node / connect_pins /
// set_pin_default) each save the .uasset, and SaveBlueprintPackage compiles the Blueprint as
// part of saving — so a 10-node graph costs ~10 compiles + ~25 round trips. build_graph does
// the whole thing with one save. Prefer it for 3+ nodes; the single-node tools remain the right
// choice when you need to inspect pins between steps.

const NodeSpec = z.object({
  ref: z.string().describe("Local name for this node, used to reference it in connections/pinDefaults (e.g. 'Print'). Must be unique within the call."),
  nodeType: z.string().describe("Node type, same values as add_node: CallFunction, VariableGet, VariableSet, Branch, Sequence, CustomEvent, OverrideEvent, CallParentFunction, DynamicCast, MakeStruct, BreakStruct, ForEachLoop, ForLoop, ForLoopWithBreak, WhileLoop, SpawnActorFromClass, Select, Comment, Reroute."),
  posX: z.number().optional().describe("Graph X position. Omit to auto-place left-to-right."),
  posY: z.number().optional().describe("Graph Y position. Omit to auto-place."),
}).passthrough().describe("Node spec. Type-specific fields are passed through to add_node unchanged — functionName, className, variableName, eventName, callInEditor, castTarget, actorClass, typeName, comment, width, height. Use the same field names you would pass to add_node.");

const ConnectionSpec = z.object({
  from: z.string().describe("Source endpoint as 'RefOrNodeId.PinName' (e.g. 'BeginPlay.then'). The ref may be a node created in this call OR an existing node GUID already in the graph."),
  to: z.string().describe("Target endpoint as 'RefOrNodeId.PinName' (e.g. 'Print.execute')."),
});

const PinDefaultSpec = z.object({
  nodeRef: z.string().describe("Ref from this call, or an existing node GUID."),
  pinName: z.string().describe("Input pin name (aliases allowed)."),
  value: z.string().describe("Value to set as the pin's default."),
});

export function registerBuildGraphTools(server: McpServer): void {
  server.tool(
    "build_graph",
    "Create multiple nodes, wire them together, and set pin defaults in a Blueprint graph in ONE call, with a single compile+save at the end. Much faster and cheaper than add_node/connect_pins/set_pin_default for 3+ nodes. " +
      "Connections use 'Ref.PinName' where Ref is either a node created in this call or an existing node GUID, so you can wire new nodes onto existing ones. " +
      "Pin name aliases: 'execute'/'exec'/'in' (first exec input), 'then'/'output'/'out' (first exec output), 'value'/'result' (first data output), 'true'/'false' (Branch). Exact pin names always take priority over aliases. " +
      "Returns per-item results — a partial failure reports exactly which node/connection/default failed and why, and the rest still apply.",
    {
      blueprint: z.string().describe("Blueprint name or package path (e.g. 'BP_MyActor')"),
      graph: z.string().describe("Graph name (e.g. 'EventGraph')"),
      nodes: z.array(NodeSpec).optional().describe("Nodes to create."),
      connections: z.array(ConnectionSpec).optional().describe("Pin connections to make, applied after all nodes exist."),
      pinDefaults: z.array(PinDefaultSpec).optional().describe("Input pin default values to set."),
      dryRun: z.boolean().optional().describe("Validate the request structure without modifying the Blueprint."),
    },
    async ({ blueprint, graph, nodes, connections, pinDefaults, dryRun }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/build-graph", {
        blueprint,
        graph,
        ...(nodes ? { nodes } : {}),
        ...(connections ? { connections } : {}),
        ...(pinDefaults ? { pinDefaults } : {}),
        ...(dryRun ? { dryRun } : {}),
      });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];

      if (data.dryRun) {
        lines.push(data.success ? `Dry run OK — no problems found.` : `Dry run found ${data.problems?.length ?? 0} problem(s).`);
        lines.push(`Blueprint: ${data.blueprint}   Graph: ${data.graph}`);
        lines.push(`Would create ${data.nodeCount} node(s), ${data.connectionCount} connection(s), ${data.pinDefaultCount} pin default(s).`);
        for (const p of data.problems ?? []) lines.push(`  - ${p}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      lines.push(data.success ? `Graph built successfully.` : `Graph built with failures — see below.`);
      lines.push(`Blueprint: ${data.blueprint}   Graph: ${data.graph}`);
      lines.push(
        `Nodes: ${data.nodesCreated}/${data.nodesCreated + data.nodesFailed}   ` +
        `Connections: ${data.connectionsMade}/${data.connectionsMade + data.connectionsFailed}   ` +
        `Pin defaults: ${data.pinDefaultsSet}/${data.pinDefaultsSet + data.pinDefaultsFailed}`
      );
      lines.push(`Compiled: ${data.compiled}   Saved: ${data.saved}`);

      // Only surface the ref -> GUID map on success; on failure the failures matter more.
      const created = (data.nodes ?? []).filter((n: any) => n.success);
      if (created.length) {
        lines.push(``);
        lines.push(`Created nodes:`);
        for (const n of created) lines.push(`  ${n.ref} = ${n.nodeId}`);
      }

      const failures: string[] = [];
      for (const n of data.nodes ?? []) if (!n.success) failures.push(`  node[${n.index}] '${n.ref ?? "?"}': ${n.error}`);
      for (const c of data.connections ?? []) if (!c.success) failures.push(`  connection[${c.index}] ${c.from} -> ${c.to}: ${c.error}`);
      for (const d of data.pinDefaults ?? []) if (!d.success) failures.push(`  pinDefault[${d.index}] ${d.nodeRef}.${d.pinName}: ${d.error}`);
      if (failures.length) {
        lines.push(``);
        lines.push(`Failures:`);
        lines.push(...failures);
      }

      lines.push(``);
      lines.push(`Next steps:`);
      lines.push(`  describe_graph(blueprint="${data.blueprint}", graph="${data.graph}") — verify the result`);
      if (failures.length) {
        lines.push(`  get_pin_info(...) — check real pin names, then repair with connect_pins / set_pin_default`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
