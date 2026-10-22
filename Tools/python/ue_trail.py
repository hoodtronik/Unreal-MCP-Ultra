# ue_trail.py - motion trails: a bone's world path over a frame range, measured and (optionally) drawn as marker
# spheres in the level for captures, behind pose_trail (Tools/src/tools/pose-trail.ts). Exec'd after ue_posing.py.
import unreal

FOLDER = "MCP_Trails"


def trail_point(seq_path, binding_name, bone, next_frame=None):
    """CURRENT frame (posed last tick): the bone's world position; then scrub to next_frame."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    if sk is None:
        raise RuntimeError("'%s' has no skeletal mesh" % binding_name)
    allb = _bone_map(sk)
    real = bone if bone in allb else resolve_role(allb, bone)
    if not real:
        raise ValueError("bone/role '%s' not found" % bone)
    p = sk.get_socket_location(real)
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "bone": real,
           "p": [round(p.x, 3), round(p.y, 3), round(p.z, 3)]}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out


def trail_draw(name, points, radius=1.5, color=(1.0, 0.3, 0.1)):
    """Marker spheres at the points (one StaticMeshActor each, folder MCP_Trails, labels <name>_NNN), tinted."""
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    trail_clear(name)
    sphere = unreal.load_asset("/Engine/BasicShapes/Sphere")
    base = unreal.load_asset("/Engine/BasicShapes/BasicShapeMaterial")
    mi = unreal.MaterialInstanceDynamic.create(base, None) if False else None
    s = float(radius) * 2.0 / 100.0
    made = 0
    for i, p in enumerate(points):
        a = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(*p))
        a.set_actor_label("%s_%03d" % (name, i))
        a.set_folder_path(FOLDER)
        c = a.static_mesh_component
        c.set_static_mesh(sphere)
        c.set_world_scale3d(unreal.Vector(s, s, s))
        c.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
        c.set_cast_shadow(False)
        made += 1
    _tint(name, color)
    return {"ok": True, "markers": made}


def _tint(name, color):
    path = "/Game/_MCPLab/Seq/Props/MI_Trail_%s" % name
    mi = unreal.load_asset(path)
    if mi is None:
        f = unreal.MaterialInstanceConstantFactoryNew()
        pkg, n = path.rsplit("/", 1)
        mi = unreal.AssetToolsHelpers.get_asset_tools().create_asset(n, pkg, unreal.MaterialInstanceConstant, f)
        mi.set_editor_property("parent", unreal.load_asset("/Engine/BasicShapes/BasicShapeMaterial"))
    unreal.MaterialEditingLibrary.set_material_instance_vector_parameter_value(mi, "Color", unreal.LinearColor(*color, 1.0))
    unreal.EditorAssetLibrary.save_loaded_asset(mi, False)
    for a in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
        if a.get_actor_label().startswith(name + "_") and isinstance(a, unreal.StaticMeshActor):
            a.static_mesh_component.set_material(0, mi)


def trail_clear(name=None):
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    n = 0
    for a in eas.get_all_level_actors():
        if str(a.get_folder_path()) == FOLDER and (name is None or a.get_actor_label().startswith(name + "_")):
            eas.destroy_actor(a)
            n += 1
    return {"ok": True, "removed": n}
