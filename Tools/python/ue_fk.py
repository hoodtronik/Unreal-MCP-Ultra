# ue_fk.py - auto FK Control Rig (FKControlRig) for ANY skeleton, behind pose_fk (Tools/src/tools/pose-fk.ts).
# Exec'd after ue_posing.py and ue_walk.py (load_sequence, find_binding, skel_comp, rig_proxy, control_type,
# _set_one, evaluate, current_frame, _world, L, _strip_rig).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1, Fab girl - custom skeleton, no Control Rig of its own): an FKControlRig track
# gives one control per bone, named '<bone>_CONTROL' (99 on the girl, face bones included: jaw, lips, brows, lids).
# A control's value is an OFFSET on the base pose: bone local rotation = base * ctrl (Hamilton product, ctrl applied
# in the bone's own axes; measured: upperarm roll -60 -> |dot| 1.0 for base*ctrl vs 0.93 for ctrl*base). Base = the
# reference pose in REPLACE mode, the playing clip in ADDITIVE mode; muting the rig section shows the base.
import unreal

RTS_PARENT = unreal.RelativeTransformSpace.RTS_PARENT_BONE_SPACE
MODES = {"replace": unreal.ControlRigFKRigExecuteMode.REPLACE, "additive": unreal.ControlRigFKRigExecuteMode.ADDITIVE}


def _fk(seq, b):
    rig, tr = rig_proxy(seq, b)
    if not L.is_fk_control_rig(rig):
        raise ValueError("'%s' has a non-FK Control Rig track (%s); pose_fk works on an FK rig (action 'add' on a "
                         "binding without one)" % (b.get_display_name(), rig.get_class().get_name()))
    return rig, tr


def _controls(rig):
    return [str(k.name) for k in rig.get_hierarchy().get_controls()]


def resolve(rig, names):
    """Bone/control names -> control names. Accepts the full control, the bone, or a short token ('jaw',
    'upperarm_r') matched as a whole '_'-separated run inside the bone name; ambiguity is an error."""
    ctrls = _controls(rig)
    out = {}
    for n in names:
        if n in ctrls:
            out[n] = n
            continue
        if n + "_CONTROL" in ctrls:
            out[n] = n + "_CONTROL"
            continue
        tok = "_" + n.lower() + "_"
        hits = [c for c in ctrls if tok in "_" + c.lower()]
        if len(hits) != 1:
            raise ValueError("'%s' matches %s" % (n, ("no control" if not hits else ", ".join(hits[:8]))))
        out[n] = hits[0]
    return out


def bone_of(ctrl):
    return ctrl[:-len("_CONTROL")] if ctrl.endswith("_CONTROL") else ctrl


def add_fk(seq_path, binding_name, mode="replace"):
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    try:
        rig, _ = rig_proxy(seq, b)
    except ValueError:
        rig = None
    stripped = []
    if rig is not None and not L.is_fk_control_rig(rig):
        stripped = _strip_rig(b)   # auto-added default rig (absolute) would fight the FK rig
        rig = None
    created = rig is None
    if created:
        L.find_or_create_control_rig_track(_world(), seq, unreal.FKControlRig, b)
        rig, _ = _fk(seq, b)
    ok = L.set_control_rig_apply_mode(rig, MODES[mode])
    evaluate(seq, current_frame())
    return {"ok": bool(ok), "created": created, "stripped": stripped, "controls": len(_controls(rig)),
            "mode": str(L.get_fk_control_rig_apply_mode(rig)).split(".")[-1].split(":")[0]}


def fk_list(seq_path, binding_name, contains=None, limit=200):
    seq = load_sequence(seq_path)
    rig, _ = _fk(seq, find_binding(seq, binding_name))
    names = [bone_of(c) for c in _controls(rig) if not contains or contains.lower() in c.lower()]
    return {"ok": True, "count": len(names), "bones": names[:limit],
            "mode": str(L.get_fk_control_rig_apply_mode(rig)).split(".")[-1].split(":")[0]}


def _cm_per_unit(sk, bone):
    """World cm per bone-space unit (the girl's root carries scale 0.0093: 1 cm ~ 107 units)."""
    par = str(sk.get_parent_bone(bone))
    lt = sk.get_socket_transform(bone, RTS_PARENT).translation.length()
    if not par or par == "None" or lt < 1e-4:
        return 1.0
    return (sk.get_socket_location(bone) - sk.get_socket_location(par)).length() / lt


def fk_set(seq_path, binding_name, frame, rotations=None, locations=None):
    """rotations: {bone: [pitch, yaw, roll]} offsets in the bone's own axes; locations: {bone: [x, y, z]} offsets in
    the parent bone's axes in WORLD cm (converted to bone-space units). Keyed at frame."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = _fk(seq, b)
    rotations, locations = rotations or {}, locations or {}
    m = resolve(rig, sorted(set(rotations) | set(locations)))
    sk = skel_comp(seq, b)
    scale = {}
    for k, c in m.items():
        spec = {"control": c}
        if k in rotations:
            spec["rotation"] = rotations[k]
        if k in locations:
            u = _cm_per_unit(sk, bone_of(c))
            scale[c] = u
            spec["location"] = [float(v) / u for v in locations[k]]
        _set_one(seq, rig, spec, frame)
    evaluate(seq, int(frame))
    quats = {}
    for k, c in m.items():
        cur = get_control_value(seq, rig, c, int(frame))["rotation"]
        quats[c] = _q(_rot(cur).quaternion())
    return {"ok": True, "controls": m, "quats": quats, "cm_per_unit": scale}


def fk_active(seq_path, binding_name, active):
    seq = load_sequence(seq_path)
    _, tr = _fk(seq, find_binding(seq, binding_name))
    for s in tr.get_sections():
        s.set_is_active(bool(active))
    evaluate(seq, current_frame())
    return {"ok": True}


def _q(q):
    return [q.x, q.y, q.z, q.w]


def bone_locals(seq_path, binding_name, bones):
    """CURRENT frame (posed last tick): local (parent-bone space) rotation quats and world positions."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    out = {}
    for n in bones:
        t = sk.get_socket_transform(n, RTS_PARENT)
        w = sk.get_socket_location(n)
        out[n] = {"q": _q(t.rotation), "w": [round(w.x, 2), round(w.y, 2), round(w.z, 2)]}
    return {"ok": True, "frame": current_frame(), "bones": out}


RTS_WORLD = unreal.RelativeTransformSpace.RTS_WORLD


def _hq(a, b):
    x1, y1, z1, w1 = a
    x2, y2, z2, w2 = b
    return (w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2)


def _inv(q):
    return (-q[0], -q[1], -q[2], q[3])


def _arc(u, v):
    """Shortest-arc quaternion taking unit vector u onto v."""
    c = u.cross(v)
    w = 1.0 + u.dot(v)
    if w < 1e-8:   # opposite: any perpendicular axis
        ax = u.cross(unreal.Vector(1, 0, 0)) if abs(u.x) < 0.9 else u.cross(unreal.Vector(0, 1, 0))
        ax = ax / ax.length()
        return (ax.x, ax.y, ax.z, 0.0)
    n = math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z + w * w)
    return (c.x / n, c.y / n, c.z / n, w / n)


def _child(sk, bone, toward=None):
    if toward:
        return toward
    kids = [str(sk.get_bone_name(i)) for i in range(sk.get_num_bones())
            if str(sk.get_parent_bone(sk.get_bone_name(i))) == bone]
    main = [k for k in kids if "twist" not in k.lower()] or kids
    if not main:
        raise ValueError("'%s' has no child bone to aim with" % bone)
    return main[0]


def fk_aim(seq_path, binding_name, frame, bone_tok, target, toward=None):
    """One step: rotate `bone` so its child points at the WORLD target, keyed as an FK offset at frame.
    ctrl_new = ctrl_cur * local_cur^-1 * local_new (base = local_cur * ctrl_cur^-1, no mute needed). Next tick."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = _fk(seq, b)
    ctrl = resolve(rig, [bone_tok])[bone_tok]
    bone = bone_of(ctrl)
    sk = skel_comp(seq, b)
    child = _child(sk, bone, toward and resolve(rig, [toward])[toward][:-len("_CONTROL")])
    bw = sk.get_socket_transform(bone, RTS_WORLD)
    p = bw.translation
    d = sk.get_socket_location(child) - p
    t = unreal.Vector(*target) - p
    d, t = d / d.length(), t / t.length()
    err = math.degrees(math.acos(max(-1.0, min(1.0, d.dot(t)))))
    qd = _arc(d, t)
    rw = (bw.rotation.x, bw.rotation.y, bw.rotation.z, bw.rotation.w)
    lt = sk.get_socket_transform(bone, RTS_PARENT).rotation
    lq = (lt.x, lt.y, lt.z, lt.w)
    pw = _hq(rw, _inv(lq))                      # parent world = bone world * local^-1
    new_w = _hq(qd, rw)
    new_l = _hq(_inv(pw), new_w)
    cur = get_control_value(seq, rig, ctrl, int(frame))["rotation"]   # [pitch, yaw, roll]
    cq = _rot(cur).quaternion()
    cq = (cq.x, cq.y, cq.z, cq.w)
    nq = _hq(_hq(cq, _inv(lq)), new_l)
    r = unreal.Quat(nq[0], nq[1], nq[2], nq[3]).rotator()
    _set_one(seq, rig, {"control": ctrl, "rotation": [r.pitch, r.yaw, r.roll]}, frame)
    evaluate(seq, int(frame))
    return {"ok": True, "bone": bone, "child": child, "error_deg": round(err, 3)}


def fk_dir_error(seq_path, binding_name, bone_tok, target, toward=None):
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = _fk(seq, b)
    bone = bone_of(resolve(rig, [bone_tok])[bone_tok])
    sk = skel_comp(seq, b)
    child = _child(sk, bone, toward and bone_of(resolve(rig, [toward])[toward]))
    p = sk.get_socket_location(bone)
    d = sk.get_socket_location(child) - p
    t = unreal.Vector(*target) - p
    c = d.dot(t) / (d.length() * t.length())
    return {"ok": True, "frame": current_frame(), "bone": bone, "child": child,
            "error_deg": round(math.degrees(math.acos(max(-1.0, min(1.0, c)))), 3)}
