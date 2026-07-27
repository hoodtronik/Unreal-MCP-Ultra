import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { captureFrame, visionState, type AutoTarget } from "../vision-state.js";

export function registerVisionTools(server: McpServer): void {
  server.tool(
    "viewport_capture",
    "Capture what the editor is showing and return the image INLINE in this tool result — no file " +
      "path, no follow-up read. target='level' captures the level editor viewport, target='pie' a " +
      "running PIE session, target='graph' a Blueprint node graph (far easier to verify wiring from " +
      "than raw node/pin JSON). Use this to check your own work after editing.",
    {
      target: z.enum(["level", "pie", "graph"]).optional()
        .describe("What to look at. Default 'level'."),
      blueprint: z.string().optional().describe("Blueprint name or package path. Required when target='graph'."),
      graph: z.string().optional().describe("Graph name (e.g. 'EventGraph'). Required when target='graph'."),
      maxSize: z.number().min(64).max(2048).optional()
        .describe("Longest edge in pixels (64-2048, default 512). A level frame at 512 costs ~200 tokens. Node graphs need ~1024 to stay legible."),
      saveToDisk: z.boolean().optional()
        .describe("Also write the PNG to Saved/Screenshots (default false — the image is already in this result)."),
      filename: z.string().optional().describe("Output filename, only used when saveToDisk is true."),
    },
    async ({ target, blueprint, graph, maxSize, saveToDisk, filename }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, unknown> = { target: target ?? "level" };
      if (blueprint) body.blueprint = blueprint;
      if (graph) body.graph = graph;
      if (maxSize !== undefined) body.maxSize = maxSize;
      if (saveToDisk !== undefined) body.saveToDisk = saveToDisk;
      if (filename) body.filename = filename;

      const data = await uePost("/api/viewport-capture", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Captured ${data.target} — ${data.width}x${data.height} (native ${data.nativeWidth}x${data.nativeHeight})`,
        `  Method: ${data.method}`,
        `  Digest: ${data.digest}`,
        `  ${Math.round(data.bytes / 1024)} KB PNG in ${data.elapsedMs} ms`,
      ];
      if (data.fullPath) lines.push(`  Saved: ${data.fullPath}`);

      // The backend omits the payload when it matches a supplied sinceDigest. This tool never
      // sends one, so this is unreachable today — but emitting an image block with undefined data
      // would be a malformed MCP result, which is a worse failure than a text-only one.
      if (typeof data.imageBase64 !== "string" || data.imageBase64.length === 0) {
        lines.push(`\n(no image payload returned — digest unchanged)`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "image" as const, data: data.imageBase64, mimeType: data.mimeType ?? "image/png" },
        ],
      };
    },
  );

  server.tool(
    "vision_mode",
    "Turn always-on visual feedback on or off. While enabled, every tool call that CHANGES state " +
      "gets a fresh viewport frame appended to its result automatically — no extra tool call needed. " +
      "Read-only tools are skipped, and an unchanged frame is suppressed rather than re-sent.",
    {
      enabled: z.boolean().describe("Turn vision mode on or off."),
      maxSize: z.number().min(64).max(2048).optional()
        .describe("Longest edge for auto-attached frames (default 384, ~150 tokens each)."),
      targets: z.array(z.enum(["level", "graph"])).optional()
        .describe("Which domains auto-attach. Default ['level']. Adding 'graph' attaches a node-graph frame after graph edits — legible but ~1000 tokens each, and it cannot be digest-suppressed because graph edits always change the graph."),
      onReadOnly: z.boolean().optional()
        .describe("Also attach frames to read-only tools (default false — a frame after get_blueprint is pure overhead)."),
    },
    async ({ enabled, maxSize, targets, onReadOnly }) => {
      visionState.enabled = enabled;
      if (maxSize !== undefined) visionState.maxSize = maxSize;
      if (targets !== undefined) visionState.targets = targets as AutoTarget[];
      if (onReadOnly !== undefined) visionState.onReadOnly = onReadOnly;

      // Toggling clears both the duplicate-frame memory and any latched failure, so a user who
      // fixes their setup (opens the editor, opens a viewport) can just re-enable.
      visionState.lastDigest = {};
      visionState.suppressedReason = null;

      if (!enabled) {
        return { content: [{ type: "text" as const, text: "Vision mode OFF." }] };
      }

      const lines = [
        `Vision mode ON.`,
        `  Frames: ${visionState.maxSize}px longest edge`,
        `  Targets: ${visionState.targets.join(", ")}`,
        `  Read-only tools: ${visionState.onReadOnly ? "included" : "skipped"}`,
      ];

      // Prove it works now rather than failing silently on the next mutation.
      const probe = await captureFrame("level", { maxSize: visionState.maxSize });
      if (!probe && visionState.suppressedReason) {
        lines.push(`\n⚠ Capture is not available: ${visionState.suppressedReason}`);
        lines.push(`Vision mode stays on, but frames will be skipped until this is resolved.`);
        visionState.suppressedReason = null;
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "scene_digest",
    "Cheap fingerprint of editor state, for change detection. Deliberately coarse: it costs far " +
      "less than the capture it lets you avoid. scope='level' covers level name, actor count, " +
      "selection, unsaved packages and PIE state; scope='graph' hashes node GUIDs, positions and " +
      "pin links. Note it does NOT hash actor transforms — to detect a moved actor, compare the " +
      "'digest' field returned by viewport_capture, which fingerprints the actual pixels.",
    {
      scope: z.enum(["level", "graph"]).optional().describe("Default 'level'."),
      blueprint: z.string().optional().describe("Required when scope='graph'."),
      graph: z.string().optional().describe("Required when scope='graph'."),
    },
    async ({ scope, blueprint, graph }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, unknown> = { scope: scope ?? "level" };
      if (blueprint) body.blueprint = blueprint;
      if (graph) body.graph = graph;

      const data = await uePost("/api/scene-digest", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [`Digest: ${data.digest}`];
      if (data.scope === "graph") {
        lines.push(`  Blueprint: ${data.blueprint}`, `  Graph: ${data.graph}`);
        lines.push(`  Nodes: ${data.nodeCount}, links: ${data.linkCount}`);
      } else {
        lines.push(`  Level: ${data.level}`);
        lines.push(`  Actors: ${data.actorCount}, selected: ${data.selectedCount}`);
        lines.push(`  Unsaved packages: ${data.dirtyPackageCount}`);
        lines.push(`  PIE running: ${data.pieRunning ? "yes" : "no"}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
