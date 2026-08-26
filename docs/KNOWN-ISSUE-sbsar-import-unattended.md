# Known issue: run_python imports that need a modal dialog silently fail (Substance .sbsar)

<!-- CLAUDE-NOTE: Filed 2026-08-26 after batch-importing 6 .sbsar files into MyLab_5_6. -->

## Symptom

Importing a `.sbsar` through `run_python` (`AssetImportTask` or `import_assets_automated`, with
`automated` true OR false) fails with `imported_object_paths: []` and this log line:

```
[LogSlate] A modal window tried to take control while running in unattended script mode. The window was canceled.
```

The Substance plugin's `USubstanceFactory` unconditionally opens a modal import-options dialog
(`Substance::GetImportOptions()`, SubstanceFactory.cpp:206) with no settings toggle to suppress
it, and UE's Python execution context carries the running-unattended-script flag, so Slate
auto-cancels the dialog and the factory treats that as an aborted import. Any factory that
insists on a modal will hit the same wall.

## Workaround (proven)

Defer the import out of the Python execution context with a Slate post-tick callback — the
callback fires outside the unattended flag, so the dialog actually appears and a human clicks it:

```python
state = {'done': False, 'handle': None}
def do_import(dt):
    if state['done']: return
    state['done'] = True
    try:
        task = unreal.AssetImportTask()
        task.filename = ...; task.destination_path = ...
        task.automated = False; task.factory = unreal.SubstanceFactory()
        unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    finally:
        unreal.unregister_slate_post_tick_callback(state['handle'])
state['handle'] = unreal.register_slate_post_tick_callback(do_import)
```

Caveats: while the modal is up, the BlueprintMCP subsystem does not tick — the server is
unreachable and the TS layer may fall back to trying to spawn a commandlet ("No .uproject file
found" from a non-project cwd). Queue multiple imports in ONE callback (dialogs appear
sequentially), warn the user how many clicks are coming, and verify results only after they
confirm. Batch imports of 6 sbsars this way worked first try.

## Suggested fix

A dedicated `/api/import-asset` C++ endpoint that runs `import_asset_tasks` from the server's
own tick (outside any Python context) would let the dialog appear without the callback dance —
or, better, pre-fill the Substance import options struct and pass it via
`AssetImportTask.options` if the plugin's options class is discoverable, making the import
fully headless.

## Real cost

~20 minutes of diagnosis (three failed import attempts + callstack reading) before the
callback workaround; each future sbsar batch costs one user click per file.
