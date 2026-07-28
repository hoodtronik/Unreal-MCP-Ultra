# Riot Crowd — Test Record

## Provenance

| Item | Value |
|------|-------|
| Branch | `feature/riot-crowd-foundation-ue56` |
| Engine | UE **5.6.1**, CL 44394996, CompatibleCL 43139311 |
| Node / npm | v24.13.1 / 11.8.0 |
| Test project | `F:\.bpmcp-build\RiotTest` (disposable, junctions to the canonical repo) |
| Build host | `F:\.bpmcp-build\BuildHost` (disposable) |
| Production projects touched | **None** |
| Seed | 20260728 |

## Automated suite

```
Test Files  64 passed | 9 skipped (73)
     Tests  633 passed | 68 skipped (701)
  Duration  91.54s
```

Baseline before this milestone was 622 passed / 68 skipped. The delta is exactly the 11 new riot
tests. **No regressions**, and the skip count is unchanged.

`npx tsc --noEmit` clean. `npm run build` clean.

### The invariants were proved capable of failing

The repo's convention is that a static invariant test which cannot fail is decoration. Both riot
invariants were verified by introducing a real violation (commenting the riot entry out of
`TOOL_REGISTRATIONS`), confirming failure, then restoring:

```
× actually registers every riot tool through TOOL_REGISTRATIONS
× every register* function under src/tools is actually wired up
Tests  2 failed | 12 passed
```

**This exposed a pre-existing defect in the repo's own `registration-parity.test.ts`.** On the first
attempt the violation left both tests *green*, because
`registry.includes("register: registerFooTools")` matches that text just as happily inside a `//`
comment as in live code — precisely the silent drift the test exists to catch. Two fixes followed:
`registration-parity.test.ts` now strips comments, and the riot invariant does not string-match at
all — it executes `TOOL_REGISTRATIONS` against a recording stub server and asserts all 16 tool names
actually arrive.

## Build matrix

| Target | Result |
|--------|--------|
| TypeScript typecheck | Pass |
| TypeScript build | Pass |
| Full vitest suite | Pass (633/68/0) |
| Core `BlueprintMCP` C++ | Pass |
| Optional `BlueprintMCPRiotCrowd` C++ | Pass |
| Editor opens disposable project | Pass |
| Required plugins load | Pass — `MassGameplay` enabled, `MassEntity` plugin deliberately **not** |
| MCP server starts | Pass — editor mode, port 9847 |
| Riot routes reachable | Pass — all 16 |
| Existing non-riot tools present | Pass — 174 blueprints / 622 materials indexed, health OK |
| Startup crash | None |
| Shutdown crash | None (4 editor restarts) |

UE 5.8 compatibility: **not claimed, not tested, no 5.8 code added.**

## Live acceptance run

Scenario: 2 factions, 3 flow origins × 70 rioters = **210**, 1 blockade with **34** defenders,
1 breach trigger (pressure ≥ 95), 1 panic trigger (30 agents passed, 40 % affected).

Exceeds the required minimum of 200 rioters / 30 defenders.

### Sequence results

| Step | Result |
|------|--------|
| Clean disposable level | Pass |
| `riot_get_capabilities` | Pass — `featureInstalled: true`, `supported: true`, `5.6.1` |
| Create scenario over MCP | Pass |
| Read scenario back | Pass |
| Dry-run spawn | Pass — planned 210/34, spawned **0/0** |
| Dry run created nothing | Pass — verified by read-back |
| Real spawn | Pass — **210 / 34**, planned == actual, no warnings |
| Rioters advance from all 3 origins | Pass — three distinct streams visible |
| Pressure increases | Pass — 0 → 7.1 → 53.0 → peak **95.4** |
| Breach executes | Pass — t ≈ **21.6 s** |
| Rioters pass through | Pass — **138–140** |
| Panic / retreat executes | Pass — **70–72** routed |
| Pause stops advancement | Pass — `simulationTime` frozen at 55.8 across 5 s |
| Resume | Pass |
| Reset removes all runtime objects | Pass — counts 0/0, ISM components released |
| Reset idempotent | Pass — called twice, no error, no crash |
| ≥ 3 spawn/start/reset cycles | Pass — 3 consecutive, no crash |
| Same-seed repeatability | Pass — see below |
| Editor close/reopen, no stale state | Pass — 4 restarts, feature loaded clean each time |

### Determinism, three consecutive runs on seed 20260728

| Metric | Run 1 | Run 2 | Run 3 | Spread |
|--------|-------|-------|-------|--------|
| Spawned rioters / defenders | 210 / 34 | 210 / 34 | 210 / 34 | 0 |
| Breach time (s) | 21.59 | 21.58 | 21.58 | 0.01 s (**0.05 %**) |
| Panic time (s) | 22.40 | 22.40 | 22.40 | 0 |
| Peak pressure | 95.23 | 95.44 | 95.45 | 0.22 (**0.23 %**) |
| Passed blockade | 138 | 138 | 138 | 0 |
| Retreated | 72 | 72 | 72 | 0 |

**Recorded tolerance:** counts must match exactly; times within **±0.1 s**; peak pressure within
**±1.0 unit**. All three runs are well inside it. Per-frame float identity is not claimed.

## Performance baseline

Measured with `get_frame_timing`.

| Stage | Game thread | Render | RHI |
|-------|-------------|--------|-----|
| Empty level, no PIE | 4.38 ms | 2.45 ms | 1.22 ms |
| Spawned but paused | 6.31 ms | — | 0.08 ms |
| Advancing crowd | ~5.5 ms | — | 0.11 ms |
| **Peak pressure / breach** | **64.11 ms** | — | 0.10 ms |
| Passing through | 55.96 ms | — | 0.11 ms |
| Settled | ~5.2 ms | — | 0.16 ms |
| After reset | 5.07 ms | — | 0.11 ms |

Entity count 244 (210 + 34). Representation count 244 ISM instances. Actor count 139 in the PIE
world.

**Render-thread values read 0.00 ms during PIE and are reported as unavailable, not as zero.**
`get_frame_timing` documents that these can read 0 depending on context; treating that as a real
measurement would be wrong.

The **64 ms game-thread spike** is the honest headline number and is a known cost of this
foundation: `TickRepresentation` calls `ClearInstances()` and re-adds every instance each tick,
and the orchestration passes walk all agents linearly. That is ~15 fps at 244 agents, which will not
scale to cinematic crowd counts. It is a baseline for a later optimisation pass, not an acceptable
end state.

Mass processor/archetype statistics: **not collected.** `MassInsights` is enabled by default but was
not exercised. Marked unavailable rather than guessed.

Stuck-agent and failed-movement counts: **not instrumented.** All 210 agents reached a terminal
state in every run, so no stuck agents were observed, but there is no counter to prove it.

## Visual evidence

`F:\.bpmcp-build\RiotEvidence\` — outside the repository, **not committed**.

| File | Size | Stage |
|------|------|-------|
| `A_spawned.png` | ~1.3 MB | 1286×760, t=0.0 |
| `B_approaching.png` | ~1.3 MB | t=10.0, three streams converging |
| `C_pressing.png` | ~1.3 MB | t=17.1, contact |
| `D_breach.png` | ~1.3 MB | t=22.1, centre gives way |
| `E_through_panic.png` | ~1.3 MB | t=27.1, 126 through / 70 panicked |
| `F_retreating.png` | ~1.3 MB | t=36.2, rout scattering |
| `G_after_reset.png` | ~1.3 MB | empty field, line gone |

All non-zero, all 1286×760.

**How they were captured, and why it matters:** these are OS-level grabs of the PIE window. Both
in-editor paths (`viewport_capture`, `HighResShot`) photograph the **editor** level viewport, where
riot entities do not exist, because PIE opens in a separate floating window. Earlier captures taken
that way showed an empty landscape while the runtime report correctly claimed 210 live agents —
metadata that looked entirely plausible and was proving nothing. See findings §12.

## Output log

No errors during the successful runs. One pre-existing engine warning unrelated to this feature
(duplicate `GreyscalegorillaConnect` plugin in two engine locations).

One **editor-fatal crash** occurred during testing and was fixed:
`Cannot generate unique name for 'RiotCrowdVisualizer'` (`LevelActor.cpp:585`) on the second spawn
of a session. Root cause and fix in the commit history and findings §12.

## What was NOT tested

Stated explicitly, because skipped is not passed:

- `riot_delete_scenario` against a currently-spawned scenario
- `RIOT_FEATURE_NOT_INSTALLED` against a genuinely uninstalled plugin
- `RIOT_RESET_FAILED` (reset never failed)
- Any engine version other than 5.6.1
- Whether a bare custom `UMassProcessor` auto-registers, isolated from the subsystem's own writes
- Editor-world behaviour (the subsystem refuses to create there)
- The 300-rioter / 40–60-defender stretch count
