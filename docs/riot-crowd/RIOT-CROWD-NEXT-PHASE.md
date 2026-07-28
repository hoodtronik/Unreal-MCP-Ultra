# Riot Crowd — Next Phase Options

**Do not start any of these without approval.** The milestone brief is explicit that the next
milestone is a human decision, not one I select.

Listed with what each would actually cost, given what the foundation now proves.

## 1. Foreground hero incident and melee pockets

Selected close-range conflict at chosen points, while the macro crowd keeps behaving.

- Needs: agent→actor promotion (`MassActors` is already linked), a pocket-selection rule, paired
  interaction states, and animation.
- Blocked by nothing technical. `MassActors` exists and the state field has room.
- Risk: this is where "riot" becomes "violence" content. Scope it explicitly before starting.
- **Prerequisite:** decide question 2 in the human review (representation fidelity), because a hero
  pocket rendered as cylinders is pointless.

## 2. Improved animation and representation LOD

Replace placeholder ISM with skeletal proxies at close range, ISM at distance.

- Needs: `MassRepresentation`'s `MassVisualizationTrait` + entity config assets — the surface this
  foundation deliberately skipped, plus `MassLOD` which is already linked.
- **Also fixes the 64 ms spike.** The current wholesale ISM rebuild every tick is the dominant cost;
  proper representation management replaces it.
- Lowest-risk option with the highest immediate payoff, because it improves both the visuals and
  the frame budget at once.

## 3. Cinematic Riot Director tools

Higher-level direction: "surge here", "hold this line for 8 seconds", "collapse the west flank".

- Needs: a beat/cue layer above the current trigger model, and a timeline.
- The trigger model is the seam this would extend; conditions are already pluggable.
- Most valuable if the goal is *directing* shots rather than simulating crowds.

## 4. UE 5.8 compatibility and comparative scale benchmark

- 5.8 is installed on this machine.
- Interest is sparse fragments, which would replace the enum-field state design and remove the
  archetype-churn tradeoff documented in the architecture.
- Needs a backend seam; the processor/subsystem split already isolates most API churn.
- **Only worth doing after option 2**, otherwise the benchmark measures the ISM rebuild rather than
  Mass.

## 5. Sequencer and Movie Render Queue integration

- Explicitly a non-goal for this milestone.
- Would also solve the capture problem from a different direction: MRQ renders the game world
  directly, sidestepping the PIE-window issue documented in findings §12.

---

## What I would fix first regardless of which is chosen

These are small, known, and independent of direction:

| Item | Why |
|------|-----|
| Defender fallback movement | `fallbackLocation` is plumbed, validated, and unused — a documented field that does nothing is a trap |
| Distance-gated breaching | Currently the whole crowd flips to `Breaching` at once regardless of distance, so compression is over instantly |
| Stuck-agent / failed-movement counters | The perf section can only say "none observed", not "none occurred" |
| Scenario persistence | In-process only; every editor restart loses authored scenarios |
| A capture path that sees PIE | The milestone needed visual proof and the built-in tools could not provide it |

## Explicitly still out of scope

Weapons, ballistics, tear gas, vehicles, looting, storefront destruction, arrest logic, injury,
ragdolls, blood/gore, full animation variation libraries, motion matching, Houdini/Golaem/Massive/
Blender integration, backward asset transfer.
