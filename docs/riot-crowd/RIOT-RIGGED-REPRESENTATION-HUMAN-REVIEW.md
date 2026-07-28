# Rigged Representation — Human Review

Every material claim of this milestone, classified. The classes are exclusive:

- **LIVE-PROVEN** — executed against a real editor and read back / photographed
- **AUTOMATED-TEST-ONLY** — guaranteed by the suite, never exercised live
- **DOCUMENTED-BUT-UNTESTED** — implemented and described; no evidence either way
- **UNSUPPORTED** — known not to work; reported as such by the runtime
- **DEFERRED** — deliberately not built this milestone

## Claim classification

| Claim | Class |
|---|---|
| Project-owned rigged characters drive the crowd; nothing hardcoded in the plugin | LIVE-PROVEN |
| Asset validation loads and inspects; distinct errors for missing vs wrong-type; no partial mutation | LIVE-PROVEN |
| Skeleton compatibility check (mesh↔skeleton, anim↔skeleton via `IsCompatibleForEditor`) | AUTOMATED-TEST-ONLY for the mismatch path (no incompatible asset existed in the template content to try live); happy path LIVE-PROVEN |
| Deterministic weighted profile selection, stable across resets | LIVE-PROVEN (3× identical distributions) |
| State-driven animation switching across ≥6 states | LIVE-PROVEN (state readback + captures; user-watched) |
| Playback rate derives from velocity (`referenceSpeed`) | LIVE-PROVEN, user-judged "much better, not perfect" |
| Speed-thresholded clip choice (`minSpeed` walk/run split) | LIVE-PROVEN |
| Anti-clone variation (phase + rate from seed salt) | LIVE-PROVEN visually (distinct run phases in captures); statistical uniformity fixed and verified numerically |
| Three-tier LOD with automatic camera-distance transitions | LIVE-PROVEN for tier *selection and counts* (sweep + report). Tier 1/2 visuals LIVE-PROVEN; **Tier 3 renders but does not animate — see UNSUPPORTED** |
| Absolute-uu hysteresis prevents boundary flapping | LIVE-PROVEN (6 oscillations, zero flaps) |
| Budgets enforced exactly; overflow demotes, never destroys | LIVE-PROVEN |
| Manual promote/demote, idempotent, whole-request budget refusal | LIVE-PROVEN |
| No duplicate bodies during any transition | LIVE-PROVEN (count 0 throughout; demote capture) |
| Pause policy: states freeze, LOD keeps tracking camera | LIVE-PROVEN |
| Idempotent reset; zero leaks; clean editor reopen | LIVE-PROVEN |
| Safe teardown when PIE ends abruptly with a live crowd | LIVE-PROVEN (crash reproduced pre-fix, absent post-fix) |
| 244-agent hard perf gate ≤32 ms | LIVE-PROVEN at 12.01 ms sampled — with the caveats in the performance doc (sampled not traced; not a same-conditions A/B) |
| 500 / 1,000-agent behaviour | LIVE-PROVEN as benchmarks; 1,000 is a ceiling for the current mix only |
| Animation Blueprint mode: class loads, instances, runs | LIVE-PROVEN |
| Animation Blueprint mode: actually animates | **UNSUPPORTED with a Character-expecting ABP** — measured static (±2 uu) vs Mode B (~80 uu). Needs an ABP written to this system's parameter contract; registration now warns |
| Defender fallback movement | LIVE-PROVEN (holds → braces → retreats as an intact line → holds) |
| `explicitTransform` camera source | DOCUMENTED-BUT-UNTESTED |
| `sequencerCamera` camera source | DOCUMENTED-BUT-UNTESTED — deliberately not claimed |
| Tier 3 animated instancing (AnimToTexture VAT) | DEFERRED — feasibility proven from source (findings §11b), pipeline designed, not built. Until then background instancing is **UNSUPPORTED as animation** and the runtime report says so in `warnings` |
| Scenario/profile persistence to disk | DEFERRED by standing owner decision |
| Automatic retargeting | DEFERRED (explicit non-goal; mismatches are structured errors) |

## Process findings a reviewer should weigh

1. **The user found what nothing else could.** Four of seven live defects (facing, blob,
   backwards-run, foot slide) came from a human watching; two of those had shipped in the *accepted
   foundation* hidden by a symmetric placeholder. Recommendation: keep a human fly-through in every
   visual milestone's gate, alongside the new `capture_view` self-verification.
2. **The audited core baseline moved 241 → 242** for `capture_view`, by explicit owner instruction,
   recorded in the baseline provenance and on `main` independently of this branch.
3. **Honest-distinction note:** the acceptance profiles use 2 distinct meshes across 5 profiles.
   The brief's minimum (≥2 meshes, ≥3 distinguishable rioters, ≥2 distinguishable defenders) is met
   via animation-set and rate differences, not five unique models.

## Decisions taken by the owner (2026-07-28)

1. **Mode A first, over VAT.** Actioned: run live and measured this session. It loads and runs but
   does **not** animate with a Character-expecting ABP; the contract is now documented and warned
   about at registration. Genuinely proving Mode A needs a conforming ABP - the remaining piece.
2. **Accept non-animated background instances for now.** Tier 3 VAT deferred; feasibility and design
   stay recorded in findings 11a/11b for whenever it is wanted.
3. **Recommendations rather than the tested values.** Four configurations measured; see
   `RIOT-REPRESENTATION-PERFORMANCE.md` section 6. Headline: at <=250 agents use 2500/7000/20000
   with 48/250 - every agent skeletal, no far-tier stand-ins, ~12 ms, still ~3x inside the gate.
4. **Include defender fallback.** Done and live-verified - which surfaced two further foundation-era
   defects (defenders never state-ticked; the police line spawned facing away from the riot).
5. **Production characters: MetaHuman / Reallusion CC4 / possibly Mixamo.** See below - the one
   answer with a hard technical consequence.

## Production characters: what each choice costs

This system **hard-errors on skeleton mismatch and does no retargeting** (an explicit non-goal). So
the deciding question for any character source is *which skeleton do its animations target*.

| Source | Skeleton reality | Consequence here |
|---|---|---|
| **Reallusion CC4** | Can export **on the UE5 mannequin skeleton** (Auto Setup / UE mannequin profile) | **Best fit.** One shared skeleton means one animation set drives every profile - exactly what weighted per-agent selection wants. Register and go |
| **MetaHuman** | Own body skeleton; Epic ships IK Retargeters from the mannequin | Works only if you **bake retargeted animations onto the MetaHuman skeleton first**, then register those. Also very expensive per instance - realistically Tier 1 only, small `maxNearActors`, with cheaper characters filling mid/far |
| **Mixamo** | Its own rig; animations baked per download | Needs a retarget step onto whichever skeleton you standardise on. Licence is fine commercially; the brief excluded it from the *test* project for test hygiene, not as a restriction on production |

**Recommendation:** standardise the crowd on one skeleton (CC4-on-mannequin is the cheapest route)
and reserve MetaHumans for promoted hero agents, where `riot_promote_agents` already pins a full
skeletal actor. Mixing skeletons *is* supported - profiles are per-skeleton - but every extra
skeleton needs its own complete animation set, so the cost is per-skeleton authoring, not
per-character.

**If retargeting should become automatic**, that is a milestone of its own (IK Retargeter asset
creation + baking through the Python bridge, much like the VAT pipeline). Not a small addition, and
currently an explicit non-goal - worth deciding deliberately rather than discovering.

## Recommendation

Accept as the representation milestone, with Tier 3 animation explicitly carried as the one open
implementation item. The orchestration loop the milestone had to prove — register → validate →
assign → spawn → deterministic selection → tier assignment → state-driven animation → promotion /
demotion → report → visual verification → reset — is closed end-to-end on a real editor, at 244,
500 and 1,000 agents, with the performance gate passed at 5× margin and every defect found en route
fixed and regression-guarded rather than worked around.
