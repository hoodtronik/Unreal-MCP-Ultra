# Known issue: editor subsystem binds port 9847 once at startup, never retries — FIXED 2026-08-26

**Status: FIXED.** The subsystem now retries a failed bind every 15s from Tick, and a
`BlueprintMCP.Restart` console command forces a stop+rebind in-session (both suggested fixes
below were implemented). Kept for the diagnosis record.

<!-- CLAUDE-NOTE: Filed 2026-08-26 by Claude Code after losing a session start to it live.
     A windowless zombie UnrealEditor (yesterday's ElevenWeekFallSeries session, hung but
     alive) held 9847 when MyLab_5_6 launched; MyLab's subsystem logged one Warning and gave
     up. By the time anyone probed the port it was free again — but the only recovery is a
     full editor restart. Related: the multi-project port-collision hazard (two live editors
     fighting over 9847) is a separate, known workflow issue; this doc is about the missing
     RETRY/RESTART path. -->

## Symptom

The editor is open, the plugin is installed and enabled, but nothing listens on port 9847 —
every MCP call fails with connection refused. The only trace is a single startup log line:

```
BlueprintMCP: Editor subsystem failed to start MCP server (port may be in use)
```

`UBlueprintMCPEditorSubsystem::Initialize` (`BlueprintMCPEditorSubsystem.cpp`) calls
`Server->Start(9847, ...)` exactly once, and on failure resets the server permanently. If the
port is busy for even a moment during editor startup (a crashed/zombie editor from a previous
session, another project's editor, a lingering commandlet), the subsystem is dead for the
entire editor session — even after the squatter releases the port seconds later.

## Real cost

- 2026-08-26: MyLab_5_6 session start lost to a hung windowless editor from the previous day.
  Diagnosis required netstat + process forensics + reading plugin source; recovery required
  killing the zombie AND fully restarting the editor (project load time + shader warmup).
- The failure is silent from the MCP client's perspective — indistinguishable from "plugin not
  installed", which sends debugging in the wrong direction first.

## Suggested fix

Either (or both), in `UBlueprintMCPEditorSubsystem`:

1. **Retry in Tick:** if `Server` is null (or not running) because the initial bind failed,
   re-attempt `Start(9847)` on a timer (e.g. every 10–15 s). Cheap: a failed bind is one
   socket call. Log once on eventual success.
2. **Console command:** register `BlueprintMCP.Restart` via `IConsoleManager` so a user can
   recover in-session from the editor console without restarting the editor.

The retry alone would have fully self-healed the 2026-08-26 incident (the port was free again
well before anyone noticed).

## Workaround (until fixed)

1. Find the squatter: `netstat -ano | findstr 9847`, kill the stale process if it's a zombie.
2. Restart the affected editor — the subsystem only attempts the bind at startup.
