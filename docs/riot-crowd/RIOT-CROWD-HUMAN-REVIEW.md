# Riot Crowd — Human Review

For Ilyas. Everything below was observed on this machine; nothing is projected.

## Exact test project and level

| | |
|---|---|
| Project | `F:\.bpmcp-build\RiotTest\RiotTest.uproject` — **disposable**, created for this milestone |
| Level | The engine default startup map (empty landscape + sky) plus one spawned ground cube |
| Plugins | `BlueprintMCP`, `BlueprintMCPRiotCrowd`, `MassGameplay` |
| Engine | UE 5.6.1, CL 44394996 |
| Branch / commit | `feature/riot-crowd-foundation-ue56` — see `RIOT-CROWD-STATUS.md` for the SHA |
| Production projects touched | **None.** Both `RiotTest` and `BuildHost` are throwaway and junction to the canonical repo |

## Reproducing the demonstration

1. Close every UE editor (UBT refuses to build while Live Coding holds the lock).
2. Build:
   ```powershell
   & "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" `
       UnrealEditor Win64 Development -Project="F:\.bpmcp-build\BuildHost\BuildHost.uproject" -waitmutex
   ```
3. Launch `F:\.bpmcp-build\RiotTest\RiotTest.uproject`. The MCP server auto-starts on port 9847.
4. `riot_get_capabilities` — expect `featureInstalled: true`, `supported: true`, `5.6.1`,
   `massGameplay: true`, `massEntity: true`, and `availableModules.MassEntity: true`.

   `massEntity` reports on the engine **module**, which is always present — not on the deprecated
   shell plugin, which stays off. It read `false` here until 2026-07-31; that was a probe bug, and a
   `false` now means something is genuinely wrong. On a 5.8 editor also expect
   `availableModules.MassCore: true`.
5. Author the scenario (see the Quick start in [README.md](README.md), seed `20260728`).
6. `start_pie`, then `riot_spawn` → `riot_start`.
7. Poll `riot_get_runtime_report` every 2–3 s.

To capture images, use the committed helper:

```powershell
cd Tools
powershell -NoProfile -File .\test\manual\capture-riot-pie.ps1 `
    -EvidenceRoot F:\.bpmcp-build\RiotEvidence -Name breach
```

It resolves the PIE window (titled `RiotTest Preview [NetMode: Standalone 0]`) by process name and
title pattern, refuses to capture anything else, writes only inside `-EvidenceRoot`, verifies the
PNG is non-zero, prints path/dimensions/bytes/SHA-256, and exits non-zero if the window is missing
or the output was not produced. It never launches, closes, or modifies an editor or project.

`viewport_capture` and `HighResShot` will *not* work here — see below.

## Expected visual sequence

| t (s) | What you should see |
|-------|---------------------|
| 0 | 34 defender cubes in a line; no crowd |
| ~10 | Three separate rioter clusters converging from three directions |
| ~17 | Crowd reaches the line; pressure starts climbing |
| ~21.6 | Centre of the line gives way; crowd pours through while the flanks still hold |
| ~22.4 | Roughly 40 % of the crowd turns and routs away |
| ~36 | ~140 through, ~70 scattered behind; line standing again |
| after reset | Empty field, no cubes, no cylinders |

## Performance observations

| Stage | Game thread |
|-------|-------------|
| Empty | 4.4 ms |
| Spawned, paused | 6.3 ms |
| Advancing | ~5.5 ms |
| **Peak pressure / breach** | **64.1 ms** |
| After reset | 5.1 ms |

**The 64 ms spike is the number to look at.** At 244 agents that is ~15 fps. Cause is known and not
mysterious: `TickRepresentation` clears and rebuilds every ISM instance each tick, and the
orchestration passes walk all agents linearly. This is a baseline for a later optimisation pass, not
an acceptable end state for cinematic counts.

Render-thread timings read 0.00 ms during PIE and are reported as **unavailable**, not as zero.

## Screenshots

**Committed, durable:**

| Artefact | Path |
|----------|------|
| Contact sheet, all 7 stages labelled | `docs/riot-crowd/evidence/riot-stages-contact-sheet.jpg` (245 KB, 1270×1618) |
| SHA-256 manifest | `docs/riot-crowd/evidence/EVIDENCE-SHA256.txt` (9 entries) |
| Capture helper | `Tools/test/manual/capture-riot-pie.ps1` |
| Package builder | `Tools/test/manual/build-evidence-package.ps1` |

**Originals (not committed):** `F:\.bpmcp-build\RiotEvidence\` — `A_spawned`, `B_approaching`,
`C_pressing`, `D_breach`, `E_through_panic`, `F_retreating`, `G_after_reset`, all 1286×760 PNG,
1.31–1.33 MB each. The manifest hashes authenticate them if they are ever produced for audit. All
nine hashes were re-verified independently after the manifest was written.

The originals were **not** regenerated during closeout. A separate six-capture set produced while
proving the helper works is kept apart under
`F:\.bpmcp-build\RiotEvidence\closeout-verify\` (`verify_1_spawned` … `verify_6_after_reset`) so it
cannot be confused with the reviewed evidence.

## Known limitations

1. **Scenarios do not persist across editor restarts.** In-process by design, so PIE teardown cannot
   destroy them. Re-author or script it.
2. **In-editor capture cannot see the simulation, in this PIE configuration.** `viewport_capture`
   and `HighResShot` photograph the editor viewport, where riot entities do not exist. They return
   valid-looking images of an empty field — this genuinely misled the first evidence pass.

   Scope of that claim is deliberately narrow: it was measured for the floating-window PIE that
   `start_pie` produces on UE 5.6.1 (`WorldType=PlayInEditor`, `DestinationSlateViewport=nullptr`).
   Setting `LastExecutedPlayModeType=PlayMode_InViewPort` in
   `DefaultEditorPerProjectUserSettings.ini` was tried and did **not** redirect it, because
   `start_pie` sets the session params explicitly. A build that passes `DestinationSlateViewport`,
   or Simulate-In-Editor, was **not** tested and may behave differently. This is not a claim about
   every possible PIE configuration.
3. **The whole crowd flips to breaching at once.** Any agent whose nearest blockade is broken
   breaches regardless of distance, so the compression phase is brief and the surge is uniform.
4. **Defenders never move.** `fallbackLocation` is stored and validated but nothing consumes it.
5. **Hotspots are annotations only.** They activate but drive no behaviour.
6. **Only 5.6.1 tested.** No other engine version, and no 5.8 code was added.
7. **Not isolated:** whether a bare custom `UMassProcessor` auto-registers is unproven, because the
   subsystem also writes transforms. Agents move; which code moved them is not separated.

## Three defects the live run caught

Worth knowing, because they argue for keeping the live gate rather than trusting the suite:

1. **Panic fired and did nothing** — reported `fired: true` while affecting zero agents, for ~5
   minutes of testing before the counts were read carefully.
2. **Editor-fatal crash on the second spawn** — a fixed actor name is unrecoverable after
   `Destroy()` until GC. Only a spawn/reset/respawn cycle exposed it.
3. **Pressure froze at its breaking value forever**, making a walked-through blockade look loaded.

None of these were reachable by the automated suite.

Separately, proving the new invariant *could* fail exposed a real blind spot in the repo's existing
`registration-parity.test.ts`: it matched text inside comments, so a commented-out registration
passed. Fixed.

## Audit note: the force-closed `ElevenWeekFallSeries` editor session

During the foundation milestone an editor holding
`F:\_UnrealProjects\Ilyas_ElevenWeekFallSeries_Dev\...\ElevenWeekFallSeries.uproject` was
force-terminated because it held the Live Coding lock and blocked all C++ builds.

For the record:

- That project is **unrelated** to Riot Crowd and was **not** opened, loaded, read, or modified by
  the Riot Crowd feature or by any part of this work.
- The process was terminated **only after explicit owner instruction**, chosen from options that
  included closing it manually and disabling Live Coding instead.
- The only consequence was the loss of any unsaved editor state in that session. No file in that
  project was written by this milestone.
- All Riot Crowd building and testing used the disposable `BuildHost` and `RiotTest` projects.

## Questions requiring your decision

1. **Is the extra install step acceptable?** It is what keeps MassGameplay off core users' projects.
   The alternative is folding Riot Crowd into `BlueprintMCP.uplugin` and enabling MassGameplay for
   everyone. You chose the separate plugin during the build; confirming it now that it is real.
2. **Is placeholder representation good enough for the next milestone**, or should animated
   skeletal proxies come before behaviour work? Cylinders and cubes read clearly at a distance but
   convey nothing at close range, which matters for the "hero pocket" direction.
3. **How close to the crowd will the camera actually get?** That decides whether representation LOD
   or melee pockets is the more urgent next step.
4. **Is ~15 fps at 244 agents acceptable as a working baseline**, or should optimisation come before
   any new behaviour? The fix is well understood.
5. **Should scenarios persist to disk?** Currently in-process only. Persisting them would make
   scenario authoring reusable across sessions but adds an asset/serialisation surface.

## Recommendation

**Accept as a foundation milestone, with the limitations above recorded.**

The orchestration loop the milestone set out to prove — agent command → validated MCP request →
Unreal mutation → runtime simulation → structured read-back → visual verification → performance
report → clean reset — is closed and demonstrated end to end on a real editor, with deterministic
re-runs and an idempotent reset.

What I would not accept it as: a crowd system. It is one blockade, one breach shape, no defender
behaviour, and a frame cost that will not scale. Those are the next milestone, not this one.
