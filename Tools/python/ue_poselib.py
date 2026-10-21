# ue_poselib.py - Control Rig pose library in Sequencer (pose_library_save / pose_library_apply MCP tools).
# Exec'd after ue_posing.py (load_sequence, find_binding, rig_proxy, skel_comp, control_type, _set_one, evaluate,
# _v, _bone_map, resolve_role, L, FN, DR).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): poses are stored as ControlRigPoseAsset (the asset type the Animation-mode
# Poses tool uses). ControlRigPoseAsset.paste_pose(do_key=True) writes NO keys outside the Control Rig edit mode and
# changes nothing without a control selection, so poses are applied by keying each stored control value through
# the Sequencer API. Verified: wave frame 20 -> pose asset -> another frame: every bone 0.0 cm.
# Mirroring: pose_mirror (see the mirroring section below).
import json

import unreal

def _pose_asset(path, create=False):
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        a = unreal.load_asset(path)
        if not isinstance(a, unreal.ControlRigPoseAsset):
            raise ValueError(path + " is not a ControlRigPoseAsset")
        return a, False
    if not create:
        raise ValueError("pose asset not found: " + path)
    folder, name = path.rsplit("/", 1)
    a = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.ControlRigPoseAsset, None)
    if a is None:
        raise RuntimeError("could not create " + path)
    return a, True


def poselib_save(seq_path, binding_name, asset_path):
    """Store the binding's CURRENT Control Rig pose (scrub to the frame in an earlier call) as a pose asset."""
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    pa, created = _pose_asset(asset_path, create=True)
    pa.save_pose(rig, True)
    # bone snapshot (actor space) + mesh, so an apply can verify itself without the source sequence
    snap = bones_local(seq_path, binding_name)["bones"]
    sk = skel_comp(seq, find_binding(seq, binding_name))
    eal = unreal.EditorAssetLibrary
    eal.set_metadata_tag(pa, "mcp_bones", json.dumps(snap))
    eal.set_metadata_tag(pa, "mcp_mesh", sk.get_skeletal_mesh_asset().get_path_name().split(".")[0])
    eal.set_metadata_tag(pa, "mcp_source", "%s:%s@%d" % (seq_path, binding_name, current_frame()))
    eal.save_loaded_asset(pa, False)
    return {"ok": True, "asset": asset_path, "created": created, "controls": len(pa.get_control_names()),
            "frame": current_frame(), "bones": len(snap)}


def poselib_snapshot(asset_path):
    pa, _ = _pose_asset(asset_path)
    eal = unreal.EditorAssetLibrary
    raw = eal.get_metadata_tag(pa, "mcp_bones")
    return {"ok": True, "bones": json.loads(raw) if raw else None, "mesh": eal.get_metadata_tag(pa, "mcp_mesh") or None,
            "source": eal.get_metadata_tag(pa, "mcp_source") or None}


def mesh_of(seq_path, binding_name):
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    return {"ok": True, "mesh": sk.get_skeletal_mesh_asset().get_path_name().split(".")[0]}


def _entry_value(t, e):
    """Typed control value from a pose-asset entry: RigControlCopy.local_transform IS the control value (measured
    with the source open: equal for FK, IK and body controls on CR_Mannequin_Body; offsets are translation-only)."""
    x = e.get_editor_property("local_transform")
    r = x.rotation.rotator()
    # rotation as [pitch, yaw, roll] - the order every pose tool (ue_posing._rot) takes
    loc, rot, scl = [x.translation.x, x.translation.y, x.translation.z], [r.pitch, r.yaw, r.roll], [x.scale3d.x, x.scale3d.y, x.scale3d.z]
    if t in ("EULER_TRANSFORM", "TRANSFORM"):
        return {"location": loc, "rotation": rot, "scale": scl}
    if t == "TRANSFORM_NO_SCALE":
        return {"location": loc, "rotation": rot}
    if t == "POSITION":
        return {"location": loc}
    if t == "ROTATOR":
        return {"rotation": rot}
    if t in ("FLOAT", "INTEGER", "BOOL"):
        return {"value": (x.translation.x > 0.5) if t == "BOOL" else (int(round(x.translation.x)) if t == "INTEGER" else x.translation.x)}
    return None


def poselib_apply(seq_path, binding_name, asset_path, frame=0, controls=None):
    """Key a pose asset onto a Sequencer character at `frame` from the asset's stored control values.
    The stored entries are exact (the rotation must be passed as [pitch, yaw, roll]; a [roll, pitch, yaw] slip
    twisted every FK control); switches first, then parents before children."""
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    pa, _ = _pose_asset(asset_path)
    want = set(controls) if controls else None
    order = {str(k.name): i for i, k in enumerate(rig.get_hierarchy().get_controls())}
    rows, skipped = [], []
    for e in pa.get_editor_property("pose").get_editor_property("copy_of_controls"):
        n = str(e.get_editor_property("name"))
        if want is not None and n not in want:
            continue
        t = control_type(rig, n)
        v = _entry_value(t, e) if t else None
        if v is None:
            skipped.append(n)
            continue
        v["control"] = n
        rows.append((0 if t == "BOOL" else 1, order.get(n, 9999), v))
    for _, _, v in sorted(rows, key=lambda r: (r[0], r[1])):
        _set_one(seq, rig, v, frame, True)
    evaluate(seq, frame)
    return {"ok": True, "asset": asset_path, "keyed": len(rows), "skipped": skipped[:20], "frame": int(frame)}


POSE_BONES = ("pelvis", "spine_05", "head", "upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r",
              "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r", "index_03_l", "index_03_r")


def bones_local(seq_path, binding_name, bones=POSE_BONES):
    """Current-frame bone positions in the ACTOR's space (so characters at different places/facings compare)."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    xf = sk.get_owner().get_actor_transform()
    names = set(str(sk.get_bone_name(i)) for i in range(sk.get_num_bones()))
    out = {}
    for b in bones:
        if b in names:
            out[b] = _v(xf.inverse_transform_location(sk.get_socket_location(b)))
    return {"ok": True, "frame": current_frame(), "bones": out}



# ---- mirroring (control-level, in rig space) --------------------------------------------------------------------
# CLAUDE-NOTE (2026-10-21, live 5.6.1): mirror = every control set to its partner's rig-space global, reflected
# across the lateral axis (R' = S R S k, k from the initial pose; control initials are exact mirrors, so k = 1 on
# CR_Mannequin_Body). Root causes of the earlier failed attempts, each measured: (1) the FK controls of a limb in IK
# mode are stale, yet the partner limb ends up in FK - FK targets are derived from the bones (FK controls sit on
# their bones, 0.0 cm); (2) IK limbs mis-solve even with all IK controls on target - limbs are keyed in FK;
# (3) bones are read from the rendered mesh, not the rig hierarchy (helper bones and, in a kneel, ball_l were stale
# there by up to 5 cm).
# Verified: wave pose, 88 rendered bones within 0.1 cm of the mirror image after one write pass.

def _q(r):
    return (r.x, r.y, r.z, r.w)


def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def _qconj(a):
    return (-a[0], -a[1], -a[2], a[3])


def _qmirror(q, axis):
    """S R S for the reflection that negates `axis` (0=X,1=Y,2=Z): keep that vector component, negate the others."""
    v = [-q[0], -q[1], -q[2]]
    v[axis] = q[axis]
    return (v[0], v[1], v[2], q[3])


def mirror_name(n):
    for a, b in (("_l_", "_r_"), ("_r_", "_l_")):
        if a in n:
            return n.replace(a, b)
    for a, b in (("_l", "_r"), ("_r", "_l")):
        if n.endswith(a):
            return n[: -len(a)] + b
    return n


def mirror_partners(rig, h, keys):
    """Control -> its other-side control. By name (_l/_r), else (switches named 'Softness'/'Softness_2', 'Auto
    Interpolate_3'...) the control of the same type and base name under the mirrored parent."""
    import re
    names = set(str(k.name) for k in keys)
    par = {str(k.name): str(h.get_first_parent(k).name) for k in keys}
    base = lambda n: re.sub(r"_\d+$", "", n)
    out = {}
    for n in names:
        m = mirror_name(n)
        if m != n and m in names:
            out[n] = m
            continue
        mp = mirror_name(par[n])
        if mp == par[n]:
            continue
        cands = [c for c in names if par[c] == mp and base(c) == base(n) and control_type(rig, c) == control_type(rig, n)]
        if len(cands) == 1:
            out[n] = cands[0]
    return out


def _lateral_axis(h):
    """Component-space axis that separates the left and right side (from the initial pose)."""
    B = unreal.RigElementType.BONE
    a = h.get_global_transform(unreal.RigElementKey(B, "upperarm_l"), True).translation
    b = h.get_global_transform(unreal.RigElementKey(B, "upperarm_r"), True).translation
    d = [abs(a.x - b.x), abs(a.y - b.y), abs(a.z - b.z)]
    return d.index(max(d))


# CLAUDE-NOTE (2026-10-21, live): limbs are keyed in FK. With the switches swapped as-is, IK limbs came out wrong even
# with every IK control on its mirrored target (left upper arm placed on the inner side of the clavicle, calves
# 7-20 cm off); in FK the 88 rendered bones of the wave pose mirrored within 0.1 cm. False = FK on CR_Mannequin_Body.
FK_SWITCHES = ("arm_l_fk_ik_switch", "arm_r_fk_ik_switch", "leg_l_fk_ik_switch", "leg_r_fk_ik_switch")


def mirror_targets(seq_path, binding_name):
    """Mirrored rig-space target for every control, from the binding's CURRENT pose (read only).
    Transform controls: partner global mirrored, with the fixed axis correction k taken from the initial pose
    (R_target = S R_partner S k, k = (S R0_partner S)^-1 R0_target). Bool/float controls: swapped with the partner."""
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    h = rig.get_hierarchy()
    ax = _lateral_axis(h)
    f = current_frame()
    C = unreal.RigElementType.CONTROL
    keys = list(h.get_controls())
    names = [str(k.name) for k in keys]
    partner = mirror_partners(rig, h, keys)
    bones = set(str(k.name) for k in h.get_bones())
    sk = skel_comp(seq, find_binding(seq, binding_name))
    out = []
    for n in names:
        src = partner.get(n, n)
        t = control_type(rig, n)
        if t in ("BOOL", "FLOAT", "INTEGER"):
            v = get_control_value(seq, rig, src, f)["value"]
            if n in FK_SWITCHES:
                v = False
            out.append({"control": n, "type": t, "value": v})
            continue
        ks, kt = unreal.RigElementKey(C, src), unreal.RigElementKey(C, n)
        g = h.get_global_transform(ks, False)
        s0s, s0t = h.get_global_transform(ks, True).scale3d, h.get_global_transform(kt, True).scale3d
        bone = src[: -len("_fk_ctrl")] if src.endswith("_fk_ctrl") else None
        if bone and bone in bones:
            # an FK control of a limb in IK mode is stale (it does not follow the bone), but the partner limb takes
            # FK mode after the switch swap - so derive FK targets from the BONE (FK controls sit on their bones)
            # the RENDERED bone (component space): the rig hierarchy's copy can lag (kneel: ball_l 5 cm off)
            kb = unreal.RigElementKey(unreal.RigElementType.BONE, bone)
            rel = h.get_global_transform(ks, True).make_relative(h.get_global_transform(kb, True))
            g = rel * sk.get_socket_transform(bone, unreal.RelativeTransformSpace.RTS_COMPONENT)
        q0s, q0t = _q(h.get_global_transform(ks, True).rotation), _q(h.get_global_transform(kt, True).rotation)
        k = _qmul(_qconj(_qmirror(q0s, ax)), q0t)
        q = _qmul(_qmirror(_q(g.rotation), ax), k)
        p = [g.translation.x, g.translation.y, g.translation.z]
        p[ax] = -p[ax]
        # scale keeps the TARGET's own initial sign: right-side controls on CR_Mannequin_Body carry a negative
        # initial scale, and copying it across gave the left bones scale (-1,1,1) - reflected, inside-out skin
        # (the eyes caught it; bone positions still matched to 0.04 cm)
        sc = [g.scale3d.x * s0t.x / s0s.x, g.scale3d.y * s0t.y / s0s.y, g.scale3d.z * s0t.z / s0s.z]
        out.append({"control": n, "type": t, "q": q, "p": p, "s": sc})
    return {"ok": True, "axis": ax, "frame": f, "targets": out}


def mirror_write(seq_path, binding_name, frame, targets):
    """One write pass: values first, then transform controls parents-first, as world transforms."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = rig_proxy(seq, b)
    cw = skel_comp(seq, b).get_world_transform()
    f = FN(int(frame))
    order = {str(k.name): i for i, k in enumerate(rig.get_hierarchy().get_controls())}
    for t in targets:
        if "value" in t:
            _set_one(seq, rig, {"control": t["control"], "value": t["value"]}, frame, True)
    for t in sorted((t for t in targets if "q" in t), key=lambda t: order.get(t["control"], 9999)):
        x, y, z, w = t["q"]
        rs = unreal.Transform(location=unreal.Vector(*t["p"]), rotation=unreal.Quat(x, y, z, w).rotator(),
                              scale=unreal.Vector(*t["s"]))
        L.set_control_rig_world_transform(seq, rig, t["control"], f, rs * cw, DR, True)
    evaluate(seq, frame)
    return {"ok": True, "written": len(targets)}


def rig_bones(seq_path, binding_name, mirror=False):
    """Every bone's current position in RIG (component) space - optionally reflected across the centre plane and
    renamed to the other side, i.e. where a mirrored pose must put each bone."""
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    h = rig.get_hierarchy()
    ax = _lateral_axis(h)
    # read the RENDERED mesh pose (component space), not the rig hierarchy: helper/corrective bones are driven
    # after the rig (post-process), so the hierarchy holds stale values for them. `reflected` = bones whose scale
    # has a negative determinant (inside-out skin) - positions alone cannot see that.
    sk = skel_comp(seq, find_binding(seq, binding_name))
    out, reflected = {}, []
    R = unreal.RelativeTransformSpace.RTS_COMPONENT
    for i in range(sk.get_num_bones()):
        n = str(sk.get_bone_name(i))
        x = sk.get_socket_transform(n, R)
        if x.scale3d.x * x.scale3d.y * x.scale3d.z < 0:
            reflected.append(n)
        t = x.translation
        p = [t.x, t.y, t.z]
        if mirror:
            p[ax] = -p[ax]
            n = mirror_name(n)
        out[n] = [round(v, 2) for v in p]
    return {"ok": True, "axis": ax, "bones": out, "reflected": reflected}
