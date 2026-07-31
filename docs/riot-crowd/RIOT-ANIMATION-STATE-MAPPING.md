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


## Mode A (Animation Blueprint) — the contract, and what it costs to ignore it

**Live finding, 2026-07-28.** Registering a profile with `animationMode: "animationBlueprint"`
against the Third Person template's `ABP_Unarmed` produces a profile that validates as `valid`,
loads its class, instances it, reports `animationMode = AnimationBlueprint`… **and does not
animate.** Measured on the same frame, same 1-second intervals:

| | `hand_r` drift while travelling |
|---|---|
| Mode A (`ABP_Unarmed`) | ±2 uu — idle pose, despite `Speed = 414` |
| Mode B (SequenceSet) | (−4, −26, 92) → (−39, 4, 110) → (−67, −41, 137) — a real run cycle |

**Cause, not a defect:** `ABP_Unarmed` reads locomotion from a **Character pawn owner**.
`ARiotCharacterActor` is deliberately neither a Character nor a Pawn — Mass owns the transform, and
adding a movement component would put two systems in charge of it. The ABP's speed variable stays
0, so it plays idle forever. There is no generic fix: an ABP written against a Character cannot be
satisfied without becoming one.

**Therefore an operator-supplied ABP must read the actor.** In the ABP event graph:

```
Event Blueprint Update Animation
  → Get Owning Actor
  → Cast To RiotCharacterActor
      → Speed / NormalizedSpeed  → drive a locomotion blendspace
      → RiotState / RiotAnimationSlot (FName) → drive a state machine
      → IsMoving / IsPromoted / SeedPhase / FactionType / CharacterProfileId
```

`SeedPhase` (0–1, deterministic per agent) is the right input for start-time offset so a Mode A
crowd does not move in lockstep — Mode B does this automatically, Mode A must do it itself.

Registration now emits a **warning** saying exactly this, because the failure is otherwise silent
and visual: everything reports success and the crowd stands still. Mode A remains
**implemented-and-loadable but not animation-proven** until someone supplies a conforming ABP —
that is a real remaining gap, not a formality.
