# KNOWN ISSUE: CallFunction nodes for Blueprint-defined functions bind by global name, and className cannot narrow them to a Blueprint class

Found 2026-09-01 (ApplyContentFit) and hit again 2026-09-02 (SetWallPos) on the Wonderwall
graybox Blueprints.

## Symptom

`add_node` / `build_graph` with `nodeType: CallFunction, functionName: <BlueprintFunctionOrEvent>`
and no `className` resolves the function by searching every loaded Blueprint class. When two
sibling Blueprints define the same function or custom event (here `SetWallPos` exists in both
`BP_Walls_Graybox` and `BP_WallsGraybox_TrueSize`), the node created inside `BP_Walls_Graybox`
was bound to `BP_WallsGraybox_TrueSize_C` (get_pin_info on `self`: `object (BP_WallsGraybox_TrueSize_C)`)
and compiles with "Target must have a connection". Passing `className: "BP_Walls_Graybox"` made
no difference: the node still bound to the sibling class.

Interface events are a second gap in the same area: `nodeType: OverrideEvent` looks only at the
parent native class ("Function 'GB_SetStagePreset' not found on parent class 'Actor'"), so an
event implementing a Blueprint Interface function without outputs cannot be created at all.

## Workaround used

- Give every Blueprint function / custom event a name that is unique across the project
  (`ApplyContentFitTS`, `GB_ApplyStageTS`, `GB_ApplyDoorsTS`, ...), or
- reuse a node the editor created (an orphaned self-bound `SetWallPos` call was found and rewired).
- Interfaces were dropped in favour of per-class custom events + casts.

## Suggested fix

In the function resolver, when `className` is empty, look up the name on the target Blueprint's
own `SkeletonGeneratedClass` / `GeneratedClass` (and its parents) FIRST and only fall back to the
global scan when nothing is found. When `className` names a Blueprint (with or without the `_C`
suffix), resolve it through the asset registry to the generated class instead of ignoring it.
For `OverrideEvent`, also search `ImplementedInterfaces` of the Blueprint so interface events can
be spawned (`UK2Node_Event` with `bOverrideFunction`, `EventReference` set to the interface function).

## Real cost

Roughly an hour across two sessions, plus a subagent run to locate a correctly bound node.
