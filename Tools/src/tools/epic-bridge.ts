import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// CLAUDE-NOTE (2026-11-12): bridge to Epic's native MCP server (UE 5.8+, HTTP on :8000). Three
// reasons it lives here instead of leaving clients to connect to Epic's server themselves:
//  1. A client that started before the editor shows `unreal-mcp` as failed and often cannot
//     reconnect it mid-session; this server is already connected, so Epic's ~900 (5.8) / ~1,900
//     (5.9) tools stay reachable through it.
//  2. Epic's describe call returns a whole toolset (70 KB+ for the big ones) and overflows a tool
//     result. epic_describe filters to the tools asked for and only then includes schemas.
//  3. epic_call goes through this server's vision wrapper, so with vision_mode on an Epic-side
//     mutation returns a viewport frame like any native tool.
// It is a thin JSON-RPC client on purpose: no tool list is mirrored, so nothing here drifts when
// Epic adds toolsets. It deliberately does NOT call ensureUE(): Epic's server is a different
// process endpoint and must never trigger spawning our headless commandlet.

const EPIC_URL = process.env.UE_EPIC_MCP_URL || "http://127.0.0.1:8000/mcp";

let sessionId: string | null = null;
let topLevelTools: Set<string> | null = null;
let nextId = 1;

function parseBody(text: string): any {
  // Streamable HTTP may answer as plain JSON or as an SSE frame ("data: {...}").
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Unexpected response from Epic MCP: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

async function rpc(method: string, params?: unknown, notify = false): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!notify) body.id = nextId++;
  if (params !== undefined) body.params = params;

  const res = await fetch(EPIC_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  if (notify) return null;
  if (!res.ok) throw new Error(`Epic MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = parseBody(text);
  if (data.error) throw new Error(`Epic MCP: ${data.error.message ?? JSON.stringify(data.error)}`);
  return data.result;
}

async function connect(): Promise<void> {
  if (sessionId && topLevelTools) return;
  sessionId = null;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "blueprint-mcp-epic-bridge", version: "1" },
  });
  await rpc("notifications/initialized", undefined, true).catch(() => null);
  const listed = await rpc("tools/list");
  topLevelTools = new Set<string>((listed?.tools ?? []).map((t: { name: string }) => t.name));
}

/** Call one of Epic's top-level tools, reconnecting once if the editor restarted (stale session). */
async function callTop(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      await connect();
      const result = await rpc("tools/call", { name, arguments: args });
      const text = (result?.content ?? [])
        .map((c: { text?: string }) => c.text ?? "")
        .join("\n");
      return { text, isError: !!result?.isError };
    } catch (e) {
      sessionId = null;
      topLevelTools = null;
      if (attempt >= 1) throw e;
    }
  }
}

function unreachable(e: unknown): string {
  return (
    `Error: could not reach Epic's MCP server at ${EPIC_URL} (${(e as Error).message}). ` +
    "It needs a UE 5.8+ editor with the ModelContextProtocol plugin enabled and bAutoStartServer=True " +
    "(see the blueprintmcp-install skill, Step 6). Set UE_EPIC_MCP_URL if it listens elsewhere."
  );
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Describe one toolset on either engine: 5.8 has describe_toolset, 5.9 has describe_toolsets. */
async function describeToolset(toolset: string, withSchemas: boolean): Promise<any> {
  await connect();
  if (topLevelTools!.has("describe_toolsets")) {
    const r = await callTop("describe_toolsets", { toolset_names: [toolset], include_schemas: withSchemas });
    if (r.isError) throw new Error(r.text);
    const parsed = JSON.parse(r.text);
    return parsed.toolsets?.[toolset] ?? Object.values(parsed.toolsets ?? {})[0];
  }
  const r = await callTop("describe_toolset", { toolset_name: toolset });
  if (r.isError) throw new Error(r.text);
  return JSON.parse(r.text);
}

export function registerEpicBridgeTools(server: McpServer): void {
  server.tool(
    "epic_toolsets",
    "List the toolsets of Epic's native Unreal MCP server (UE 5.8+, the editor's own server on port 8000) " +
      "through this server, so they are reachable even when the client has no working unreal-mcp connection. " +
      "Use for breadth this server lacks: GAS, StateTree, UMG/MVVM, Niagara, MetaSound, physics, source control, " +
      "profiling, plugin scaffolding, Blueprint graph DSL. Then epic_describe a toolset and epic_call a tool.",
    {
      filter: z.string().optional().describe("Case-insensitive substring to match against toolset name or description, e.g. 'niagara'."),
    },
    async ({ filter }) => {
      try {
        const r = await callTop("list_toolsets", {});
        if (r.isError) return text(`Error: ${r.text}`);
        // Each entry is "- Name: description" where the description may run over several lines.
        const entries = r.text.split(/\n(?=- [\w.]+:)/).map((e) => e.trim()).filter(Boolean);
        const f = filter?.toLowerCase();
        const kept = f ? entries.filter((e) => e.toLowerCase().includes(f)) : entries;
        const lines = kept.map((e) => {
          const firstLine = e.split("\n")[0];
          return firstLine.length > 220 ? firstLine.slice(0, 217) + "..." : firstLine;
        });
        return text(
          `${kept.length} of ${entries.length} Epic toolsets${f ? ` matching '${filter}'` : ""} at ${EPIC_URL}:\n` +
            lines.join("\n") +
            "\n\nNext: epic_describe(toolset=<name>) for its tools."
        );
      } catch (e) {
        return text(unreachable(e));
      }
    }
  );

  server.tool(
    "epic_describe",
    "Describe one toolset of Epic's native Unreal MCP: tool names with one-line descriptions. Pass 'tools' " +
      "(names or substrings) to get the full input schema of just those tools - Epic's own describe call returns " +
      "every schema at once and overflows a tool result on large toolsets.",
    {
      toolset: z.string().describe("Toolset name exactly as epic_toolsets lists it, e.g. 'BlueprintToolsets.BlueprintToolset'."),
      tools: z.array(z.string()).optional().describe("Tool names or case-insensitive substrings; matching tools are returned WITH input schemas."),
    },
    async ({ toolset, tools }) => {
      try {
        const wanted = (tools ?? []).map((t) => t.toLowerCase()).filter(Boolean);
        const d = await describeToolset(toolset, wanted.length > 0);
        const all: Array<{ name: string; description?: string; inputSchema?: unknown }> = d?.tools ?? [];
        if (all.length === 0) return text(`Error: toolset '${toolset}' not found or has no tools. Check epic_toolsets.`);
        const short = (n: string) => (n.startsWith(toolset + ".") ? n.slice(toolset.length + 1) : n);

        if (wanted.length === 0) {
          const lines = all.map((t) => `- ${short(t.name)}: ${(t.description ?? "").split("\n")[0].slice(0, 160)}`);
          return text(
            `${toolset}: ${all.length} tools\n${(d.description ?? "").slice(0, 600)}\n\n${lines.join("\n")}` +
              "\n\nNext: epic_describe(toolset, tools=[...]) for schemas, then epic_call."
          );
        }
        const hits = all.filter((t) => wanted.some((w) => short(t.name).toLowerCase().includes(w)));
        if (hits.length === 0) return text(`Error: no tool in '${toolset}' matches ${JSON.stringify(tools)}.`);
        const blocks = hits.map(
          (t) => `## ${short(t.name)}\n${t.description ?? ""}\ninputSchema: ${JSON.stringify(t.inputSchema ?? {})}`
        );
        return text(`${toolset}: ${hits.length} of ${all.length} tools\n\n${blocks.join("\n\n")}`);
      } catch (e) {
        return text(unreachable(e));
      }
    }
  );

  server.tool(
    "epic_call",
    "Call a tool on Epic's native Unreal MCP server through this server. Object and class parameters are " +
      "{\"refPath\": \"/Game/Path/Asset.Asset\"} or {\"refPath\": \"/Script/Engine.Actor\"}. With vision_mode on, " +
      "the result carries a fresh viewport frame like any native state-changing tool. Get the schema from " +
      "epic_describe first; Epic's 'optional' struct parameters often must be passed anyway.",
    {
      toolset: z.string().describe("Toolset name from epic_toolsets, e.g. 'EditorToolset.ActorToolset'."),
      tool: z.string().describe("Tool name without the toolset prefix, e.g. 'CompileBlueprint'."),
      arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments object for the tool, per its input schema."),
    },
    async ({ toolset, tool, arguments: args }) => {
      try {
        const r = await callTop("call_tool", { toolset_name: toolset, tool_name: tool, arguments: args ?? {} });
        if (r.isError) return text(`Error: ${r.text}`);
        const out = r.text.length > 20000 ? r.text.slice(0, 20000) + `\n... [truncated ${r.text.length - 20000} chars]` : r.text;
        return text(out || "(no output)");
      } catch (e) {
        return text(unreachable(e));
      }
    }
  );
}
