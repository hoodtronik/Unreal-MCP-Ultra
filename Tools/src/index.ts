import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getUEHealth, gracefulShutdown, state } from "./ue-bridge.js";
import { TOOL_REGISTRATIONS } from "./tool-registry.js";

import { registerBlueprintListResource } from "./resources/blueprint-list.js";
import { registerWorkflowRecipesResource } from "./resources/workflow-recipes.js";
import { registerSkills } from "./skills/index.js";
import { registerExamples } from "./examples/index.js";
import { registerDiscoveryMode } from "./discovery/index.js";
import { registerAgentConfigTools } from "./tools/agent-config.js";
import { installVisionWrapper } from "./vision-wrapper.js";

const server = new McpServer({ name: "blueprint-mcp", version: "1.0.0" });

// Must run BEFORE any registration — it wraps server.tool, so tools registered earlier would
// miss the hook entirely. No-op unless vision_mode has been turned on.
installVisionWrapper(server);

for (const { register } of TOOL_REGISTRATIONS) register(server);

registerBlueprintListResource(server);
registerWorkflowRecipesResource(server);
registerSkills(server);
registerExamples(server);
registerAgentConfigTools(server);

// Opt-in (MCP_DISCOVERY_MODE=true). Must run LAST — after every tool is registered —
// so the catalog sees them. No-op when the env var is unset (default behavior).
registerDiscoveryMode(server);

process.on("exit", () => { if (!state.editorMode) state.ueProcess?.kill(); });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (!state.editorMode && state.ueProcess) await gracefulShutdown();
    process.exit();
  });
}

async function main() {
  const health = await getUEHealth();
  if (health) {
    state.editorMode = health.mode === "editor";
    console.error(`Connected to UE5 ${health.mode} \u2014 MCP server already running.`);
  } else {
    state.editorMode = false;
    console.error("UE5 server not detected. Commandlet will be spawned on first tool call.");
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
