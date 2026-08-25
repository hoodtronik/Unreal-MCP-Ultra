# Known gap: no way to set "Call In Editor" on custom events via MCP — FIXED 2026-08-25

<!-- CLAUDE-NOTE: Filed 2026-08-25 by Claude Code after building BP_MaterialCycler in MyLab_5_6.
     GitHub issues are disabled on hoodtronik/Unreal-MCP-Ultra, so the request lives here.
     FIXED same day — see the FIX section; the manual-workaround text below is only needed on
     builds older than this fix. -->

## FIX (2026-08-25)

`add_node` (and `build_graph`, which passes node fields through) now accepts
`callInEditor: bool` on `nodeType: "CustomEvent"` and sets `UK2Node_CustomEvent::bCallInEditor`
before compile. The flag is also serialized back in the node JSON (`callInEditor`), which fixed a
second latent bug on the way: `SerializeNode` checked `Cast<UK2Node_Event>` before
`Cast<UK2Node_CustomEvent>`, so the CustomEvent branch was dead code — custom events reported as
nodeType `"Event"` and their parameter list never serialized. Branch order swapped.

Regression tests: `Tools/test/tools/add-node.test.ts` ("adds a CustomEvent with callInEditor",
"defaults callInEditor to false when omitted").

## Symptom

Custom events created through `add_node` / `build_graph` cannot become Details-panel buttons:
there is no `callInEditor` option on the CustomEvent node spec, and no generic node-property
setter tool exists.

The editor-Python escape hatch also fails: `K2Node_CustomEvent::bCallInEditor` is a bare
`UPROPERTY()` (no `EditAnywhere` / `BlueprintReadWrite`), so
`node.set_editor_property('bCallInEditor', True)` raises
*"Property 'bCallInEditor' ... is protected and cannot be set"*. (Finding the node works fine
via `unreal.ObjectIterator()` + class-name match — only the write is blocked.)

## Manual workaround

One-time, in the Blueprint editor: select each custom event node → Details → tick
**Call In Editor** → compile → save. The flag persists in the asset.

## Suggested fix

Add `callInEditor: bool` to the CustomEvent node spec in both `add_node` and `build_graph`
(TypeScript schema + `BlueprintMCPHandlers_Mutation.cpp` / `_BuildGraph.cpp`): after creating
the `UK2Node_CustomEvent`, set `bCallInEditor = true` before the compile+save step.

## First real cost

`BP_MaterialCycler` (MyLab_5_6, `/Game/Tools/BP_MaterialCycler`, 2026-08-25): everything was
MCP-authorable except the two buttons, which needed the manual checkbox step. Its cycle logic
also had to route through `PythonScriptLibrary::ExecutePythonCommand` + `Content/Python/mat_cycler.py`
because of the open wildcard-pin issue (`KNOWN-ISSUE-wildcard-pins.md`) blocking
`Array_Get`/`Array_Length` — fixing both issues would make this whole class of editor-tool BPs
buildable natively.
