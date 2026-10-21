// Live e2e of ikrig_create / retarget_setup / retarget_animations / pose_asset_create through an MCP client.
// Usage: node Tools/test/manual/retarget-e2e.mjs   (editor on :9847; writes under /Game/_MCPLab/RtgE2E)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRetargetTools } from "../../dist/tools/retarget.js";

const R = "/Game/_MCPLab/RtgE2E";
const MANNY = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple";
const TARGET = process.argv[2] ?? "/Game/Fab/Dummy/handpaint_-_girl_01/scene/SkeletalMeshes/scene";
const server = new McpServer({ name: "rtg-e2e", version: "0" });
registerRetargetTools(server);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "e2e", version: "0" });
await client.connect(b);
let failed = 0;
async function call(name, args, expectOk = true) {
  const r = await client.callTool({ name, arguments: args });
  const pass = !r.isError === expectOk;
  if (!pass) failed++;
  console.log(`\n=== ${name} ${pass ? "PASS" : "FAIL"}\n${r.content.map((c) => c.text).join("\n")}`);
}
const stamp = Date.now();
await call("ikrig_create", { mesh: MANNY, path: `${R}/IK_Manny_${stamp}` });
await call("ikrig_create", { mesh: TARGET, path: `${R}/IK_Target_${stamp}`, templateRig: `${R}/IK_Manny_${stamp}` });
await call("ikrig_create", { mesh: TARGET, path: `${R}/IK_NoTpl_${stamp}` }, false);   // custom skeleton, no template
await call("retarget_setup", { path: `${R}/RTG_${stamp}`, sourceRig: `${R}/IK_Manny_${stamp}`, targetRig: `${R}/IK_Target_${stamp}`, sourceMesh: MANNY, targetMesh: TARGET });
await call("retarget_animations", { anims: ["/Game/Characters/Mannequins/Anims/Unarmed/Jump/MM_Jump", "/Game/Characters/Mannequins/Anims/Unarmed/Walk/MF_Unarmed_Walk_Fwd"],
  sourceMesh: MANNY, targetMesh: TARGET, retargeter: `${R}/RTG_${stamp}`, outFolder: `${R}/Anims_${stamp}` });
await call("pose_asset_create", { anim: "/Game/Characters/Mannequins/Anims/Unarmed/Jump/MM_Land", path: `${R}/PA_Land_${stamp}`, poseNames: ["Impact", "Absorb"] });
console.log(`\n${failed ? failed + " FAILED" : "ALL PASS"}`);
process.exit(failed ? 1 : 0);
