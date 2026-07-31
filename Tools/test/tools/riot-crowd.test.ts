import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_REGISTRATIONS } from "../../src/tool-registry.js";

// CLAUDE-NOTE: these are STATIC invariants, deliberately not live-integration tests.
//
// The test harness boots a headless commandlet against a generated temp project that installs only
// BlueprintMCP. The Riot Crowd plugin is a separate opt-in sibling that is NOT installed there, and
// the simulation only runs inside PIE, which a -nullrhi commandlet does not have. So a "live" riot
// test in this suite would be testing a mock, and the milestone is explicit that a passing mock is
// not a live proof. Live verification is a manual editor procedure — see
// docs/riot-crowd/RIOT-CROWD-HUMAN-REVIEW.md.
//
// What IS worth asserting statically is the wiring that has silently broken before in this repo:
// tools defined but never registered, routes called but never bound, and the core plugin quietly
// acquiring a dependency it is supposed to stay free of.

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SRC_DIR = path.resolve(PLUGIN_ROOT, "Tools", "src");
const RIOT_ROOT = path.resolve(PLUGIN_ROOT, "RiotCrowd");

const riotToolSrc = fs.readFileSync(path.join(SRC_DIR, "tools", "riot-crowd.ts"), "utf-8");
const registrySrc = fs.readFileSync(path.join(SRC_DIR, "tool-registry.ts"), "utf-8");
const registrationCpp = fs.readFileSync(
  path.join(RIOT_ROOT, "Source", "BlueprintMCPRiotCrowd", "Private", "RiotCrowdRegistration.cpp"),
  "utf-8",
);
const errorCodesH = fs.readFileSync(
  path.join(RIOT_ROOT, "Source", "BlueprintMCPRiotCrowd", "Public", "RiotErrorCodes.h"),
  "utf-8",
);

/** The public vocabulary the milestone specifies. Renaming one of these is a breaking change. */
const EXPECTED_TOOLS = [
  "riot_get_capabilities",
  "riot_get_scenario",
  "riot_get_runtime_report",
  "riot_list_scenarios",
  "riot_create_scenario",
  "riot_delete_scenario",
  "riot_add_faction",
  "riot_add_flow_origin",
  "riot_add_blockade",
  "riot_add_hotspot",
  "riot_set_trigger",
  "riot_spawn",
  "riot_start",
  "riot_pause",
  "riot_resume",
  "riot_reset",
];

describe("riot crowd — tool surface", () => {
  it("defines every specified public tool", () => {
    const defined = Array.from(
      riotToolSrc.matchAll(/server\.tool\(\s*"(riot_[a-z_]+)"/g),
      (m) => m[1],
    );
    // lifecycleTool() registers via a variable name, so pick those up too.
    const viaHelper = Array.from(
      riotToolSrc.matchAll(/lifecycleTool\(\s*"(riot_[a-z_]+)"/g),
      (m) => m[1],
    );
    const all = new Set([...defined, ...viaHelper]);

    const missing = EXPECTED_TOOLS.filter((t) => !all.has(t));
    expect(missing, "Tools named in the milestone but not defined").toEqual([]);
  });

  // CLAUDE-NOTE: this is the test the milestone explicitly asks for — one that fails if the riot
  // registration function exists in source but never reaches the live MCP registry.
  //
  // It EXECUTES the registry against a recording stub rather than grepping tool-registry.ts for
  // "register: registerRiotCrowdTools". That distinction is not pedantic: I verified it by
  // commenting the entry out, and the string-matching version still passed, because `includes()`
  // happily matches the text inside a `//` comment. Executing the registry is the only form of this
  // check that can actually fail. (The repo's generic registration-parity.test.ts had the same
  // blind spot; it is fixed there too.)
  it("actually registers every riot tool through TOOL_REGISTRATIONS", () => {
    const registered: string[] = [];
    const recordingServer = {
      tool: (name: string) => { registered.push(name); },
    } as any;

    for (const entry of TOOL_REGISTRATIONS) {
      entry.register(recordingServer);
    }

    const missing = EXPECTED_TOOLS.filter((t) => !registered.includes(t));
    expect(
      missing,
      "These riot tools never reach the MCP registry, so no client would ever see them.",
    ).toEqual([]);
  });

  it("registers a C++ route for every riot endpoint the TS layer calls", () => {
    const tsRoutes = new Set(
      Array.from(riotToolSrc.matchAll(/"(\/api\/riot-[a-z-]+)"/g), (m) => m[1]),
    );
    const cppRoutes = new Set(
      Array.from(registrationCpp.matchAll(/TEXT\("(\/api\/riot-[a-z-]+)"\)/g), (m) => m[1]),
    );

    expect(tsRoutes.size).toBeGreaterThanOrEqual(16);

    const missingInCpp = [...tsRoutes].filter((r) => !cppRoutes.has(r)).sort();
    expect(missingInCpp, "TS calls these routes but C++ never registers them").toEqual([]);

    const missingInTs = [...cppRoutes].filter((r) => !tsRoutes.has(r)).sort();
    expect(missingInTs, "C++ registers these routes but no TS tool calls them").toEqual([]);
  });
});

describe("riot crowd — structured errors", () => {
  const REQUIRED_CODES = [
    "RIOT_FEATURE_NOT_INSTALLED",
    "RIOT_REQUIRED_PLUGIN_DISABLED",
    "RIOT_UNSUPPORTED_ENGINE_VERSION",
    "RIOT_SCENARIO_NOT_FOUND",
    "RIOT_SCENARIO_ALREADY_EXISTS",
    "RIOT_SCENARIO_INVALID",
    "RIOT_DUPLICATE_ID",
    "RIOT_FACTION_NOT_FOUND",
    "RIOT_FLOW_ORIGIN_NOT_FOUND",
    "RIOT_BLOCKADE_NOT_FOUND",
    "RIOT_INVALID_COUNT",
    "RIOT_INVALID_TRANSFORM",
    "RIOT_INVALID_THRESHOLD",
    "RIOT_SIMULATION_NOT_RUNNING",
    "RIOT_SIMULATION_ALREADY_RUNNING",
    "RIOT_RESET_FAILED",
    "RIOT_RUNTIME_STATE_MISMATCH",
    "RIOT_LIVE_VERIFICATION_FAILED",
  ];

  it("declares every error code the milestone requires", () => {
    const missing = REQUIRED_CODES.filter((c) => !errorCodesH.includes(c));
    expect(missing).toEqual([]);
  });

  it("translates a missing feature into RIOT_FEATURE_NOT_INSTALLED rather than a parse error", () => {
    // uePost() calls resp.json() unconditionally; a 404 body would throw. The riot helpers must
    // check status first, or an uninstalled feature looks like a broken tool.
    expect(riotToolSrc).toContain("resp.status === 404");
    expect(riotToolSrc).toContain("RIOT_FEATURE_NOT_INSTALLED");
  });
});

describe("riot crowd — optional-plugin boundary", () => {
  it("ships RiotCrowd as its own plugin descriptor, not as a core module", () => {
    expect(fs.existsSync(path.join(RIOT_ROOT, "BlueprintMCPRiotCrowd.uplugin"))).toBe(true);
  });

  // CLAUDE-NOTE: the load-bearing invariant of this whole feature. Riot Crowd exists as a separate
  // plugin precisely so users who only want the core Blueprint tools never get MassGameplay
  // enabled. If someone later "simplifies" things by folding the module or the Mass dependency into
  // BlueprintMCP.uplugin, that guarantee is silently gone and nothing else would catch it.
  it("keeps the core plugin free of the riot module and of Mass", () => {
    const coreUplugin = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, "BlueprintMCP.uplugin"), "utf-8"),
    );

    const moduleNames = (coreUplugin.Modules ?? []).map((m: any) => m.Name);
    expect(moduleNames).toEqual(["BlueprintMCP"]);

    const pluginDeps = (coreUplugin.Plugins ?? []).map((p: any) => p.Name);
    const massDeps = pluginDeps.filter((n: string) => /^Mass|ZoneGraph|StateTree|SmartObjects/.test(n));
    expect(
      massDeps,
      "Core BlueprintMCP must not depend on Mass — that would force an experimental crowd stack on every user.",
    ).toEqual([]);
  });

  it("declares MassGameplay on the riot plugin, and not the MassEntity shell deprecated in 5.5", () => {
    const riotUplugin = JSON.parse(
      fs.readFileSync(path.join(RIOT_ROOT, "BlueprintMCPRiotCrowd.uplugin"), "utf-8"),
    );
    const deps = (riotUplugin.Plugins ?? []).map((p: any) => p.Name);

    expect(deps).toContain("MassGameplay");
    expect(deps).toContain("BlueprintMCP");
    expect(
      deps,
      "MassEntity became an engine Runtime module in 5.6; the plugin is a deprecated shell and enabling it warns.",
    ).not.toContain("MassEntity");
  });
});

// CLAUDE-NOTE: this whole block exists because riot_get_capabilities reported a useless answer.
// It probed for a *plugin* named MassEntity — a content-only shell this project deliberately leaves
// disabled — so it answered `massEntity: false` on a healthy editor. On 5.6 that was at least
// literally true of the plugin, and it still misled: three docs cited it as PROVEN-LIVE evidence
// that only MassGameplay is required. On 5.8, where the shell plugin does not exist at all, the
// same code flatly contradicted a running system. These assert the shape that prevents both.
describe("riot crowd — capability probe honesty", () => {
  const handlersRaw = fs.readFileSync(
    path.join(RIOT_ROOT, "Source", "BlueprintMCPRiotCrowd", "Private", "RiotCrowdHandlers.cpp"),
    "utf-8",
  );

  // CLAUDE-NOTE: assert against CODE, not comments. The first draft of these tests failed on the
  // CLAUDE-NOTE that documents the bug, because the note quotes the banned call verbatim — exactly
  // the text you want written down. A source-text invariant that a correct explanatory comment can
  // break trains the next person to delete the explanation to get green, so strip comments first.
  const handlersCpp = handlersRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("never probes MassEntity or MassCore as a plugin", () => {
    for (const engineModule of ["MassEntity", "MassCore"]) {
      expect(
        handlersCpp,
        `${engineModule} is an engine Runtime module, not a plugin. IsPluginEnabled answers about ` +
          `a shell this project keeps disabled, which is how the bug shipped — use IsModuleAvailable.`,
      ).not.toContain(`IsPluginEnabled(TEXT("${engineModule}"))`);
    }
  });

  it("probes the Mass ECS by module, covering both the 5.6 and 5.8 module names", () => {
    expect(handlersCpp).toContain(`IsModuleAvailable(TEXT("MassEntity"))`);
    expect(
      handlersCpp,
      "5.8 split Runtime/MassEntity into Runtime/Mass/{MassCore,...}. MassCore is absent on 5.6 and " +
        "the check simply costs a false — kept so this file stays identical across engine branches.",
    ).toContain(`IsModuleAvailable(TEXT("MassCore"))`);
  });

  it("does not report engine modules under the availablePlugins key", () => {
    // Reported separately as availableModules. A name listed under "plugins" sends the reader to the
    // plugin browser to enable something that cannot be enabled and does not need to be.
    const availableBlock = handlersCpp.slice(
      handlersCpp.indexOf("TSharedRef<FJsonObject> Available ="),
      handlersCpp.indexOf('Result->SetObjectField(TEXT("availablePlugins"), Available);'),
    );
    expect(availableBlock.length).toBeGreaterThan(0);
    expect(availableBlock).not.toContain("MassEntity");
    expect(availableBlock).not.toContain("MassCore");
    expect(handlersCpp).toContain('Result->SetObjectField(TEXT("availableModules"), Modules);');
  });

  it("warns about an untested engine only when the engine is not the one this branch targets", () => {
    // This is the 5.6 branch, so 6. The 5.8 fork carries the identical file with an 8 — that single
    // constant is the ONLY sanctioned divergence, and it is named so nobody syncs it as a stray
    // literal. The 5.8 fork shipped a bare 6 here, warning every correct 5.8 install on every call.
    expect(handlersCpp).toContain("constexpr int32 TargetEngineMinor = 6;");
    expect(handlersCpp).toContain("Version.GetMinor() != TargetEngineMinor");
  });

  it("keeps the explicitly-unsupported flags as unconditional literals", () => {
    // These were suspected of being collateral damage from the massEntity bug. They are not — they
    // are milestone non-goals. If one ever becomes derived, that is a real capability change and
    // this test should be updated deliberately alongside it, not silently.
    for (const flag of [
      "supportsHeroPromotion",
      "supportsMelee",
      "supportsZoneGraphNavigation",
      "supportsStateTreeBehaviour",
    ]) {
      expect(handlersCpp).toContain(`Result->SetBoolField(TEXT("${flag}"), false);`);
    }
  });
});

describe("riot crowd — scenario model guarantees", () => {
  const scenarioCpp = fs.readFileSync(
    path.join(RIOT_ROOT, "Source", "BlueprintMCPRiotCrowd", "Private", "RiotScenario.cpp"),
    "utf-8",
  );

  it("rejects a break threshold that does not exceed the hold threshold", () => {
    // A scenario whose break <= hold breaches the instant any pressure registers, which silently
    // makes "the line held, then broke" impossible to demonstrate.
    expect(scenarioCpp).toContain("BreakThreshold <= B.HoldThreshold");
    expect(scenarioCpp).toContain("InvalidThreshold");
  });

  it("enforces stable ids and rejects duplicates across the whole scenario", () => {
    expect(scenarioCpp).toContain("DuplicateId");
    expect(scenarioCpp).toMatch(/IsValidRiotId/);
  });

  it("preserves the authored definition across a runtime reset", () => {
    // Reset must zero runtime state only — wiping the definition would make re-running the same
    // seed for a determinism comparison impossible.
    const resetBody = scenarioCpp.slice(
      scenarioCpp.indexOf("void FRiotScenario::ResetRuntimeState"),
      scenarioCpp.indexOf("TSharedRef<FJsonObject> FRiotScenario::ToJson"),
    );
    expect(resetBody).toContain("SimulationTime = 0.0");
    expect(resetBody).not.toMatch(/Factions\.(Empty|Reset)\(\)/);
    expect(resetBody).not.toMatch(/Origins\.(Empty|Reset)\(\)/);
    expect(resetBody).not.toMatch(/Blockades\.(Empty|Reset)\(\)/);
  });
});
