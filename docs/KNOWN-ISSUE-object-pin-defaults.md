# Known issue: set_pin_default silently fails on object and class pins

<!-- CLAUDE-NOTE: Filed 2026-08-25 by Claude Code after hitting it live while building the native
     CycleMaterial function in BP_MaterialCycler (MyLab). Long known informally (skill-level gotcha
     since ~2026-08); promoted to a repo doc because the failure mode REPORTS SUCCESS. -->

## Symptom

`set_pin_default` (and the `pinDefaults` list in `build_graph`) on an **object-reference or
class-reference pin** reports success but leaves the pin unchanged. Live repro 2026-08-25:
setting `GetComponentByClass`'s `ComponentClass` pin to `"MeshComponent"` returned OK in the
`build_graph` per-item results (`Pin defaults: 4/4`), but `get_pin_info` showed the pin still at
`/Script/Engine.ActorComponent`. The false success makes downstream failures (here: a type
mismatch on the node's `DeterminesOutputType` return pin) look like unrelated bugs.

## Root cause (likely)

The handler routes every default through the string path
(`TrySetDefaultValue`-style). Object and class pins store their value in
`UEdGraphPin::DefaultObject`, set via `UEdGraphSchema::TrySetDefaultObject` after resolving the
string to a `UObject*`/`UClass*` — the string path is a no-op for them, and nothing checks
whether the value actually landed.

## Suggested fix

In the pin-default handler(s): if `Pin->PinType.PinCategory` is `PC_Object`, `PC_Class`,
`PC_SoftObject`, or `PC_SoftClass`, resolve the value string to an object/class
(`FindObject`/`LoadObject`, accepting both short names and `/Path.Name` forms) and call
`Schema->TrySetDefaultObject(Pin, Obj)`; error if the resolve fails. In all cases, after setting,
compare the pin's effective default against the request and report failure on mismatch instead of
unconditional success.

## Workarounds

- **Class pins:** create a class-typed variable (`add_variable` with `variableType:
  "class:Foo"` — its `defaultValue` DOES resolve correctly at creation) and wire its getter into
  the class pin. Bonus: on `DeterminesOutputType` functions the connected pin retypes the output
  properly (better than a pin default, which UBT applies without reconstructing the node).
- **Object pins:** same idea with an `object:Foo` variable; set the CDO default via editor python
  if needed (`unreal.get_default_object(bp.generated_class()).set_editor_property(...)`).
