# ue_clip.py - inspect AnimSequences and author procedural ones (bone keys -> clip), behind anim_clip_info /
# anim_clip_create (Tools/src/tools/clip.ts). Exec'd after ue_posing.py and ue_anim.py (resolve_anim).
import math

import unreal

AL = unreal.AnimationLibrary
LOCAL = unreal.AnimPoseSpaces.LOCAL


def _rate(anim):
    try:
        fr = anim.get_editor_property("data_model_interface").get_frame_rate()
        return fr.numerator / float(fr.denominator)
    except Exception:
        n = AL.get_num_frames(anim)
        return n / max(1e-6, anim.get_play_length())


def clip_info(path, sample_bones=None, times=None):
    anim = resolve_anim(path, ("AnimSequence",))
    length = anim.get_play_length()
    info = {"ok": True, "path": anim.get_path_name().split(".")[0], "length": round(length, 4),
            "frames": AL.get_num_frames(anim), "fps": round(_rate(anim), 4),
            "skeleton": anim.get_skeleton().get_path_name().split(".")[0],
            "root_motion": bool(AL.is_root_motion_enabled(anim)),
            "curves": [str(c) for c in AL.get_animation_curve_names(anim, unreal.RawCurveTrackTypes.RCT_FLOAT)][:40],
            "notifies": [{"name": str(n.notify_name) if hasattr(n, "notify_name") else str(n.get_editor_property("notify_name")),
                          "time": round(n.get_editor_property("link_value") if False else AL.get_anim_notify_event_trigger_time(n), 4)}
                         for n in AL.get_animation_notify_events(anim)][:40],
            "sync_markers": [{"name": str(m.marker_name), "time": round(m.time, 4)} for m in AL.get_animation_sync_markers(anim)][:40]}
    try:
        r0 = AL.extract_root_track_transform(anim, 0.0)
        r1 = AL.extract_root_track_transform(anim, length)
        d = r1.translation - r0.translation
        info["root_delta"] = [round(d.x, 2), round(d.y, 2), round(d.z, 2)]
        info["root_speed_cm_s"] = round(math.hypot(d.x, d.y) / max(1e-6, length), 2)
    except Exception as e:
        info["root_delta_error"] = str(e)
    if sample_bones:
        opts = unreal.AnimPoseEvaluationOptions()
        out = {}
        for t in (times or [0.0, length / 2.0, length]):
            pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, float(t), opts)
            out[str(round(t, 4))] = {b: [round(v, 2) for v in (lambda p: (p.x, p.y, p.z))(
                unreal.AnimPoseExtensions.get_bone_pose(pose, b, unreal.AnimPoseSpaces.WORLD).translation)] for b in sample_bones}
        info["bones"] = out
    return info


def _qmul(a, b):
    x1, y1, z1, w1 = a
    x2, y2, z2, w2 = b
    return (w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2)


def _lerp_keys(keys, t, field):
    ks = sorted(keys, key=lambda k: k["time"])
    if t <= ks[0]["time"]:
        return ks[0].get(field)
    for a, b in zip(ks, ks[1:]):
        if a["time"] <= t <= b["time"]:
            u = (t - a["time"]) / max(1e-9, b["time"] - a["time"])
            u = u * u * (3 - 2 * u)   # smoothstep ease between keys
            va, vb = a.get(field) or [0, 0, 0], b.get(field) or [0, 0, 0]
            return [x + (y - x) * u for x, y in zip(va, vb)]
    return ks[-1].get(field)


def clip_create(path, skeleton, seconds, fps, bone_keys):
    """New AnimSequence of `seconds` at `fps` on `skeleton`: every bone at its reference pose, the listed bones keyed
    with rotation offsets [pitch, yaw, roll] (deg, applied in the bone's own axes on top of the reference pose) and
    optional location offsets (cm, parent space), eased between keys. bone_keys: {bone: [{time, rotation?, location?}]}"""
    pkg, name = path.rsplit("/", 1)
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        raise ValueError(path + " exists")
    skel = unreal.load_asset(skeleton)
    if not isinstance(skel, unreal.Skeleton):
        raise ValueError("Not a Skeleton: " + skeleton)
    f = unreal.AnimSequenceFactory()
    f.set_editor_property("target_skeleton", skel)
    anim = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, pkg, unreal.AnimSequence, f)
    if anim is None:
        raise RuntimeError("could not create " + path)
    ctrl = anim.get_editor_property("controller")
    n = int(round(seconds * fps))
    ctrl.open_bracket("MCP procedural clip", True)
    ctrl.set_frame_rate(unreal.FrameRate(int(fps), 1), True)
    ctrl.set_number_of_frames(unreal.FrameNumber(n), True)
    ref = unreal.AnimPoseExtensions.get_reference_pose(skel)
    names = [str(b) for b in unreal.AnimPoseExtensions.get_bone_names(ref)]
    missing = [b for b in bone_keys if b not in names]
    if missing:
        ctrl.close_bracket(True)
        raise ValueError("bones not on the skeleton: " + ", ".join(missing))
    for b in names:
        rt = unreal.AnimPoseExtensions.get_bone_pose(ref, b, LOCAL)
        rq = (rt.rotation.x, rt.rotation.y, rt.rotation.z, rt.rotation.w)
        locs, rots, scls = [], [], []
        for i in range(n + 1):
            t = i / float(fps)
            loc = rt.translation
            q = rq
            if b in bone_keys:
                r = _lerp_keys(bone_keys[b], t, "rotation")
                if r:
                    dq = unreal.Rotator(pitch=r[0], yaw=r[1], roll=r[2]).quaternion()
                    q = _qmul(rq, (dq.x, dq.y, dq.z, dq.w))
                lo = _lerp_keys(bone_keys[b], t, "location")
                if lo:
                    loc = rt.translation + unreal.Vector(*lo)
            locs.append(unreal.Vector(loc.x, loc.y, loc.z))
            rots.append(unreal.Quat(q[0], q[1], q[2], q[3]))
            scls.append(rt.scale3d)
        ctrl.add_bone_curve(b, True)
        ctrl.set_bone_track_keys(b, locs, rots, scls, True)
    ctrl.close_bracket(True)
    unreal.EditorAssetLibrary.save_loaded_asset(anim, False)
    return {"ok": True, "path": path, "frames": n, "fps": fps, "tracks": len(names), "keyed": list(bone_keys)}


def clip_bone_local(path, bone, t):
    anim = unreal.load_asset(path)
    pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, float(t), unreal.AnimPoseEvaluationOptions())
    p = unreal.AnimPoseExtensions.get_bone_pose(pose, bone, LOCAL)
    ref = unreal.AnimPoseExtensions.get_bone_pose(unreal.AnimPoseExtensions.get_reference_pose(anim.get_skeleton()), bone, LOCAL)
    return {"ok": True, "q": [p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w],
            "ref_q": [ref.rotation.x, ref.rotation.y, ref.rotation.z, ref.rotation.w],
            "loc": [p.translation.x, p.translation.y, p.translation.z],
            "ref_loc": [ref.translation.x, ref.translation.y, ref.translation.z]}
