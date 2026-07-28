# UE 5.6.1 — Rigged Representation, Animation and LOD API Findings

Investigation gate for the rigged-character / representation-LOD milestone. Written **before** any
implementation, per the milestone brief §5.

Engine inspected: `C:\Program Files\Epic Games\UE_5.6`, `Engine/Build/Build.version` reports
`5.6.1`, changelist `44394996`, branch `++UE5+Release-5.6`. **Proven by installed source.**

Every conclusion below carries an evidence class:

| Class | Meaning |
|-------|---------|
| **[SOURCE]** | Read directly in the installed 5.6.1 engine source |
| **[COMPILE]** | Proven by compiling against it |
| **[LIVE]** | Proven against a running editor |
| **[DOC]** | Officially documented |
| **[INFER]** | Strong inference from source, not yet executed |
| **[UNTESTED]** | Believed true, no evidence gathered yet |
| **[UNSUPPORTED]** | Proven not available |

At the time of writing, nothing in this document is **[COMPILE]** or **[LIVE]** — this is the
pre-implementation survey. Those classes get filled in by the test record, not here.

---

## 1. Module availability

**[SOURCE]** `Engine/Plugins/Runtime/MassGameplay` ships these Runtime modules:

```
MassActors  MassCommon  MassEQS  MassGameplayDebug  MassGameplayExternalTraits
MassLOD  MassMovement  MassReplication  MassRepresentation  MassSignals
MassSimulation  MassSmartObjects  MassSpawner
```

The foundation already links `MassCommon`, `MassMovement`, `MassRepresentation`, `MassSpawner`,
`MassSimulation`, and engine-Runtime `MassEntity`
(`RiotCrowd/Source/BlueprintMCPRiotCrowd/BlueprintMCPRiotCrowd.Build.cs:48-62`).

**This milestone needs two additions, both inside the already-enabled MassGameplay plugin:**

- `MassLOD` — LOD fragments, the viewer/camera abstraction, the LOD calculator.
- `MassActors` — `FMassActorFragment`, `UMassActorSubsystem`, `UMassActorSpawnerSubsystem`,
  `IMassActorPoolableInterface`.

**[SOURCE]** `MassGameplay.uplugin` sets `"EnabledByDefault": false`, and the foundation's install
step already enables it. Adding these two module names does **not** add a new plugin dependency and
does **not** change the core `BlueprintMCP` plugin. The optional-sibling boundary is preserved.

---

## 2. Representation tiers map onto an existing engine enum

**[SOURCE]** `MassRepresentation/Public/MassRepresentationTypes.h:33-40`

```cpp
enum class EMassRepresentationType : uint8
{
    HighResSpawnedActor,
    LowResSpawnedActor,
    StaticMeshInstance,
    None,
};
```

**[SOURCE]** `MassLOD/Public/MassLODTypes.h:37-47` — `EMassLOD::{High, Medium, Low, Off, Max}`.

**[SOURCE]** `MassRepresentationFragments.h:112-113` — representation is chosen per LOD band by a
plain array, default `{HighResSpawnedActor, LowResSpawnedActor, StaticMeshInstance, None}`:

```cpp
EMassRepresentationType LODRepresentation[EMassLOD::Max] = { ... };
```

**Conclusion [INFER]:** the brief's three tiers are not something we must invent. They are the
engine's own model:

| Brief tier | Engine representation | EMassLOD band |
|-----------|----------------------|---------------|
| Tier 1 near — full skeletal | `HighResSpawnedActor` | High |
| Tier 2 middle — cheap skeletal | `LowResSpawnedActor` | Medium |
| Tier 3 background — animated instances | `StaticMeshInstance` | Low |
| beyond far distance | `None` | Off |

This is the single most important finding in this document: **there is no need for a bespoke tier
state machine.** The work is supplying the right fragments and the right actor classes.

---

## 3. The per-tick ISM rebuild has a direct engine replacement

The foundation's bottleneck is `RiotCrowdSubsystem.cpp:916-924`, which documents *why* it rebuilds
wholesale:

> instance counts change every frame as agents are released and deactivated, and
> `AddInstance`/`RemoveInstance` shuffles indices, so index-based updates drift out of sync with the
> entity list within a few frames. `BatchUpdateInstancesTransforms` cannot change the count, hence
> Clear + Add.

That reasoning is correct **for raw `UInstancedStaticMeshComponent`**. It does not apply to Mass's
own instance layer, because Mass keys instances by entity handle rather than by array index.

**[SOURCE]** `MassRepresentationTypes.h:566-598` — `FMassLODSignificanceRange`:

```cpp
void AddBatchedTransform(const FMassEntityHandle EntityHandle, const FTransform& Transform,
                         const FTransform& PrevTransform, TConstArrayView<FISMCSharedDataKey> ...);
void AddInstance(const FMassEntityHandle EntityHandle, const FTransform& Transform);
void RemoveInstance(const FMassEntityHandle EntityHandle);
```

**[SOURCE]** `MassRepresentationTypes.h:305-308` — the identity map that makes this work:

```cpp
using FEntityToPrimitiveIdMap = Experimental::TRobinHoodHashMap<FMassEntityHandle, FPrimitiveInstanceId>;
```

**[SOURCE]** `MassRepresentationTypes.h:265-286` — updates accumulate into per-frame buffers
(`UpdateInstanceIds`, `StaticMeshInstanceTransforms`, `RemoveInstanceIds`,
`StaticMeshInstanceCustomFloats`) and are flushed in batch; `FMassISMCSharedDataMap` tracks a dirty
bit per ISM component so untouched components are skipped entirely.

**Conclusion [INFER]:** adopting `UMassVisualizationComponent` removes the clear-and-rebuild without
us hand-rolling stable indexing. Entity churn is handled by `RemoveInstance(EntityHandle)`, which is
exactly the case the CLAUDE-NOTE says raw ISM could not express. **This is the intended fix for the
64 ms peak, and it is engine-provided rather than bespoke.**

---

## 4. Entity requirements — no entity-config asset is required

This was the open architectural risk. The foundation creates entities directly through
`FMassEntityManager`, not through `UMassSpawner` + entity config `.uasset`s. Traits like
`UMassVisualizationTrait` are authored on config assets, which would have forced an asset-authoring
pipeline into an otherwise code-and-MCP-driven system.

**It does not.** The engine processors query for *fragments and tags*, not for traits. A trait is
only a convenience that adds those fragments. Composing the same archetype in code is equivalent.

**[SOURCE]** `MassRepresentation/Private/MassRepresentationProcessor.cpp:41-47, 364`
— `UMassVisualizationProcessor` requires:

```
FTransformFragment                       (ReadOnly)   -- foundation already has this
FMassRepresentationFragment              (ReadWrite)
FMassRepresentationLODFragment           (ReadOnly)
FMassActorFragment                       (ReadWrite)  -- MassActors
FMassRepresentationParameters            (const shared)
FMassRepresentationSubsystemSharedFragment (shared)
UMassActorSubsystem                      (subsystem)
FMassVisualizationProcessorTag           (tag, presence All)
```

**[SOURCE]** `MassRepresentation/Private/MassVisualizationLODProcessor.cpp:19-24, 47`
— `UMassVisualizationLODProcessor` requires:

```
FMassVisualizationLODProcessorTag        (tag, presence All)
FMassViewerInfoFragment                  (ReadOnly)
FMassRepresentationLODFragment           (ReadWrite)
FTransformFragment                       (ReadOnly)
FMassVisualizationLODParameters          (const shared)
FMassVisualizationLODSharedFragment      (shared)
UMassLODSubsystem                        (subsystem)
```

**[SOURCE]** `MassLOD/Private/MassLODCollectorProcessor.cpp:23-25, 54`
— `UMassLODCollectorProcessor` fills `FMassViewerInfoFragment` and requires:

```
FMassCollectLODViewerInfoTag             (tag, presence All)
FTransformFragment                       (ReadOnly)
FMassViewerInfoFragment                  (ReadWrite)
```

**[SOURCE]** Tag/fragment declarations:
`MassLOD/Public/MassLODFragments.h:37` (`FMassViewerInfoFragment`), `:103`
(`FMassCollectLODViewerInfoTag`); `MassRepresentationProcessor.h:90`
(`FMassVisualizationProcessorTag`); `MassVisualizationLODProcessor.h:19`
(`FMassVisualizationLODProcessorTag`).

**Conclusion [INFER]:** the riot archetype gains 3 fragments + 3 tags + 2 shared fragments + 2 const
shared fragments, all set at spawn time in C++. **Zero new `.uasset` authoring, zero entity config
assets, and scenario definition stays exactly where it is today** — which also keeps scenario
persistence deferred, as the brief requires.

**[UNTESTED]** Whether the engine's representation processors auto-register and run in our
world without an explicit processor list. Mass processors are auto-discovered via CDO registration
and gated by their queries, so entities simply matching the queries should be picked up. This must
be proven live, and is the first thing to verify once the archetype compiles.

---

## 5. Trait naming — the brief names a deprecated class

**[SOURCE]** `MassRepresentation/Public/MassVisualizationTrait.h:17-19`

```cpp
/** This class has been soft-deprecated. Use MassStationaryVisualizationTrait or MassMovableVisualizationTrait */
UCLASS(MinimalAPI, meta=(DisplayName="DEPRECATED Visualization"))
class UMassVisualizationTrait : public UMassEntityTraitBase
```

The milestone brief §5 and the foundation's own next-phase document both name
`MassVisualizationTrait`. In 5.6 that class is soft-deprecated in favour of
`UMassMovableVisualizationTrait` (**[SOURCE]** `MassMovableVisualizationTrait.h`) and
`UMassStationaryVisualizationTrait`.

Given §4, we are not using a trait at all — we compose fragments directly. Recording this so nobody
later "fixes" our code by reintroducing the deprecated trait. If a trait ever is wanted, the movable
one is correct: riot agents move.

---

## 6. Actor pooling is engine-provided

**[SOURCE]** `MassActors/Public/MassActorSpawnerSubsystem.h:230-232, 279, 296-299`

```cpp
void EnableActorPooling();  void DisableActorPooling();  bool IsActorPoolingEnabled();
virtual bool ReleaseActorToPool(AActor* Actor);
bool bActorPoolingEnabled = true;                                   // on by default
TMap<TSubclassOf<AActor>, TArray<TObjectPtr<AActor>>> PooledActors; // pool is per actor class
```

**[SOURCE]** `MassActors/Public/MassActorPoolableInterface.h` — the contract an actor implements to
be poolable:

```cpp
bool CanBePooled();
void PrepareForPooling();
void PrepareForGame();
```

**[SOURCE]** `MassRepresentationSubsystem.h:108-138` — the spawn/release API the representation
processor drives, all keyed by `FMassEntityHandle`:
`GetOrSpawnActorFromTemplate`, `CancelSpawning`, `ReleaseTemplateActor`,
`ReleaseTemplateActorOrCancelSpawning`, plus `FindOrAddTemplateActor` to register an actor class.

**[SOURCE]** `MassActorSpawnerSubsystem.h:268-274` — spawning and destruction are **time-sliced**
(`ProcessPendingSpawningRequest(MaxTimeSlicePerTick)`), so a burst of promotions does not spike one
frame.

**Conclusion [INFER]:** the milestone's pooling requirement is configuration plus an
`IMassActorPoolableInterface` implementation on our character actor, not a pool implementation.
`PrepareForPooling` / `PrepareForGame` are also the correct hooks for resetting animation state, so
a recycled actor cannot leak the previous agent's pose — which is exactly the "no duplicate body /
no stale state" requirement.

**[UNTESTED]** Whether pooled `USkeletalMeshComponent`s fully reset their animation instance across
`PrepareForGame`. Must be proven live; a stale `UAnimInstance` is the most likely source of a
one-frame wrong-pose artefact.

---

## 7. Camera source

**[SOURCE]** `MassLOD/Public/MassLODSubsystem.h:30-67` — `FViewerInfo` carries `Location`,
`Rotation`, `FOV`, `AspectRatio`, an `ActorViewer`, and (editor-only) an
`EditorViewportClientIndex`.

**[SOURCE]** `MassLODSubsystem.h:156-157` — `bGatherPlayerControllers = true` by default, and
`SynchronizeViewers()` builds the viewer list from the engine's PlayerController list
(`:128-132`).

**Conclusion [INFER]:** *"Active PIE player camera"*, the one camera source the brief makes
mandatory, requires **no work** — it is the default viewer.

**[SOURCE]** `MassLODSubsystem.h:108-109` — `RegisterActorViewer(AActor&)` /
`UnregisterActorViewer(AActor&)` accept an arbitrary actor as a viewer, gated by
`bAllowNonPlayerViwerActors` (`:165`, engine's typo, not ours).

**Conclusion [INFER]:** an explicit world-space camera is implementable by spawning a transient
actor at the requested transform and registering it. A Sequencer camera is implementable by
registering the active `ACineCameraActor`. Both are **[UNTESTED]**; per the brief, Sequencer support
will not be claimed unless live-proven.

**[SOURCE]** `MassLODSubsystem.h:139-142` — `AddEditorViewer(HashValue, ClientIndex)` exists under
`WITH_EDITOR`, so a non-PIE editor viewport can drive LOD. Note it is `protected`, so it is not
callable from our code without subclassing. Relevant because the foundation's capture problem
(findings §12 of the previous milestone) is a PIE-window problem.

---

## 8. Hysteresis is a percentage, not a distance

**[SOURCE]** `MassRepresentationFragments.h:200-222`

```cpp
float BaseLODDistance[EMassLOD::Max]    = { 0.f, 1000.f, 2500.f, 10000.f };
float VisibleLODDistance[EMassLOD::Max] = { 0.f, 2000.f, 4000.f, 15000.f };
float BufferHysteresisOnDistancePercentage = 10.0f;
int32 LODMaxCount[EMassLOD::Max] = { 50, 100, 500, MAX_int32 };
float DistanceToFrustum = 0.0f;
float DistanceToFrustumHysteresis = 0.0f;
```

Two mismatches against the brief:

1. **Hysteresis.** The brief asks for a configurable absolute hysteresis, default `500` Unreal
   units. The engine expresses hysteresis as a **percentage of the LOD distance**
   (`BufferHysteresisOnDistancePercentage`, default 10%). At the brief's recommended near threshold
   of 2,500 uu, 10% is 250 uu; at the mid threshold of 7,000 uu, 10% is 700 uu.

   **Decision:** keep the public MCP parameter absolute (`hysteresisDistance`, uu) because it is the
   engine-agnostic form the brief requires, and convert to the engine's percentage against the
   relevant threshold at apply time. The conversion, and the fact that a single absolute value maps
   to different percentages per band, must be stated in the architecture doc and the report — not
   silently rounded.

2. **Budgets.** `LODMaxCount` is engine-provided and per-band, which covers the brief's
   `maxNearActors` / `maxMidRepresentations` directly. **[SOURCE]**
   `MassVisualizationLODSharedFragment` carries `bHasAdjustedDistancesFromCount`
   (`MassRepresentationFragments.h:238`), meaning the engine's own answer to budget overflow is to
   *shrink the distance band*, not to hard-drop agents. That satisfies "keep overflow agents in the
   next cheaper tier" and "never delete Mass entities because a budget is full", but it means the
   reported *effective* distance can differ from the *requested* distance. The runtime report must
   surface both, or the numbers will look like a bug.

---

## 9. Skeleton compatibility validation

**[SOURCE]** `Engine/Source/Runtime/Engine/Classes/Animation/Skeleton.h`

```cpp
bool IsCompatible(const USkeleton* InSkeleton) const;                       // :773
bool IsCompatibleForEditor(const USkeleton* InSkeleton) const;              // :750
bool IsCompatibleForEditor(const FAssetData&, const TCHAR* InTag) const;    // :755
bool IsCompatibleSkeletonByAssetData(const FAssetData&, const TCHAR*) const;// :776
bool IsCompatibleMesh(const USkinnedAsset*, bool bDoParentChainCheck) const;// :826
```

**Conclusion [INFER]:** profile validation has real engine predicates available and does not need a
hand-rolled bone-name comparison:

- mesh ↔ skeleton: `Skeleton->IsCompatibleMesh(SkeletalMesh)`
- animation ↔ skeleton: compare `AnimSequence->GetSkeleton()` then `IsCompatible`
- the `FAssetData` overloads allow validating **without fully loading** the animation, which matters
  for a profile carrying many sequences

This directly serves the brief's `RIOT_SKELETON_MISMATCH` requirement and its rule that a parseable
path is never proof — we load and interrogate the asset.

---

## 10. Cheap skeletal representation for Tier 2

**[SOURCE]** `Engine/Source/Runtime/Engine/Classes/Components/SkinnedMeshComponent.h`

- `:93` `enum class EVisibilityBasedAnimTickOption` and `:733`
  `VisibilityBasedAnimTickOption` — skip animation ticking when not rendered.
- `:59` `FOnAnimUpdateRateParamsCreated`, plus the `FAnimUpdateRateParameters` machinery — URO,
  evaluate animation every N frames with interpolation.
- `:280-289` `LeaderPoseComponent` (the 5.1+ name; `MasterPoseComponent` is deprecated) — many
  components sharing one evaluated pose.

**[SOURCE]** `Engine/Plugins/Developer/AnimationSharing` exists as a separate plugin.

**Conclusion:** Tier 2 has several supported cost-reduction paths. Preference order for this
milestone, cheapest to integrate first:

1. **URO + `VisibilityBasedAnimTickOption`** on the same pooled actor class as Tier 1, configured
   differently. No new plugin, no new asset, and it is per-component so it is a pure runtime switch.
   **[INFER]**
2. `LeaderPoseComponent` sharing — strong win but forces identical skeletons across a shared group,
   which conflicts with the brief's explicit "do not require all characters to share one skeleton".
   **[INFER]** Recorded as a possible later optimisation, not this milestone.
3. AnimationSharing plugin — **[UNTESTED]**, and it is under `Plugins/Developer`, which would be a
   new plugin dependency on consuming projects. Against the optional-boundary principle unless
   proven necessary.

**Decision:** Tier 2 = same pooled actor class as Tier 1 with URO enabled and visibility-based tick,
driven by `LowResSpawnedActor`. This keeps one actor class, one pool, and no new dependency.

---

## 11. Tier 3 background animation — the milestone's largest risk

**[SOURCE]** `Engine/Plugins/Experimental/AnimToTexture/AnimToTexture.uplugin`:

```json
"VersionName": "2.1",
"IsExperimentalVersion": true,
"Modules": [
  { "Name": "AnimToTexture",       "Type": "Runtime", "LoadingPhase": "PreDefault" },
  { "Name": "AnimToTextureEditor", "Type": "Editor",  "LoadingPhase": "PreLoadingScreen" }
]
```

There is also `Engine/Plugins/Animation/AnimToTexture`, which is **content only** — a single
`NS_InstancerFrameData.uasset` under `Content/Characters/Mannequin`, no `.uplugin` and no source.
Do not confuse the two.

**[SOURCE]** Runtime playback API — `AnimToTexture/Public/AnimToTextureInstancePlaybackHelpers.h`:

```cpp
static bool SetupInstancedMeshComponent(UInstancedStaticMeshComponent*, int32 NumInstances, bool bAutoPlay);
static bool BatchUpdateInstancesAutoPlayData(UInstancedStaticMeshComponent*,
        const TArray<FAnimToTextureAutoPlayData>&, const TArray<FMatrix>& Transforms, bool bMarkRenderStateDirty);
static bool BatchUpdateInstancesFrameData(UInstancedStaticMeshComponent*,
        const TArray<FAnimToTextureFrameData>&, const TArray<FMatrix>& Transforms, bool bMarkRenderStateDirty);
static bool GetAutoPlayDataFromDataAsset(const UAnimToTextureDataAsset*, int32 AnimationIndex,
        FAnimToTextureAutoPlayData&, float TimeOffset, float PlayRate);
```

This is genuinely well-suited: batched, transform+animation in one call, per-instance time offset
and play rate (which is exactly the brief's deterministic anti-clone variation), and animation
selection per instance by index.

**[SOURCE]** Baking is **editor-only** — `AnimToTextureEditor/Public/AnimToTextureBPLibrary.h:26-50`,
the whole class body is inside `#if WITH_EDITOR`:

```cpp
static bool AnimationToTexture(UAnimToTextureDataAsset* DataAsset);
static UStaticMesh* ConvertSkeletalMeshToStaticMesh(USkeletalMesh*, const FString PackageName, int32 LODIndex);
static bool SetLightMapIndex(UStaticMesh*, int32 LODIndex, int32 LightmapIndex, bool bGenerateLightmapUVs);
static void UpdateMaterialInstanceFromDataAsset(const UAnimToTextureDataAsset*, UMaterialInstanceConstant*, EMaterialParameterAssociation);
```

**Assessment [INFER].** Tier 3 via AnimToTexture is *possible* but it is not a runtime feature — it
is an **asset-production pipeline** that must run before simulation:

1. convert each rigged `USkeletalMesh` → `UStaticMesh`
2. create and configure a `UAnimToTextureDataAsset` per character (mesh, skeleton, anim list,
   frame ranges, resolution)
3. bake → produces bone position / rotation / weight textures
4. create a `UMaterialInstanceConstant` from the plugin's VAT material layer and push the data asset
   parameters into it
5. only then can the runtime ISM path be used

All four editor entry points are `BlueprintCallable`, so they are reachable from this repo's
existing `/api/run-python` bridge without new C++ — a genuine advantage. But steps 1–4 create
**persistent assets in the consuming project**, which is a materially different commitment from
everything Riot Crowd has done so far (in-process only, nothing serialised), and it interacts badly
with the brief's own "scenario persistence deferred" and "do not copy template assets into the repo"
constraints.

**Risk is real and is being flagged now rather than discovered at acceptance time.** Three things
could each sink it: the plugin is Experimental and may not link cleanly (**[UNTESTED]**); the bake
requires editor and cannot be part of a cooked runtime path (**[SOURCE]**, accepted); and the VAT
material layer must be wired for each mesh's material slots (**[UNTESTED]**).

**Planned order:** implement Tiers 1 and 2 first and prove them, then attempt Tier 3. If Tier 3
cannot be proven, the brief's instruction is explicit — prove why, ship the most efficient supported
fallback, and mark background animated instancing **blocked or incomplete** rather than claiming
three production-ready tiers. The fallback in that case is the existing ISM path *fixed* per §3
(batched, entity-keyed, no per-tick rebuild) with static posed meshes — cheaper and honest, but not
animated, and it would be reported as such.

---

## 12. What this changes about the plugin boundary

Nothing. **[SOURCE]** Every API named above lives in either the engine's own Runtime modules
(`Engine`, `MassEntity`) or the already-enabled `MassGameplay` plugin, except AnimToTexture, which is
an engine plugin the *consuming project* would enable only if Tier 3 is adopted.

No change to `Source/BlueprintMCP` is anticipated. The foundation's
`FBlueprintMCPServer::RegisterExternalEndpoint` seam already carries new riot endpoints without core
edits, and the new tools are additional endpoints through that same seam. Per the brief, "prefer no
core C++ changes in this milestone" — currently we expect exactly zero.

---

## 13. Open questions to close during implementation

| # | Question | How it gets answered |
|---|----------|---------------------|
| 1 | Do engine representation processors pick up code-composed archetypes with no trait? | First compile + live spawn. Highest-priority unknown. |
| 2 | Does the AnimToTexture module link into an opt-in plugin build? | Compile against it before writing any Tier 3 code. |
| 3 | Do pooled skeletal actors fully reset animation state on reuse? | Live promote → demote → promote of the same agent. |
| 4 | Does `LODMaxCount` band-shrinking make reported distances diverge from requested? | Live, by reading the report at a known camera distance. |
| 5 | Can a registered non-player actor viewer drive LOD in PIE? | Live, by registering a transient camera actor and moving it. |
| 6 | Does time-sliced actor spawning visibly lag a mass promotion of 24 agents? | Live, measured at the acceptance run. |

---

## 14. Summary of decisions taken at this gate

1. Use the engine's `EMassRepresentationType` tiers rather than a bespoke tier machine. **§2**
2. Compose representation fragments/tags in C++; **no entity config assets, no traits.** **§4**
3. Replace the per-tick ISM rebuild with `UMassVisualizationComponent`'s entity-keyed batched
   updates. **§3**
4. Tier 1 and Tier 2 share one pooled actor class, differing by URO/visibility-tick configuration.
   **§10**
5. Public `hysteresisDistance` stays absolute uu and is converted to the engine's percentage, with
   the conversion documented. **§8**
6. Tier 3 (AnimToTexture) is attempted **after** Tiers 1–2 are proven, and is reported honestly as
   blocked if it cannot be live-proven. **§11**
7. Add `MassLOD` and `MassActors` to the riot module only. No core plugin changes. **§1, §12**
