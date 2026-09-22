# KNOWN ISSUE: set_pin_default reports success for invalid enum values, and build_graph applies defaults after connections

Found 2026-09-02 while building the Window-mode off-axis projection in BP_Walls_Graybox.

## Symptom 1 — invalid enum default silently ignored

`build_graph` / `set_pin_default` on an enum pin with a value that is not a member of the
enum returns success, and the pin keeps its previous default. Example: `Matrix_SetColumn`'s
`Column` pin is `EMatrixColumns` whose members are `First, Second, Third, Fourth`; setting
`"W"` reported `Pin defaults: 30/30` but `get_pin_info` showed `Default value: First`, so the
matrix was built in the wrong column and every capture came out black. Nothing in the
response hinted at the rejection.

## Symptom 2 — `DeterminesOutputType` pins are typed too late

`build_graph` creates nodes, then makes connections, then sets pin defaults. For functions
whose output type follows a class pin (`Actor.GetComponentByClass` with
`ComponentClass=/Script/Engine.CameraComponent`), the `ReturnValue` is still `ActorComponent`
when the connections are made, so `ReturnValue -> <CameraComponent var>` fails with
"Incompatible pins"; the default is applied afterwards and retypes the pin. A second
`build_graph` call with just the connection succeeds — and the editor then warns that a
cast you added meanwhile is redundant.

## Workaround used

- Always `get_pin_info` an enum pin after setting it; use the enum's real member names
  (`First..Fourth` for `EMatrixColumns`, `X/Y/Z` for `EAxis`).
- For `DeterminesOutputType` functions, set the class pin default in one `build_graph`
  call and make the output connection in a second call.

## Suggested fix

- `set_pin_default` / `build_graph` pin defaults: after `TrySetDefaultValue`, compare the
  pin's `DefaultValue` with the request and return an error (with the enum's member list)
  when it did not take. For byte/enum pins, validate against `PinType.PinSubCategoryObject`
  (`UEnum::IsValidEnumName`) before applying.
- `build_graph`: apply pin defaults for class/enum pins (or at least those on
  `DeterminesOutputType` nodes) before making connections, or run two passes.

## Real cost

About 40 minutes: two rounds of black renders and a matrix dump to discover the column
enum was never set, plus a delete/rebuild cycle for the camera-component lookup.
