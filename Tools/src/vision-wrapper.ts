import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captureFrame, resolveTarget, shouldAttach } from "./vision-state.js";

// CLAUDE-NOTE: the whole feature hangs off this one function. Blender's port appends the frame in
// its generic tool dispatcher, so one code path covers every tool and no individual tool needed
// modification. This codebase has no generic dispatcher — all 228 tools call server.tool() directly
// against the MCP SDK — but every registration funnels through the single loop in index.ts, so
// wrapping server.tool once before that loop buys the same property: one code path, zero tool
// files touched. Do NOT reach for per-tool attachment; it would mean editing 45 files and would
// rot the moment someone adds tool 229.

/** Text results that indicate the tool failed, using this codebase's `Error: ${data.error}` convention. */
function isErrorResult(result: unknown): boolean {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (r?.isError) return true;
  const first = r?.content?.[0];
  return first?.type === "text" && typeof first.text === "string" && first.text.startsWith("Error:");
}

async function attachFrame(toolName: string, toolArgs: unknown, result: unknown): Promise<unknown> {
  const r = result as { content?: unknown[] };
  if (!Array.isArray(r?.content)) return result;

  // A tool that errored almost certainly changed nothing. Attaching a frame to it is the same
  // wasted overhead as attaching one to a read-only call.
  if (isErrorResult(result)) return result;

  const resolved = resolveTarget(toolArgs);
  if (!resolved) return result;

  const frame = await captureFrame(resolved.target, {
    blueprint: resolved.blueprint,
    graph: resolved.graph,
    useDigest: true,
  });
  if (!frame) return result;

  r.content.push({
    type: "image",
    data: frame.base64,
    mimeType: "image/png",
  });
  return result;
}

/**
 * Wrap McpServer.tool so every subsequently-registered tool gets automatic frame attachment.
 * Must be called BEFORE any tool registers.
 */
export function installVisionWrapper(server: McpServer): void {
  const originalTool = (server.tool as (...a: unknown[]) => unknown).bind(server);

  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    // CLAUDE-NOTE: server.tool has several overloads — (name, handler), (name, desc, handler),
    // (name, desc, schema, handler), (name, desc, schema, annotations, handler). The handler is
    // always the LAST argument, never a fixed position, so key off that rather than arity.
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    const toolName = typeof args[0] === "string" ? args[0] : "";

    if (typeof handler !== "function" || !toolName) {
      return originalTool(...args);
    }

    const originalHandler = handler as (...h: unknown[]) => unknown;

    args[handlerIndex] = async (...handlerArgs: unknown[]) => {
      const result = await originalHandler(...handlerArgs);

      // A schema'd tool's handler is (args, extra); a schema-less one's is (extra) alone. Only
      // the former carries the tool's own arguments, which is what target routing reads.
      const toolArgs = handlerArgs.length >= 2 ? handlerArgs[0] : {};

      if (!shouldAttach(toolName)) return result;

      try {
        return await attachFrame(toolName, toolArgs, result);
      } catch {
        // A failed screenshot must NEVER turn a successful edit into an error.
        return result;
      }
    };

    return originalTool(...args);
  };
}
