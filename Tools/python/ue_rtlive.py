# ue_rtlive.py - runtime retargeting: a target character whose Anim Blueprint copies a source mesh's pose through an
# IK Retargeter (AnimGraphNode_RetargetPoseFromMesh, bUseAttachedParent), behind rt_live (Tools/src/tools/rt-live.ts).
# Exec'd after ue_posing.py (_eas, _bone_map, resolve_role) and ue_anim.py (abp_preview) and ue_take.py (take_subject).
import unreal

RT_ROLES = ["pelvis", "head", "hand_l", "hand_r", "foot_l", "foot_r", "lowerarm_l", "lowerarm_r", "calf_l", "calf_r"]


def _act(label):
    a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == label), None)
    if a is None:
        raise ValueError("no level actor '%s'" % label)
    return a


def rt_live_setup(src_label, tgt_label, abp_path, tgt_mesh, offset=(150, 0, 0)):
    """Target mannequin running abp_path, ATTACHED to the source actor (the node reads its attach parent's mesh)."""
    src = _act(src_label)
    l = src.get_actor_location()
    abp_preview(tgt_label, abp_path, tgt_mesh, (l.x, l.y, l.z))
    tgt = _act(tgt_label)
    tgt.attach_to_actor(src, "None", unreal.AttachmentRule.KEEP_RELATIVE, unreal.AttachmentRule.KEEP_RELATIVE,
                        unreal.AttachmentRule.KEEP_RELATIVE, False)
    tgt.root_component.set_editor_property("relative_location", unreal.Vector(*offset))
    tgt.root_component.set_editor_property("relative_rotation", unreal.Rotator())
    return {"ok": True, "parent": tgt.get_attach_parent_actor().get_actor_label() if tgt.get_attach_parent_actor() else None}


def rt_live_hold(src_label, ref_label, offline_clip, t, tgt_mesh, ref_offset=(300, 0, 0)):
    """Pause the source at clip time t and hold a reference copy of the target mesh playing the OFFLINE retarget at t
    (spawned beside the source if missing). Bones update next tick - compare in a later call."""
    src = _act(src_label)
    c = src.skeletal_mesh_component
    c.set_position(float(t), False)
    c.set_play_rate(0.0)
    ref = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == ref_label), None)
    if ref is None:
        l = src.get_actor_location()
        ref = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(l.x + ref_offset[0], l.y + ref_offset[1], l.z + ref_offset[2]))
        ref.set_actor_label(ref_label)
    rc = ref.skeletal_mesh_component
    rc.set_skeletal_mesh_asset(unreal.load_asset(tgt_mesh))
    rc.set_update_animation_in_editor(True)
    rc.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    rc.play_animation(unreal.load_asset(offline_clip), False)
    rc.set_position(float(t), False)
    rc.set_play_rate(0.0)
    return {"ok": True, "t": float(t)}


def rt_live_compare(src_label, tgt_label, ref_label, roles=None):
    """Live retargeted target vs the reference copy playing the offline retarget at the same time: pelvis-relative
    component-space distance per role (same mesh, same units); pos = the live target's pelvis-relative positions (the
    caller checks they change between samples, so a frozen target cannot pass)."""
    src, tgt, ref = _act(src_label), _act(tgt_label), _act(ref_label)
    CS = unreal.RelativeTransformSpace.RTS_COMPONENT
    a, b = tgt.skeletal_mesh_component, ref.skeletal_mesh_component
    bones = _bone_map(a)
    pel = resolve_role(bones, "pelvis")
    pa, pb = a.get_socket_transform(pel, CS).translation, b.get_socket_transform(pel, CS).translation
    out, pos = {}, {}
    for role in roles or RT_ROLES:
        bn = resolve_role(bones, role)
        if not bn:
            continue
        p = a.get_socket_transform(bn, CS).translation - pa
        q = b.get_socket_transform(bn, CS).translation - pb
        out[role] = round((p - q).length(), 3)
        pos[role] = [round(p.x, 3), round(p.y, 3), round(p.z, 3)]
    return {"ok": True, "t": round(src.skeletal_mesh_component.get_position(), 4),
            "t_ref": round(b.get_position(), 4), "cm": out, "pos": pos}
