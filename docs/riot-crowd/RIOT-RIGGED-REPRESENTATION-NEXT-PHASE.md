# Rigged Representation — Next Phase Options

**Do not start any of these without approval.** Listed with real costs, given what is now proven.

## 1. Tier 3 animated instancing (VAT) — the open implementation item

Tasks already scoped (#10 bake tool, #11 far-tier rework). Feasibility proven from source
(findings §11b): five-step bake via the Python bridge (the one missing API — creating the empty
target textures — is ~40 lines of our own C++), far rendering moves to the engine ISM
custom-data path (findings §11a, CitySample-confirmed). Accepted consequence: persistent VAT
assets in the consuming project. This is the only item standing between "two animated tiers +
instanced background" and the milestone's full three-tier vision.

## 2. Animation Blueprint mode, live-proven

Mode A is implemented but never run. Registering one profile with `ABP_Unarmed` +
`BS_Idle_Walk_Run` would (a) prove the second animation mode, (b) eliminate the residual
foot-slide via a real blendspace, (c) exercise the parameter contract
(RiotState/Speed/NormalizedSpeed/…) for operator ABPs. Cheap: fixture change + one live session.

## 3. Hero incidents / melee pockets

The original next-phase candidate, now unblocked properly: promotion yields pinned full skeletal
actors with preserved transform and state — the seam melee attaches to. Still where "riot" becomes
"violence" content; scope explicitly before starting. Wants transition blending first (see 5).

## 4. Defender fallback + line behaviour

`fallback`/`broken` slots validate and map but no defender has ever moved. Small behaviour
addition; would also justify decoupled facing (backing up while facing the crowd), which is the
one case the current velocity-facing cannot express.

## 5. Polish items, small and known

| Item | Why |
|---|---|
| Transition cross-fade | single-node clip swaps can pop on fast state flips |
| Per-clip `referenceSpeed` tuning UI-side | 200/375 were eyeballed; operator-tunable live already |
| Editor RSS capture in the perf harness | the one measurement that failed silently this run |
| Same-conditions A/B vs foundation | would upgrade the 64→12 ms claim from recorded-baseline to measured |
| Materials/tint variation per profile | `materialOverrides` works but no acceptance profile used it |

## Explicitly still out of scope

Everything in the brief's non-goals list: melee mechanics themselves, weapons, gore, ragdolls,
Sequencer/MRQ, retargeting, motion matching, root-motion locomotion, UE 5.8, persistence.
