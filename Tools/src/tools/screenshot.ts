import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

export function registerScreenshotTools(server: McpServer): void {
  server.tool(
    "capture_view",
    "Render the world from a camera YOU choose and save a PNG: either an ad-hoc camera (location + lookAt/rotation) or an existing CameraActor placed in the level (by label). Captures the PIE world when PIE is running, otherwise the editor world (override with world:'pie'|'editor'). Unlike take_screenshot/viewport_capture this does not depend on any viewport or window, so it can see gameplay (crowds, simulations) from any vantage point.",
    {
      location: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Camera position in world space. Required unless cameraActor is given."),
      lookAt: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Aim the camera at this world position. Takes precedence over rotation."),
      rotation: z
        .object({ pitch: z.number().optional(), yaw: z.number().optional(), roll: z.number().optional() })
        .optional()
        .describe("Explicit rotation when lookAt is omitted."),
      cameraActor: z
        .string()
        .optional()
        .describe("Capture through an existing CameraActor with this label instead of an ad-hoc transform. Uses its position, rotation and FOV."),
      world: z
        .enum(["auto", "pie", "editor"])
        .optional()
        .describe("Which world to render. Default auto: PIE if running, else editor."),
      fov: z.number().optional().describe("Field of view in degrees for ad-hoc cameras. Default 90."),
      width: z.number().optional().describe("Image width, 64-3840. Default 1280."),
      height: z.number().optional().describe("Image height, 64-2160. Default 720."),
      name: z.string().optional().describe("Output file name (no extension). Default capture_view."),
    },
    async (args) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/capture-view", args);
      if (data.error) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Captured ${data.width}x${data.height} (${data.world} world${data.cameraActor ? `, camera '${data.cameraActor}'` : ""}).`,
              `  file: ${data.path}`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "take_screenshot",
    "Capture a screenshot of the active viewport. Saves as PNG to the project's Saved/Screenshots folder. Requires editor mode.",
    {
      filename: z.string().optional()
        .describe("Output filename (without path). Defaults to 'Screenshot_<timestamp>.png'"),
    },
    async ({ filename }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = {};
      if (filename) body.filename = filename;

      const data = await uePost("/api/take-screenshot", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Screenshot captured:`,
        `  File: ${data.filename}`,
        `  Path: ${data.fullPath}`,
        `  Size: ${data.width}x${data.height}`,
        `\nNext steps:`,
        `  1. Use set_viewport_camera to adjust the view, then take another screenshot`,
        `  2. Use take_high_res_screenshot for higher resolution output`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "take_high_res_screenshot",
    "Capture a high-resolution screenshot of the active viewport with configurable resolution multiplier. Requires editor mode.",
    {
      resolutionMultiplier: z.number().min(1).max(8).optional()
        .describe("Resolution multiplier (1-8, default: 2). A 2x multiplier on a 1920x1080 viewport produces a 3840x2160 image."),
      filename: z.string().optional()
        .describe("Output filename (without path). Defaults to 'HighRes_<timestamp>.png'"),
    },
    async ({ resolutionMultiplier, filename }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = {};
      if (resolutionMultiplier !== undefined) body.resolutionMultiplier = resolutionMultiplier;
      if (filename) body.filename = filename;

      const data = await uePost("/api/take-high-res-screenshot", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `High-res screenshot requested:`,
        `  File: ${data.filename}`,
        `  Path: ${data.fullPath}`,
        `  Multiplier: ${data.resolutionMultiplier}x`,
        `  Estimated size: ${data.estimatedWidth}x${data.estimatedHeight}`,
        `  Note: ${data.note}`,
        `\nNext steps:`,
        `  1. The screenshot is captured asynchronously — check the output path after a moment`,
        `  2. Use set_viewport_camera to adjust the view before capturing`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "screenshot_graph",
    "Capture a Blueprint GRAPH (not the 3D viewport) as a PNG — the node layout as it would appear in the Blueprint editor, zoomed to fit all nodes. Use this to visually verify exec flow and wiring after graph edits instead of only reading the raw node/pin JSON. Saves to the project's Saved/Screenshots folder. Requires editor mode.",
    {
      blueprint: z.string().describe("Blueprint name or package path"),
      graph: z.string().describe("Graph name (e.g. 'EventGraph')"),
      width: z.number().optional().describe("Image width in pixels (default 1600, clamped 256-8192)"),
      height: z.number().optional().describe("Image height in pixels (default 1200, clamped 256-8192)"),
      filename: z.string().optional().describe("Output filename (without path). Defaults to 'Graph_<blueprint>_<graph>_<timestamp>.png'"),
    },
    async ({ blueprint, graph, width, height, filename }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { blueprint, graph };
      if (width !== undefined) body.width = width;
      if (height !== undefined) body.height = height;
      if (filename) body.filename = filename;

      const data = await uePost("/api/screenshot-graph", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Graph screenshot captured:`,
        `  Blueprint: ${data.blueprint}`,
        `  Graph: ${data.graph}`,
        `  File: ${data.filename}`,
        `  Path: ${data.fullPath}`,
        `  Size: ${data.width}x${data.height}`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
