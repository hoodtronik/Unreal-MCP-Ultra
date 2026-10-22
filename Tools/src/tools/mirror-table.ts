import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

export function registerMirrorTableTools(server: McpServer): void {
  // ------------------------------------------------------------------
  // list_mirror_table_rows
  // ------------------------------------------------------------------
  server.tool(
    "list_mirror_table_rows",
    "List every row in a Mirror Data Table (UMirrorDataTable) — the bone/curve/notify name-swap " +
    "table used to mirror animations left-to-right. Each row maps a name to its mirrored " +
    "counterpart. Useful for auditing centerline (self-mirror) entries that aren't covered by the " +
    "table's MirrorFindReplaceExpressions, e.g. a pelvis bone that should map to itself.",
    {
      table: z.string().describe("Mirror data table asset name or path (e.g. 'MDT_CC4_Mirror')"),
    },
    async ({ table }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/list-mirror-table-rows", { table });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const rows: any[] = data.rows ?? [];
      const lines: string[] = [
        `${data.table}`,
        `Mirror axis: ${data.mirrorAxis}`,
        `${data.rowCount} row(s):`,
      ];
      for (const r of rows) {
        lines.push(`  ${r.name} <-> ${r.mirroredName}  [${r.entryType}]`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ------------------------------------------------------------------
  // set_mirror_table_rows
  // ------------------------------------------------------------------
  server.tool(
    "set_mirror_table_rows",
    "Add or update rows in a Mirror Data Table. Each row maps 'name' to 'mirroredName' — pass the " +
    "same value for both to declare a centerline (self-mirror) entry, e.g. a spine or pelvis bone " +
    "that has no left/right counterpart. Existing rows with a matching 'name' are overwritten.",
    {
      table: z.string().describe("Mirror data table asset name or path"),
      rows: z.array(z.object({
        name: z.string().describe("Bone/curve/notify name this row applies to"),
        mirroredName: z.string().describe("The name it mirrors to — same as 'name' for a centerline entry"),
        entryType: z.enum(["Bone", "AnimationNotify", "Curve", "SyncMarker", "Custom"]).optional().describe(
          "Row type. Defaults to 'Bone' if omitted."
        ),
      })).describe("Rows to add or update"),
    },
    async ({ table, rows }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/set-mirror-table-rows", { table, rows });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`${data.table}`);
      lines.push(`Added: ${data.added}, updated: ${data.updated}, total rows: ${data.totalRows}`);
      lines.push(`Saved: ${data.saved}`);
      if (data.warnings?.length) {
        lines.push(`\nWarnings:`);
        for (const w of data.warnings) lines.push(`  ${w}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ------------------------------------------------------------------
  // remove_mirror_table_rows
  // ------------------------------------------------------------------
  server.tool(
    "remove_mirror_table_rows",
    "Remove rows from a Mirror Data Table by row name.",
    {
      table: z.string().describe("Mirror data table asset name or path"),
      rowNames: z.array(z.string()).describe("Row names to remove"),
    },
    async ({ table, rowNames }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/remove-mirror-table-rows", { table, rowNames });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`${data.table}`);
      lines.push(`Removed: ${data.removed}, remaining rows: ${data.totalRows}`);
      lines.push(`Saved: ${data.saved}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ------------------------------------------------------------------
  // create_mirror_table
  // ------------------------------------------------------------------
  // CLAUDE-NOTE (2026-10-22): Python cannot make a usable MirrorDataTable (factory fields not public; a factory-less
  // table has no row struct) - C++ /api/create-mirror-table sets them by reflection and fills the rows from the
  // default _l/_r find-replace expressions.
  server.tool(
    "create_mirror_table",
    "Create a Mirror Data Table for a skeleton (rows filled automatically from left/right naming such as _l/_r), " +
      "for the Mirror animation node and mirrored playback. Verified by reading the rows back.",
    {
      path: z.string().describe("New asset path, e.g. /Game/Animation/MDT_Mannequin."),
      skeleton: z.string().describe("Skeleton asset path."),
      axis: z.enum(["X", "Y", "Z"]).optional().describe("Mirror axis (default X)."),
    },
    async ({ path, skeleton, axis }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }], isError: true };
      const data = await uePost("/api/create-mirror-table", { path, skeleton, axis: axis ?? "X" });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }], isError: true };
      const back = await uePost("/api/list-mirror-table-rows", { table: data.table });
      const n = back.rowCount ?? 0;
      const bad = !n || data.rowStruct !== "MirrorTableRow";
      const sample = (back.rows ?? []).slice(0, 4).map((r: any) => `${r.name} -> ${r.mirroredName}`).join(", ");
      return { content: [{ type: "text" as const, text: `${bad ? "MIRROR TABLE CHECK FAILED:" : "Mirror table created and verified:"}
${data.table}: ${n} row(s) read back (row struct ${data.rowStruct}, axis ${back.mirrorAxis}, saved ${data.saved}); e.g. ${sample}` }], ...(bad ? { isError: true } : {}) };
    }
  );
}
