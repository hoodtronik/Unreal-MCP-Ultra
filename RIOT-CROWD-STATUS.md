# Riot Crowd — Status

> **This file covers two milestones.** The rigged-representation milestone (below) supersedes the
> foundation status further down; the foundation record is kept intact for history.

## Milestone 2: Rigged animation + representation LOD — READY FOR HUMAN REVIEW

Branch `feature/riot-crowd-rigged-animation-lod-ue56` (stacked on the merged foundation).
Full detail: `docs/riot-crowd/RIOT-RIGGED-REPRESENTATION-*.md` and
`RIOT-REPRESENTATION-PERFORMANCE.md`; claim classification in the human-review doc.

**Proven live** (UE 5.6.1, disposable RiotRiggedTest project, flat proxy level, seed 20260728):
- Project-owned rigged characters (Manny/Quinn) drive the crowd via 5 registered profiles;
  zero placeholders on the success path; deterministic 2:2:1 selection stable across resets.
- Three-tier LOD with exact budgets (24/200), absolute-uu hysteresis (zero flapping over six
  threshold oscillations), idempotent promote/demote, zero duplicate bodies anywhere.
- Speed-thresholded clip choice (walk/run split) + velocity-scaled playback rate.
- 244 agents: 12.01 ms comparable peak vs the foundation's 64 ms (~81% better; hard gate 32 ms,
  preferred 16.7 ms - both passed). 500: full cycle, 18.5 ms peak. 1,000: two clean cycles,
  29.4 ms peak (ceiling for the current mix - far tier does not animate yet).
- 3x repeat cycles bit-identical in distribution; editor reopen holds no stale state; abrupt
  PIE-stop crash found and fixed; the foundation-era arrival-oscillation blob found and fixed.
- Evidence: 10-frame contact sheet + SHA-256 in docs/riot-crowd/evidence/rigged-representation/,
  captured by the agent itself via the new core capture_view tool (core baseline 241 -> 242 by
  owner decision, also landed on main).

**Open, stated plainly:** Tier 3 renders instanced cones and does not animate (VAT bake designed,
not built); Animation Blueprint mode implemented but never run live; sequencer/explicit camera
sources unproven; RSS-at-scale not captured; perf comparison is against the recorded baseline,
not a same-session A/B. Tool surface: 269 (242 core + 27 riot), stdio-client-verified.

---


**Foundation provisionally accepted; review closeout complete.** Do not merge to `main`.

This remains a **foundation** milestone. It is not production ready, and nothing in the closeout
changed that — no Riot Crowd behaviour was added and no C++ source changed.

| | |
|---|---|
| Branch | `feature/riot-crowd-foundation-ue56` |
| Engine | UE **5.6.1** (CL 44394996) — the only version built or tested |
| Automated tests | **633 passed / 68 skipped / 0 failed** (baseline was 622/68 — delta is exactly the 11 new riot tests) |
| C++ build | Core + optional riot plugin both `Result: Succeeded` |
| Live acceptance | **Passed** — 210 rioters vs 34 defenders, 3 seeded cycles, deterministic, idempotent reset |
| Production projects touched | **None** |

## What this is

An **optional, opt-in** UE 5.6.1 plugin that adds 16 MCP tools for directing a cinematic riot crowd:
multiple streams flood an intersection, press a defended blockade, break through, and part of the
crowd routs. It proves the full orchestration loop end to end on a real editor:

```
agent command → validated MCP request → Unreal mutation → runtime simulation
→ structured read-back → visual verification → performance report → clean reset
```

It is **not** a crowd system. One blockade, one breach shape, no defender behaviour, placeholder
representation, and a frame cost that will not scale.

## Install (deliberately a separate step)

`RiotCrowd/` is inert while nested in this repo — Unreal never scans inside a plugin. Copy or
junction it to `<Project>/Plugins/BlueprintMCPRiotCrowd`, then enable `MassGameplay`.

That step **is** the opt-in: UHT forbids reflected types in preprocessor blocks, so a module cannot
be conditionally Mass-linked. A separate plugin is the only way core users never get an experimental
crowd stack enabled. Core `BlueprintMCP` gained **zero** Mass dependencies.

## Live results (seed 20260728)

| Metric | Run 1 | Run 2 | Run 3 |
|--------|-------|-------|-------|
| Spawned | 210 / 34 | 210 / 34 | 210 / 34 |
| Breach time | 21.59 s | 21.58 s | 21.58 s |
| Panic time | 22.40 s | 22.40 s | 22.40 s |
| Peak pressure | 95.23 | 95.44 | 95.45 |
| Passed / retreated | 138 / 72 | 138 / 72 | 138 / 72 |

Counts identical; times within 0.05 %; pressure within 0.23 %.

## Headline caveats

1. **~64 ms game thread at peak** (~15 fps, 244 agents). Known cause: ISM instances are rebuilt
   wholesale every tick. Baseline for optimisation, not an end state.
2. **In-editor capture cannot photograph the simulation.** `viewport_capture` and `HighResShot`
   shoot the editor viewport; PIE runs in a floating window. They return valid-looking images of an
   empty field. Evidence required OS-level window grabs.
3. **Scenarios do not survive an editor restart** (in-process store, by design).
4. **Defenders never move**; `fallbackLocation` is plumbed but unused.

## Three defects the live run caught

None were reachable by the automated suite:

- Panic trigger reported `fired: true` while affecting **zero** agents.
- **Editor-fatal crash** on the second spawn of a session (fixed actor name unrecoverable until GC).
- Pressure froze at its breaking value forever, making a walked-through blockade look loaded.

Separately, proving the new invariant could fail exposed a **pre-existing blind spot in the repo's
own `registration-parity.test.ts`** — it matched text inside comments, so a commented-out
registration passed. Fixed there too.

## Review closeout

Three narrow evidence/regression gaps were closed after provisional acceptance.

| Gap | Outcome |
|-----|---------|
| **A** — real-client regression check only caught missing *riot* tools | Hardened to diff the full tool surface both ways against a committed manifest. Proven to fail on a simulated core-tool removal. |
| **B** — evidence existed only as machine-local PNGs | Committed contact sheet + SHA-256 manifest; 9/9 hashes independently re-verified. |
| **C** — capture procedure referenced a scratchpad script | Committed `capture-riot-pie.ps1` with window validation, path confinement, and gated exit codes. |

**Baseline provenance:** `tool-baseline.json` core tools were captured by running a real MCP client
against a detached worktree of the merge-base commit `af6ec58` — **not** the branch under test.
That run saw 241 tools, 0 riot.

**Baseline policy:** the manifest is an audited contract, not a moving snapshot. Core removals, core
**additions**, riot removals, unexpected riot additions, and any count mismatch all fail the
harness. Added core tools are listed separately for diagnosis but still fail via the strict total-
and non-riot-count gates. Any intentional change to the tool surface requires deliberate review and
a conscious refresh of `tool-baseline.json`; it is never regenerated automatically from the branch
under test.

| Artefact | Path |
|----------|------|
| Contact sheet | `docs/riot-crowd/evidence/riot-stages-contact-sheet.jpg` (245 KB) |
| SHA-256 manifest | `docs/riot-crowd/evidence/EVIDENCE-SHA256.txt` |
| Capture helper | `Tools/test/manual/capture-riot-pie.ps1` |
| Evidence packager | `Tools/test/manual/build-evidence-package.ps1` |
| Tool baseline | `Tools/test/manual/tool-baseline.json` |

Closeout verification: typecheck ✓ · build ✓ · **633/68/0** ✓ · core C++ ✓ · riot C++ relink ✓ ·
stdio harness exit 0 ✓ · live spawn→breach→panic→reset ✓ · capture helper 3 negative + 6 positive ✓
· 9/9 hashes ✓ · clean shutdown ✓

Full detail, including an expanded list of exactly what remains untested, is in the
[test record](docs/riot-crowd/RIOT-CROWD-TEST-RECORD.md).

## Documents

`docs/riot-crowd/` — [README](docs/riot-crowd/README.md) ·
[Findings](docs/riot-crowd/UE56-MASS-API-FINDINGS.md) ·
[Architecture](docs/riot-crowd/RIOT-CROWD-ARCHITECTURE.md) ·
[Capability matrix](docs/riot-crowd/RIOT-CROWD-CAPABILITY-MATRIX.md) ·
[Test record](docs/riot-crowd/RIOT-CROWD-TEST-RECORD.md) ·
[Human review](docs/riot-crowd/RIOT-CROWD-HUMAN-REVIEW.md) ·
[Next phase](docs/riot-crowd/RIOT-CROWD-NEXT-PHASE.md)

## Next

Awaiting your decision on which milestone follows. Options and their real costs are in
[RIOT-CROWD-NEXT-PHASE.md](docs/riot-crowd/RIOT-CROWD-NEXT-PHASE.md). I have not selected one.
