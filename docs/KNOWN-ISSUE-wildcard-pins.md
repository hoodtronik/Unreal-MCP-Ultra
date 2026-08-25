# Known issue: wildcard pins never resolve types via MCP connections — FIXED 2026-08-25

<!-- CLAUDE-NOTE: Filed 2026-08-04 by Claude Code after hitting this building BP_BackgroundSlideshow
     in VoxelWorld. FIXED 2026-08-25 — kept for history; the "likely root cause" below turned out
     to be WRONG, see the FIX section at the bottom for what it actually was. -->

## FIX (2026-08-25)

The root cause was **not** the connection path. `UEdGraphSchema::TryCreateConnection` already runs
`PinConnectionListChanged` on both nodes (`EdGraphSchema.cpp`, under `WITH_EDITOR`), which drives
`NotifyPinConnectionListChanged` — where wildcard propagation lives. The real bug: `add_node`
spawned **every** function call as plain `UK2Node_CallFunction`, but the propagation logic for
array functions lives on the subclass `UK2Node_CallArrayFunction`. The editor palette picks the
subclass from function metadata (`UBlueprintFunctionNodeSpawner::Create`); the plugin never did.

Fixed in `HandleAddNode` by mirroring the engine's chooser: `ArrayParm` →
`UK2Node_CallArrayFunction`, `DataTablePin` → `UK2Node_CallDataTableFunction`,
`MaterialParameterCollectionFunction` → `UK2Node_CallMaterialParameterCollectionFunction`,
`CommutativeAssociativeBinaryOperator`+pure → `UK2Node_CommutativeAssociativeBinaryOperator`.
(`UK2Node_PromotableOperator` intentionally not mirrored — feature-flag-gated, off by default.)
`build_graph` delegates node creation to `HandleAddNode`, so both tools are fixed.

Regression tests: `Tools/test/tools/wildcard-pins.test.ts` — asserts the node class, the resolved
`TargetArray`/`Item` pin types after connect, and a clean compile with `Array_Get`+`Array_Length`.

## Symptom

Connecting a typed pin (e.g. a `TArray<UTexture2D*>` VariableGet output) to a **wildcard** pin
(`Array_Get`/`Array_LastIndex` TargetArray, `Select` option pins, etc.) via `connect_pins` or
`build_graph` creates the link, but the wildcard pin stays `PC_Wildcard`. Compile then fails with
"The type of Target Array is undetermined." `refresh_all_nodes` does not fix it; disconnect +
reconnect does not fix it.

## Root cause (likely)

`BlueprintMCPHandlers_Mutation.cpp` (~line 570) and `BlueprintMCPHandlers_BuildGraph.cpp` (~line 609)
call `Schema->TryCreateConnection(...)` but the wildcard type propagation that the Blueprint editor
UI performs afterwards never runs. K2 nodes like `K2Node_CallArrayFunction` resolve wildcards in
`NotifyPinConnectionListChanged` / `PostReconstructNode` — in the editor this is driven by the graph
panel notify chain, not by the schema call alone.

## Suggested fix

After a successful `TryCreateConnection` in both handlers:

```cpp
SourcePin->GetOwningNode()->PinConnectionListChanged(SourcePin);
TargetPin->GetOwningNode()->PinConnectionListChanged(TargetPin);
// or, heavier but safer for array nodes:
// Schema->ReconstructNode(*TargetPin->GetOwningNode());
FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
```

Then rebuild the plugin (UE 5.6, Win64) and restart the editor.

## Workaround used meanwhile

BP_BackgroundSlideshow avoids all wildcard nodes: assets renamed to index-based names
(`T_BG_<i>`), the graph composes soft object paths from the index with typed String ops,
loads via `LoadAsset_Blocking`, and casts to `Texture2D`/`TextureCube`.

## Re-confirmed 2026-08-13

Reproduced while building `BP_BackgroundSlideshow-Vanish` (4:1 variant): `Array_Get` wired to a
typed `TArray<UTexture2D*>` VariableGet output stayed `PC_Wildcard` after `connect_pins`,
`refresh_all_nodes`, AND back-connecting `Item` into a typed `Texture` input (no back-propagation
either). Compile error verbatim: *"The type of Item is undetermined. Connect something to Get to
imply a specific type."* Real cost: descriptive scene-name plate labels were abandoned for numeric
`T_VBG_<i>` names because index→array→display-name is unreachable. Also note `add_node` offers no
Array-Get nodeType — the node must be created as CallFunction `KismetArrayLibrary.Array_Get`.
