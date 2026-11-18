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
    "carve_under_actor",
    "Carve the world around an actor (made for SciFiModules spline corridors, works for any mesh actor): " +
      "lower the landscape into a hidden trough under its real footprint so terrain and grass stop poking " +
      "through, settle props left floating on the lowered ground, and (for actors with a spline) ray-trace " +
      "the interior, removing intruding instances and pushing intruding actors sideways. Re-runnable after " +
      "the actor changes; the previous terrain is backed up. Runs blueprintmcp_carve.py inside the editor.",
    {
      actor: z.string().describe("Actor label, name or path, e.g. 'SFM_RampartCorridor'."),
      depth: z.number().optional().describe("Trough depth below each piece's underside (default 450)."),
      inset: z.number().optional().describe("Shrink each piece's footprint by this much so the trough hides under the walls (default 20)."),
      cutHalfWidth: z.number().optional().describe("Half-width of the cut envelope around the spline, walls included (default 300)."),
      settle: z.boolean().optional().describe("Drop props standing on lowered ground (default true)."),
      clearIntrusions: z.boolean().optional().describe("Ray-scan along the spline and clear intruders (default true)."),
      landscape: z.string().optional().describe("Landscape label if the level has more than one."),
      layer: z.string().optional().describe("Edit layer; default the base layer."),
      dryRun: z.boolean().optional().describe("Report what would change without changing anything."),
      settleBaseline: z.string().optional().describe(
        "Optional .r16 of the terrain BEFORE earlier edits (e.g. a landscape_import_heightmap backupFile): props are settled by the total drop since then. Only still-floating things move, so re-runs are safe."
      ),
    },
    async ({ actor, depth, inset, cutHalfWidth, settle, clearIntrusions, landscape, layer, dryRun, settleBaseline }) => {
      const err = await ensureUE();
      if (err) return text(err);
      const kw: string[] = [];
      if (depth !== undefined) kw.push(`depth=${Number(depth)}`);
      if (inset !== undefined) kw.push(`inset=${Number(inset)}`);
      if (cutHalfWidth !== undefined) kw.push(`cut_half_width=${Number(cutHalfWidth)}`);
      if (settle !== undefined) kw.push(`settle=${settle ? "True" : "False"}`);
      if (clearIntrusions !== undefined) kw.push(`clear_intrusions=${clearIntrusions ? "True" : "False"}`);
      if (landscape) kw.push(`landscape=${JSON.stringify(landscape)}`);
      if (layer) kw.push(`layer=${JSON.stringify(layer)}`);
      if (dryRun) kw.push("dry_run=True");
      if (settleBaseline) kw.push(`settle_baseline=${JSON.stringify(settleBaseline)}`);
      const code =
        "import importlib, blueprintmcp_carve as c\nimportlib.reload(c)\n" +
        `c.carve_json(${JSON.stringify(actor)}${kw.length ? ", " + kw.join(", ") : ""})`;
      const d = await uePost("/api/run-python", { code });
      if (d.error) return text(`Error: ${d.error}`);
      const out = String(d.output ?? "").trim().split(/\r?\n/).pop() ?? "";
      let r: any;
      try { r = JSON.parse(out); } catch { return text(`Carve output was not JSON:\n${d.output ?? ""}`); }
      if (r.error) return text(`Error: ${r.error}`);
      const lines = [
        `${r.dryRun ? "Dry run - " : ""}Carved around ${r.actor} on ${r.landscape}:`,
        `  trough: ${r.troughVerts} landscape vertices lowered under ${r.pieces} mesh pieces`,
        `  settled: ${r.settledActors?.length ?? 0} actors, ${r.settledInstances ?? 0} instances`,
      ];
      if (typeof r.intrusions === "string") lines.push(`  intrusions: ${r.intrusions}`);
      else {
        lines.push(`  cut through: ${r.cutMeshes?.length ?? 0} meshes (${r.instancesConvertedToCutActors ?? 0} were instances, now actors), ${r.removedInstances ?? 0} small instances removed`);
        for (const m of r.cutMeshes ?? []) lines.push(`    - ${m}`);
      }
      if (r.unpackedActors?.length) lines.push(`  unpacked into plain actors (so edits persist): ${r.unpackedActors.join(", ")}`);
      if (r.backup) lines.push(`  previous terrain: ${r.backup}`);
      lines.push("", "Next: look at it (capture_view inside the actor), then save_all.");
      return text(lines.join("\n"));
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
