# UE 5.6.1 Mass / Crowd API Findings

Investigation gate for the Riot Crowd foundation milestone. Nothing in this document is inferred
from tutorials, release notes, or memory of other engine versions unless explicitly labelled as
such.

## Evidence tiers

Every claim below carries one of:

| Tier | Meaning |
|------|---------|
| **PROVEN-SOURCE** | Read directly out of the installed UE 5.6.1 tree on this machine |
| **PROVEN-BUILD** | Confirmed by an actual UBT/UHT compile+link against UE 5.6.1 |
| **PROVEN-LIVE** | Observed at runtime in a live editor/PIE session |
| **DOCUMENTED** | Official UE 5.6 documentation only |
| **INFERRED** | Strong reasoning from source read, but the specific behaviour was not executed |
| **UNTESTED** | Stated for completeness; no evidence gathered yet |
| **UNSUPPORTED** | Confirmed unavailable |

At the time of writing, **no PROVEN-LIVE claims exist in this document.** Everything is
PROVEN-BUILD or weaker. The live tier gets filled in by the acceptance run, not by this gate.

## Environment

| Item | Value | Tier |
|------|-------|------|
| Engine | UE **5.6.1**, CL 44394996, CompatibleCL 43139311, `++UE5+Release-5.6`, promoted build | PROVEN-SOURCE (`Engine/Build/Build.version`) |
| Install type | Binary (launcher) install, `C:\Program Files\Epic Games\UE_5.6` | PROVEN-SOURCE |
| Node | v24.13.1 | PROVEN-SOURCE |
| npm | 11.8.0 | PROVEN-SOURCE |
| Other engines present | 5.3, 5.5, 5.7, 5.8 | PROVEN-SOURCE |

Note: UE 5.8 is installed on this machine. It is explicitly **out of scope** for this milestone and
no 5.8 code path is being added.

---

## 1. MassEntity is an engine Runtime module in 5.6, not a plugin module

This is the single most load-bearing finding and it contradicts how MassEntity is usually described.

`Engine/Plugins/Runtime/MassEntity/` contains **only** `Content/`, `Resources/` and
`MassEntity.uplugin`. There is **no `Source/` directory.** — PROVEN-SOURCE

The actual code lives at `Engine/Source/Runtime/MassEntity/`, with `Public/` carrying 42 headers
including `MassEntityManager.h`, `MassEntitySubsystem.h`, `MassEntityQuery.h`, `MassProcessor.h`,
`MassExecutionContext.h`, `MassObserverProcessor.h`, `MassCommandBuffer.h`. — PROVEN-SOURCE

**Consequence:** the `MassEntity` *module* is linkable from a Build.cs without the MassEntity
*plugin* contributing any code. The plugin is a content/enable shell. A naive assumption that
"no Source directory means Mass is unavailable in a binary install" is wrong, and the opposite
assumption ("adding the module name is enough, no plugin needed") needs live confirmation before
being relied on — the subsystems and settings objects may still require the plugin to be enabled.

`MassEntity.Build.cs` public dependencies: `Core`, `CoreUObject`, `Engine`, `DeveloperSettings`,
`TraceLog`. It adds `UnrealEd` + `EditorSubsystem` privately under
`Target.bBuildEditor || Target.bCompileAgainstEditor`. — PROVEN-SOURCE

## 2. Plugin availability and default-enabled state

All crowd-relevant plugins ship with this binary install. **Every one of them is
`EnabledByDefault: false`.** — PROVEN-SOURCE

| Plugin | Path | EnabledByDefault | Modules |
|--------|------|------------------|---------|
| MassEntity | `Runtime/MassEntity` | false | *(none — shell, see §1)* |
| MassGameplay | `Runtime/MassGameplay` | false | MassActors, MassCommon, MassEQS, MassGameplayDebug, MassGameplayEditor, MassGameplayExternalTraits, MassGameplayTestSuite, MassLOD, MassMovement, MassMovementEditor, MassReplication, MassRepresentation, MassSignals, MassSimulation, MassSmartObjects, MassSpawner |
| MassAI | `AI/MassAI` | false | MassAIBehavior, MassAIBehaviorEditor, MassAIDebug, MassAIReplication, MassNavigation, MassNavigationEditor, MassNavMeshNavigation, MassZoneGraphNavigation, MassAITestSuite |
| MassCrowd | `AI/MassCrowd` | false | MassCrowd |
| ZoneGraph | `Runtime/ZoneGraph` | false | ZoneGraph, ZoneGraphDebug, ZoneGraphEditor, ZoneGraphTestSuite |
| ZoneGraphAnnotations | `Runtime/ZoneGraphAnnotations` | false | ZoneGraphAnnotations |
| StateTree | `Runtime/StateTree` | false | StateTreeModule, StateTreeEditorModule, StateTreeTestSuite |
| GameplayStateTree | `Runtime/GameplayStateTree` | false | — |
| SmartObjects | `Runtime/SmartObjects` | false | — |
| MassInsights | `MassInsights` | **true** | — |

**Consequence:** the Riot Crowd feature cannot assume any Mass plugin is on. Capability detection is
mandatory, not decorative, and `riot_get_capabilities` has real work to do.

### Incidental defect worth knowing about

`ZoneGraphAnnotations.uplugin` contains a **trailing comma** in its `Modules` array, which makes it
invalid strict JSON. PowerShell's `ConvertFrom-Json` rejects it; UE's own tolerant parser accepts it.
— PROVEN-SOURCE

Any code we write that enumerates `.uplugin` files to report availability must use a tolerant parse
or handle the throw, or capability detection will crash on a stock engine install. This is a real
trap, not a hypothetical.

## 3. Nested plugins are undiscoverable — this forces the architecture

`FPluginManager::FindPluginsInDirectory`
(`Engine/Source/Runtime/Projects/Private/PluginManager.cpp:1091`) uses a custom directory walk
rather than `IterateDirectoryRecursively`. Its own comment states the optimisation explicitly:

> "we know once we find one .uplugin file that there shouldn't be anymore in the same folder
> hierarchy"

and at the visit site (`PluginManager.cpp:1163-1167`):

> "Since we found a .uplugin, ignore sub-directories (stop from iterating deeper) — there shouldn't
> be any other .uplugin files deeper."

The code discards the accumulated sub-directory list when a `.uplugin` is found in that directory.
— PROVEN-SOURCE

**Consequence, and this decides the milestone's architecture:**

This repository *is* a plugin — its root contains `BlueprintMCP.uplugin`, and it is consumed by
cloning into `<Project>/Plugins/BlueprintMCP`. Therefore:

- A nested plugin at `Plugins/BlueprintMCP/RiotCrowd/BlueprintMCPRiotCrowd.uplugin` would **never be
  discovered**, because discovery stops at `Plugins/BlueprintMCP/BlueprintMCP.uplugin`.
- A true sibling plugin would have to live at `Plugins/BlueprintMCPRiotCrowd/` — *outside this
  repository's root*, which a single-repo clone cannot deliver.

The milestone brief anticipated this and instructs: prove the constraint, then choose the narrowest
alternate architecture that preserves optional loading and capability detection.

**Initial conclusion — later overturned:** a second module inside the existing `BlueprintMCP.uplugin`.
That was attempted, built, and **failed**. See §9, which supersedes this. The final architecture is a
separate opt-in sibling plugin staged in this repo at `RiotCrowd/`.

What survives from this section regardless: the sibling plugin **cannot ship pre-installed** by
cloning this repo, because while it sits at `RiotCrowd/` inside the plugin it is never scanned.
Installing it is an explicit copy/junction to `<Project>/Plugins/BlueprintMCPRiotCrowd`.

## 4. UE 5.6 API drift — signatures that changed

Mass churns hard between engine versions. Code written against 5.3/5.4 examples will not compile
here. The following were read out of the installed 5.6.1 headers:

### `UMassProcessor::ConfigureQueries` — PROVEN-SOURCE

```cpp
// MassProcessor.h:196 — the override to implement
virtual void ConfigureQueries(const TSharedRef<FMassEntityManager>& EntityManager);

// MassProcessor.h:309-310 — the OLD signature, now sealed
UE_DEPRECATED(5.6, "This flavor of ConfigureQueries is deprecated. Override
                    ConfigureQueries(const TSharedRef<FMassEntityManager>&) instead.")
virtual void ConfigureQueries() final {};
```

The no-argument form is `final`. Overriding it is a **hard compile error**, not a deprecation
warning. Any 5.3-era processor is guaranteed to fail to build.

### `FMassEntityQuery::ForEachEntityChunk` — PROVEN-SOURCE

```cpp
// MassEntityQuery.h:93 — current
void ForEachEntityChunk(FMassExecutionContext& ExecutionContext,
                        const FMassExecuteFunction& ExecuteFunction);

// MassEntityQuery.h:314-315 — deprecated, takes the now-redundant manager
UE_DEPRECATED(5.6, "ForEachEntityChunk is deprecated. New version doesn't require the
                    FMassEntityManager parameter")
void ForEachEntityChunk(FMassEntityManager&, FMassExecutionContext&, const FMassExecuteFunction&);
```

Same removal of the `FMassEntityManager&` first parameter applies to
`ForEachEntityChunkInCollections`, `ParallelForEachEntityChunk` (whose `ParallelMode` parameter also
changed type to `EParallelExecutionFlags`), and
`ParallelForEachEntityChunkInCollection`. — PROVEN-SOURCE

### `UMassProcessor::Initialize` — PROVEN-SOURCE

```cpp
// MassProcessor.h:307-308
UE_DEPRECATED(5.6, "Initialize is deprecated. Override InitializeInternal(UObject&,
                    const TSharedRef<FMassEntityManager>&) instead. If you want to call the
                    function, use CallInitialize.")
virtual void Initialize(UObject& Owner) final;
```

Also `final`. Override `InitializeInternal` instead.

### Entity manager access — PROVEN-SOURCE

```cpp
// MassEntitySubsystem.h:35-36
const FMassEntityManager& GetEntityManager() const;
FMassEntityManager&       GetMutableEntityManager();
```

## 5. Where Mass actually executes

`UMassSimulationSubsystem` (`MassGameplay/Source/MassSimulation`) is the phase driver.

- Under `#if WITH_EDITOR`, when `GEditor` is valid and the world is **not** a game world, it calls
  `RebuildTickPipeline()` and registers `FEditorDelegates::BeginPIE` / `PrePIEEnded` handlers
  (`MassSimulationSubsystem.cpp:104-112`). So the subsystem *is* created for editor worlds, but its
  role there is to react to PIE starting and stopping. — PROVEN-SOURCE
- The cvar handler for `mass.SimulationTickingEnabled` walks `GEngine->GetWorldContexts()` and
  filters with the comment "we only want to affect game worlds"
  (`MassSimulationSubsystem.cpp:153-159`). — PROVEN-SOURCE

**Conclusion — INFERRED, not proven:** riot processors will execute in a **game world (PIE)** and not
in the editor world. I read the gating fragments, not the whole execution path, so I am explicitly
*not* claiming "Mass never ticks in an editor world" as proven. The acceptance run must confirm it by
live probe before any doc states it as fact.

**Consequence:** the riot simulation is a PIE-scoped feature. MCP handlers run in the editor process
and must reach the simulation through `GEditor->PlayWorld`.

The repository already has exactly this pattern —
`BlueprintMCPHandlers_PIERuntime.cpp:18-33` `GetPIEWorld()` returns `GEditor->PlayWorld` or the
error `"PIE is not running. Use start_pie first."`. The riot handlers will reuse this shape rather
than invent a new one. — PROVEN-SOURCE

## 6. Available building blocks, by module

All PROVEN-SOURCE (header inventory), none exercised yet.

| Need | Module | Relevant headers |
|------|--------|------------------|
| ECS core, fragments, queries, processors, observers, command buffer | `MassEntity` *(engine Runtime module)* | `MassEntityManager.h`, `MassEntityQuery.h`, `MassProcessor.h`, `MassObserverProcessor.h`, `MassCommandBuffer.h`, `MassExecutionContext.h`, `MassEntityBuilder.h` |
| Transform / common fragments | `MassCommon` | `MassCommonFragments.h`, `RandomSequence.h` |
| Velocity, force, movement params | `MassMovement` | `MassMovementFragments.h`, `MassMovementTrait.h`, `MassSimpleMovementTrait.h`, `MassVelocityRandomizerTrait.h` |
| ISM-based rendering of many agents | `MassRepresentation` | `MassVisualizationTrait.h`, `MassRepresentationSubsystem.h`, `MassUpdateISMProcessor.h`, `MassVisualizationComponent.h` |
| Spawning from entity configs | `MassSpawner` | `MassSpawner.h`, `MassEntityConfigAsset.h`, `MassEntityTemplateRegistry.h`, `MassEntityTraitBase.h` |
| Phase driving / pause | `MassSimulation` | `MassSimulationSubsystem.h` |
| LOD | `MassLOD` | `MassLODTrait.h`, `MassSimulationLOD.h` |
| Lane-based navigation | `ZoneGraph` + `MassZoneGraphNavigation` | — |
| StateTree behaviour | `StateTreeModule` + `MassAIBehavior` | — |

`RandomSequence.h` in `MassCommon` is worth flagging: determinism support appears to exist in-engine
rather than needing to be hand-rolled. Not yet inspected in detail. — UNTESTED

## 7. Scope decision this evidence supports

`MassCrowd` movement is built on **ZoneGraph lanes**, which require authored `ZoneShape` actors and a
built zone graph in the level. Authoring that through MCP into a disposable level is a large,
fragile surface, and `MassAI` StateTree behaviour adds asset authoring on top.

The foundation therefore targets:

- **In scope:** `MassEntity` + `MassCommon` + `MassMovement` + `MassRepresentation` + `MassSpawner`
  + `MassSimulation`, with custom processors for steering, pressure accumulation, breach and panic.
- **Deferred, with seams left:** `MassCrowd`, `ZoneGraph`, `MassZoneGraphNavigation`, `StateTree`,
  `SmartObjects`.

This is a deliberate narrowing of dependencies, not an inability to use them. It is recorded here so
the capability matrix can report ZoneGraph/StateTree honestly as *available but unused* rather than
implying they are wired in.

## 9. UHT forbids reflected types inside preprocessor blocks — this killed the second-module design

The first architecture attempt was a second module (`BlueprintMCPRiotCrowd`) inside
`BlueprintMCP.uplugin`, with Mass made optional by a `WITH_RIOT_MASS` define: `Build.cs` would
detect whether the host `.uproject` enabled MassGameplay, add the Mass modules only then, and guard
all Mass-touching code with `#if WITH_RIOT_MASS`.

**UBT accepted this. UHT rejected it outright.** — PROVEN-BUILD

```
RiotCrowdFragments.h(20): Error: 'USTRUCT' must not be inside preprocessor blocks,
                                 except for WITH_EDITORONLY_DATA
RiotCrowdFragments.h(26): Error: 'UPROPERTY' must not be inside preprocessor blocks, ...
RiotCrowdSteeringProcessor.h(19): Error: 'UCLASS' must not be inside preprocessor blocks, ...
Result: Failed (OtherCompilationError)
```

`WITH_EDITORONLY_DATA` is the *only* permitted conditional. Since Mass fragments **must** be
`USTRUCT`s deriving `FMassFragment` and processors **must** be `UCLASS`es deriving `UMassProcessor`,
there is no way to conditionally reflect them.

**Therefore: the Mass link is all-or-nothing per module.** A single module cannot be "Mass-optional".
Optionality has to live at the plugin boundary, which is what forced the final architecture.

Two secondary findings from the same build:

- The missing-plugin-dependency complaint is only a **warning**, not an error
  (`"Plugin 'BlueprintMCP' does not list plugin 'MassGameplay' as a dependency, but module
  'BlueprintMCPRiotCrowd' depends on module 'MassCommon'"`). So the conditional-Build.cs technique is
  viable at the UBT layer — it is purely UHT that blocks it. Worth remembering for any future
  non-reflected optional dependency. — PROVEN-BUILD
- **Do not enable the `MassEntity` plugin.** UBT emits: `"Project 'UnrealEditor' depends on plugin
  'MassEntity' which was deprecated in 5.5 and will soon be removed."` Naming the `MassEntity`
  *module* in `PrivateDependencyModuleNames` is correct and sufficient, because it is an engine
  Runtime module (§1). Enabling the deprecated shell plugin buys nothing and will break on a future
  engine. — PROVEN-BUILD

## 10. The final architecture builds

`RiotCrowd/` is a complete, standalone plugin (`BlueprintMCPRiotCrowd.uplugin` + `Source/`) whose
descriptor depends on `BlueprintMCP` and `MassGameplay`. Verified by junctioning both plugins as
siblings into a disposable build host and building the editor target:

```
[610/784] Compile [x64] BlueprintMCPRiotCrowdModule.cpp
[617/784] Compile [x64] Module.BlueprintMCPRiotCrowd.cpp
[620/784] Link    [x64] UnrealEditor-BlueprintMCPRiotCrowd.lib
[628/784] Link    [x64] UnrealEditor-BlueprintMCPRiotCrowd.dll
Result: Succeeded
Total execution time: 307.12 seconds
```

— PROVEN-BUILD

This compile is what upgrades §4's signature claims from "read in a header" to "actually compiles":
`ConfigureQueries(const TSharedRef<FMassEntityManager>&)`, the two-argument
`ForEachEntityChunk(FMassExecutionContext&, ...)`, `FMassEntityQuery(UMassProcessor&)` construction,
`FMassFragment`-derived `USTRUCT`s, and `FTransformFragment` / `FMassVelocityFragment` fragment views
all built and linked together in `URiotCrowdSteeringProcessor`.

**It does not prove the processor ever runs, or produces correct motion.** Compiling is not
executing. That remains UNTESTED until the live run.

## 11. Open questions the live run must answer

These are **UNTESTED** and must not be asserted anywhere until the acceptance run settles them:

1. Does enabling the `MassEntity` plugin change anything, given the module is engine-side? Or is
   `MassGameplay` the only plugin that must be on?
2. Do custom `UMassProcessor` subclasses auto-register into the tick pipeline in a PIE world, and at
   which processing phase?
3. Does `RandomSequence.h` give reproducible spawn ordering across runs with a fixed seed?
4. Does `MassRepresentation` ISM rendering work without a `MassVisualizer` actor pre-placed in the
   level?
5. Is entity count observable cheaply enough to poll from an HTTP handler each frame?
6. Confirm (5) — that processors genuinely do not tick in the editor world.

---

*Gate recorded before implementation, per milestone §5. Live tiers to be filled in by the acceptance
run; this document is expected to be revised, and revisions must preserve the tier labels.*
