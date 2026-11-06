# KNOWN ISSUE: `CallFunction` can bind to a same-named function on another class

## Symptom

`add_node` / `build_graph` with `nodeType: "CallFunction"`, `className: "<MyBlueprint>"` and a
`functionName` that also exists on an engine class can create a call to the **engine** function.
The tool reports success and the Blueprint compiles.

Seen on UE 5.6.1 while building the LevelUp template:

| Requested | What the node became |
|---|---|
| `WBP_LU_Sign.SetContent` | `ContentWidget.SetContent` (pins `self`, `Content`; the expected parameters were missing) |
| `BP_LU_Marker.SetActive` | `ActorComponent.SetActive`, with the marker's output auto-wired through a new `Get RootComponent` node |

The second case compiles cleanly and fails silently at runtime: it toggles the marker's root component
and never runs the Blueprint's own function. It only showed up because a Play test read the
marker's `bActive` variable and found it still false.

## Workaround used

Give Blueprint functions a project prefix that the engine will not have (`LU_SetActive`,
`LU_ShowSign`), then read the result back with `describe_graph`. The line should say
`CALL <MyBlueprint>_C.<Function>`.

## Suggested fix

In the `CallFunction` handler, when `className` resolves to a class, look the function up on **that
class and its parents first**, and only fall back to the global search if nothing is found. Return
an error, or at least a warning naming the class actually bound, when the bound function's owner is
not that class or a parent of it.

## Real cost

About 30 minutes on one LevelUp build: one rebuilt graph for `SetContent`, plus a full Play test,
diagnosis, two node deletions per call site and a rewire for `SetActive`.
