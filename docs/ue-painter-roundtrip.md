# UE side of the Painter round-trip — gotchas that cost real time

<!-- CLAUDE-NOTE: written 2026-08-25 after the SM_Container20F_variant1 weathering session
     (MyLab_5_6). Painter-side pipeline lives in the Substance-Paint-MCP repo:
     docs/ue-painter-workflow.md. This file records the UE/BlueprintMCP-side facts. -->

## Mesh export (UE → Painter)

- **Actor override ≠ asset slot.** `comp.get_material(0)` can differ from
  `sm.static_materials[0].material_interface` (None + slot "WorldGridMaterial" here). Painter
  names texture sets from the FBX material name, so export with the ASSET slot fixed: assign
  material + slot name in memory, `AssetExportTask` + `StaticMeshExporterFBX`
  (`automated=True, prompt=False`), then revert and DON'T save. Verify by grepping the .fbx
  bytes for the material name.
- Asset export lands the mesh at origin; level export would bake world transform in.

## Resolving what a MaterialInstance actually uses

- `get_material_instance_parameters` (MCP tool) shows "(default)" for inherited params —
  resolve through the chain with `mi.get_texture_parameter_value(...)` /
  `get_vector_parameter_value(...)` in python. Here the "Base Texture" resolved to the 64×64
  engine placeholder `127grey` — the visible color was a VECTOR param. Never assume the
  base color is a texture.

## Texture import (Painter → UE)

- Mask/data textures: `AssetImportTask` then set `srgb=False` +
  `compression_settings=TC_MASKS`, save. Re-import with `replace_existing=True` keeps
  references intact (never delete+recreate a texture other assets use).
- Sampler type in materials must match the texture (memory rule): sRGB→COLOR,
  TC_Normalmap→NORMAL, TC_Masks→MASKS, linear default→LINEAR_COLOR.

## Building parametric materials via MEL (MaterialEditingLibrary)

- **Expression enumeration is python-blocked** (`mat.expressions` protected, no MEL getter), so
  a material graph CANNOT be built across multiple run_python calls — node references die with
  the call. Pattern that works: create the asset shell, SAVE it, then ONE script:
  `delete_all_material_expressions` → build everything (150+ nodes is fine) → `recompile_material`
  → save.
- **Editor crash mode found:** delete_asset + create_asset dance on a material whose earlier
  create failed mid-script (orphaned in-memory asset) crashed UE 5.6. If `create_asset` returns
  None, `load_asset` the orphan and rebuild into it instead of deleting.
- `MaterialExpressionBoundingBoxBased_0_1_UVW` is NOT python-exposed. Bottom-up gradient
  substitute: `1 - saturate((WorldPos.Z - ObjectPositionWS.Z) / ObjectBounds.Z)` — assumes the
  mesh pivot is at the base (true for this container pack); a centered pivot shifts the sweep.
- `DeterminesOutputType` functions (GetComponentByClass): connecting a class-typed VARIABLE to
  the class pin retypes the output properly; a pin DEFAULT does not (and `set_pin_default`
  false-succeeds on object/class pins — `docs/KNOWN-ISSUE-object-pin-defaults.md`).
- Coverage-growth slider (spots populate, not fade):
  `cov = saturate((mask*heightW - (1-Amount)*1.05) / 0.15) * Opacity` — at Amount=0 nothing
  crosses the threshold, at Amount=1 the full mask shows. Cheap bump that grows with coverage:
  two extra mask samples offset by ~1/1024 UV, finite-difference the alpha relief channel,
  Append(nx, ny, 0) + Add to base normal + Normalize.

## Assets produced (MyLab_5_6, Container_FREE)

- `Textures/T_Container20F_WeatherMasks` — R=edge rust, G=patch rust, B=dirt, A=relief height
- `Materials/M_Container_Weathered` (fixed-pattern sliders) and
  `M_Container_Weathered_Procedural` (growth sliders; supersedes v1 at Amount=1/Bias=0)
- `Mat_Instances/MI_Container_Weathered`, `MI_Container_Weathered_Proc`
- Painter source: `F:/__PROJECTS/11Weeks/Painter/CargoContainer.spp`
