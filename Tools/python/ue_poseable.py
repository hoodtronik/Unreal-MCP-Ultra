# ue_poseable.py - "statues": freeze a character's CURRENT pose (level actor or sequence binding at a frame) into a
# one-frame AnimSequence held on a plain SkeletalMeshActor, with optional bone edits. Behind pose_statue
# (Tools/src/tools/pose-statue.ts). Exec'd after ue_posing.py (load_sequence, find_binding, skel_comp, evaluate, _eas).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): the first version used a PoseableMeshComponent. Its bones read back exactly
# (0 cm) but the EDITOR VIEWPORT kept drawing the reference pose - poseable meshes only refresh their render transforms
# when they tick (PIE / movie renders showed the pose, the viewport never did). A baked one-frame clip held by a
# single-node instance renders everywhere (editor, PIE, MRQ).
import math

import unreal

STATUE_DIR = "/Game/MCP/Statues"
PARENT = unreal.RelativeTransformSpace.RTS_PARENT_BONE_SPACE
COMP = unreal.RelativeTransformSpace.RTS_COMPONENT


def _source_comp(seq_path, name):
    if seq_path:
        seq = load_sequence(seq_path, open_it=True)
        return skel_comp(seq, find_binding(seq, name))
    a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == name), None)
    if a is None:
        raise ValueError("no level actor '%s'" % name)
    c = a.get_component_by_class(unreal.SkeletalMeshComponent)
    if c is None:
        raise ValueError("'%s' has no skeletal mesh" % name)
    return c


def _statue(label):
    a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == label), None)
    return a, (a.get_component_by_class(unreal.SkeletalMeshComponent) if a else None)


def _bake(path, skel, locals_):
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        unreal.EditorAssetLibrary.delete_asset(path)
    pkg, name = path.rsplit("/", 1)
    f = unreal.AnimSequenceFactory()
    f.set_editor_property("target_skeleton", skel)
    anim = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, pkg, unreal.AnimSequence, f)
    if anim is None:
        raise RuntimeError("could not create " + path)
    ctrl = anim.get_editor_property("controller")
    ctrl.open_bracket("MCP statue", True)
    ctrl.set_frame_rate(unreal.FrameRate(30, 1), True)
    ctrl.set_number_of_frames(unreal.FrameNumber(1), True)
    for b, t in locals_.items():
        ctrl.add_bone_curve(b, True)
        ctrl.set_bone_track_keys(b, [t.translation, t.translation], [t.rotation, t.rotation], [t.scale3d, t.scale3d], True)
    ctrl.close_bracket(True)
    unreal.EditorAssetLibrary.save_loaded_asset(anim, False)
    return anim


def statue_make(label, source, seq_path=None, location=(0, 0, 0), yaw=None, bp=None, edits=None):
    """Bake the source's CURRENT pose (scrub the sequence first; bones refresh between calls) into a one-frame clip
    and hold it on a SkeletalMeshActor `label` at `location`. edits: [{bone, rotation:[pitch,yaw,roll]}] applied in
    the bone's own (parent) space on top of the copied pose."""
    src = _source_comp(seq_path, source)
    mesh = src.get_skeletal_mesh_asset()
    skel = mesh.skeleton
    ref = unreal.AnimPoseExtensions.get_reference_pose(skel)
    names = [str(n) for n in unreal.AnimPoseExtensions.get_bone_names(ref)]
    locals_ = {}
    for b in names:
        if src.get_bone_index(b) >= 0:
            t = src.get_socket_transform(b, PARENT)
        else:
            t = unreal.AnimPoseExtensions.get_bone_pose(ref, b, unreal.AnimPoseSpaces.LOCAL)
        locals_[b] = t
    # a copied locomotion pose carries its root motion in the root bone (3.7 m off in round 51): zero it
    root = names[0]
    locals_[root] = unreal.Transform(unreal.Vector(0, 0, 0), locals_[root].rotation.rotator(), locals_[root].scale3d)
    turned = {}
    for e in edits or []:
        b = e["bone"]
        if b not in locals_:
            raise ValueError("no bone '%s'" % b)
        cur = locals_[b].rotation
        d = unreal.Rotator(pitch=e["rotation"][0], yaw=e["rotation"][1], roll=e["rotation"][2]).quaternion()
        new = cur * d
        locals_[b] = unreal.Transform(locals_[b].translation, new.rotator(), locals_[b].scale3d)
        turned[b] = round(math.degrees(cur.angular_distance(new)), 2)
    clip = _bake("%s/A_Statue_%s" % (STATUE_DIR, label), skel, locals_)
    a, sk = _statue(label)
    if a is not None and not isinstance(a, unreal.SkeletalMeshActor):
        _eas().destroy_actor(a)          # an older poseable-mesh statue with this label
        a = None
    if a is None:
        a = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*location))
        a.set_actor_label(label)
        sk = a.skeletal_mesh_component
    a.set_actor_location(unreal.Vector(*location), False, False)
    sr = src.get_owner().get_actor_rotation()
    a.set_actor_rotation(unreal.Rotator(yaw=float(yaw) if yaw is not None else sr.yaw), False)
    sk.set_skeletal_mesh_asset(mesh)
    sk.set_update_animation_in_editor(True)
    sk.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    sk.play_animation(clip, False)
    sk.set_position(0.0, False)
    sk.set_play_rate(0.0)
    return {"ok": True, "statue": label, "clip": clip.get_path_name().split(".")[0], "turned": turned}


def statue_where(label):
    a, sk = _statue(label)
    p = sk.get_socket_location("pelvis")
    l = a.get_actor_location()
    return {"ok": True, "actor": [round(l.x, 2), round(l.y, 2), round(l.z, 2)], "pelvis": [round(p.x, 2), round(p.y, 2), round(p.z, 2)]}


def statue_compare(label, source, seq_path=None, bones=("pelvis", "head", "hand_l", "hand_r", "foot_l", "foot_r", "lowerarm_r")):
    """Statue (as rendered: its skeletal mesh component, posed on the previous tick) vs source, component space
    relative to the root: per-bone cm."""
    src = _source_comp(seq_path, source)
    _, sk = _statue(label)
    p0, q0 = sk.get_socket_transform("root", COMP).translation, src.get_socket_transform("root", COMP).translation
    out = {}
    for b in bones:
        p = sk.get_socket_transform(b, COMP).translation - p0
        q = src.get_socket_transform(b, COMP).translation - q0
        out[b] = round((p - q).length(), 3)
    return {"ok": True, "cm": out}
