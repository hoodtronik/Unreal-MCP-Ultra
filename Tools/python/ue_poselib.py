# ue_poselib.py - Control Rig pose library in Sequencer (pose_library_save / pose_library_apply MCP tools).
# Exec'd after ue_posing.py (load_sequence, find_binding, rig_proxy, skel_comp, control_type, _set_one, evaluate,
# _v, _bone_map, resolve_role, L, FN, DR).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): poses are stored as ControlRigPoseAsset (the asset type the Animation-mode
# Poses tool uses). ControlRigPoseAsset.paste_pose(do_key=True) writes NO keys outside the Control Rig edit mode and
# changes nothing without a control selection, so poses are applied by keying each stored control value through
# the Sequencer API. Verified: wave frame 20 -> pose asset -> another frame: every bone 0.0 cm.
# Mirroring is NOT implemented: paste_pose(do_mirror) + hierarchy readback, and a rig-space S*G*S mirror with an
# initial-pose axis fix, both left the arms 12-75 cm off (centre line exact) - see targets/unreal/NOTES.md.
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

