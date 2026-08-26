import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, ueGet, uePost } from "../ue-bridge.js";

export function registerEditorUtilityTools(server: McpServer): void {
  server.tool(
    "focus_actor",
    "Focus the viewport camera on a specific actor, centering it in view and selecting it. Requires editor mode.",
    {
      actorLabel: z.string().describe("Label of the actor to focus on in the World Outliner"),
    },
    async ({ actorLabel }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/focus-actor", { actorLabel });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Focused on '${data.actorLabel}'`,
        `Location: (${data.location.x}, ${data.location.y}, ${data.location.z})`,
        `\nNext steps:`,
        `  1. The actor is now selected and centered in the viewport`,
        `  2. Use take_screenshot to capture the current view`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "editor_notification",
    "Show a toast notification in the UE5 editor. Useful for providing feedback to the user during long operations. Requires editor mode.",
    {
      message: z.string().describe("Notification message text"),
      severity: z.enum(["none", "success", "fail", "pending"]).optional()
        .describe("Visual style: none (default), success (green check), fail (red X), pending (spinner)"),
      duration: z.number().optional()
        .describe("How long to show the notification in seconds (default: 5)"),
    },
    async ({ message, severity, duration }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, any> = { message };
      if (severity) body.severity = severity;
      if (duration !== undefined) body.duration = duration;

      const data = await uePost("/api/editor-notification", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      return { content: [{ type: "text" as const, text: `Notification shown: "${data.message}" (${data.duration}s)` }] };
    }
  );

  server.tool(
    "save_all",
    "Save all dirty (unsaved) packages in the editor, including maps and content. Runs as a background task by default: if the save takes long (shader compiles, many packages, or a modal dialog needs a human click), this returns a taskId instead of blocking — poll it with get_task_status. Requires editor mode.",
    {
      background: z.boolean().optional()
        .describe("Default true: run detached and poll briefly, returning a taskId if still busy. Set false to block until the save finishes (can exceed client timeouts)."),
    },
    async ({ background }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      // CLAUDE-NOTE: background default. A synchronous save-all once outlived the client's timeout
      // while a modal dialog held the editor — the client hung on a dead socket with no way to ask
      // what happened. Detached + poll keeps the socket free and the status queryable throughout.
      if (background === false) {
        const data = await uePost("/api/save-all", {});
        if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        const lines = [
          data.success ? "All dirty packages saved successfully." : "Save completed with some failures.",
          `\nNext steps:`,
          `  1. Use get_dirty_packages to verify no unsaved changes remain`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      const started = await uePost("/api/save-all?async=1", {});
      if (started.error) return { content: [{ type: "text" as const, text: `Error: ${started.error}` }] };
      const taskId: string = started.taskId;

      // Poll up to ~90s; most saves finish in a few seconds.
      const deadline = Date.now() + 90_000;
      let last: any = started;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, last.state === "pending" ? 500 : 2000));
        last = await ueGet("/api/task-status", { id: taskId });
        if (last.error) return { content: [{ type: "text" as const, text: `Error: ${last.error}` }] };
        if (last.state === "done") {
          const ok = last.result?.success;
          const lines = [
            ok ? "All dirty packages saved successfully." : `Save completed with some failures: ${JSON.stringify(last.result ?? last.resultText)}`,
            `(background task ${taskId}, ${Math.round(last.elapsedSeconds)}s)`,
            `\nNext steps:`,
            `  1. Use get_dirty_packages to verify no unsaved changes remain`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }
      }

      const lines = [
        `Save is still running in the background (task ${taskId}, ${Math.round(last.elapsedSeconds ?? 0)}s so far).`,
        `A save this long usually means shader compilation or a MODAL DIALOG waiting for a human click — check the editor window.`,
        `\nNext steps:`,
        `  1. get_task_status(taskId="${taskId}") — poll until state is 'done'`,
        `  2. If it never finishes, look for a dialog in the editor blocking the save`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_task_status",
    "Check a background task started by an async-capable tool (e.g. save_all). Returns state (pending/running/done), elapsed time, and the operation's full result once done. Works even while the editor's main thread is busy with the task itself.",
    {
      taskId: z.string().describe("Task id returned when the operation was started (e.g. 'task_3')"),
    },
    async ({ taskId }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await ueGet("/api/task-status", { id: taskId });
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [
        `Task ${data.taskId} (${data.endpoint}): ${data.state}`,
        `Elapsed: ${Math.round(data.elapsedSeconds)}s`,
      ];
      if (data.state === "done") {
        lines.push(`Result: ${JSON.stringify(data.result ?? data.resultText, null, 1)}`);
      } else {
        lines.push(`\nNext steps:`);
        lines.push(`  1. Poll get_task_status again in a few seconds`);
        lines.push(`  2. If stuck for minutes, check the editor for a modal dialog holding the operation`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_dirty_packages",
    "List all packages with unsaved changes. Useful for checking what needs saving before closing. Requires editor mode.",
    {},
    async () => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/get-dirty-packages", {});
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines: string[] = [];
      lines.push(`Unsaved packages: ${data.count}`);

      if (data.packages && data.packages.length > 0) {
        for (const pkg of data.packages) {
          lines.push(`  - ${pkg.name}`);
        }
      } else {
        lines.push("No unsaved changes.");
      }

      lines.push(`\nNext steps:`);
      lines.push(`  1. Use save_all to save all dirty packages`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "reset_transaction_buffer",
    "Clear the editor's undo/redo transaction buffer, then run garbage collection. The transaction buffer pins hard references to every object it records, which can keep recently-touched assets from being deleted or GC'd (delete_asset returns false) until an editor restart — this frees them without one. WARNING: destroys all undo history. Requires editor mode.",
    {},
    async () => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/reset-transaction-buffer", {});
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Transaction buffer reset (cleared ${data.clearedUndo} undo / ${data.clearedRedo} redo entries) and GC run.`,
        `Undo history is now empty; previously undo-pinned assets can now be deleted.`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
