# Riot Animation — State → Slot Mapping

One authoritative mapping, in `RiotAnimationSlotForState()` (`RiotCharacterProfile.cpp`).
Slots name **riot intent**, not engine state, and the mapping is **faction-dependent on purpose**:
the same simulation state means opposite things on the two sides of the line.

## Rioter / Neutral

| Agent state | Slot | Notes |
|---|---|---|
| Queued | idle | queued agents are also unrepresented until released |
| Advancing, PassedBlockade | advancing | locomotion; supports walk/run split by `minSpeed` |
| Blocked | gathering | |
| Pressuring | pressuring | contact — attack clips in the test set |
| Breaching | breaching | |
| Panicked | panicked | |
| Retreating | retreating | **must be a forward-moving clip**: facing derives from velocity, so a fleeing agent turns and runs; a backwards clip reads as moonwalking (live finding) |
| Inactive | inactive | unrepresented |

## Police / Military (defenders)

| Agent state | Slot | Notes |
|---|---|---|
| Queued, Advancing | holding | |
| Blocked, Pressuring | bracing | the crowd pushing *is* the defender bracing |
| Breaching, PassedBlockade, Panicked | broken | the line has gone |
| Retreating | fallback | backwards clip is legitimate **here only** — a shield line backs up still facing the crowd — but defender fallback movement is a deferred behaviour, so this slot has not moved anyone live |
| Inactive | inactive | |

## Fallback chains

Every slot resolves through a documented chain that terminates at `idle`; locomotion-flavoured
slots route through `advancing` first, so a walk+idle-only asset set still reads (a panicking agent
with no panic clip runs rather than standing). Resolution is bounded, so an accidental future cycle
fails a test instead of hanging the game thread. Every fallback actually taken is recorded as a
profile warning and shown in `resolvedAnimationSlots` — reused animation is reported, never hidden.

`idle ← gathering, advancing, holding, broken, inactive` · `advancing ← pressuring, breaching,
panicked, retreating, fallback` · `holding ← bracing`

## Rules that came from live findings

1. **Moving states map forward-moving clips** (velocity facing). Backward clips only where facing
   is decoupled from travel — currently only the defender `fallback` intent.
2. **`referenceSpeed` doubles as the locomotion marker**: a stationary agent whose resolved clip has
   `referenceSpeed > 0` plays `idle` instead of treadmilling; a stationary pressuring agent
   (`referenceSpeed` 0 on attack clips) keeps punching.
3. **Clip choice follows speed, not just rate** (`minSpeed`), because a walk clip rate-stretched to
   1.7× reads as a runner and the crowd loses its walkers.
4. Transitions swap clips at the agent's deterministic phase offset; no blending yet (single-node
   playback). Cross-fade blending is a known polish item for the next phase, honestly: fast state
   flips can pop.
