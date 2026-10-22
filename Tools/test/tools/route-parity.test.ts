import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SRC_DIR = path.resolve(PLUGIN_ROOT, "Tools", "src");
const SERVER_CPP = path.resolve(
  PLUGIN_ROOT,
  "Source",
  "BlueprintMCP",
  "Private",
  "BlueprintMCPServer.cpp",
);

// CLAUDE-NOTE: the optional Riot Crowd plugin contributes its routes through the core's
// external-endpoint seam, so they are registered in RiotCrowdRegistration.cpp rather than via
// FHttpPath in BlueprintMCPServer.cpp. Without scanning it, every riot route the TS layer calls
// would look like a missing C++ registration — the exact false positive that would train someone
// to ignore this test. Registered externally, but still registered.
const RIOT_REGISTRATION_CPP = path.resolve(
  PLUGIN_ROOT,
  "RiotCrowd",
  "Source",
  "BlueprintMCPRiotCrowd",
  "Private",
  "RiotCrowdRegistration.cpp",
);

// CLAUDE-NOTE (2026-10-22): the optional Pose Search sibling plugin registers its routes the same way (external
// endpoints, PoseSearchExt/ in this repo).
const POSESEARCH_REGISTRATION_CPP = path.resolve(
  PLUGIN_ROOT,
  "PoseSearchExt",
  "Source",
  "BlueprintMCPPoseSearch",
  "Private",
  "BlueprintMCPPoseSearchModule.cpp",
);

const ROUTE_RE = /\/api\/[a-zA-Z0-9-]+/g;

// CLAUDE-NOTE: /api/test-save is an intentional diagnostic-only endpoint with no MCP tool wrapper
// (see BlueprintMCPHandlers_Read.cpp: "load a Blueprint and save it unmodified") — everything else
// is expected to have a TS caller.
// CLAUDE-NOTE (2026-10-21): the blend-space routes are superseded by the Python path in anim-guard.ts (the C++
// wiped samples and skipped assets silently); kept until the C++ is fixed at the next editor restart.
const KNOWN_ORPHAN_CPP_ROUTES = new Set(["/api/test-save", "/api/create-blend-space", "/api/set-blend-space-samples"]);

function walkTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

// CLAUDE-NOTE: catches the failure mode from the 2026-05-27 merge that silently dropped 58 route
// registrations from BlueprintMCPServer.cpp (see memory: blueprint-mcp-route-loss-incident) — every
// route the TS layer calls must have a matching FHttpPath registration in the C++ backend, and vice
// versa, or a tool silently 404s / a registration goes uncalled.
describe("TS/C++ route parity", () => {
  const tsRoutes = new Set(
    walkTsFiles(SRC_DIR).flatMap((file) =>
      Array.from(fs.readFileSync(file, "utf-8").matchAll(ROUTE_RE), (m) => m[0]),
    ),
  );

  const cppSource = fs.readFileSync(SERVER_CPP, "utf-8");
  const cppRoutes = new Set(
    Array.from(
      cppSource.matchAll(/FHttpPath\(TEXT\("(\/api\/[a-zA-Z0-9-]+)"\)\)/g),
      (m) => m[1],
    ),
  );

  // External endpoints: Add(TEXT("/api/riot-spawn"), TEXT("riot-spawn"), ...)
  const riotSource = [RIOT_REGISTRATION_CPP, POSESEARCH_REGISTRATION_CPP]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf-8"))
    .join("\n");
  for (const m of riotSource.matchAll(/TEXT\("(\/api\/[a-zA-Z0-9-]+)"\)/g)) {
    cppRoutes.add(m[1]);
  }

  it("has a C++ route registration for every route the TS layer calls", () => {
    const missingInCpp = [...tsRoutes].filter((r) => !cppRoutes.has(r)).sort();
    expect(missingInCpp).toEqual([]);
  });

  it("has a TS caller for every C++ route registration", () => {
    const missingInTs = [...cppRoutes]
      .filter((r) => !tsRoutes.has(r) && !KNOWN_ORPHAN_CPP_ROUTES.has(r))
      .sort();
    expect(missingInTs).toEqual([]);
  });

  it("does not carry stale entries in the known-orphan allowlist", () => {
    // If a route gets wired up or removed, its allowlist entry must be deleted too.
    const staleEntries = [...KNOWN_ORPHAN_CPP_ROUTES]
      .filter((r) => !cppRoutes.has(r) || tsRoutes.has(r))
      .sort();
    expect(staleEntries).toEqual([]);
  });
});
