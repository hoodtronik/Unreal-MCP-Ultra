# KNOWN ISSUE: Blueprint function parameters cannot be arrays (or other containers)

**Status:** open (2026-09-02)

## Symptom

`add_function_parameter` and `change_function_parameter_type` accept an `isArray: true` argument
(the same flag `add_variable` honours), but the created parameter is always a single value:

```
add_function_parameter(blueprint="BPC_GB_Show", functionName="Configure",
                       paramName="Phases", paramType="S_GB_Phase", isArray=true)
→ "Parameter: Phases: S_GB_Phase"          (no "(Array)")
```

Connecting an array variable to that pin then fails with
`Incompatible pins: Only exactly matching structures are considered compatible` (structs) or
`Array of X Object References is not compatible with X Object Reference` (objects), and the
editor silently inserts a `Make Array` node on the other side of the entry pin when it tries to
auto-repair.

There is also no way to set the container type afterwards, and no output/return parameters can
be declared either (`direction` is not a parameter of the tool).

## Workaround used

Avoid array parameters altogether: have the caller write the arrays straight into the callee's
variables with `className`-qualified `VariableSet` nodes (`{"nodeType":"VariableSet",
"className":"BPC_GB_Show","variableName":"LocalPhases"}` with `self` wired to the component),
then call a parameterless function. For a "return value", write to a variable the caller reads
back the same way.

## Suggested fix

- Honour `isArray` (and ideally `isSet` / `isMap`) in `add_function_parameter` and
  `change_function_parameter_type`: set `FEdGraphPinType::ContainerType` on the user-defined pin
  (`UK2Node_EditablePinBase::CreateUserDefinedPin`) instead of only the category/sub-category.
- Add `direction: "input" | "output"` so return values can be declared (`UK2Node_FunctionResult`
  needs to exist or be created for outputs).
- Reject unknown arguments instead of ignoring them, so the caller learns immediately.

## Real cost

About 40 minutes and one wrong architecture: a `Configure(Phases[], Preset, Presets[], Index)`
function was built, wired, found broken, then torn out and replaced by direct variable writes.
