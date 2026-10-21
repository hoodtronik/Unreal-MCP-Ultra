// Call ONE BlueprintMCP tool through a real MCP client (in-memory transport), against the live editor on :9847.
// Lets an agent use freshly built tools (Tools/dist) before its own MCP connection is restarted.
//   node Tools/test/manual/mcp-call.mjs <tool> '<json args>' [image-out.png]
// Prints the text content; writes the first image block (if any) to image-out.png. Exit 1 when isError.
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_REGISTRATIONS } from "../../dist/tool-registry.js";

const [tool, json = "{}", imgOut] = process.argv.slice(2);
if (!tool) {
  console.error("usage: mcp-call.mjs <tool> '<json args>' [image-out.png]");
  process.exit(2);
}
const server = new McpServer({ name: "mcp-call", version: "0" });
for (const { register } of TOOL_REGISTRATIONS) register(server);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "mcp-call", version: "0" });
await client.connect(b);
const r = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 600_000 });
for (const c of r.content) {
  if (c.type === "text") console.log(c.text);
  else if (c.type === "image" && imgOut) {
    writeFileSync(imgOut, Buffer.from(c.data, "base64"));
    console.log(`[image -> ${imgOut}]`);
  }
}
if (r.isError) console.log("[isError]");
// Close both ends instead of process.exit(): exiting with live handles trips a libuv assertion on Windows.
await client.close();
await server.close();
process.exitCode = r.isError ? 1 : 0;
