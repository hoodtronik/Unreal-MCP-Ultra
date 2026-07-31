# Riot Character Profile — Schema

Versioned, in-process (persistence deferred by owner decision). Authored via
`riot_register_character_profile` / `riot_update_character_profile`; validated against **loaded
assets**, never against paths. C++: `RiotCharacterProfile.h`. `schemaVersion` = 1.

## Character profile

| Field | Type | Notes |
|---|---|---|
| `profileId` | string | ≤64 chars, `[A-Za-z0-9_-]`. Stable id |
| `displayName` | string | reports only |
| `factionTypes` | `rioter\|police\|military\|neutral`[] | empty = any |
| `selectionWeight` | number > 0 | deterministic weighted pick per agent seed salt |
| `skeletalMeshPath` | string | must load as `USkeletalMesh` |
| `skeletonPath` | string? | omitted → derived from mesh (recorded as warning); if given and different, `IsCompatibleMesh` must hold |
| `animationMode` | `sequenceSet` \| `animationBlueprint` | mode B live-proven; mode A implemented-unproven |
| `animationBlueprintPath` | string | required for mode A; asset or `_C` class path both accepted |
| `animationSet` | binding[] | see below |
| `materialOverrides` | string[] | by material slot index; bad override = warning, not error |
| `meshYawOffsetDegrees` | number, default **−90** | mesh-forward correction; −90 matches Epic's +Y-authored meshes |
| `representationProfileId` | string? | LOD profile reference |
| `enabled` | bool | disabled profiles are never selected |
| `validationState` | `notValidated\|valid\|warning\|invalid` | written by validation only |
| `warnings[]`, `failureCode`, `failureMessage` | | validation output; `resolvedAnimationSlots` in read-back shows exactly what each state will play and whether it is a fallback |

## Animation binding

| Field | Type | Notes |
|---|---|---|
| `slot` | one of the 12 slots | see `RIOT-ANIMATION-STATE-MAPPING.md` |
| `animationPath` | string | must load as `UAnimSequenceBase`, skeleton-compatible |
| `playRate` | number > 0, default 1 | base rate; per-agent ±10% variation multiplies it |
| `looping` | bool, default true | |
| `referenceSpeed` | number ≥ 0, default 0 | authored ground speed (uu/s). >0 ⇒ rate scales by actual speed (clamped 0.5–1.7×) **and** marks the clip as locomotion (stationary agents fall back to idle). 0 ⇒ fixed rate (attacks, idles, deaths) |
| `minSpeed` | number ≥ 0, default 0 | binding applies from this speed. Same slot at different `minSpeed` = walk/run split; same slot at the same `minSpeed` = rejected |

## Representation profile

| Field | Default | Notes |
|---|---|---|
| `nearDistance` / `midDistance` / `farDistance` | 2500 / 7000 / 20000 | strictly increasing; tiers: near = full skeletal actor, mid = pooled skeletal with URO + visibility-tick, far = instanced (non-animated until VAT lands), beyond far = none |
| `hysteresisDistance` | 500 | **absolute uu** (engine uses percentage internally; converted, documented); must be ≤ half the narrowest band |
| `maxNearActors` / `maxMidRepresentations` | 24 / 200 | exact enforcement; overflow demotes a tier, never destroys |
| `farRepresentationEnabled` | true | |
| `updateIntervals.{near,mid,far}` | 0 / 0.1 / 0.25 s | |
| `cameraSource` | `piePlayerCamera` | `explicitTransform` (+`cameraTransform`), `sequencerCamera` exist but are not live-proven |
| `fallbackBehavior` | `placeholderMesh` | diagnostic cone (deliberately directional); never a successful result |

## Validation contract

Schema checks are pure (no editor needed; covered by the static suite). Asset validation loads
everything, checks skeleton compatibility for the mesh and every sequence, resolves every required
slot through the fallback chain, and records every fallback as a warning. Required slots are only
`idle` + `advancing` (+ `holding` for defender-only profiles) — demanding all twelve would reject
every realistic starter asset set. Errors carry: stable `RIOT_*` code, message, `profileId`,
`assetPath`, explicit `partialMutation`, `suggestedNextAction`. Registration and update are
all-or-nothing.
