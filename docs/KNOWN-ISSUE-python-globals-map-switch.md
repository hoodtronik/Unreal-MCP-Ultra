# KNOWN ISSUE: run_python retained wrappers make LoadMap fatal

**Symptom.** After a session of run_python calls that leave `unreal` object wrappers
(actors, components, worlds) in the persistent Python interpreter globals, any map switch —
`LevelEditorSubsystem.load_level` from run_python, or duplicating the open level — kills
the editor: `Fatal error: EditorServer.cpp:2516 World Memory Leaks: N leaks objects and
packages` (crash #1/#2, 2026-09-01, MyLab_5_6). The callstack runs UnrealEd → LevelEditor →
PythonScriptPlugin → BlueprintMCP. This is the map-load sibling of the known
module-scope-wrapper Save crash (ue5-led-wall-content-framing skill, Gotcha 1).

**Root cause.** run_python executes every script in the same `__main__` module, so
top-level names survive between calls. Wrappers pin their UObjects; on LoadMap the old
world can't be purged and the engine's leak check is fatal by design.

**Workaround (verified).** Before any level switch: delete all non-module attributes from
`__main__`, `gc.collect()`, and only then call load_level — as the first python call of the
session where possible, with every wrapper function-local. Loads succeed reliably this way.

**Suggested fix.** Give run_python an opt-in `freshGlobals` flag (exec in a throwaway dict),
and have the C++ side purge `__main__` + run Python GC before any route that can change the
editor world (load_level/new_level/open_level handlers). Cost so far: two editor crashes and
one lost (unsaved) level duplicate in a single afternoon.
