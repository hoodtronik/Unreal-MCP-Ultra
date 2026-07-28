# Riot Crowd — Representation Performance

Measured results for the rigged-character / representation-LOD milestone.

**Status: the 244-agent performance gate is met. The 500 and 1,000-agent runs have not been done.**

---

## 1. What the milestone had to beat

The foundation recorded **~64 ms peak game thread at 244 agents**, dominated by a wholesale
`ClearInstances()` + per-instance `AddInstance()` rebuild of the visualiser every tick
(`RiotCrowdSubsystem.cpp:916-924` at commit `0826b8e`).

Milestone gates:

| Gate | Target |
|------|--------|
| Hard | ≤ **32 ms** at the comparable peak stage (50% improvement) |
| Preferred | ≤ **16.7 ms** |

---

## 2. Measured result — 244 agents

Configuration: 210 rioters + 34 defenders, three flow origins, one blockade (34 defenders), breach
and panic triggers, seed `20260728`. Representation profile `rep_default`: near 2,500 / mid 7,000 /
far 20,000 uu, hysteresis 500 uu, budgets 24 near / 200 mid, camera `piePlayerCamera`.

Project: `F:\.bpmcp-build\RiotRiggedTest` (disposable, Third Person template).
Characters: `SKM_Manny_Simple` and `SKM_Quinn_Simple` on `SK_Mannequin`, six distinct animation
sequences. **No placeholder cylinders on the success path.**

Sampled every 3 s across a full run via `get_frame_timing`:

| t (s) | game thread (ms) | represented / total | near / mid / far | dominant states |
|------:|-----------------:|--------------------:|-----------------:|-----------------|
|  3 | 12.16 |  89 / 244 | 24 / 65 / 0   | queued 114, advancing 96 |
|  **6** | **9.12**  | **244 / 244** | **24 / 200 / 20** | advancing 210 |
|  **9** | **9.64**  | **244 / 244** | **24 / 200 / 20** | advancing 210 |
| **12** | **10.41** | **244 / 244** | **24 / 200 / 20** | retreating 105, advancing 53 |
| **15** | **10.61** | **244 / 244** | **24 / 200 / 20** | retreating 105, passed 82 |
| **18** | **12.01** | 234 / 244 | 24 / 200 / 10 | passed 105, retreating 88 |
| 21 | 10.68 | 161 / 244 | 24 / 137 / 0 | passed 105, inactive 87 |
| 24 |  9.80 | 139 / 244 | 24 / 115 / 0 | passed 105, inactive 105 |
| 27–48 | 9.79 – 12.65 | 139 / 244 | 24 / 115 / 0 | steady, post-run |

**The comparable peak stage is t = 6–18 s**, where all 244 agents are simultaneously live and
represented. Game thread there: **9.12 – 12.01 ms**. Peak across the entire run: **12.65 ms**.

| | |
|---|---|
| Foundation peak | ~64 ms |
| This milestone, comparable peak | **12.01 ms** |
| Improvement | **~81%** |
| Hard gate (≤32 ms) | **PASS**, with ~20 ms of headroom |
| Preferred target (≤16.7 ms) | **PASS** |

The result is stronger than the raw numbers suggest, because the **visual workload went up, not
down**: the foundation drew 244 instanced cylinders, this run drives **224 animated skeletal
meshes** plus 20 instances, and is still ~5× faster.

---

## 3. Why it got faster

Not tuning — the per-tick rebuild was **replaced**.

The foundation's `CLAUDE-NOTE` was correct about its constraint: instance counts change every frame,
and `UInstancedStaticMeshComponent::RemoveInstance` re-indexes every later instance, so any cached
index goes stale within a few frames. Its conclusion was to rebuild wholesale.

`FRiotRepresentationManager` sidesteps the constraint rather than solving it:

- Instance slots are allocated once and **never removed** while a run is live. A released slot is
  parked at zero scale and pushed onto a free list for reuse.
- Slot indices are therefore stable for the whole run, and the instance count only grows to the
  high-water mark.
- Steady state is **one transform write per visible agent** plus a **single** `MarkRenderStateDirty`
  per pass, instead of a full clear, N allocations and a proxy rebuild every frame.

Tier budgets also cap the expensive work directly: at most 24 full-rate skeletal actors, at most 200
reduced-rate ones (URO + `OnlyTickPoseWhenRendered`), everything else instanced or not drawn.

---

## 4. Honest caveats

These matter and are not hedging:

1. **This is not an A/B under identical conditions.** The 64 ms figure is the foundation's
   *recorded* number, not a same-session re-measurement of the old code path. The milestone brief
   asks for a same-conditions comparison when conditions differ; that has **not** been done. What is
   certain is the absolute number: 12.01 ms at the peak stage, well inside a 32 ms gate.
2. **`get_frame_timing` is a single-frame snapshot from the last viewport draw, not a trace.** These
   are samples at 3-second intervals, so a shorter spike between samples would be missed. A real
   trace (Unreal Insights) would be needed to claim a *traced* peak rather than a *sampled* one.
3. **Render-thread and RHI numbers are not meaningful here.** They read ~0.001 ms and ~0.1 ms, which
   reflects the editor viewport rather than the PIE window doing the crowd rendering. Reported as
   measured rather than as zero, per the milestone's no-fake-zeros rule.
4. **Tier 3 is instanced but not animated.** Some of the saving comes from the far tier being
   cheaper than a real animated-instance path would be. When AnimToTexture VAT lands, far-tier cost
   will rise — the headroom is there, but the number will move.

---

## 5. Not yet measured

| Requirement | Status |
|---|---|
| 500-agent full cycle | **not run** |
| 1,000-agent scalability benchmark | **not run** |
| Memory, actor count, skeletal-mesh count at scale | **not captured** |
| Unreal Insights trace | **not captured** |
| Same-conditions A/B against the foundation build | **not run** |

Do not read the 244-agent pass as evidence for any of these.
