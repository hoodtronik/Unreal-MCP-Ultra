# Riot Crowd — optional agent-directed crowd foundation for UE 5.6.1

A bounded vertical slice for cinematic riot crowds: multiple streams flood an intersection, press a
defended blockade, break through a segment, and part of the crowd routs. Driven entirely over MCP.

**This is a foundation, not the finished system.** See [Non-goals](#non-goals).

## Requirements

| | |
|---|---|
| Engine | UE **5.6.1** (the only version built and tested) |
| Plugins | `BlueprintMCP` (this repo) + `MassGameplay` |
| Do **not** enable | The `MassEntity` plugin — deprecated in 5.5, and unnecessary because MassEntity is an engine Runtime module in 5.6 |

## Install — it is deliberately a separate step

Riot Crowd ships inside this repo at `RiotCrowd/`, where it is **inert**. Unreal's plugin scanner
stops descending once it finds a `.uplugin`, so a nested plugin is never discovered. Activating it
means installing it as a **sibling**:

```
<Project>/Plugins/
├── BlueprintMCP/            <- this repo (241 core tools, zero Mass)
│   └── RiotCrowd/           <- staged here, inert
└── BlueprintMCPRiotCrowd/   <- copy or junction RiotCrowd/ here to activate
```

```powershell
# Windows, junction (no duplication)
cmd /c mklink /J "<Project>\Plugins\BlueprintMCPRiotCrowd" "<Project>\Plugins\BlueprintMCP\RiotCrowd"
```

```bash
# or just copy
cp -r <Project>/Plugins/BlueprintMCP/RiotCrowd <Project>/Plugins/BlueprintMCPRiotCrowd
```

Then enable `MassGameplay` in your `.uproject` and restart the editor.

**Why the extra step exists:** it is the opt-in. UHT forbids reflected types inside preprocessor
blocks, so a single module cannot be conditionally Mass-linked — the dependency is all-or-nothing.
Making Riot Crowd a separate plugin is the only way users who just want the core Blueprint tools
never get an experimental crowd stack enabled. Full reasoning in
[RIOT-CROWD-ARCHITECTURE.md](RIOT-CROWD-ARCHITECTURE.md).

The riot tools are always registered even when the feature is absent; they report
`RIOT_FEATURE_NOT_INSTALLED` with these instructions rather than silently vanishing.

## The simulation runs in PIE

Mass processors execute in a game world. **Call `start_pie` before `riot_spawn`** — spawning without
it returns `RIOT_PIE_NOT_RUNNING`.

## Quick start

```
riot_get_capabilities                    # verify install + plugin state first
start_pie

riot_create_scenario  scenarioId=demo seed=20260728
riot_add_faction      scenarioId=demo factionId=rioters type=rioter
riot_add_faction      scenarioId=demo factionId=police  type=police

riot_add_flow_origin  scenarioId=demo originId=o_n factionId=rioters \
                      location={x:-5000,y:-2200,z:0} initialTarget={x:0,y:0,z:0} \
                      spawnRadius=700 spawnCount=70 spawnInterval=0.03
# ...two more origins from different directions...

riot_add_blockade     scenarioId=demo blockadeId=b_main defendingFactionId=police \
                      location={x:0,y:0,z:0} width=1800 defenderCount=34 \
                      holdThreshold=40 breakThreshold=150

riot_set_trigger      scenarioId=demo triggerId=t_breach type=breach \
                      condition=pressure_threshold targetBlockadeId=b_main thresholdValue=95
riot_set_trigger      scenarioId=demo triggerId=t_panic type=panic \
                      condition=agents_passed thresholdValue=30 affectedFraction=0.4

riot_spawn  scenarioId=demo dryRun=true    # confirm the plan first
riot_spawn  scenarioId=demo
riot_start
riot_get_runtime_report                    # poll this
riot_reset
```

## Tools

**Inspection** — `riot_get_capabilities`, `riot_list_scenarios`, `riot_get_scenario`,
`riot_get_runtime_report`

**Authoring** — `riot_create_scenario`, `riot_delete_scenario`, `riot_add_faction`,
`riot_add_flow_origin`, `riot_add_blockade`, `riot_add_hotspot`, `riot_set_trigger`

**Runtime** — `riot_spawn`, `riot_start`, `riot_pause`, `riot_resume`, `riot_reset`

All authoring tools support `dryRun`. Validation runs on a copy, so a rejected call leaves **no**
partial state.

## The pressure model is not a black box

```
attackersPerDefender = pressingAgents / max(1, defenderCount)
target = attackersPerDefender * pressureGain * (1 + sustainBonusPerSecond * avgPressingTime)
```

`riot_get_runtime_report` returns this formula and every tunable alongside the current figures, so
any reported pressure can be recomputed by hand. Override the tunables via `pressureModel` on
`riot_create_scenario`.

## Determinism

Same scenario + same seed reproduces the run. Measured over three consecutive runs: counts
identical, breach time within 0.01 s, peak pressure within 0.23 %. Per-frame float identity is not
claimed.

## Things that will bite you

- **Scenarios do not survive an editor restart.** The store is in-process by design, so PIE teardown
  cannot destroy authored scenarios. Re-author or script it.
- **You cannot screenshot the crowd with `viewport_capture` or `HighResShot`.** Both photograph the
  editor viewport; PIE runs in a floating window where the entities actually live. They will return
  perfectly valid-looking images of an empty field. Use an OS-level window grab.
- **Peak cost is ~64 ms on the game thread at 244 agents.** This foundation rebuilds all ISM
  instances every tick. Optimisation is a later milestone.

## Non-goals

Not implemented, and reported as unsupported: melee, weapons, injury, ragdolls, arrests, looting,
destruction, police/military tactical AI, hero promotion, motion matching, Sequencer / Movie Render
Queue, ZoneGraph navigation, StateTree behaviour, UE 5.8.

## Documents

| File | Contents |
|------|----------|
| [UE56-MASS-API-FINDINGS.md](UE56-MASS-API-FINDINGS.md) | Engine investigation, evidence-tiered |
| [RIOT-CROWD-ARCHITECTURE.md](RIOT-CROWD-ARCHITECTURE.md) | Boundaries, lifecycle, determinism, state representation |
| [RIOT-CROWD-CAPABILITY-MATRIX.md](RIOT-CROWD-CAPABILITY-MATRIX.md) | What is live-proven vs merely implemented |
| [RIOT-CROWD-TEST-RECORD.md](RIOT-CROWD-TEST-RECORD.md) | Full results, determinism table, perf baseline |
| [RIOT-CROWD-HUMAN-REVIEW.md](RIOT-CROWD-HUMAN-REVIEW.md) | How to reproduce the demo; open decisions |
| [RIOT-CROWD-NEXT-PHASE.md](RIOT-CROWD-NEXT-PHASE.md) | Candidate next milestones |
