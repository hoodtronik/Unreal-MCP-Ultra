# Rigged Representation — Test Record

What was actually run, on what, with what results. Claims here are limited to what happened;
anything not listed was not tested. Companion documents: performance numbers in
`RIOT-REPRESENTATION-PERFORMANCE.md`, claim classification in
`RIOT-RIGGED-REPRESENTATION-HUMAN-REVIEW.md`.

## Environment

| | |
|---|---|
| Engine | UE 5.6.1 (CL 44394996), Win64, editor mode |
| Project | `F:\.bpmcp-build\RiotRiggedTest` — disposable, Third Person template assets |
| Level | `Lvl_RiotProxy` — flat-plane proxy intersection built via MCP tools (user decision; the template level's raised platform floated agents over the void and its walls occluded ground contact) |
| Characters | `SKM_Manny_Simple`, `SKM_Quinn_Simple` on `SK_Mannequin` — project content, discovered via asset registry, never assumed and never copied into the plugin |
| Animations | 7 distinct source sequences used: `MM_Idle`, `MF_Unarmed_Walk_Fwd`, `MF_Unarmed_Jog_Fwd`, `MF_Unarmed_Jog_Bwd`*, `MM_Attack_01/02/03`, `MM_ChargedAttack`, `MM_Death_Front_01`, `MM_Death_Back_01` (*Jog_Bwd was later removed from rioter retreat — see finding 6) |
| Client | All authoring through the HTTP API the MCP tools call; tool surface verified through a real MCP stdio client |
| Reproduction | `Tools/test/manual/riot-rigged-scenario.sh [rioters] [defenders]` — committed fixture; re-running it is the whole reproduction path since nothing persists by design |

## Acceptance scenario

210 rioters + 34 defenders, three flow origins, one blockade (34 defenders, breaks at pressure 100),
breach + panic triggers, seed `20260728`. Representation profile: near 1,500 / mid 4,000 /
far 14,000 uu, hysteresis 300 uu, budgets 24 near / 200 mid, camera `piePlayerCamera`.
Five character profiles: 3 rioter (weights 2:2:1), 2 defender. **Visual distinction reported
honestly: 2 distinct skeletal meshes; `rioter_quinn` and `rioter_agitator` share the Quinn mesh and
differ by animation set and rates. This is not five unique models.**

## Results — verified live

| Gate | Result |
|---|---|
| Register 5 profiles from project asset paths | PASS — every asset loaded and inspected; all validate as `warning` (fallback slots reported, not hidden) |
| Invalid registration attempts | PASS — missing path → `RIOT_ASSET_LOAD_FAILED`; wrong asset type → `RIOT_INVALID_SKELETAL_MESH` naming the type actually loaded; duplicate id → `RIOT_CHARACTER_PROFILE_ALREADY_EXISTS`. After all three, store contained only valid profiles — zero partial mutation |
| Profile update patch semantics | PASS — 3 live updates; failed validation leaves the original untouched; a live crowd keeps its snapshot until reset+respawn (verified) |
| Spawn 210+34 | PASS, sub-second |
| No placeholders on the success path | PASS — `fallbackPlaceholderCount` 0 in every reading of every run |
| Weighted deterministic selection | PASS — 87/72/51 rioters (2:2:1 weights, seed-stable), identical across all repeat cycles |
| Six+ visible state transitions | PASS — queued → advancing → pressuring → breaching → passedBlockade → retreating → inactive, all observed in state readback and captures; defenders holding → bracing |
| Walk/run split by speed | PASS — `minSpeed` clip selection at 280 uu/s; origin speeds 180–420 produce visible walkers and joggers in one wave |
| Playback rate follows travel speed | PASS (user-judged "much better, not perfect") — `referenceSpeed` scaling, clamped 0.5–1.7× |
| Automatic LOD by camera distance | PASS — sweep: x=−6000 → 0/0/244; x=0 → 0/180/64; x=1500 → 24/200/20 |
| Budgets enforced exactly | PASS — near pinned at 24, mid at 200 whenever demand exceeded them; overflow to next cheaper tier; entities never destroyed by budget |
| Hysteresis | PASS — 6 oscillations ±100 uu across the near threshold: zero tier changes |
| No duplicate bodies | PASS — `duplicateRepresentationCount` 0 in every reading, including during promote/demote and tier transitions |
| Manual promotion | PASS — 5 promoted nearest-to-location; re-promotion idempotent (0 changed, 5 alreadyPromoted); over-budget request refused **as a whole** with `RIOT_REPRESENTATION_BUDGET_EXCEEDED` |
| Manual demotion | PASS — transform/state preserved, idempotent (second call 0/244 alreadyDemoted) |
| Pause policy | PASS — agent states freeze; representation LOD continues following the camera (documented behaviour) |
| Reset | PASS — all counts to zero, pooled/skeletal 0, idempotent double-reset, zero riot actors in the editor world after |
| 3× repeat cycles | PASS — identical tier counts and identical per-profile distribution every cycle; 10.5–11.9 ms mid-run |
| Defender fallback + facing | PASS — line braces at x=1500 facing the crowd, retreats to x=499 on break with lateral spread (−899..899) intact, then holds |
| Mode A (Animation Blueprint) | **PARTIAL — loads and runs, does not animate** with `ABP_Unarmed`; measured ±2 uu bone drift vs ~80 uu for Mode B. Contract documented, warning added |
| Editor close + reopen | PASS — after restart: 0 profiles, 0 scenarios (in-process by design, nothing stale); cold re-author + full run works |
| PIE stopped abruptly with a live crowd | PASS — editor survives (regression-fixed this milestone; previously a fatal `EntityManager` assert) |
| 244 perf gate | **PASS — 12.01 ms comparable peak vs 64 ms baseline; see performance doc** |
| 500 full cycle | PASS — peak 18.5 ms sampled, clean reset |
| 1,000 benchmark | PASS as benchmark — 2 full cycles, peak 29.4 ms sampled, no crash, no leak; **not** evidence for 1,000 animated agents (far tier does not animate) |

## Evidence

`docs/riot-crowd/evidence/rigged-representation/` — 10-frame labelled contact sheet + SHA-256
manifest. Originals (uncommitted): `F:\.bpmcp-build\RiotEvidence\rigged-final\`. All frames taken by
the agent via the core `capture_view` tool from self-placed cameras. Note on frame 01: queued
(unreleased) agents are deliberately unrepresented, so the pre-release frame shows an empty field —
that is the design, not a missed capture.

## Defects found and fixed during live testing

Every one was invisible to the compiler and to the automated suite; four of seven were found by the
user watching or free-flying, which is why human fly-through should remain an acceptance step.

1. **No agent was ever represented** — pass-3 guard skipped every agent whose tier was still the
   default `None` on frame 1. Budget arithmetic was provably correct while every tier read zero.
2. **Weighted selection non-uniform** — `HashCombine` does not avalanche near-sequential salts
   (104/64/42 where 84/84/42 expected); replaced with a lowbias32 finalizer.
3. **Editor crash on abrupt PIE stop** (user's accidental stop) — Mass manager released mid-tick;
   `bIsTearingDown` guards added; reproduced and confirmed fixed.
4. **Crowd never faced travel** (user) — mesh forward-axis convention; per-profile
   `meshYawOffsetDegrees` default −90. Facing verified by yaw census, not eyeball.
5. **Fused jittering blob past the blockade** (user) — arrival oscillation at a shared breach
   destination; shipped unseen in the foundation because oscillating *cylinders* read as nothing.
   Arrival radius + deterministic dispersal + passed→inactive; end state now all-inactive.
6. **Backwards run while fleeing** (user) — with velocity-derived facing, every moving state must
   map a forward clip; fixture corrected.
7. **Foot slide** (user) — fixed rate regardless of speed; `referenceSpeed` scaling added.

## Not tested / explicitly out of evidence

- Tier 3 renders instanced cones and **does not animate** (AnimToTexture deferred; report warns).
- Animation Blueprint mode (mode A): **run live and measured — loads, instances, does NOT animate**
  with a Character-expecting ABP. See the Mode A contract section in the animation-mapping doc.
  Registration now warns. Not animation-proven until a conforming ABP exists.
- `sequencerCamera` / `explicitTransform` camera sources: schema exists, **not live-proven**.
- Editor RSS during scale runs: sampler broke, noticed post-teardown, not re-run.
- Unreal Insights trace; same-conditions A/B against the foundation build.
- Skeleton-mismatch rejection was tested only structurally (wrong asset type); a true
  incompatible-skeleton animation asset was not available in the template content to try live.
