# Riot Crowd — Status

**Ready for human review.** Do not merge to `main`.

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
