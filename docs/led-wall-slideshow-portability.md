# BP_BackgroundSlideshow portability — root cause and the `-fix` variant

<!-- CLAUDE-NOTE (2026-08-06): companion to led-wall-background-content.md. The original
BP_BackgroundSlideshow must NOT be "repaired" in place — the golden instance in the template
levels depends on the very quirks documented here. All portable use goes through the -fix
variant. -->

**Use `/Game/_Backgrounds/BP_BackgroundSlideshow-fix`** (VoxelWorld project) whenever the
slideshow needs to exist anywhere other than the original hand-configured instance. The
original blueprint *appears* broken everywhere else by design accident, not corruption.

## Why the original only works as its one placed instance

The class owns no visuals. Its construction script runs, in order:

```
SetStaticMesh(NewMesh = None)
SetMaterial(0, Material = None)
CreateDynamicMaterialInstance(0, SourceMaterial = None)
```

All three object pins were left empty. The one working actor functions because:

1. Its mesh (`/Engine/BasicShapes/Cube`), material (`M_BackgroundSlideshow`) and wall scale
   `(0.235, 103.4, 47.76)` are **per-instance overrides** on that actor;
2. `SetStaticMesh(None)` silently no-ops on a Static-mobility component that already has a
   mesh (same engine quirk noted in the framing skill);
3. `CreateDynamicMaterialInstance(SourceMaterial=None)` falls back to whatever is already in
   slot 0 — which only that instance has.

A fresh drag has no mesh at all → renders nothing, no errors anywhere.

## Why Migrate never carried the stills

Slides load through **runtime-built path strings**
(`"/Game/_Backgrounds/Std4K/T_BG_" + index`, `Sharp4K/T_BGS_` for the sharp set).
Migrate's dependency scanner follows real property references; it cannot see strings, so the
48 textures were never gathered and the load dead-ends at `Cast Failed` in the target
project — again silently.

## What the `-fix` variant changes

| Change | Effect |
|---|---|
| BackdropMesh component template: mesh + material + wall scale baked in | fresh drag renders immediately, any level |
| The three construction pins given real defaults | belt-and-suspenders vs the template |
| `EnvLightIntensity` default 0 → 1.0 | env-light wash works out of the box |
| `SlideTextures_MigrationAnchor` array: hard refs to all 48 plates | Migrate gathers every still (verified: 48 texture deps in the asset registry) |

Load logic is untouched — sharp/std switching, index clamp, plate label, EnvRectLight wash
all behave exactly as before.

**Residual constraint:** the load strings still expect the textures at
`/Game/_Backgrounds/Std4K/` and `/Sharp4K/`. Migrate preserves those paths, so this only
bites if someone relocates the folders inside a target project afterward.

## Repro notes for future BP surgery of this kind

- `duplicate_asset` **churns node GUIDs** — refetch the graph before `set_pin_default`.
- Component templates are reached via `SubobjectDataSubsystem.k2_gather_subobject_data_for_blueprint`
  (template objects are named `<Component>_GEN_VARIABLE`).
- After `set_pin_default` reports success, verify with `get_pin_info` — pin edits have
  silently reverted before (ghost-node incident).
- Test = spawn a fresh instance far off-stage, check mesh/MID/texture on it, capture it,
  delete it.
