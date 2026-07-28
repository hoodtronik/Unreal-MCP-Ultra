// Manual harness: connect to the built MCP server over REAL stdio and enumerate what a client
// actually sees.
//
// CLAUDE-NOTE: this exists because "registered in source" and "visible to a client" are different
// claims, and this repo has been bitten by the gap before — three actor-state tools shipped with
// working C++ handlers and registered routes but were never listed in TOOL_REGISTRATIONS, so no
// client ever saw them. The vitest suite now asserts registration by executing TOOL_REGISTRATIONS
// against a stub, but a stub is not a client. This is the end-to-end version.
//
// Usage:  cd Tools && node test/manual/riot-mcp-client.mjs
// Does NOT require a running editor to list tools; calling riot_get_capabilities will report the
// feature as unreachable if no editor/commandlet is up, which is itself a valid result.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "..", "dist", "index.js");

const EXPECTED_RIOT_TOOLS = [
  "riot_add_blockade", "riot_add_faction", "riot_add_flow_origin", "riot_add_hotspot",
  "riot_create_scenario", "riot_delete_scenario", "riot_get_capabilities",
  "riot_get_runtime_report", "riot_get_scenario", "riot_list_scenarios", "riot_pause",
  "riot_reset", "riot_resume", "riot_set_trigger", "riot_spawn", "riot_start",
];

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, UE_PROJECT_DIR: process.env.UE_PROJECT_DIR ?? process.cwd() },
});

const client = new Client({ name: "riot-acceptance", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const riot = names.filter((n) => n.startsWith("riot_"));
const missing = EXPECTED_RIOT_TOOLS.filter((e) => !riot.includes(e));

console.log(`Total tools visible to client : ${names.length}`);
console.log(`  riot_* tools                : ${riot.length}`);
console.log(`  non-riot tools              : ${names.length - riot.length}`);
console.log(`Missing from expected set     : ${missing.length ? missing.join(", ") : "none"}`);

console.log("\nRiot tools as the client sees them:");
for (const r of riot) console.log(`  ${r}`);

const res = await client.callTool({ name: "riot_get_capabilities", arguments: {} });
const text = res.content?.[0]?.text ?? "";
console.log("\nriot_get_capabilities round-trip through the client:");
console.log(text.split("\n").slice(0, 10).map((l) => "  " + l).join("\n"));

await client.close();
process.exit(missing.length ? 1 : 0);
