import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

// CLAUDE-NOTE (2026-11-18): heightmap I/O for landscapes WITH edit layers. Python's
// landscape_import_heightmap_from_render_target refuses those ("Cannot import to landscape with Edit
// Layers enabled"), so the C++ side writes through FLandscapeEditDataInterface inside
// FScopedSetLandscapeEditingLayer, like Landscape mode does. Workflow: export -> edit the .r16 in
// numpy -> import (with backupFile) -> export again to verify.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerLandscapeTools(server: McpServer): void {
  server.tool(
    "landscape_export_heightmap",
    "Write a landscape edit layer's heights to a raw .r16 file (uint16 little-endian, one value per vertex, " +
      "row-major with rows running +Y). world_z = actorZ + (value - 32768) / 128 * scaleZ. Works with Edit Layers.",
    {
      file: z.string().describe("Output .r16 path (absolute)."),
      landscape: z.string().optional().describe("Landscape actor label; optional if the level has one landscape."),
      layer: z.string().optional().describe("Edit layer name; default is layer 0 (the base layer)."),
    },
    async ({ file, landscape, layer }) => {
      const err = await ensureUE();
      if (err) return text(err);
      const d = await uePost("/api/landscape-export-heightmap", { file, landscape, layer });
      if (d.error) return text(`Error: ${d.error}`);
      return text(
        `Exported ${d.landscape} layer '${d.layer}' (${d.width}x${d.height}) to ${d.file}\n` +
          `Value range ${d.minValue}..${d.maxValue}. Layers: ${d.layers || "(none)"}\n\n` +
          "Next: edit the .r16 and bring it back with landscape_import_heightmap(file, backupFile=...)."
      );
    }
  );

  server.tool(
    "landscape_import_heightmap",
    "Overwrite a landscape edit layer's heights from a raw .r16 file (same format as landscape_export_heightmap; " +
      "size must equal the landscape's vertex count). Works with Edit Layers, unlike the Python render-target " +
      "import. Undoable; pass backupFile to save the previous heights first, and dryRun to only count changes.",
    {
      file: z.string().describe("Input .r16 path (absolute)."),
      landscape: z.string().optional().describe("Landscape actor label; optional if the level has one landscape."),
      layer: z.string().optional().describe("Edit layer name; default is layer 0 (the base layer)."),
      backupFile: z.string().optional().describe("Write the layer's current heights here before importing."),
      dryRun: z.boolean().optional().describe("Validate and count changed vertices without writing."),
    },
    async ({ file, landscape, layer, backupFile, dryRun }) => {
      const err = await ensureUE();
      if (err) return text(err);
      const d = await uePost("/api/landscape-import-heightmap", { file, landscape, layer, backupFile, dryRun });
      if (d.error) return text(`Error: ${d.error}`);
      return text(
        `${d.dryRun ? "Dry run: would change" : "Imported into"} ${d.landscape} layer '${d.layer}' ` +
          `(${d.width}x${d.height}): ${d.changedVerts} vertices changed, max delta ${d.maxDelta} units of 1/128 scaleZ.\n` +
          `Layers: ${d.layers || "(none)"}${d.backupFile ? `\nPrevious heights saved to ${d.backupFile}` : ""}\n\n` +
          "Next: landscape_export_heightmap to verify, then save_all. Foliage and actors on changed ground do not move with it."
      );
    }
  );
}
