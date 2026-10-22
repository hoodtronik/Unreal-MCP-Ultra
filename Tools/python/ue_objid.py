# ue_objid.py - object ID (segmentation) pass without the MRQ mask plugin: per-binding Custom Depth Stencil IDs and a
# post-process material that paints each ID a flat colour, rendered as an extra MRQ pass. Behind shot_object_ids
# (Tools/src/tools/object-ids.ts). Exec'd after ue_posing.py and ue_shot.py (render_passes_start, PP_MATERIALS).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): this install has no MoviePipelineObjectIdRenderPass (Cryptomatte needs the
# "Movie Render Pipeline Mask Render Pass" plugin - enabling it is the user's call). Stencil IDs need
# r.CustomDepth=3, set only for the render through the job's console-variable setting, never in project settings.
import unreal

MEL = unreal.MaterialEditingLibrary

# HLSL: stencil 0 -> black; id -> a fixed saturated colour (same table in object-ids.ts).
PALETTE = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (1, 0, 1), (0, 1, 1), (1, 0.5, 0), (0.5, 0, 1),
           (0, 1, 0.5), (1, 0, 0.5), (0.5, 1, 0), (0, 0.5, 1)]


def _code():
    rows = ["if (s < %d.5) return float3(%g,%g,%g);" % (i + 1, c[0], c[1], c[2]) for i, c in enumerate(PALETTE)]
    return "float s = floor(S + 0.5);\nif (s < 0.5) return float3(0,0,0);\n" + "\n".join(rows) + "\nreturn float3(1,1,1);"


def ensure_material(path):
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.load_asset(path)
    folder, name = path.rsplit("/", 1)
    m = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
    m.set_editor_property("material_domain", unreal.MaterialDomain.MD_POST_PROCESS)
    st = MEL.create_material_expression(m, unreal.MaterialExpressionSceneTexture, -500, 0)
    st.set_editor_property("scene_texture_id", unreal.SceneTextureId.PPI_CUSTOM_STENCIL)
    cu = MEL.create_material_expression(m, unreal.MaterialExpressionCustom, -250, 0)
    ci = unreal.CustomInput()
    ci.set_editor_property("input_name", "S")
    cu.set_editor_property("inputs", [ci])
    cu.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT3)
    cu.set_editor_property("code", _code())
    MEL.connect_material_expressions(st, "Color", cu, "S")
    MEL.connect_material_property(cu, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    MEL.recompile_material(m)
    unreal.EditorAssetLibrary.save_loaded_asset(m, False)
    return m


def _prims(obj):
    """Primitive components of an actor - also of a spawnable TEMPLATE, whose components are not registered, so
    get_components_by_class returns none (live: the template kept stencil 0 and the PIE render was all black)."""
    if obj is None:
        return []
    out = list(obj.get_components_by_class(unreal.PrimitiveComponent)) if hasattr(obj, "get_components_by_class") else []
    for attr in ("skeletal_mesh_component", "static_mesh_component"):
        c = getattr(obj, attr, None)
        if c is not None and c not in out:
            out.append(c)
    return out


def assign_ids(seq_path, names):
    """Stencil id i+1 for names[i] (binding, else level actor label) on the live actor AND the spawnable template
    (MRQ renders in PIE, where spawnables are rebuilt from the template)."""
    seq = load_sequence(seq_path, open_it=True)
    out = []
    for i, n in enumerate(names):
        objs = []
        try:
            b = find_binding(seq, n)
            objs = [bound_actor(seq, b)]
            tpl = b.get_object_template() if hasattr(b, "get_object_template") else None
            if tpl:
                objs.append(tpl)
        except ValueError:
            a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == n), None)
            if a is None:
                raise ValueError("no binding or level actor '%s'" % n)
            objs = [a]
        k = 0
        for o in objs:
            for c in _prims(o):
                c.set_editor_property("render_custom_depth", True)
                c.set_editor_property("custom_depth_stencil_value", i + 1)
                k += 1
        out.append({"name": n, "id": i + 1, "components": k, "color": PALETTE[i % len(PALETTE)]})
    return {"ok": True, "ids": out}


def render_ids_start(seq_path, material, width=960, height=540, start=None, end=None):
    PP_MATERIALS["object_id"] = material
    r = render_passes_start(seq_path, ["lit", "object_id"], None, width, height, start, end, "png", cvars={"r.CustomDepth": 3})
    return r
