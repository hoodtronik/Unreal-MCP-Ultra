# ue_aim.py - head gaze readback for aim_offset_check (Tools/src/tools/aim-offset.ts). Exec'd after ue_posing.py,
# ue_anim.py (abp_preview, _eas, _bone_map, resolve_role).
import math

import unreal


def head_gaze(label, bone="head"):
    """World yaw / pitch (deg) of the head's gaze axis (+Y on the UE5 mannequin, see ue_posing gaze note)."""
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        raise ValueError("No level actor labelled '%s'" % label)
    sk = act.skeletal_mesh_component
    allb = _bone_map(sk)
    real = bone if bone in allb else resolve_role(allb, bone)
    if not real:
        raise ValueError("bone '%s' not found" % bone)
    t = sk.get_socket_transform(real, unreal.RelativeTransformSpace.RTS_WORLD)
    g = t.rotation.rotate_vector(unreal.Vector(0, 1, 0))   # +Y axis of the bone in world space
    yaw = math.degrees(math.atan2(g.y, g.x))
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, g.z))))
    pel = sk.get_socket_location(resolve_role(allb, "pelvis") or "pelvis")
    hd = t.translation
    return {"ok": True, "yaw": round(yaw, 3), "pitch": round(pitch, 3), "bone": real,
            "pelvis_z": round(pel.z - act.get_actor_location().z, 3),
            "spine_len": round(math.dist((pel.x, pel.y, pel.z), (hd.x, hd.y, hd.z)), 3)}
