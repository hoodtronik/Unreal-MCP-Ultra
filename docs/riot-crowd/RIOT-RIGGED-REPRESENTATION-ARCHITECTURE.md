# Rigged Representation — Architecture

How the crowd is *drawn*. Behaviour is unchanged from the foundation architecture doc except where
noted (arrival handling). Evidence classes for every underlying API decision:
`UE56-RIGGED-REPRESENTATION-API-FINDINGS.md`.

## Shape

```
FRiotCharacterProfileStore (process-wide, outlives PIE)
  character profiles + representation profiles, validated against loaded assets
        │ snapshot at spawn (mid-run edits cannot alter a live crowd → determinism)
        ▼
URiotCrowdSubsystem ── owns ──► FRiotRepresentationManager (plain member, weak actor ptrs)
  Tick: sim ticks, then          per frame: camera → distance → desired tier → budgets →
  TickRepresentation()           transitions → per-agent updates → one render-dirty
        │                                 │
        ▼                                 ▼
  Mass fragments (authoritative     Near/Mid: pooled ARiotCharacterActor (skeletal)
  position/velocity/state)          Far: stable-slot ISM instances (cones until VAT)
```

## Decisions and their reasons

- **Bespoke tier manager on engine primitives, not `UMassRepresentationProcessor`.** The engine
  chain enforces budgets by *shrinking distance bands*, expresses hysteresis as a percentage, and
  has no seam for pinning specific agents. All three are milestone requirements (exact budgets,
  absolute-uu hysteresis, `riot_promote_agents`). Reused rather than rebuilt: `MassLOD`'s viewer
  model conceptually, engine pooling interfaces, `IMassActorPoolableInterface`. CitySample later
  confirmed the far tier should move to the engine ISM custom-data path when VAT lands — recorded
  in findings §11a as a planned partial reversal for *rendering only*.
- **One pooled actor class for both skeletal tiers.** The engine pools per actor class; two classes
  would turn a tier change into destroy-and-respawn. Tier is a runtime reconfigure: near = full
  tick + shadows; mid = URO + `OnlyTickPoseWhenRendered`, no shadows.
- **Actor, not Character; no collision anywhere.** Mass is authoritative over transforms; the actor
  is a view. `PrepareForPooling` fully strips mesh/anim state so a recycled actor cannot flash the
  previous agent's pose.
- **Facing is presentation.** Steering orients movers (`ToOrientationQuat`); the representation
  re-derives from velocity so far-tier instances get rotation, zero-velocity defenders keep their
  authored yaw, and presentation doesn't depend on which processor wrote the transform. The mesh's
  own authoring convention is per-profile `meshYawOffsetDegrees` (default −90, Epic convention).
- **Far tier: stable slots, park-don't-remove.** `RemoveInstance` re-indexes; slots are allocated
  once, released slots park at zero scale on a free list. Steady state: one transform write per
  visible agent + one `MarkRenderStateDirty` per pass. This replaced the foundation's per-tick
  `ClearInstances` rebuild and is the primary source of the 64→12 ms improvement.
- **Camera**: PIE player camera read directly from `PlayerCameraManager` each frame (one frame
  fresher than the Mass viewer array). Unresolvable camera ⇒ documented fallback: everything far,
  warning in the report.
- **Hysteresis**: one-sided extension of the *current* band. Symmetric dead zones create ranges
  where two tiers are simultaneously valid and the winner depends on evaluation order.
- **Budgets**: manual promotions first, then nearest-first, then entity index as a stable tie-break
  (without it, equal-distance agents swap tiers with TMap iteration order and read as LOD thrash).
  Overflow demotes one tier; entities are never destroyed by representation.
- **Determinism**: everything per-agent derives from the spawn-time seed salt — profile choice
  (lowbias32 finalizer; `HashCombine` measurably banded), phase offset and rate scale (two
  *different* salts, or late-phase agents would all also play fast), breach dispersal points.
  Same seed ⇒ same crowd, verified across 3× resets.
- **Teardown**: `World->bIsTearingDown` gates every Mass access — the engine's accessors assert and
  its member is protected, so the world flag is the only available signal. Reset order: entities →
  representation → visualizer (reversing it leaks actors). All live-crash-proven.

## Seams for what comes next

- **Hero/melee**: promotion already yields a pinned full skeletal actor with preserved transform +
  state; a melee milestone attaches interaction logic to promoted actors without touching tiers.
- **VAT far tier (#10/#11)**: bake pipeline via the Python bridge (no link-time AnimToTexture
  dependency); far rendering moves to `FMassInstancedStaticMeshInfo::AddBatchedCustomData` so
  playback state rides per-instance custom data, CitySample-style.
- **UE 5.8**: representation manager touches Mass only through `FMassEntityManager` fragment reads
  and the teardown flag; the processor/subsystem split isolates API churn as before.
- **Experimental dependencies**: none linked. AnimToTexture stays a consuming-project opt-in.
