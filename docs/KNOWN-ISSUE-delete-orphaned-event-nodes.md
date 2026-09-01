# KNOWN ISSUE: delete_node cannot remove orphaned event nodes

**Symptom.** `delete_node` refuses ALL event-class nodes (FunctionEntry, Event, CustomEvent,
and K2Node_ComponentBoundEvent) with "This is the root node of the event handler — removing
it would leave an empty, uncompilable graph." The guard is a blanket class check, so it also
blocks the one case where deleting an event node is exactly right: an **orphaned
component-bound event** whose component has been removed.

**Live repro (2026-09-01, MyLab).** Making BP_Walls_Graybox project-agnostic required
stripping its LiveLink dependency: `remove_component('LiveLink')` succeeded, which left
`On Live Link Updated (LiveLink)` (K2Node_ComponentBoundEvent) dangling. That node now:
- fails compilation with "does not have a valid matching component!" (BP stuck not-valid),
- keeps `/Script/LiveLink` in the asset's dependency closure, defeating the de-plugin work.

No workaround exists through the bridge: `delete_node` refuses; the python route dead-ends
(`EdGraph.Nodes` is a protected property, and `UEdGraphNode::DestroyNode` is not a UFUNCTION,
so the found node object exposes no deletion method). Only manual deletion in the Blueprint
editor works.

**Real cost.** A fully automated "derivative BP" pipeline needs one human click at the end,
and any agent task of the form "remove plugin X from this Blueprint" cannot complete.

**Suggested fix.** In the delete_node handler, allow deletion when the node is an event-class
node that is *safe* to remove:
- `K2Node_ComponentBoundEvent` whose `ComponentPropertyName` no longer resolves to a
  component on the Blueprint (the orphan case), or any bound event when explicitly requested;
- disabled stub events (`bDisabledState`) with no connections.
Route through `FBlueprintEditorUtils::RemoveNode(Blueprint, Node, true)` which handles
delegate-binding cleanup, then recompile. Keep the refusal for FunctionEntry and for the
last event node only when its graph genuinely cannot exist empty (function graphs — the
EventGraph can hold zero events legally).
