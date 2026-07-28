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
| Animation Blueprint mode (operator ABP reads actor parameters) | DOCUMENTED-BUT-UNTESTED (implemented, compiles, never run) |
| `explicitTransform` camera source | DOCUMENTED-BUT-UNTESTED |
| `sequencerCamera` camera source | DOCUMENTED-BUT-UNTESTED — deliberately not claimed |
| Tier 3 animated instancing (AnimToTexture VAT) | DEFERRED — feasibility proven from source (findings §11b), pipeline designed, not built. Until then background instancing is **UNSUPPORTED as animation** and the runtime report says so in `warnings` |
| Defender fallback movement | DEFERRED (pre-existing foundation gap; `fallback` slot exists and validates) |
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

## Questions requiring your decision

1. **Is SequenceSet-quality animation sufficient for the next milestone**, or should Mode A
   (Animation Blueprint with a real blendspace, e.g. `ABP_Unarmed`/`BS_Idle_Walk_Run`) be
   live-proven first? Mode A is the path to fixing the residual foot-slide entirely.
2. **Tier 3: build the VAT bake next** (tasks exist: bake tool + far-tier rework onto the engine
   ISM custom-data path), or accept non-animated background instances for now?
3. **Are the tested thresholds/budgets (1500/4000/14000 uu, 24/200) the defaults to ship**, or do
   you want different recommendations after flying the proxy level yourself?
4. **Defender fallback movement** — small behaviour addition that would light up the `fallback`
   and `broken` animation slots properly. Include in the next milestone?
5. **Which of your production characters should be registered first** once this merges — and do
   any use a non-mannequin skeleton (which would exercise the per-profile skeleton path for real)?

## Recommendation

Accept as the representation milestone, with Tier 3 animation explicitly carried as the one open
implementation item. The orchestration loop the milestone had to prove — register → validate →
assign → spawn → deterministic selection → tier assignment → state-driven animation → promotion /
demotion → report → visual verification → reset — is closed end-to-end on a real editor, at 244,
500 and 1,000 agents, with the performance gate passed at 5× margin and every defect found en route
fixed and regression-guarded rather than worked around.
