import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// CLAUDE-NOTE: static invariants, for the same reason as riot-crowd.test.ts — the Riot Crowd plugin
// is an opt-in sibling that the generated test project does not install, and the representation
// system only does anything inside PIE, which a -nullrhi commandlet does not have. A "live" test
// here would assert against a mock, and the milestone is explicit that a passing mock is not a live
// proof.
//
// What these DO catch is the class of wiring failure this repo has actually shipped: a tool defined
// but never routed, a route called but never bound, an error code referenced in TypeScript that no
// longer exists in C++, and a baseline manifest drifting away from the source it is supposed to
// audit. Live proof of the representation behaviour is a manual editor procedure recorded in the
// milestone test record.

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SRC_DIR = path.resolve(PLUGIN_ROOT, "Tools", "src");
const RIOT_SRC = path.resolve(PLUGIN_ROOT, "RiotCrowd", "Source", "BlueprintMCPRiotCrowd");

const read = (...p: string[]) => fs.readFileSync(path.resolve(...p), "utf-8");

const riotToolSrc = read(SRC_DIR, "tools", "riot-crowd.ts");
const registrationCpp = read(RIOT_SRC, "Private", "RiotCrowdRegistration.cpp");
const handlersHeader = read(RIOT_SRC, "Public", "RiotCrowdHandlers.h");
const characterHandlersCpp = read(RIOT_SRC, "Private", "RiotCharacterHandlers.cpp");
const errorCodesH = read(RIOT_SRC, "Public", "RiotErrorCodes.h");
const profileH = read(RIOT_SRC, "Public", "RiotCharacterProfile.h");
const profileCpp = read(RIOT_SRC, "Private", "RiotCharacterProfile.cpp");
const representationH = read(RIOT_SRC, "Public", "RiotRepresentation.h");
const coreBuildCs = read(PLUGIN_ROOT, "Source", "BlueprintMCP", "BlueprintMCP.Build.cs");
const baseline = JSON.parse(read(PLUGIN_ROOT, "Tools", "test", "manual", "tool-baseline.json"));

/** The 11 tools this milestone adds. Renaming one is a breaking change to the public vocabulary. */
const NEW_TOOLS = [
  "riot_register_character_profile",
  "riot_update_character_profile",
  "riot_delete_character_profile",
  "riot_list_character_profiles",
  "riot_get_character_profile",
  "riot_validate_character_profile",
  "riot_assign_character_profiles",
  "riot_set_representation_profile",
  "riot_get_representation_report",
  "riot_promote_agents",
  "riot_demote_agents",
];

describe("riot character profile + representation tools: registration", () => {
  it.each(NEW_TOOLS)("%s is defined in the TypeScript layer", (tool) => {
    expect(riotToolSrc).toContain(`"${tool}"`);
  });

  it("every riot endpoint the TS layer calls is bound in C++", () => {
    const called = new Set<string>();
    for (const m of riotToolSrc.matchAll(/["'`](\/api\/riot-[a-z-]+)["'`]/g)) {
      called.add(m[1]);
    }
    expect(called.size).toBeGreaterThan(20);

    const bound = new Set<string>();
    for (const m of registrationCpp.matchAll(/TEXT\("(\/api\/riot-[a-z-]+)"\)/g)) {
      bound.add(m[1]);
    }

    const unbound = [...called].filter((r) => !bound.has(r));
    expect(unbound, `TS calls routes with no C++ binding: ${unbound.join(", ")}`).toEqual([]);
  });

  it("every riot route bound in C++ is reachable from a tool", () => {
    const bound = new Set<string>();
    for (const m of registrationCpp.matchAll(/TEXT\("(\/api\/riot-[a-z-]+)"\)/g)) {
      bound.add(m[1]);
    }
    const orphans = [...bound].filter((r) => !riotToolSrc.includes(r));
    // CLAUDE-NOTE: this direction is the one that actually bit this repo — ~75 core tools once
    // 404'd for two months because routes existed with nothing calling them, and nothing checked.
    expect(orphans, `C++ routes no tool ever calls: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every declared handler has a definition", () => {
    const declared = [...handlersHeader.matchAll(/static FString (Handle\w+)\(/g)].map((m) => m[1]);
    const characterHandlers = declared.filter((h) =>
      /CharacterProfile|RepresentationProfile|RepresentationReport|PromoteAgents|DemoteAgents/.test(h),
    );
    expect(characterHandlers.length).toBe(11);
    for (const handler of characterHandlers) {
      expect(
        characterHandlersCpp,
        `${handler} is declared but not defined in RiotCharacterHandlers.cpp`,
      ).toContain(`FRiotCrowdHandlers::${handler}`);
    }
  });
});

describe("riot character profile tools: audited baseline", () => {
  it("the baseline's riot tool list matches the tools in source, exactly", () => {
    const inSource = new Set<string>();
    for (const m of riotToolSrc.matchAll(/["'](riot_[a-z_]+)["']/g)) {
      inSource.add(m[1]);
    }
    const inBaseline = new Set<string>(baseline.riotTools);

    const missing = [...inSource].filter((t) => !inBaseline.has(t)).sort();
    const extra = [...inBaseline].filter((t) => !inSource.has(t)).sort();

    expect(missing, `in source but not audited: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `audited but no longer in source: ${extra.join(", ")}`).toEqual([]);
  });

  it("baseline counts are self-consistent", () => {
    expect(baseline.riotTools.length).toBe(baseline.provenance.riotToolCount);
    expect(baseline.coreTools.length).toBe(baseline.provenance.coreToolCount);
    expect(baseline.provenance.expectedTotal).toBe(
      baseline.coreTools.length + baseline.riotTools.length,
    );
  });

  it("the core surface is exactly the audited 241 plus the owner-approved capture_view", () => {
    // CLAUDE-NOTE: the single most important assertion in this file. The whole architecture rests on
    // Riot Crowd being optional and additive; a core tool appearing or disappearing here means an
    // optional plugin changed the surface every user sees. capture_view is the one sanctioned
    // exception: the owner explicitly ordered camera features into core mid-milestone ("make the
    // camera features for the Unreal MCP Ultra first"), and the baseline provenance records it.
    expect(baseline.coreTools.length).toBe(242);
    expect(baseline.coreTools).toContain("capture_view");
    expect(baseline.provenance.coreToolsSourceCommit).toBeTruthy();
    expect(baseline.coreTools.some((t: string) => t.startsWith("riot_"))).toBe(false);
  });
});

describe("riot character profile tools: structured errors", () => {
  /** Every code the milestone brief names. A missing one means an error path cannot be reported. */
  const REQUIRED_CODES = [
    "RIOT_CHARACTER_PROFILE_NOT_FOUND",
    "RIOT_CHARACTER_PROFILE_ALREADY_EXISTS",
    "RIOT_CHARACTER_PROFILE_IN_USE",
    "RIOT_INVALID_SKELETAL_MESH",
    "RIOT_INVALID_SKELETON",
    "RIOT_INVALID_ANIMATION_ASSET",
    "RIOT_SKELETON_MISMATCH",
    "RIOT_ANIMATION_MAPPING_INCOMPLETE",
    "RIOT_ANIM_BLUEPRINT_INVALID",
    "RIOT_REPRESENTATION_PROFILE_NOT_FOUND",
    "RIOT_REPRESENTATION_BUDGET_EXCEEDED",
    "RIOT_PROMOTION_FAILED",
    "RIOT_DEMOTION_FAILED",
    "RIOT_DUPLICATE_REPRESENTATION",
    "RIOT_REPRESENTATION_READBACK_MISMATCH",
    "RIOT_ASSET_LOAD_FAILED",
  ];

  it.each(REQUIRED_CODES)("%s is declared", (code) => {
    expect(errorCodesH).toContain(code);
  });

  it("every error the handlers return states whether it partially mutated", () => {
    // CLAUDE-NOTE: MakeDetailedError takes bPartialMutation with NO default precisely so this is
    // checkable. "Did this leave half a profile behind?" is the one question an operator cannot
    // answer from outside, so every call site must answer it explicitly.
    // `return MakeDetailedError(...)` matches call sites only — the bare form would also match the
    // function's own definition, whose signature names the parameter without passing it.
    const calls = [...characterHandlersCpp.matchAll(/return MakeDetailedError\(([\s\S]{0,500}?)\);/g)];
    expect(calls.length).toBeGreaterThan(10);
    for (const [full] of calls) {
      expect(full, `a MakeDetailedError call omits the partial-mutation answer:\n${full}`).toMatch(
        /\/\*bPartialMutation=\*\/(true|false)/,
      );
    }
  });
});

describe("riot animation slot model", () => {
  const SLOTS = [
    "Idle", "Gathering", "Advancing", "Pressuring", "Breaching", "Panicked", "Retreating",
    "Holding", "Bracing", "Fallback", "Broken", "Inactive",
  ];

  it("declares all twelve slots", () => {
    for (const slot of SLOTS) {
      expect(profileH).toContain(`\t${slot},`);
    }
  });

  it("every slot has a string form", () => {
    for (const slot of SLOTS) {
      expect(profileCpp).toContain(`ERiotAnimationSlot::${slot}:`);
    }
  });

  it("the TS enum offers exactly the twelve slots the C++ model declares", () => {
    // A slot the tool schema accepts but C++ cannot parse is rejected at runtime with a confusing
    // error; a slot C++ supports but the schema forbids is simply unreachable.
    const tsSlots = new Set<string>();
    for (const m of riotToolSrc.matchAll(
      /"(idle|gathering|advancing|pressuring|breaching|panicked|retreating|holding|bracing|fallback|broken|inactive)"/g,
    )) {
      tsSlots.add(m[1]);
    }
    expect([...tsSlots].sort()).toEqual(SLOTS.map((s) => s.toLowerCase()).sort());
  });

  it("every agent state is mapped for both rioters and defenders", () => {
    const AGENT_STATES = [
      "Queued", "Advancing", "Blocked", "Pressuring", "Breaching",
      "PassedBlockade", "Panicked", "Retreating", "Inactive",
    ];
    const fn = profileCpp.slice(
      profileCpp.indexOf("ERiotAnimationSlot RiotAnimationSlotForState"),
      profileCpp.indexOf("ERiotAnimationSlot RiotAnimationSlotFallback"),
    );
    expect(fn.length).toBeGreaterThan(200);
    for (const state of AGENT_STATES) {
      const occurrences = fn.split(`ERiotAgentState::${state}:`).length - 1;
      // Once in the defender branch, once in the rioter branch.
      expect(occurrences, `${state} is not mapped for both faction families`).toBeGreaterThanOrEqual(2);
    }
  });

  it("the fallback chain terminates at Idle", () => {
    const fn = profileCpp.slice(
      profileCpp.indexOf("ERiotAnimationSlot RiotAnimationSlotFallback"),
      profileCpp.indexOf("const FRiotAnimationBinding* FRiotCharacterProfile::FindBinding"),
    );
    // Idle is the chain root and must return Max, the "nothing further" sentinel.
    expect(fn).toMatch(/case ERiotAnimationSlot::Idle:[\s\S]*?return ERiotAnimationSlot::Max;/);
    // Every other slot must have an outgoing edge.
    for (const slot of SLOTS.filter((s) => s !== "Idle")) {
      expect(fn, `${slot} has no fallback edge`).toContain(`case ERiotAnimationSlot::${slot}:`);
    }
  });

  it("slot resolution is bounded, so a future cyclic edge fails a test instead of hanging", () => {
    const fn = profileCpp.slice(profileCpp.indexOf("bool ResolveRiotAnimationSlot"));
    expect(fn).toMatch(/for \(int32 Step = 0; Step <= static_cast<int32>\(ERiotAnimationSlot::Max\)/);
  });
});

describe("riot representation model", () => {
  it("hysteresis is documented as absolute uu with the engine-percentage mismatch recorded", () => {
    expect(profileH).toContain("HysteresisDistance");
    expect(profileH).toMatch(/ABSOLUTE Unreal units/);
    expect(profileH).toMatch(/BufferHysteresisOnDistancePercentage/);
  });

  it("validation rejects mis-ordered bands, negative budgets and oversized hysteresis", () => {
    expect(profileCpp).toContain("RiotErrorCodes::InvalidRepresentationRange");
    expect(profileCpp).toMatch(/strictly increasing/);
    expect(profileCpp).toMatch(/NarrowestBand \* 0\.5/);
    expect(profileCpp).toMatch(/negative budget/);
  });

  it("selection weight must be strictly positive", () => {
    expect(profileCpp).toContain("RiotErrorCodes::InvalidSelectionWeight");
  });

  it("the far tier's lack of animation is reported rather than implied working", () => {
    // CLAUDE-NOTE: guards the milestone's cardinal rule — never report a capability as working when
    // it is not. If Tier 3 later gains real VAT animation, this test SHOULD fail and be updated.
    const representationCpp = read(RIOT_SRC, "Private", "RiotRepresentation.cpp");
    expect(representationCpp).toMatch(/does NOT animate/i);
    expect(representationCpp).toContain("animatedInstanceCount");
  });

  it("promotion and demotion are documented as idempotent", () => {
    const representationCpp = read(RIOT_SRC, "Private", "RiotRepresentation.cpp");
    expect(representationCpp).toMatch(/Idempotent: promoting an already-promoted agent/);
    expect(representationCpp).toMatch(/Idempotent: demoting an already-demoted agent/);
  });

  it("budget overflow drops a tier instead of deleting entities", () => {
    const representationCpp = read(RIOT_SRC, "Private", "RiotRepresentation.cpp");
    expect(representationCpp).toMatch(/never dropped from the simulation/i);
  });

  it("Mass is never touched while the world is tearing down", () => {
    // CLAUDE-NOTE: guards a real editor crash. UMassEntitySubsystem exposes only asserting accessors
    // (check(EntityManager)) and keeps the member protected, so there is no way to ask whether the
    // manager is still alive. Ending PIE with a crowd still spawned therefore killed the editor with
    // "Assertion failed: EntityManager [MassEntitySubsystem.h] [Line: 36]". The world's teardown flag
    // is the only available signal. Removing either guard reintroduces the crash.
    const subsystemCpp = read(RIOT_SRC, "Private", "RiotCrowdSubsystem.cpp");

    const accessor = subsystemCpp.slice(
      subsystemCpp.indexOf("FMassEntityManager* URiotCrowdSubsystem::GetEntityManager"),
      subsystemCpp.indexOf("bool URiotCrowdSubsystem::SpawnScenario"),
    );
    expect(accessor.length).toBeGreaterThan(100);
    expect(accessor, "GetEntityManager must bail out while the world is tearing down").toContain(
      "bIsTearingDown",
    );
    // The guard has to come before the asserting engine call, not after it.
    expect(accessor.indexOf("bIsTearingDown")).toBeLessThan(
      accessor.indexOf("GetMutableEntityManager"),
    );

    const tick = subsystemCpp.slice(
      subsystemCpp.indexOf("void URiotCrowdSubsystem::Tick"),
      subsystemCpp.indexOf("void URiotCrowdSubsystem::TickSpawning"),
    );
    expect(tick, "Tick must stop as soon as the world begins tearing down").toContain(
      "bIsTearingDown",
    );
  });

  it("the old per-tick ISM rebuild is gone", () => {
    // The specific regression this milestone exists to fix. ClearInstances in the steady-state path
    // would silently restore the 64ms peak.
    const subsystemCpp = read(RIOT_SRC, "Private", "RiotCrowdSubsystem.cpp");
    expect(subsystemCpp).not.toMatch(/ISM->ClearInstances\(\)/);
  });
});

describe("plugin boundary", () => {
  it("the CORE plugin never acquires Mass, animation or AnimToTexture dependencies", () => {
    // CLAUDE-NOTE: the entire optional-sibling architecture rests on this. If the core plugin ever
    // links Mass, every BlueprintMCP user pays for a crowd feature they did not ask for.
    for (const forbidden of ["Mass", "AnimToTexture", "AnimationSharing"]) {
      expect(coreBuildCs, `core Build.cs must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the riot plugin's new module deps stay inside the already-enabled MassGameplay plugin", () => {
    const riotBuildCs = read(RIOT_SRC, "BlueprintMCPRiotCrowd.Build.cs");
    expect(riotBuildCs).toContain('"MassLOD"');
    expect(riotBuildCs).toContain('"MassActors"');
    // AnimToTexture must NOT be linked: the bake is driven through the Python bridge precisely so
    // consumers are not forced to enable an Experimental engine plugin.
    expect(riotBuildCs).not.toContain("AnimToTexture");
  });

  it("the representation manager records why it is bespoke rather than the engine chain", () => {
    expect(representationH).toMatch(/deliberate reversal|NOT the engine's UMassRepresentationProcessor/);
  });
});
