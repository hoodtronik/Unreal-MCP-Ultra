# ue_montage.py - anim montages (create from clips, sections, slot) and playing them through an ABP Slot, behind the
# anim_montage tools (Tools/src/tools/montage.ts). Exec'd after ue_posing.py, ue_anim.py and ue_abp.py.
import unreal


def montage_info(path):
    """What Python can read of a montage (5.6: slot_anim_tracks / composite_sections are not exposed)."""
    m = unreal.load_asset(path)
    if not isinstance(m, unreal.AnimMontage):
        raise ValueError("Not an AnimMontage: " + path)
    return {"ok": True, "path": path, "length": round(m.get_play_length(), 4),
            "slots": [str(x) for x in unreal.AnimationLibrary.get_montage_slot_names(m)],
            "sections": [str(m.get_section_name(i)) for i in range(m.get_num_sections())],
            "group": str(m.get_group_name()), "blend_in": round(m.get_default_blend_in_time(), 4),
            "blend_out": round(m.get_default_blend_out_time(), 4),
            "skeleton": m.get_skeleton().get_path_name().split(".")[0]}


def montage_create(path, clip):
    pkg, name = path.rsplit("/", 1)
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        raise ValueError(path + " exists")
    src = resolve_anim(clip, ("AnimSequence",))
    f = unreal.AnimMontageFactory()
    f.set_editor_property("source_animation", src)
    m = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, pkg, unreal.AnimMontage, f)
    if m is None:
        raise RuntimeError("create_asset returned None for " + path)
    unreal.EditorAssetLibrary.save_loaded_asset(m, False)
    return montage_info(path)


def _ai(label, pie=False):
    act = _find_actor(label, _world(pie))
    ai = act.get_component_by_class(unreal.SkeletalMeshComponent).get_anim_instance()
    if ai is None:
        raise ValueError("'%s' has no anim instance" % label)
    return ai


def montage_play(label, montage, rate=1.0, start=0.0, section=None, pie=False):
    m = unreal.load_asset(montage)
    ai = _ai(label, pie)
    length = ai.montage_play(m, float(rate), unreal.MontagePlayReturnType.MONTAGE_LENGTH, float(start), True)
    if section:
        ai.montage_jump_to_section(section, m)
    return {"ok": length > 0, "length": round(length, 4), "playing": bool(ai.montage_is_playing(m))}


def montage_state(label, montage, pie=False):
    m = unreal.load_asset(montage)
    ai = _ai(label, pie)
    return {"ok": True, "playing": bool(ai.montage_is_playing(m)), "active": bool(ai.montage_is_active(m)),
            "position": round(ai.montage_get_position(m), 4), "section": str(ai.montage_get_current_section(m)),
            "slot_weight": round(ai.blueprint_get_slot_montage_local_weight("DefaultSlot"), 4),
            "time": round(unreal.SystemLibrary.get_game_time_in_seconds(ai), 4)}


def montage_hold(label, montage, position, pie=False):
    """Play (if needed), pause and park the montage at `position` s; the pose shows on the next tick."""
    m = unreal.load_asset(montage)
    ai = _ai(label, pie)
    if not ai.montage_is_active(m):
        ai.montage_play(m, 1.0, unreal.MontagePlayReturnType.MONTAGE_LENGTH, 0.0, True)
    ai.montage_pause(m)
    ai.montage_set_position(m, float(position))
    return {"ok": True}


def pose_vs_clip(label, clip, t, pie=False):
    """Rendered pose of `label` (posed last tick) vs `clip` evaluated at exactly t s: worst bone distance (cm),
    root-relative component space over the clip_match bones. Also returns the best time in the clip (diagnostic)."""
    act = _find_actor(label, _world(pie))
    sk = act.get_component_by_class(unreal.SkeletalMeshComponent)
    root = sk.get_bone_name(0)
    r0 = sk.get_socket_transform(root, unreal.RelativeTransformSpace.RTS_COMPONENT).translation
    now = {b: sk.get_socket_transform(b, unreal.RelativeTransformSpace.RTS_COMPONENT).translation - r0
           for b in _MATCH_BONES if sk.get_bone_index(b) >= 0}
    anim = unreal.load_asset(clip)
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("optional_skeletal_mesh", sk.get_skeletal_mesh_asset())

    def worst_at(tt):
        pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, tt, opts)
        q0 = unreal.AnimPoseExtensions.get_bone_pose(pose, root, unreal.AnimPoseSpaces.WORLD).translation
        w, wb = 0.0, None
        for b, p in now.items():
            q = unreal.AnimPoseExtensions.get_bone_pose(pose, b, unreal.AnimPoseSpaces.WORLD).translation - q0
            d = (p - q).length()
            if d > w:
                w, wb = d, b
        return w, wb
    w, wb = worst_at(float(t))
    return {"ok": True, "cm": round(w, 3), "bone": wb, "t": float(t)}


def montage_jump(label, montage, section, pie=False):
    """Jump to a section and pause; the montage position is read back on the next call."""
    m = unreal.load_asset(montage)
    ai = _ai(label, pie)
    if not ai.montage_is_active(m):
        ai.montage_play(m, 1.0, unreal.MontagePlayReturnType.MONTAGE_LENGTH, 0.0, True)
    ai.montage_jump_to_section(section, m)
    ai.montage_pause(m)
    return {"ok": True}


def montage_stop(label, pie=False):
    _ai(label, pie).montage_stop(0.0)
    return {"ok": True}


def subset_match(label, clip, bones, fps=60.0, pie=False):
    """Best frame of `clip` for a SUBSET of bones (root-relative component space): worst-bone cm at that frame."""
    act = _find_actor(label, _world(pie))
    sk = act.get_component_by_class(unreal.SkeletalMeshComponent)
    root = sk.get_bone_name(0)
    r0 = sk.get_socket_transform(root, unreal.RelativeTransformSpace.RTS_COMPONENT).translation
    now = {b: sk.get_socket_transform(b, unreal.RelativeTransformSpace.RTS_COMPONENT).translation - r0 for b in bones}
    anim = unreal.load_asset(clip)
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("optional_skeletal_mesh", sk.get_skeletal_mesh_asset())
    best, bt = 1e9, 0.0
    n = max(1, int(anim.get_play_length() * fps))
    for i in range(n + 1):
        t = min(anim.get_play_length(), i / fps)
        pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, t, opts)
        q0 = unreal.AnimPoseExtensions.get_bone_pose(pose, root, unreal.AnimPoseSpaces.WORLD).translation
        w = max((p - (unreal.AnimPoseExtensions.get_bone_pose(pose, b, unreal.AnimPoseSpaces.WORLD).translation - q0)).length()
                for b, p in now.items())
        if w < best:
            best, bt = w, t
    return {"ok": True, "cm": round(best, 3), "at": round(bt, 3)}
