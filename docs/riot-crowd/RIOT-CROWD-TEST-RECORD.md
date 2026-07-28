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

## Review closeout (post-`ff5a56c`)

Three narrow gaps were closed after the foundation was provisionally accepted. No Riot Crowd
behaviour was added; no C++ source changed.

### Gap A — hardened real-client regression check

The original harness only asserted the 16 riot tools were present, so its exit code could **not**
detect a core tool disappearing. It now diffs the full tool set against a committed manifest in both
directions.

**Baseline provenance (this is the part that matters):** `Tools/test/manual/tool-baseline.json`
`coreTools` were captured by running a real MCP stdio client against a **detached git worktree of
the merge-base commit `af6ec58`** — not against the feature branch. Generating a baseline from the
branch under test and comparing it to itself would be vacuous. That baseline run reported 241 tools
and **0** riot tools, confirming the source is genuinely riot-free.

| Run | Result | Exit |
|-----|--------|------|
| Feature branch, live editor | **PASS** — 257 total / 16 riot / 241 core, none missing, none unexpected, `riot_get_capabilities` round-trips | 0 |
| Against the riot-free baseline server (negative) | **FAIL** — 241 total, 16 riot tools missing; correctly reported "Missing core tools: none" | 1 |
| Simulated core-tool removal (negative) | **FAIL** — `MISSING CORE TOOLS (regression): get_blueprint_THAT_WAS_REMOVED` | 1 |

The third run is the one that proves the gap is actually closed. The manifest was restored to
241/257 afterwards and re-verified.

**`RIOT_FEATURE_NOT_INSTALLED` is now live-proven**, incidentally and against a real editor. During
the policy-correction verification a second editor running an unrelated project (`VoxelWorld`, which
has BlueprintMCP but *not* the riot plugin) held port 9847, so the harness reached it instead of the
riot-enabled test project. `riot_get_capabilities` correctly returned `featureInstalled: false`,
`supported: false` with the sibling-install instructions — the 404 → `RIOT_FEATURE_NOT_INSTALLED`
path working end to end on an editor that genuinely lacks the plugin. It had previously been listed
as untested. The intended run was then obtained on an isolated port without disturbing that editor.

Checks enforced: total count, riot count exactly 16, core count, every expected riot tool present,
no unexpected `riot_`-prefixed tool, and the complete core name set still present.

**Baseline policy — the manifest is an audited contract, not a moving snapshot.** Core removals,
core *additions*, riot removals, unexpected riot additions, and any total- or non-riot-count
mismatch all fail the run. Intentional core-tool additions are listed separately by the harness for
diagnosis, but they still fail the strict total-count and non-riot-count gates until
`tool-baseline.json` is deliberately reviewed and refreshed. Additions fail for the same reason
removals do: the reviewed tool surface changed. The baseline is never regenerated automatically from
the branch under test.

### Gap B — durable evidence package

| Artefact | Path | Size |
|----------|------|------|
| Contact sheet (7 labelled stages) | `docs/riot-crowd/evidence/riot-stages-contact-sheet.jpg` | 245,116 bytes, 1270×1618 |
| SHA-256 manifest | `docs/riot-crowd/evidence/EVIDENCE-SHA256.txt` | 3,067 bytes, 9 entries |
| Package builder | `Tools/test/manual/build-evidence-package.ps1` | committed |

Covers the seven originals (1286×760, 1,306,496 – 1,329,415 bytes each), the contact sheet, and the
capture helper. All nine hashes were **independently re-verified** against the files after the
manifest was written: 9 OK, 0 failed.

The seven full-resolution PNGs remain uncommitted, consistent with this repository having no
precedent for committing test evidence. The originals were not altered or regenerated.

### Gap C — reproducible capture procedure

`Tools/test/manual/capture-riot-pie.ps1` replaces the scratchpad script the review document
previously referenced.

| Verification | Result |
|--------------|--------|
| No PIE window open | **FAIL**, exit 1, no file created |
| `-Name "..\escape"` traversal attempt | **FAIL**, exit 1, no file written outside the root |
| Non-matching window title pattern | **FAIL**, exit 1 |
| Live PIE, six sequential captures | **PASS**, exit 0 each; all 1286×760, 1,095,156 – 1,352,604 bytes |

`Fail()` writes to stderr rather than using `Write-Error`, because `$ErrorActionPreference = "Stop"`
would make `Write-Error` throw before `exit 1` ran — the documented exit code has to be deliberate,
since callers gate on it.

### Closeout live cycle

Fresh scenario `closeout`, seed 20260728, run end to end:

| Step | Result |
|------|--------|
| Dry-run spawn | planned 210/34, **spawned 0/0** |
| Real spawn | 210 / 34 |
| Approaching (t=11.0) | 210 advancing, ISM 210+34 |
| Pressing (t=18.8) | 37 pressuring, pressure 31.9 |
| Breach (t=25.5) | **BROKEN**, 96 passed, 71 retreating |
| Panic (t=32.2) | 135 passed, 71 retreating |
| Reset | success, live 0/0, 0 warnings, ISM released (−1/−1) |

### Closeout verification matrix

| Check | Result |
|-------|--------|
| TypeScript typecheck | Pass (exit 0) |
| TypeScript build | Pass (exit 0) |
| Full vitest suite | **633 passed / 68 skipped / 0 failed** (701 total) — unchanged |
| Core `BlueprintMCP` C++ | Up to date, `Result: Succeeded` (no C++ changed) |
| Optional Riot Crowd C++ | DLL deleted and **relinked from source**, `Result: Succeeded`, 415,232 bytes |
| Real MCP stdio harness | Pass, exit 0 |
| Live spawn/start/breach/panic/reset | Pass |
| Capture-helper proof | Pass (3 negative, 6 positive) |
| Evidence hash verification | 9/9 OK |
| Clean editor shutdown | Pass |

Note on the C++ builds: no C++ source changed during closeout, so the core module was already up to
date. The riot module's DLL was deliberately deleted to force a genuine link step rather than
accept a no-op. The full compile of both modules was performed at the reviewed commit and is
recorded above.

## Visual evidence

`F:\.bpmcp-build\RiotEvidence\` — outside the repository, **not committed**. See the closeout
section above for the committed contact sheet and hash manifest.

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

Stated explicitly, because skipped is not passed. Current as of the review closeout.

**Riot behaviour and error paths**

- `riot_delete_scenario` against a currently-spawned scenario (the reset-first branch)
- `riot_add_hotspot` beyond authoring — hotspots activate but drive no behaviour
- Defender fallback movement — `fallbackLocation` is stored and validated, nothing consumes it
- `RIOT_RESET_FAILED` — reset succeeded on every attempt, so the downgrade branch never ran
- `RIOT_UNSUPPORTED_ENGINE_VERSION` — only 5.6.1 was run
- `RIOT_RUNTIME_STATE_MISMATCH` and `RIOT_LIVE_VERIFICATION_FAILED` — declared and asserted present,
  never triggered
- The 300-rioter / 40–60-defender stretch count

**Engine and Mass**

- Any engine version other than 5.6.1. No UE 5.8 code exists
- Whether a bare custom `UMassProcessor` auto-registers into the PIE tick pipeline, isolated from
  the subsystem's own transform writes. Agents move; which code moved them is not separated
- Editor-world behaviour — `ShouldCreateSubsystem` refuses to create there, so that path is
  unreachable by design and untested by consequence
- Mass processor/archetype statistics. `MassInsights` is enabled by default but was never exercised
- Stuck-agent and failed-movement counters — not instrumented. Every agent reached a terminal state
  in every run, but there is no counter proving it

**Capture**

- Whether a PIE configuration that passes `DestinationSlateViewport`, or Simulate-In-Editor, would
  be capturable by `viewport_capture` / `HighResShot`. The documented limitation is scoped to the
  floating-window PIE that `start_pie` produces on 5.6.1 and is **not** a general claim

**Tool-surface baseline**

- No scenario was exercised in which the tool surface legitimately changes and the baseline is then
  refreshed. Adding a core tool fails the harness by design (strict total- and non-riot-count
  gates); the refresh-and-re-verify workflow that follows such a change has not itself been walked
  through end to end
