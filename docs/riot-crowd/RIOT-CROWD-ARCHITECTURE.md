# Riot Crowd — Architecture

## Why the feature is optional, and why it is a separate plugin

Two measured engine constraints, not preferences, produced this shape. Both are recorded with
evidence in [UE56-MASS-API-FINDINGS.md](UE56-MASS-API-FINDINGS.md) §3 and §9.

1. **A nested plugin is never discovered.** `FPluginManager::FindPluginsInDirectory`
   (`PluginManager.cpp:1163-1167`) discards a directory's sub-directories the moment it finds a
   `.uplugin` there. This repository's root *is* a plugin, so `RiotCrowd/` is inert while it sits
   inside it.
2. **A single module cannot be conditionally Mass-linked.** UHT rejects reflected types inside any
   preprocessor block except `WITH_EDITORONLY_DATA`. Mass fragments must be `USTRUCT`s and
   processors must be `UCLASS`es, so `#if WITH_RIOT_MASS` around them is a hard build error. The
   Mass link is all-or-nothing per module.

Together those rule out both of the obvious designs — a nested sibling plugin, and a second
Mass-optional module inside `BlueprintMCP.uplugin`. What remains is a genuinely separate plugin that
the user installs deliberately.

**The opt-in is the install step.** Users who only want the 241 core Blueprint tools never enable
MassGameplay, which is the requirement that drove all of this.

## Core-plugin boundary

```
<Project>/Plugins/
├── BlueprintMCP/               core, 241 tools, ZERO Mass dependencies
│   └── RiotCrowd/              staged here, inert (never scanned)
└── BlueprintMCPRiotCrowd/      copied here to activate
```

Core changes for this milestone are confined to one extension seam:

| Symbol | Purpose |
|--------|---------|
| `FBlueprintMCPServer::FExternalEndpoint` | Route, dispatch key, handler, mutation flag, verb |
| `RegisterExternalEndpoint()` | Called from a contributing module's `StartupModule()` |
| `GetExternalEndpoints()` | Read by `Start()` and `RegisterHandlers()` |
| `HaveExternalEndpointsBeenBound()` | Detects too-late registration |

Only those three statics carry `BLUEPRINTMCP_API`. The class is otherwise module-internal, and
exporting all of it would drag every editor-only handler signature into the export table.

Guarantees the seam enforces:

- External endpoints are dispatched through the **same** `QueuedHandler` path as built-ins, so they
  inherit HTTP-thread queueing, game-thread execution, and undo-transaction wrapping. Copying that
  machinery into a second plugin is how you end up with two subtly different request lifecycles.
- Externals are added to `HandlerMap` **last** and refuse to overwrite a built-in key. An optional
  plugin can never shadow a core tool.
- Duplicate routes or keys are rejected with an error log.
- Registering after `Start()` logs a loud warning, because the endpoint would silently 404.

## Module dependency graph

```
BlueprintMCPRiotCrowd (Editor)
├── BlueprintMCP            (the seam)
├── MassEntity              ENGINE Runtime module, not a plugin module
├── MassCommon, MassMovement, MassRepresentation,
│   MassSpawner, MassSimulation   (from the MassGameplay plugin)
├── UnrealEd, EditorSubsystem, Projects
└── Core, CoreUObject, Engine, Json, JsonUtilities
```

The `MassEntity` **plugin** is deliberately *not* enabled: it is a content-only shell and UBT warns
that it "was deprecated in 5.5 and will soon be removed". Naming the module is correct and
sufficient. Confirmed live — `riot_get_capabilities` reports `massEntity: false` while
`massGameplay: true`, and the simulation runs.

## Request flow

```
MCP client
  → riot_* tool (Tools/src/tools/riot-crowd.ts)
    → HTTP POST/GET /api/riot-*            [404 ⇒ RIOT_FEATURE_NOT_INSTALLED]
      → core router (HTTP thread) → RequestQueue
        → ProcessOneRequest (GAME THREAD)
          → FRiotCrowdHandlers::Handle*
            → FRiotScenarioStore   (editor-side, authoring)
            → URiotCrowdSubsystem  (PIE world, runtime)
              → FMassEntityManager
```

## Game-thread execution rules

Every riot handler runs on the game thread, because the core queues requests off the HTTP thread and
dispatches them from `ProcessOneRequest`. That is what makes it safe for handlers to touch
`GEditor->PlayWorld`, the Mass entity manager, and actor spawning directly. **No riot code may be
called from any other thread.**

## Scenario storage

Scenario definitions live in `FRiotScenarioStore`, a process-wide singleton of plain C++ structs —
**not** a UObject and **not** world-scoped.

A `UWorldSubsystem` would be destroyed on PIE end and take every authored scenario with it, which
would make "reset, then re-run the same seed and compare" impossible. Authoring happens before PIE
starts; the runtime lives inside it.

The consequence, and a real limitation: **scenarios do not persist across an editor restart.** They
are in-process only. Re-author, or drive authoring from a script.

## Runtime lifecycle

```
unconfigured → configured → spawned → running ⇄ paused → completed
                                ↑                          │
                                └────────── reset ←─────────┘
                                        (or failed)
```

`running` is only reported once runtime state confirms it. `reset` is only reported once entity
counts read back as zero — the handler downgrades itself to `success: false` +
`RIOT_RESET_FAILED` if any agent survives.

## Reset strategy

Reset destroys only what the subsystem created: it tracks its own `OwnedRioters` / `OwnedDefenders`
handles and its visualizer actor, and touches nothing else in the world. It is idempotent by
construction — an unspawned reset is a success, not an error, because a correct cleanup script must
not look like it failed on the second call.

Reset clears runtime state only. The authored definition, including the seed, is preserved.

## Determinism approach

- One `FRandomStream(Seed)`, consumed in a **fixed order**: origins in array order, then agents in
  index order, then blockades. The fixed consumption order is what reproduces a run — not the seed
  alone.
- Per-agent jitter is stored as `SeedSalt` at spawn rather than recomputed, so it stays stable
  across frames and across re-runs even if entity allocation order shifts.
- Panic selection uses a **stable index stride**, not a random draw. A draw would break run-to-run
  comparison even with a fixed seed, because by that point the number of RNG consumers depends on
  frame timing.
- Breach tie-breaking falls back to array order, which is stable.

Measured tolerance over three consecutive seeded runs: counts **identical**, breach time within
**0.01 s (0.05 %)**, peak pressure within **0.22 units (0.23 %)**. Per-frame float identity is not
claimed and is not required.

## Pressure model

Fully exposed in every runtime report, together with its formula:

```
attackersPerDefender = pressingAgents / max(1, defenderCount)
target  = attackersPerDefender * PressureGain * (1 + SustainBonusPerSecond * avgPressingTime)
current → target at RiseRatePerSecond, decaying at DecayRatePerSecond when nobody presses
```

| Tunable | Default | Meaning |
|---------|---------|---------|
| `PressureGain` | 25 | Pressure per attacker-per-defender |
| `SustainBonusPerSecond` | 0.15 | Extra fraction per second of sustained pressing |
| `DecayRatePerSecond` | 20 | Shed per second when unpressed |
| `RiseRatePerSecond` | 60 | How fast current chases target |
| `ContactBand` | 250 | Distance counting as "pressing" |
| `MaxPressure` | 500 | Hard ceiling |

No constant in the model is hidden; an operator can recompute any reported figure by hand.

## UE 5.6 state representation

Agent state is a **single enum field inside one fragment**, deliberately not a set of Mass tags.

Tags are archetype-defining: flipping one migrates the entity to a different archetype. Riot agents
change state in bursts — a whole crowd goes Advancing → Blocked on contact, then Blocked →
Breaching the instant a segment breaks. Tags would migrate hundreds of entities within a frame or
two, the classic archetype-churn pathology.

The tradeoff: queries cannot filter on state at the archetype level, so processors read all agents
and branch per entity. At this scale the branch is far cheaper than the migrations it avoids. If
counts ever reach a scale where the branch dominates, the fix is a few coarse, rarely-flipped tags
layered *on top* of the field, not replacing it.

UE 5.8's sparse fragments would change this calculus. We are on 5.6 and do not emulate them.

## Where the simulation runs, and why the split

- **Per-agent motion** runs in `URiotCrowdSteeringProcessor`, a real `UMassProcessor`.
- **Orchestration** (spawn release, pressure, triggers, state transitions) runs in
  `URiotCrowdSubsystem::Tick`.

Orchestration needs to be pausable, inspectable and deterministically ordered, all awkward to
guarantee across independently-scheduled processors. Motion is a pure per-entity transform and
belongs in a processor.

The subsystem is gated to game worlds via `ShouldCreateSubsystem`. Creating it in an editor world
would accept spawns and then never advance — the worst failure shape, because it looks successful.

## Representation

A plain `UInstancedStaticMeshComponent` pair on a transient actor, driven from entity transforms,
using engine `BasicShapes` (cylinders for rioters, cubes for defenders). No third-party assets, no
production art, nothing to pre-author into a level.

`MassRepresentation` is linked and available but **unused** — its LOD/visualisation traits need
entity-config assets, which is a larger authoring surface than this foundation needs. Recorded as
available-but-unused rather than implied-working.

Instances are rebuilt wholesale each tick rather than diffed: counts change every frame as agents
are released and deactivated, and `AddInstance`/`RemoveInstance` shuffles indices, so index-based
updates drift out of sync within a few frames.

## Expected UE 5.8 compatibility seam

Nothing 5.8-specific is present, and no untested cross-version macros were added. The seams that
would absorb a 5.8 backend:

- `ERiotAgentState` as a field is the piece 5.8 sparse fragments would replace.
- The processor/subsystem split isolates API churn to `RiotCrowdSteeringProcessor`.
- `FRiotScenario` is engine-agnostic and would port unchanged.

## Known experimental dependencies

MassGameplay and its modules are experimental in 5.6. That risk is confined to users who opt in.

## Security implications

- No arbitrary code execution is added. There is no riot Python or C++ eval tool; every operation is
  a typed, validated endpoint.
- No filesystem writes outside engine-standard screenshot output.
- Handlers only touch `GEditor->PlayWorld`, never arbitrary project paths.
- The seam cannot be used to shadow or override a core endpoint.

## Failure recovery

- Validation runs on a **copy**; a rejected call leaves no partial state. Verified live: six
  consecutive rejections left the scenario byte-identical.
- A failed spawn leaves diagnostic state intact rather than half-resetting.
- Counts are always read back off live entities rather than echoed from the request, so a mismatch
  surfaces as an explicit warning.
- Reset is idempotent and safe to call after a crash or a PIE teardown.
