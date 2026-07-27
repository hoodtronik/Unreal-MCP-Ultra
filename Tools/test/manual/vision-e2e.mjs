// End-to-end test of vision_mode through a REAL MCP client over stdio.
// This exercises the wrapper installed in index.ts, which no unit test can reach: the wrapper
// intercepts server.tool at registration time, so it only exists in a live server process.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_DIR = "F:/__PROJECTS/Jesus-I_AM_Series/_LuminousExhibit/TestProject56/TestProject56";
const SERVER = "F:/__PROJECTS/ue5-mcp/Tools/dist/index.js";

const pass = [], fail = [];
const check = (name, ok, detail) => {
  (ok ? pass : fail).push(name);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} :: ${detail}`);
};

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, UE_PROJECT_DIR: PROJECT_DIR },
});
const client = new Client({ name: "e2e-probe", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
check("MCP handshake + tool listing", tools.length > 200, `${tools.length} tools registered`);
check("vision tools registered", ["viewport_capture", "vision_mode", "scene_digest"].every((n) => names.has(n)),
  ["viewport_capture", "vision_mode", "scene_digest"].filter((n) => names.has(n)).join(", "));
check("level tools registered", names.has("open_level") && names.has("new_level"), "open_level, new_level");

const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const imageBlocks = (r) => (r.content || []).filter((c) => c.type === "image");
const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// Put the editor on a level that actually has something to look at.
const opened = await call("open_level", { level: "Fire_part_02", discardUnsaved: true });
check("open_level via MCP", !/Error:/.test(textOf(opened)), textOf(opened).split("\n")[0]);

// --- Baseline: vision OFF, a mutating tool must NOT carry an image ---
await call("vision_mode", { enabled: false });
const off = await call("spawn_light", { type: "point", label: "E2EProbeA", intensity: 1000 });
check("vision OFF -> no image attached", imageBlocks(off).length === 0,
  `${imageBlocks(off).length} image block(s)`);

// --- vision ON ---
const on = await call("vision_mode", { enabled: true, maxSize: 384 });
check("vision_mode enable", /Vision mode ON/.test(textOf(on)), textOf(on).split("\n").slice(0, 4).join(" | "));

// A mutating tool should now come back with an image appended BY THE WRAPPER.
// Use a mutation with a guaranteed visual delta: a spawned point light may legitimately change
// nothing on screen, and would then be correctly suppressed — which would make this test pass or
// fail on luck rather than on whether the wrapper works.
const mut = await call("set_view_mode", { mode: "Unlit" });
const img = imageBlocks(mut)[0];
check("mutating tool -> image auto-attached", !!img,
  img ? `${img.mimeType}, ${Math.round((img.data || "").length / 1024)} KB base64` : "no image block");
check("attached image is a real PNG", !!img && Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG",
  img ? Buffer.from(img.data, "base64").subarray(0, 8).toString("hex") : "n/a");

// Second consecutive attachment on an unchanged scene SHOULD be suppressed — that is the feature
// working, not failing.
const again = await call("set_actor_tags", { label: "NoSuchActor_XYZ", tags: [] }).catch(() => null);
const mut2 = await call("set_view_mode", { mode: "Unlit" });
check("repeat with no visual change -> suppressed", imageBlocks(mut2).length === 0,
  `${imageBlocks(mut2).length} image block(s)`);
await call("set_view_mode", { mode: "Lit" });

// A read-only tool must NOT get one.
const ro = await call("list_lights", {});
check("read-only tool -> no image", imageBlocks(ro).length === 0, `${imageBlocks(ro).length} image block(s)`);

// A blueprint-scoped tool with no graph should be skipped (level frame would be unchanged anyway).
const bpScoped = await call("list_blueprints", {});
check("list_blueprints -> no image", imageBlocks(bpScoped).length === 0, `${imageBlocks(bpScoped).length} image block(s)`);

// --- explicit capture with settle ---
const cap = await call("viewport_capture", { target: "level", maxSize: 384, settle: true });
const capImg = imageBlocks(cap)[0];
check("viewport_capture(settle) returns an image", !!capImg,
  capImg ? `${Math.round((capImg.data || "").length / 1024)} KB base64` : textOf(cap).slice(0, 120));
check("settle reported in the text block", /Settled|Still changing/.test(textOf(cap)),
  (textOf(cap).match(/(Settled[^\n]*|⚠ Still changing[^\n]*)/) || ["<none>"])[0]);

// --- off again ---
await call("vision_mode", { enabled: false });
const after = await call("spawn_light", { type: "point", label: "E2EProbeC", intensity: 500 });
check("vision OFF again -> no image", imageBlocks(after).length === 0, `${imageBlocks(after).length} image block(s)`);

// cleanup
for (const l of ["E2EProbeA", "E2EProbeB", "E2EProbeC"]) {
  await call("delete_actor", { label: l }).catch(() => {});
}

console.log(`\n===== ${pass.length} passed, ${fail.length} failed =====`);
if (fail.length) console.log("FAILED: " + fail.join(", "));
await client.close();
process.exit(fail.length ? 1 : 0);
