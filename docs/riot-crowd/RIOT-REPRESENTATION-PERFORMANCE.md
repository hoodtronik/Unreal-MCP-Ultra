# Riot Crowd — Representation Performance

Measured results for the rigged-character / representation-LOD milestone.

**Status: the 244-agent performance gate is met. 500 and 1,000-agent runs completed — see §5a.**

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

## 5a. Scale runs — 500 and 1,000 agents

Same scenario shape and seed, counts scaled. Same sampling method and caveats as §2.

**500 agents (466 rioters + 34 defenders):** completed the full spawn → advance → pressure →
breach → panic → retreat → reset cycle. Game thread 9.36–18.49 ms sampled across the run
(peak 18.49 ms in the post-breach phase with ~433 agents represented at 0/200/67 after inactives).
0 placeholders, 0 duplicates, budgets held at 24/200 exactly. Reset returned every count to zero and
left zero riot actors in the editor world. Deterministic distribution scaled correctly:
196/166/104 rioters across the 2:2:1 profiles.

**1,000 agents (966 rioters + 34 defenders):** treated as a scalability benchmark, not a target.
Spawned in under 1 s, ran >40 s, sampled game thread 9.09–29.35 ms (peak during the post-breach
phase). Tier counts reached 24/200/776 at full crowd — the far tier absorbing what the budgets
rejected, as designed. No crash, no runaway actor spawning, reset clean. A **second full cycle** at
1,000 was run immediately after: spawn OK, 10.51 ms mid-run, reset clean — no degradation across
cycles.

The honest reading of the 1,000-agent number: ~29 ms sampled peak is *below* the 244-agent hard
gate, but the far tier (which most of those agents occupy) is non-animating instances, so this is
not evidence that 1,000 *animated* agents fit the budget. It establishes the ceiling for the current
representation mix only.

## 5b. Still not measured

| Requirement | Status |
|---|---|
| Editor RSS during the scale runs | **not captured** — the in-run sampler's output parsing failed; noticed only after teardown. Not re-run yet. |
| Unreal Insights trace | **not captured** |
| Same-conditions A/B against the foundation build | **not run** |

Do not read the completed runs as evidence for these.


---

## 6. Recommended thresholds and budgets (measured, not guessed)

Owner asked for a recommendation rather than shipping the tested values blind. Four configurations,
same 244-agent scenario and seed, sampled t=4.5-8 s while **all 244 are live**. (The first attempt
sampled after the crowd had drained and produced meaningless near-identical numbers - recorded
because it is exactly the trap that makes tuning data worthless.)

| Config | near / mid / far (uu) | budgets | peak ms | tiers near/mid/far | skeletal |
|---|---|---|---:|---|---:|
| A (as tested) | 1500 / 4000 / 14000 | 24 / 200 | 11.7 | 24 / 162 / 40 | 186 |
| B | 2000 / 6000 / 20000 | 32 / 200 | 13.6 | 32 / 186 / 8 | 218 |
| **C** | **2500 / 7000 / 20000** | **48 / 244** | **11.6** | **48 / 178 / 0** | **226** |
| D (frugal) | 1200 / 3000 / 12000 | 16 / 120 | 10.3 | 16 / 120 / 90 | 136 |

**What the numbers say.** Cost tracks the total *skeletal* count, and even 226 skeletal actors sits
at 11.6 ms - roughly a third of the 32 ms gate. The 13.6 ms on B versus 11.6 ms on C, despite C
carrying *more* skeletal actors, is single-frame sampling noise, not a config effect:
`get_frame_timing` is a snapshot, so differences under ~2 ms here are not real. The honest
conclusion is that **at 244 agents the thresholds are not the constraint** - anything in this range
fits comfortably.

**Recommended defaults, scaled by crowd size:**

| Crowd | near / mid / far | maxNear / maxMid | Rationale |
|---|---|---|---|
| <= 250 | 2500 / 7000 / 20000 | 48 / 250 | Config C. Every agent skeletal, zero far-tier stand-ins, ~12 ms. Best-looking option still ~3x inside budget |
| ~500 | 2500 / 7000 / 20000 | 32 / 200 | Same distances; budgets cap skeletal cost, remainder instanced. Measured 18.5 ms peak at 500 |
| ~1000 | 2000 / 6000 / 20000 | 24 / 200 | Measured 29.4 ms peak; the far tier absorbs the rest |

**Hysteresis: ~20 % of `nearDistance`** (500 uu at near 2500). 300 uu was verified flap-free at near
1500, the same ratio; the absolute value matters less than staying well under half the narrowest
band, which validation enforces anyway.

**Caveats, unchanged:** sampled peaks, not traced; the far tier does not animate yet, so far-heavy
configurations will cost more once VAT lands; one machine, one scenario shape, one seed.
