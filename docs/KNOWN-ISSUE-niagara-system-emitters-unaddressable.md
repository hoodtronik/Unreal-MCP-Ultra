# KNOWN ISSUE: Niagara stack tools cannot edit an emitter that lives inside a System

Found 2026-10-01 building volumetric haze + dust for the CaveSong "Who My God Is" LED-wall render
(UE 5.6.1).

## Symptom

`list_emitter_modules`, `list_module_inputs`, `set_module_input`, `add_niagara_module` and
`set_renderer_property` only accept a **standalone** `UNiagaraEmitter` asset. The emitter copy that a
`UNiagaraSystem` actually runs is a sub-object of the system package
(`/Game/FX/NS_Foo.NS_Foo:EmitterName`, confirmed with `unreal.ObjectIterator(unreal.NiagaraEmitter)`),
and passing that path returns:

```
Error: NiagaraEmitter '/Game/Lighting/Haze/NS_CaveHazeVol.NS_CaveHazeVol:HangingParticulates' not found
```

So there is no way to tune a system made from a template, or a duplicate of an existing system,
through the MCP. Python is no help either: `NiagaraSystem` exposes almost nothing, and
`NiagaraEmitter.renderer_properties` is deprecated (reading it raises).

The only workflow that works is: edit the standalone emitter, then `remove_emitter_from_system` +
`add_emitter_to_system` to push a fresh copy. Editing the standalone emitter alone does NOT update
the system; the system keeps referencing the old renderer material (verified via asset-registry
dependencies).

## Related trap found in the same session (engine behaviour, not this plugin)

A system whose emitters were built with `create_niagara_emitter` (factory default emitter) never
activates once `warmup_time > 0`: `spawn_system_at_location(...).is_active()` returned False for
every warmup tried (3 s, 10 s, 30 s at 1/15 s or 0.5 s ticks). It is True again with
`warmup_time = 0`. The workaround was a `SpawnBurst_Instantaneous` (count 1, loop count limit 1)
with a very long lifetime, so nothing needs pre-simulating.

## Second gap: `take_screenshot` returned stale white frames

In the same session `take_screenshot` returned a solid-white 1278x646 PNG four times in a row,
including with the only bright object hidden, while `take_high_res_screenshot` (multiplier 1) of the
same viewport, same moment, returned the correct frame. It looks like the plain path reads a buffer
that the viewport has not redrawn into. Realtime was on and game view was on. Treat
`take_screenshot` output as untrusted until it is compared against `take_high_res_screenshot`.

## Workaround used

- For the haze, Niagara was dropped entirely: a Volume-domain material on a plain static-mesh
  sphere voxelizes into volumetric fog just as well (5.6 `VolumetricFogVoxelization.cpp` swaps
  non-sprite vertex factories for a camera-facing quad sized to the bounds). Note it only shows up
  once the Volume shaders finish compiling, which took about a minute and looked like "nothing
  happens" in the meantime.
- For dust, an existing system (`NS_Dust`, the Hanging Particulates template) was duplicated and
  used unmodified.
- `take_high_res_screenshot` was used for every look.

## Suggested fix

In `FindNiagaraEmitterByNameOrPath`, when the path contains `:` (or when a `system` + `handleName`
pair is supplied), load the system and return `Handle.GetInstance().Emitter` for the matching
`FNiagaraEmitterHandle`. After a mutation, call `System->RequestCompile(false)` and mark the
system package dirty, not the emitter's. Optionally accept `system` / `handleName` fields on every
stack tool so agents never have to know the sub-object path.

For `take_screenshot`, force a viewport redraw (`Viewport->Draw()` / `FlushRenderingCommands`)
before reading pixels, like the high-res path effectively does.

## Real cost

About 40 minutes: four remove/re-add cycles to push emitter edits into the system, a warmup
investigation, and three misleading white screenshots that briefly looked like a renderer problem.
