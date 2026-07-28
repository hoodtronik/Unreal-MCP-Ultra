import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "..", "src");
const TOOLS_DIR = path.join(SRC_DIR, "tools");

// CLAUDE-NOTE: found 2026-07-27 by comparing a live MCP server's tool count (238) against the
// source count (241). tools/actor-state.ts defined set_actor_mobility, set_actor_visibility and
// set_actor_physics — with working C++ handlers and registered HTTP routes — but its
// registerActorStateTools was never listed in TOOL_REGISTRATIONS, so no client ever saw them.
//
// route-parity.test.ts structurally CANNOT catch this: it checks that every "/api/..." string in
// src/ has a C++ route and vice versa, and those strings were present — just inside a file nothing
// ever called. Same silent-drift family as the 2026-05-27 route-loss incident, one layer up.
//
// This asserts the other half: every register* function defined under src/tools/ must actually be
// wired into tool-registry.ts or invoked directly by index.ts.

function toolFiles(): string[] {
  return fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(TOOLS_DIR, f));
}

// CLAUDE-NOTE: comments must be stripped before matching. Found 2026-07-28 while proving the riot
// invariant could fail: commenting out a TOOL_REGISTRATIONS entry left this test GREEN, because
// `registry.includes("register: registerFooTools")` matches the text just as happily inside a
// `//` comment as in live code. A commented-out registration is exactly the silent-drift this file
// exists to catch, so the check was blind to its own failure mode.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("tool registration parity", () => {
  const registry = stripComments(fs.readFileSync(path.join(SRC_DIR, "tool-registry.ts"), "utf-8"));
  const index = stripComments(fs.readFileSync(path.join(SRC_DIR, "index.ts"), "utf-8"));

  const exported: { fn: string; file: string; toolCount: number }[] = [];
  for (const file of toolFiles()) {
    const src = fs.readFileSync(file, "utf-8");
    const toolCount = (src.match(/server\.tool\(\s*"/g) ?? []).length;
    for (const m of src.matchAll(/export function (register\w+)/g)) {
      exported.push({ fn: m[1], file: path.basename(file), toolCount });
    }
  }

  it("found registration functions to check (guards against a no-op test)", () => {
    expect(exported.length).toBeGreaterThan(40);
  });

  it("every register* function under src/tools is actually wired up", () => {
    const orphans = exported
      .filter(({ fn }) => !registry.includes(`register: ${fn}`) && !index.includes(`${fn}(server)`))
      .map(({ fn, file, toolCount }) => `${fn} (${file}, ${toolCount} tool(s))`)
      .sort();

    expect(
      orphans,
      "These define tools that no client will ever see. Add them to TOOL_REGISTRATIONS in " +
        "tool-registry.ts (or call them directly from index.ts).",
    ).toEqual([]);
  });

  // A registration function that registers nothing is usually a sign of a half-finished file.
  it("no wired-up registration function is empty", () => {
    const empty = exported
      .filter(({ fn }) => registry.includes(`register: ${fn}`) || index.includes(`${fn}(server)`))
      .filter(({ toolCount }) => toolCount === 0)
      .map(({ fn, file }) => `${fn} (${file})`)
      .sort();
    expect(empty).toEqual([]);
  });
});
