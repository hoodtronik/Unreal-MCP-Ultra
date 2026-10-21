// Live end-to-end check of the pose_* tools through a real MCP client, against the editor on :9847.
// Usage (editor open, BlueprintMCP running):  node Tools/test/manual/posing-e2e.mjs [/Game/_MCPLab/Pose/SEQ_E2E]
// Writes assets under the given sequence path only. Exit code 1 on any failed expectation.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPosingTools } from "../../dist/tools/posing.js";

const SEQ = process.argv[2] ?? "/Game/_MCPLab/Pose/SEQ_E2E";
const server = new McpServer({ name: "posing-e2e", version: "0" });
registerPosingTools(server);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "e2e", version: "0" });
await client.connect(b);

let failed = 0;
async function call(name, args, expectOk = true) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.map((c) => c.text).join("\n");
  const ok = !r.isError;
  const pass = ok === expectOk;
  if (!pass) failed++;
  console.log(`\n=== ${name} ${pass ? "PASS" : "FAIL"} (isError=${!ok}, expected ok=${expectOk})\n${t}`);
  return t;
}

await call("pose_setup_character", { sequence: SEQ, binding: "Hero", facing: -90,
  clip: "/Game/Characters/Mannequins/Anims/Unarmed/MM_Idle", clipFrame: 10 });
await call("pose_list_controls", { sequence: SEQ, binding: "Hero", contains: "head" });
await call("pose_set_controls", { sequence: SEQ, binding: "Hero", controls: [
  { control: "head_ctrl", rotation: [10, -25, 0] },
  { control: "spine_fk_ik_switch", value: false },
] });
await call("pose_reach", { sequence: SEQ, binding: "Hero", effector: "hand_r", target: [-25, -45, 150] }, false); // ~5 cm past arm length
await call("pose_reach", { sequence: SEQ, binding: "Hero", effector: "hand_r", target: [10, -40, 150] });
await call("pose_reach", { sequence: SEQ, binding: "Hero", effector: "hand_l", target: [0, -400, 150] }, false); // out of reach
await call("pose_set_controls", { sequence: SEQ, binding: "Hero", controls: [{ control: "no_such_ctrl", value: 1 }] }, false);
await call("pose_read", { sequence: SEQ, binding: "Hero", bones: ["head", "hand_r", "hand_l"], controls: ["head_ctrl"] });
console.log(`\n${failed ? failed + " FAILED" : "ALL PASS"}`);
process.exit(failed ? 1 : 0);
