# ue_poseable.py - "statues": a PoseableMeshComponent actor that copies a live character's pose (level actor or
# sequence binding at a frame), optional per-bone edits, frozen afterwards. Behind pose_statue
# (Tools/src/tools/pose-statue.ts). Exec'd after ue_posing.py (load_sequence, find_binding, skel_comp, evaluate, _eas).
import math

import unreal

STATUE_BP = "/Game/_MCPLab/Poseable/BP_MCPPoseable"   # Actor + PoseableMeshComponent "Pose" (created with the MCP)


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
    return a, (a.get_component_by_class(unreal.PoseableMeshComponent) if a else None)


def statue_make(label, source, seq_path=None, location=(0, 0, 0), yaw=None, bp=STATUE_BP, edits=None):
    """Copy the source's CURRENT pose (scrub the sequence first; bones refresh between calls) onto a statue."""
    src = _source_comp(seq_path, source)
    a, pc = _statue(label)
    if a is None:
        cls = unreal.EditorAssetLibrary.load_blueprint_class(bp)
        a = _eas().spawn_actor_from_class(cls, unreal.Vector(*location))
        a.set_actor_label(label)
        pc = a.get_component_by_class(unreal.PoseableMeshComponent)
    if pc is None:
        raise RuntimeError("%s has no PoseableMeshComponent" % bp)
    a.set_actor_location(unreal.Vector(*location), False, False)
    sr = src.get_owner().get_actor_rotation()
    a.set_actor_rotation(unreal.Rotator(yaw=float(yaw) if yaw is not None else sr.yaw), False)
    pc.set_skinned_asset_and_update(src.get_skinned_asset() if hasattr(src, "get_skinned_asset") else src.get_skeletal_mesh_asset(), True) \
        if hasattr(pc, "set_skinned_asset_and_update") else pc.set_skeletal_mesh_asset(src.get_skeletal_mesh_asset())
    pc.copy_pose_from_skeletal_component(src)
    # CLAUDE-NOTE (2026-10-22, live): a copied walk pose keeps its root motion in the root bone (root at (0,375,0) in
    # component space at f30), so the statue stood 3.7 m from where it was placed. The root's translation is zeroed so
    # the body stands at `location`; comparisons are root-relative.
    pc.set_bone_location_by_name("root", unreal.Vector(0, 0, 0), unreal.BoneSpaces.COMPONENT_SPACE)
    turned = {}
    for e in edits or []:
        # additive: the delta (pitch, yaw, roll) is applied on top of the copied COMPONENT-space rotation
        # (set_bone_rotation_by_name alone replaces the orientation)
        cur = pc.get_bone_rotation_by_name(e["bone"], unreal.BoneSpaces.COMPONENT_SPACE)
        d = unreal.Rotator(pitch=e["rotation"][0], yaw=e["rotation"][1], roll=e["rotation"][2])
        new = unreal.MathLibrary.compose_rotators(cur, d)
        pc.set_bone_rotation_by_name(e["bone"], new, unreal.BoneSpaces.COMPONENT_SPACE)
        got = pc.get_bone_rotation_by_name(e["bone"], unreal.BoneSpaces.COMPONENT_SPACE)
        turned[e["bone"]] = round(math.degrees(cur.quaternion().angular_distance(got.quaternion())), 2)
    return {"ok": True, "statue": label, "turned": turned}


def statue_where(label):
    a, pc = _statue(label)
    p = pc.get_bone_location_by_name("pelvis", unreal.BoneSpaces.WORLD_SPACE)
    l = a.get_actor_location()
    return {"ok": True, "actor": [round(l.x, 2), round(l.y, 2), round(l.z, 2)], "pelvis": [round(p.x, 2), round(p.y, 2), round(p.z, 2)]}


def statue_compare(label, source, seq_path=None, bones=("pelvis", "head", "hand_l", "hand_r", "foot_l", "foot_r", "lowerarm_r")):
    """Statue vs source, both in COMPONENT space: per-bone cm."""
    src = _source_comp(seq_path, source)
    _, pc = _statue(label)
    CS = unreal.RelativeTransformSpace.RTS_COMPONENT
    p0 = pc.get_bone_location_by_name("root", unreal.BoneSpaces.COMPONENT_SPACE)
    q0 = src.get_socket_transform("root", CS).translation
    out = {}
    for b in bones:
        p = pc.get_bone_location_by_name(b, unreal.BoneSpaces.COMPONENT_SPACE) - p0
        q = src.get_socket_transform(b, CS).translation - q0
        out[b] = round((p - q).length(), 3)
    return {"ok": True, "cm": out}


def statue_bones(label, bones):
    _, pc = _statue(label)
    out = {}
    for b in bones:
        p = pc.get_bone_location_by_name(b, unreal.BoneSpaces.COMPONENT_SPACE)
        r = pc.get_bone_rotation_by_name(b, unreal.BoneSpaces.COMPONENT_SPACE)
        out[b] = {"p": [round(p.x, 3), round(p.y, 3), round(p.z, 3)], "r": [round(r.pitch, 3), round(r.yaw, 3), round(r.roll, 3)]}
    return {"ok": True, "bones": out}
