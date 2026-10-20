import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

// CLAUDE-NOTE (2026-10-20): agents testing editor panels (plugin tabs, wizards) could only screenshot
// them and ask a person to press the buttons: posted Windows clicks never reach Slate. These tools read
// the live Slate tree and run a button's own OnClicked, refusing hidden or disabled widgets so a test
// can't pass where a person couldn't. C++ side: BlueprintMCPHandlers_SlateUI.cpp.

function describeElement(e: any): string {
  const state = [e.enabled ? "" : "disabled", e.visible ? "" : "hidden", e.checked === undefined ? "" : e.checked ? "checked" : "unchecked"]
    .filter(Boolean)
    .join(", ");
  let line = `  [${e.index}] ${e.type} "${e.text}"`;
  if (state) line += ` (${state})`;
  if (e.row) line += `\n        row: ${e.row}`;
  if (e.tooltip) line += `\n        tooltip: ${e.tooltip}`;
  if (e.hint) line += `\n        hint: ${e.hint}`;
  return line;
}

export function registerEditorUITools(server: McpServer): void {
  server.tool(
    "ui_find",
    "Read an editor window or dock tab like a person would: its visible text (labels, status lines, " +
      "error lines, text boxes) and its buttons and checkboxes, with enabled/checked state, the text of " +
      "the list row a checkbox sits in, and tooltips. Use it to check a panel's result after ui_click. " +
      "root matches a window title or a tab label (case-insensitive substring); omit it to list every " +
      "window. Requires the editor UI.",
    {
      root: z.string().optional().describe("Window title or tab label to search, e.g. 'RS Exposer'. Omit to search every window (large)."),
      text: z.string().optional().describe("Only widgets whose text, row text or tooltip contains this."),
      type: z.string().optional().describe("Only this widget type, e.g. 'SButton', 'SCheckBox', 'STextBlock', 'SEditableText' (text boxes)."),
      clickableOnly: z.boolean().optional().describe("Only buttons and checkboxes."),
      includeHidden: z.boolean().optional().describe("Also list collapsed/hidden widgets (marked hidden)."),
      max: z.number().optional().describe("Maximum widgets to return (default 200)."),
    },
    async ({ root, text, type, clickableOnly, includeHidden, max }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/ui-find", { root, text, type, clickableOnly, includeHidden, max });
      if (data.error) {
        const titles = data.windowTitles ? `\nOpen windows: ${data.windowTitles.map((t: string) => `"${t}"`).join(", ")}` : "";
        return { content: [{ type: "text" as const, text: `Error: ${data.error}${titles}` }] };
      }

      const lines: string[] = [];
      lines.push(`Roots: ${(data.roots || []).map((r: any) => `${r.kind} "${r.name}"${r.foreground ? "" : " (not in front)"}`).join(", ")}`);
      lines.push(`${data.count} widget(s)${data.truncated ? ` (showing ${data.elements.length}; narrow with text/type or raise max)` : ""}:`);
      for (const e of data.elements || []) lines.push(describeElement(e));

      lines.push(`\nNext steps:`);
      lines.push(`  1. ui_click with a button's text (or a checkbox's row text) to press it`);
      lines.push(`  2. ui_find again after a click to read the result`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ui_click",
    "Press a button or toggle a checkbox in an editor window or dock tab, running the same handler a real " +
      "click runs. text matches the button's label exactly first, then any widget whose label, row text " +
      "or tooltip contains it (for a list checkbox, use text from its row). Refuses hidden or disabled " +
      "widgets. If several match, pass index from the returned matches. Read the result with ui_find. " +
      "Requires the editor UI.",
    {
      text: z.string().describe("Button label, or text in the checkbox's row, e.g. 'Stop workload' or 'Prop_Shape'."),
      root: z.string().optional().describe("Window title or tab label to search, e.g. 'RS Exposer'. Strongly recommended."),
      type: z.enum(["SButton", "SCheckBox"]).optional().describe("Only buttons or only checkboxes."),
      index: z.number().optional().describe("Which match to use when several match (0-based)."),
      checked: z.boolean().optional().describe("Checkbox only: the state wanted. Omit to toggle."),
    },
    async ({ text, root, type, index, checked }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/ui-click", { text, root, type, index, checked });
      if (data.error) {
        const matches = data.matches ? "\n" + data.matches.map(describeElement).join("\n") : "";
        return { content: [{ type: "text" as const, text: `Error: ${data.error}${matches}` }] };
      }

      const w = data.widget;
      const lines = [`${data.action === "clicked" ? "Clicked" : data.action === "toggled" ? "Toggled" : "Left unchanged"} ${w.type} "${w.text}" in ${w.root}`];
      if (w.row) lines.push(`Row: ${w.row}`);
      if (data.checkedAfter !== undefined) lines.push(`Checked: ${data.checkedBefore} -> ${data.checkedAfter}`);
      lines.push(`\nNext steps:`);
      lines.push(`  1. ui_find on the same root to read what changed (status line, red/amber lines)`);
      lines.push(`  2. get_output_log for what the click logged`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ui_set_text",
    "Type into a text box in an editor window or dock tab (a filter/search box, a name field) and fire its " +
      "change and commit handlers, as if a person typed and pressed Enter. target matches the box's hint " +
      "text (the grey placeholder), current text, tooltip or row. Use it to filter a long list so the row " +
      "you need is on screen: rows scrolled out of view don't exist for ui_find or ui_click. Requires the editor UI.",
    {
      text: z.string().describe("What to type. An empty string clears the box."),
      target: z.string().optional().describe("Hint, current text, tooltip or row text of the box, e.g. 'Filter'."),
      root: z.string().optional().describe("Window title or tab label, e.g. 'RS Exposer'. Strongly recommended."),
      index: z.number().optional().describe("Which match to use when several match (0-based)."),
      commit: z.boolean().optional().describe("Also commit as if Enter was pressed (default true)."),
    },
    async ({ text, target, root, index, commit }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/ui-set-text", { text, target, root, index, commit });
      if (data.error) {
        const matches = data.matches ? "\n" + data.matches.map(describeElement).join("\n") : "";
        return { content: [{ type: "text" as const, text: `Error: ${data.error}${matches}` }] };
      }
      const hint = data.widget.hint ? ` "${data.widget.hint}"` : "";
      const lines = [
        `Typed into text box${hint} in ${data.widget.root}: "${data.before}" -> "${data.after}"${data.committed ? " (committed)" : ""}`,
        `\nNext steps:`,
        `  1. ui_find on the same root to see the result (search boxes may filter a moment later)`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
