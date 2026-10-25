# Known issue: `add_state_machine` ignores its `name` argument

<!-- CLAUDE-NOTE: Filed 2026-10-25 by Claude Code during the UE 5.8 verification run on
     feature/dual-ue56-ue58. Engine-independent: the bug is in shared handler code, not API drift. -->

## Symptom

`add_state_machine(blueprint="ABP_X", name="Locomotion")` succeeds, but the response reports
`Sub-graph: New State Machine`, and every follow-up call that uses `graph="Locomotion"` fails with
`State machine graph 'Locomotion' not found`.

## Cause

`HandleAddStateMachine` (`Source/BlueprintMCP/Private/BlueprintMCPHandlers_AnimMutation.cpp`) reads
`name` into `MachineName` and defaults it, but never puts it into the JSON it forwards to
`HandleAddAnimNode`, so the engine's default graph name is kept.

## Workaround used

Use the `Sub-graph:` name returned by `add_state_machine` (normally `New State Machine`) as the
`graph` argument for `add_anim_state` / `set_state_animation` / `add_anim_transition`.

## Suggested fix

Forward the name and rename the bound graph after creation (for example
`FBlueprintEditorUtils::RenameGraph(StateMachineNode->GetBoundGraph(), MachineName)`), then return
the final name. Add a test that passes `name` and asserts that the returned sub-graph matches it.

## Real cost

Four failed calls in one smoke run before the cause was found. An agent that trusts its own `name`
argument will build the whole state machine against a graph that does not exist.
