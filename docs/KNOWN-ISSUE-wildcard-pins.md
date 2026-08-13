# Known issue: wildcard pins never resolve types via MCP connections

<!-- CLAUDE-NOTE: Filed 2026-08-04 by Claude Code after hitting this building BP_BackgroundSlideshow
     in VoxelWorld. Do not remove without fixing the underlying issue. -->

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
