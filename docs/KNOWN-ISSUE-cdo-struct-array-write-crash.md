# KNOWN ISSUE: set_blueprint_default with a struct-array text value writes and saves correctly, then the editor crashes

Found 2026-09-02 while seeding an example show preset on `DA_GB_ShowPreset` (a PrimaryDataAsset
Blueprint whose `Phases` variable is an array of the UserDefinedStruct `S_GB_Phase`).

## Symptom

`set_blueprint_default(blueprint="DA_GB_ShowPreset", property="Phases", value="((Name_2_...=\"Walk-in\", ...),(...))")`
- parsed the ImportText value (UserDefinedStruct members must be given by their mangled
  `Name_2_<guid>` names; enum members as `NewEnumeratorN`; objects as `Texture2D'"/Game/...'"`),
- logged `Set 'DA_GB_ShowPreset.Phases' from '' to '(...)' (saved: true)`,
- and then the editor crashed (crash folder `UECC-Windows-79969DDB...` at 13:28:28); the MCP
  bridge reported `fetch failed`. After the restart the asset was intact with the new default.

This is the same family as `KNOWN-ISSUE-cdo-write-crash.md` (CDO write -> recompile ->
reinstancing), now reproduced with a single call and a struct-array value.

## Workaround used

Do not write struct arrays to class defaults through the tool. Set them on INSTANCES instead:
python `inst.set_editor_property('Phases', other.get_editor_property('Phases'))` copies an
existing array (the generic array wrapper works even though UserDefinedStructs have no python
class), and clearing a CDO with `cdo.set_editor_property('Phases', [])` + `compile_blueprint`
+ `save_asset` did not crash.

## Suggested fix

Either skip the post-write recompile/reinstance when the edited property is not part of the
class layout (a value change never needs it), or run the compile deferred on the next tick
outside the HTTP handler. A dedicated `set_asset_property` tool for DataAsset / any UObject
instance (ImportText on an instance, no CDO involved) would remove the need entirely.

## Real cost

One editor crash and restart (about 5 minutes) plus the level-instance references that a
recompile resets (`Walls` on the LevelScriptActor had to be re-set twice this session).
