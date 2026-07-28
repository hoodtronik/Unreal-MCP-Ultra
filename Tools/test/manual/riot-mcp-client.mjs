// Manual harness: connect to the built MCP server over REAL stdio and assert that what a client
// actually sees matches the reviewed baseline.
//
// CLAUDE-NOTE: "registered in source" and "visible to a client" are different claims, and this repo
// has been bitten by the gap — three actor-state tools shipped with working C++ handlers and
// registered routes but were never listed in TOOL_REGISTRATIONS, so no client ever saw them. The
// vitest suite asserts registration by executing TOOL_REGISTRATIONS against a stub, but a stub is
// not a client. This is the end-to-end version.
//
// CLAUDE-NOTE: the first version of this harness only checked that the 16 riot tools were present,
// so its exit code could not detect a CORE tool disappearing — the regression that actually matters
// when an optional plugin starts contributing endpoints to the shared server. It now diffs the full
// tool set against a committed manifest in BOTH directions.
//
// Provenance of that manifest matters and is deliberate: tool-baseline.json's coreTools were
// captured by running a real MCP client against a detached worktree of the merge-base commit
// (af6ec58), NOT against this branch. Generating a baseline from the branch under test and then
// comparing it to itself would make this check vacuous.
//
// BASELINE POLICY — the manifest is an audited contract, not a moving snapshot. Every one of these
// fails the run:
//   * a core tool removed
//   * a core tool ADDED
//   * a riot tool removed
//   * an unexpected riot-prefixed tool added
//   * any mismatch in total or non-riot counts
// Additions fail for exactly the same reason removals do: the reviewed tool surface changed. The
// fix is never to relax the check or to regenerate the baseline from this branch — it is to review
// the change and consciously refresh tool-baseline.json.
//
// Usage:  cd Tools && node test/manual/riot-mcp-client.mjs
//
// Listing tools does not require a running editor. Calling riot_get_capabilities will report the
// feature as unreachable if nothing is up, which is itself a valid (non-fatal) result — the tool
// surface is what this harness gates on.
//
// Exit 0 only when every check below passes.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "..", "dist", "index.js");
const MANIFEST = path.resolve(HERE, "tool-baseline.json");

if (!fs.existsSync(SERVER)) {
  console.error(`FAIL: server bundle not found at ${SERVER}. Run "npm run build" first.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
const expectedCore = new Set(manifest.coreTools);
const expectedRiot = new Set(manifest.riotTools);
const expectedTotal = manifest.provenance.expectedTotal;

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, UE_PROJECT_DIR: process.env.UE_PROJECT_DIR ?? process.cwd() },
});

const client = new Client({ name: "riot-acceptance", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();

const names = tools.map((t) => t.name).sort();
const seen = new Set(names);
const seenRiot = names.filter((n) => n.startsWith("riot_"));
const seenCore = names.filter((n) => !n.startsWith("riot_"));

const failures = [];
const sorted = (s) => [...s].sort();

// 1. Total count matches the reviewed expected total.
if (names.length !== expectedTotal) {
  failures.push(`total tool count is ${names.length}, expected ${expectedTotal}`);
}

// 2. Riot tool count is exactly 16.
if (seenRiot.length !== expectedRiot.size) {
  failures.push(`riot tool count is ${seenRiot.length}, expected ${expectedRiot.size}`);
}

// 3. Non-riot count matches the reviewed baseline.
if (seenCore.length !== expectedCore.size) {
  failures.push(`non-riot tool count is ${seenCore.length}, expected ${expectedCore.size}`);
}

// 4. Every expected riot tool is present.
const missingRiot = sorted([...expectedRiot].filter((n) => !seen.has(n)));
if (missingRiot.length) failures.push(`missing riot tools: ${missingRiot.join(", ")}`);

// 5. No unexpected riot-prefixed tool without updating the manifest.
const unexpectedRiot = sorted(seenRiot.filter((n) => !expectedRiot.has(n)));
if (unexpectedRiot.length) {
  failures.push(`unexpected riot tools (update tool-baseline.json if intentional): ${unexpectedRiot.join(", ")}`);
}

// 6. The complete baseline core set is still present. This is the check the original harness
//    lacked: an optional plugin must never cost the core a tool.
const missingCore = sorted([...expectedCore].filter((n) => !seen.has(n)));
if (missingCore.length) {
  failures.push(`MISSING CORE TOOLS (regression): ${missingCore.join(", ")}`);
}

// Added core tools are listed separately for diagnosis, but they still cause the harness to FAIL
// via the strict total-count and non-riot-count checks above. That is intentional: the manifest is
// an audited contract, not a moving snapshot, so any change to the tool surface — additions
// included — requires deliberate review and a conscious refresh of tool-baseline.json.
//
// This list exists only so a failing run says WHICH tool appeared, instead of leaving a reviewer to
// diff two counts by hand. It never softens the verdict, and the baseline must never be
// regenerated automatically from the branch under test.
const addedCore = sorted(seenCore.filter((n) => !expectedCore.has(n)));

console.log(`Server            : ${SERVER}`);
console.log(`Baseline manifest : ${MANIFEST}`);
console.log(`  core provenance : ${manifest.provenance.coreToolsSourceCommit} (${manifest.provenance.coreToolsSourceRef})`);
console.log("");
console.log(`Total tools visible to client : ${names.length}   (expected ${expectedTotal})`);
console.log(`  riot tools                  : ${seenRiot.length}    (expected ${expectedRiot.size})`);
console.log(`  non-riot tools              : ${seenCore.length}   (expected ${expectedCore.size})`);
console.log(`Missing riot tools            : ${missingRiot.length ? missingRiot.join(", ") : "none"}`);
console.log(`Unexpected riot tools         : ${unexpectedRiot.length ? unexpectedRiot.join(", ") : "none"}`);
console.log(`Missing core tools            : ${missingCore.length ? missingCore.join(", ") : "none"}`);
console.log(`Added core tools (also fails)  : ${addedCore.length ? addedCore.join(", ") : "none"}`);

// Round-trip one riot tool so the harness proves invocation, not just advertisement.
let roundTrip = "not attempted";
try {
  const res = await client.callTool({ name: "riot_get_capabilities", arguments: {} });
  const text = res.content?.[0]?.text ?? "";
  roundTrip = text.includes("featureInstalled") ? "ok" : "unexpected payload";
  console.log("\nriot_get_capabilities round-trip:");
  console.log(text.split("\n").slice(0, 8).map((l) => "  " + l).join("\n"));
} catch (e) {
  roundTrip = `error: ${e}`;
  console.log(`\nriot_get_capabilities round-trip: ${roundTrip}`);
}
if (roundTrip !== "ok") {
  failures.push(`riot_get_capabilities did not round-trip cleanly (${roundTrip})`);
}

await client.close();

console.log("");
if (failures.length) {
  console.error("RESULT: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("RESULT: PASS — tool surface matches the reviewed baseline.");
process.exit(0);
