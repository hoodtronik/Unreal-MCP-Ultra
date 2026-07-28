# Riot Crowd — Capability Matrix

Labels, as required by the milestone:

| Label | Meaning |
|-------|---------|
| **Live-proven** | Exercised against a real editor + PIE and observed to work |
| **Implemented, not live-proven** | Code exists and compiles; not exercised in the live run |
| **Automated-test-only** | Covered by the test suite, never run against a live editor |
| **Planned** | Deliberately deferred to a later milestone |
| **Unsupported** | Explicitly out of scope; reported as `false` by `riot_get_capabilities` |
| **Blocked** | Prevented by an engine/API limitation, with evidence |

## Tools

| Tool | Status | Notes |
|------|--------|-------|
| `riot_get_capabilities` | **Live-proven** | Returned correct plugin state and warnings on a real editor |
| `riot_list_scenarios` | **Live-proven** | |
| `riot_get_scenario` | **Live-proven** | Used to verify no partial state after rejections |
| `riot_get_runtime_report` | **Live-proven** | Polled continuously through three full runs |
| `riot_create_scenario` | **Live-proven** | Including `dryRun` |
| `riot_delete_scenario` | **Implemented, not live-proven** | Resets a live scenario first; that path was not exercised |
| `riot_add_faction` | **Live-proven** | |
| `riot_add_flow_origin` | **Live-proven** | Three origins per run |
| `riot_add_blockade` | **Live-proven** | |
| `riot_add_hotspot` | **Implemented, not live-proven** | Authoring works; hotspots are annotations only, no behaviour yet |
| `riot_set_trigger` | **Live-proven** | Breach and panic both fired |
| `riot_spawn` | **Live-proven** | Real and `dryRun`; counts read back off live entities |
| `riot_start` | **Live-proven** | |
| `riot_pause` | **Live-proven** | `simulationTime` verified frozen across 5 s |
| `riot_resume` | **Live-proven** | Resumed from exactly where it stopped |
| `riot_reset` | **Live-proven** | Idempotent; counts zeroed; definition preserved |

## Simulation behaviour

| Capability | Status | Evidence |
|------------|--------|----------|
| Spawn from multiple flow origins | **Live-proven** | 3 origins × 70 = 210, visible as three distinct streams |
| Staggered release (delay + interval) | **Live-proven** | Origins released at 0.0 / 0.5 / 1.0 s |
| Per-agent speed variation | **Live-proven** | Speed drawn per agent from the origin's range |
| Advance toward a blockade | **Live-proven** | |
| Crowd compression at a choke point | **Live-proven** | Visible in the breach capture |
| Pressure accumulation | **Live-proven** | 0 → 7.1 → 53.0 → peak 95.4 |
| Pressure decay | **Live-proven** | Falls to 0 once the segment opens |
| Blockade holds until threshold | **Live-proven** | Held through pressure 53 with break at 150 |
| Breach on trigger | **Live-proven** | Fired at pressure 95, t≈21.6 s |
| Agents pass through a breach | **Live-proven** | 138-140 through, consistently |
| Panic / retreat | **Live-proven** | 70-72 agents routed |
| Defenders hold position | **Live-proven** | Line visible and static in captures |
| Defender fallback after break | **Implemented, not live-proven** | `FallbackLocation` is stored and validated but no processor moves defenders on break |
| Deterministic re-run | **Live-proven** | 3 runs, identical counts, breach within 0.01 s |
| Idempotent reset | **Live-proven** | Called twice, no error, no crash |
| Survives editor restart without stale state | **Live-proven** | Editor restarted 4×; feature loaded clean each time. Note: scenarios are in-process and must be re-authored |

## Representation and evidence

| Capability | Status | Notes |
|------------|--------|-------|
| ISM placeholder rendering | **Live-proven** | 210 + 34 instances, both meshes set, visible in PIE |
| Visual proof of the full sequence | **Live-proven** | 7 stage captures of the PIE window |
| Capture via `viewport_capture` / `HighResShot` | **Blocked** | Both photograph the *editor* viewport; PIE runs in a floating window. Evidence required an OS-level window grab. See findings §12 |
| `MassRepresentation` LOD traits | **Planned** | Module linked and available, deliberately unused |

## Structured errors

| Capability | Status |
|------------|--------|
| All 18 required `RIOT_*` codes declared | **Automated-test-only** (asserted by `riot-crowd.test.ts`) |
| `RIOT_DUPLICATE_ID`, `RIOT_INVALID_THRESHOLD`, `RIOT_SCENARIO_NOT_FOUND`, `RIOT_FACTION_NOT_FOUND`, `RIOT_INVALID_COUNT`, `RIOT_PIE_NOT_RUNNING` | **Live-proven** | Each returned correctly from a real editor |
| `RIOT_FEATURE_NOT_INSTALLED` on 404 | **Automated-test-only** | The plugin was installed throughout the live run |
| `RIOT_RESET_FAILED` downgrade | **Implemented, not live-proven** | Reset always succeeded, so the failure branch never ran |
| `RIOT_UNSUPPORTED_ENGINE_VERSION` | **Implemented, not live-proven** | Only 5.6.1 was tested |
| `dryRun` leaves no partial state | **Live-proven** | 6 consecutive rejections left the scenario byte-identical |

## Explicitly unsupported

Reported as `false` by `riot_get_capabilities`, per the milestone's non-goals:

`supportsHeroPromotion`, `supportsMelee`, `supportsZoneGraphNavigation`,
`supportsStateTreeBehaviour`, `supportsSequencerCapture`

Also out of scope and not implemented: individual combat, weapons, injury, ragdolls, arrests,
looting, destruction, tactical AI, motion matching, Movie Render Queue, UE 5.8.

## Known gaps

| Gap | Status | Impact |
|-----|--------|--------|
| Scenarios do not persist across editor restart | **By design** | In-process store; re-author or script it |
| Whole crowd flips to `Breaching` at once | **Implemented, crude** | Any agent whose nearest blockade is broken breaches regardless of distance, so compression is brief |
| Defenders never move | **Planned** | `FallbackLocation` is plumbed but unused |
| Hotspots have no behaviour | **Planned** | Annotation + activation flag only |
| Game thread ~64 ms at peak | **Known** | ISM rebuilt wholesale each tick; see the test record |
