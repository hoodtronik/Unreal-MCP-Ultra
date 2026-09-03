# KNOWN ISSUE: a RenderStream (disguise) workload cannot be inspected or captured — the editor subsystem hard-codes port 9847

Found 2026-09-03 while verifying a `Show_Phase` cue change on the Wonderwall graybox streams
(MyLab_5_6 → Designer r33, layer `WallsGraybox RS`).

## Symptom

disguise launches the streamed project as a second `UnrealEditor.exe -game` process
(`-dc_cluster -RenderOffScreen ...`). That process loads BlueprintMCP too, but
`UBlueprintMCPEditorSubsystem` always calls `Server->Start(9847, ...)`; the editor that is
already open owns 9847, so the workload's bind fails silently and there is no second endpoint.
`server_status`, `capture_view`, `run_python`, `get_actor_properties` all talk to the editor,
never to the process that actually renders the streams. There is no way to read
`Show.CurrentPhase`, the surfaces' materials, or take a capture inside the workload, so
"did the disguise parameter arrive?" can only be judged from the Designer GUI.

The commandlet path does take `-port=`, the editor subsystem does not.

## Workaround used

- Designer side: Python API `field.getSequencedValue(t).value` proves what Designer sends.
- Engine side: nothing. Visual check by bringing the Designer window to the front and
  screenshotting the desktop (`System.Drawing CopyFromScreen`), then reading the PNG.
- Log-based proof does not work either: the media framework and the RenderStream plugin log
  nothing at default verbosity when a parameter changes or a media source opens.

## Suggested fix

Have the editor subsystem honour a port override so a `-game` instance can expose its own
endpoint next to the editor: `-BlueprintMCPPort=<n>` on the command line (disguise lets you add
engine arguments per asset), or an env var `BLUEPRINTMCP_PORT`, falling back to 9847. The
TypeScript side already takes a port. Optionally: if 9847 is busy and no override is given, try
9848..9850 and log the chosen port so an agent can find it in `node_0.log`.

## Real cost

About 40 minutes: two false leads (log diffs, the uefn-mcp listener that the workload also
starts — it only offers ping/status), then falling back to desktop screenshots.
