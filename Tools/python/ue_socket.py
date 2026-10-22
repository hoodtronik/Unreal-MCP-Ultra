# ue_socket.py - skeleton / skeletal-mesh sockets for props, behind prop_socket (Tools/src/tools/props.ts).
# Exec'd after ue_posing.py and ue_props.py (load_sequence, find_binding, skel_comp, bound_actor, evaluate,
# current_frame, _prop_actor, _attach_section, _set_xform_defaults, _v).
import math

import unreal

RTS_WORLD = unreal.RelativeTransformSpace.RTS_WORLD


def _quat_angle_deg(a, b):
    d = abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
    return math.degrees(2.0 * math.acos(min(1.0, d)))


def _q(q):
    return [q.x, q.y, q.z, q.w]


def _mesh_of(sk):
    get = getattr(sk, "get_skeletal_mesh_asset", None)
    return get() if get else sk.get_editor_property("skeletal_mesh")


def _socket_info(skm, name):
    s = skm.find_socket(name)
    if s is None:
        return None
    owner = s.get_outer()
    return {"name": str(s.socket_name), "bone": str(s.bone_name), "location": _v(s.relative_location),
            "rotation": [round(s.relative_rotation.roll, 3), round(s.relative_rotation.pitch, 3),
                         round(s.relative_rotation.yaw, 3)],
            "owner": "skeleton" if isinstance(owner, unreal.Skeleton) else "mesh", "asset": owner.get_path_name()}


def socket_get(seq_path, character, socket):
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, character))
    return {"ok": True, "socket": _socket_info(_mesh_of(sk), socket)}


def socket_offset(seq_path, prop, character, bone=None):
    """The prop's CURRENT offset from its bone (posed last tick), for storing as a socket.
    CLAUDE-NOTE (2026-10-22, live 5.6.1): SkeletalMeshSocket.socket_name is read-only from Python and Skeleton.sockets
    is protected, so the socket itself is written by the plugin's /api/add-skeleton-socket (C++) - this only measures."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, character))
    pb, pa = _prop_actor(seq, prop)
    parent = bone or str(_attach_section(pb).get_editor_property("attach_socket_name"))
    skm = _mesh_of(sk)
    if sk.get_bone_index(parent) < 0:
        ps = skm.find_socket(parent)
        if ps is None:
            raise ValueError("'%s' is not a bone of %s" % (parent, character))
        parent = str(ps.bone_name)   # prop currently on a socket: store the new one on that socket's bone
    pt = pa.get_actor_transform()
    rel = pt.make_relative(sk.get_socket_transform(parent, RTS_WORLD))
    r = rel.rotation.rotator()
    return {"ok": True, "bone": parent, "skeleton": skm.skeleton.get_path_name().split(".")[0],
            "location": [rel.translation.x, rel.translation.y, rel.translation.z],
            "rotation": [r.roll, r.pitch, r.yaw], "prop_world": _v(pt.translation), "prop_quat": _q(pt.rotation)}


def socket_switch(seq_path, prop, socket):
    """Re-attach the prop to `socket` at zero offset (its scale kept); posed next tick."""
    seq = load_sequence(seq_path)
    pb, pa = _prop_actor(seq, prop)
    _attach_section(pb).set_editor_property("attach_socket_name", socket)
    _set_xform_defaults(pb, unreal.Vector(0, 0, 0), unreal.Rotator(), pa.get_actor_scale3d())
    evaluate(seq, current_frame())
    return {"ok": True}


def socket_check(seq_path, prop, character, socket):
    """Read the CURRENT frame: prop world vs the socket's world transform (posed last tick)."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, character))
    _, pa = _prop_actor(seq, prop)
    if not sk.does_socket_exist(socket):
        return {"ok": False, "error": "the posed component has no socket '%s'" % socket}
    pt = pa.get_actor_transform()
    st = sk.get_socket_transform(socket, RTS_WORLD)
    d = (pt.translation - st.translation).length()
    ang = _quat_angle_deg(pt.rotation, st.rotation)
    return {"ok": True, "frame": current_frame(), "prop_world": _v(pt.translation), "socket_world": _v(st.translation),
            "dist_cm": round(d, 4), "angle_deg": round(ang, 4),
            "prop_rot": [round(x, 3) for x in (pt.rotation.rotator().roll, pt.rotation.rotator().pitch,
                                                pt.rotation.rotator().yaw)],
            "prop_quat": _q(pt.rotation), "attached_to": str(pa.root_component.get_attach_socket_name())}
