# ue_animedit.py - animation sequence editing on a COPY of a clip: notifies, notify states, sync markers, float curves,
# rate scale, crop. Behind anim_edit (Tools/src/tools/anim-edit.ts). Exec'd after ue_posing.py.
import unreal

AL = unreal.AnimationLibrary
LOCAL = unreal.AnimPoseSpaces.LOCAL
WORLD = unreal.AnimPoseSpaces.WORLD


def anim_copy(src, dst, overwrite=True):
    if src == dst:
        return {"ok": True, "path": dst, "copied": False}
    if unreal.EditorAssetLibrary.does_asset_exist(dst):
        if not overwrite:
            raise ValueError(dst + " exists")
        unreal.EditorAssetLibrary.delete_asset(dst)
    a = unreal.EditorAssetLibrary.duplicate_asset(src, dst)
    if a is None:
        raise RuntimeError("could not copy %s -> %s" % (src, dst))
    return {"ok": True, "path": dst, "copied": True}


def _anim(path):
    a = unreal.load_asset(path)
    if not isinstance(a, unreal.AnimSequence):
        raise ValueError("not an AnimSequence: " + str(path))
    return a


def _track(a, name):
    if name not in [str(t) for t in AL.get_animation_notify_track_names(a)]:
        AL.add_animation_notify_track(a, name)


def add_notify(path, time, name, track="MCP", duration=None):
    """Named notify (AnimNotify_PlayMontageNotify, its notify_name = name) or, with duration, a named window
    (AnimNotify_PlayMontageNotifyWindow) - the names montages and Blueprints react to."""
    a = _anim(path)
    _track(a, track)
    if duration:
        n = AL.add_animation_notify_state_event(a, track, float(time), float(duration), unreal.AnimNotify_PlayMontageNotifyWindow)
    else:
        n = AL.add_animation_notify_event(a, track, float(time), unreal.AnimNotify_PlayMontageNotify)
    if n is None:
        raise RuntimeError("notify not created")
    n.set_editor_property("notify_name", name)
    return {"ok": True}


def add_sync_marker(path, time, name, track="MCP"):
    a = _anim(path)
    _track(a, track)
    AL.add_animation_sync_marker(a, name, float(time), track)
    return {"ok": True}


def add_float_curve(path, name, times, values):
    a = _anim(path)
    if AL.does_curve_exist(a, name, unreal.RawCurveTrackTypes.RCT_FLOAT):
        AL.remove_curve(a, name, False)
    AL.add_curve(a, name, unreal.RawCurveTrackTypes.RCT_FLOAT, False)
    AL.add_float_curve_keys(a, name, [float(t) for t in times], [float(v) for v in values])
    return {"ok": True}


def set_rate(path, rate):
    AL.set_rate_scale(_anim(path), float(rate))
    return {"ok": True}


def crop(path, first, last):
    """Keep frames [first, last] (inclusive) - every bone track resampled from the clip itself, then the length cut."""
    a = _anim(path)
    n = AL.get_num_frames(a)
    first, last = max(0, int(first)), min(int(last), n - 1)
    if last <= first:
        raise ValueError("empty crop range")
    # CLAUDE-NOTE (2026-10-22, live): sample RAW and WITHOUT retargeting - with the default should_retarget the local
    # translations came back retargeted to the skeleton and, written as raw keys, the crop sat 2.5 cm off its source
    # at every frame (retarget applied twice).
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("should_retarget", False)
    opts.set_editor_property("evaluation_type", unreal.AnimDataEvalType.RAW)
    poses = [unreal.AnimPoseExtensions.get_anim_pose_at_frame(a, f, opts) for f in range(first, last + 1)]
    names = [str(b) for b in unreal.AnimPoseExtensions.get_bone_names(poses[0])]
    tracks = set(str(t) for t in AL.get_animation_track_names(a))
    c = a.controller if hasattr(a, "controller") else None
    if c is None:
        c = unreal.AnimSequenceExtensions.get_controller(a) if hasattr(unreal, "AnimSequenceExtensions") else None
    if c is None:
        raise RuntimeError("no AnimationDataController for " + path)
    c.open_bracket("MCP crop", True)
    # length first: keys written while the model still had the old frame count were stretched over it (3-4 cm off)
    c.set_number_of_frames(unreal.FrameNumber(last - first), True)
    for b in names:
        if b not in tracks:
            continue
        loc, rot, scl = [], [], []
        for p in poses:
            t = unreal.AnimPoseExtensions.get_bone_pose(p, b, LOCAL)
            loc.append(t.translation)
            rot.append(t.rotation)
            scl.append(t.scale3d)
        c.set_bone_track_keys(b, loc, rot, scl, True)
    c.close_bracket(True)
    unreal.EditorAssetLibrary.save_loaded_asset(a, False)
    return {"ok": True, "frames": AL.get_num_frames(a), "length": round(a.get_play_length(), 4)}


def anim_read(path, curve_times=None):
    a = _anim(path)
    ev = []
    for e in AL.get_animation_notify_events(a):
        n = e.get_editor_property("notify")
        st = e.get_editor_property("notify_state_class")
        obj = n or st
        ev.append({"name": str(obj.get_editor_property("notify_name")) if obj and hasattr(obj, "notify_name") else str(e.get_editor_property("notify_name")),
                   "time": round(AL.get_anim_notify_event_trigger_time(e), 4),
                   "duration": round(AL.get_anim_notify_event_duration(e), 4),
                   "class": type(obj).__name__ if obj else None})
    sm = [{"name": str(m.get_editor_property("marker_name")), "time": round(m.get_editor_property("time"), 4)}
          for m in AL.get_animation_sync_markers(a)]
    curves = {}
    for cn in AL.get_animation_curve_names(a, unreal.RawCurveTrackTypes.RCT_FLOAT):
        cn = str(cn)
        times, vals = AL.get_float_keys(a, cn)
        d = {"keys": [[round(t, 4), round(v, 4)] for t, v in zip(times, vals)]}
        if curve_times:
            # evaluated two ways: the curve accessor and an AnimPose evaluation with curves on (the runtime path)
            opts = unreal.AnimPoseEvaluationOptions()
            opts.set_editor_property("evaluate_curves", True)
            d["eval"] = [[round(float(t), 4), round(AL.get_float_value_at_time(a, cn, float(t)), 4),
                          round(unreal.AnimPoseExtensions.get_curve_weight(unreal.AnimPoseExtensions.get_anim_pose_at_time(a, float(t), opts), cn), 4)]
                         for t in curve_times]
        curves[cn] = d
    return {"ok": True, "length": round(a.get_play_length(), 4), "frames": AL.get_num_frames(a), "rate": AL.get_rate_scale(a),
            "notifies": ev, "sync_markers": sm, "curves": curves}


def pose_shift_check(src, dst, offset_frames, frames, bones=("pelvis", "hand_r", "foot_l", "head")):
    """Cropped clip frame f vs the source frame f + offset (component space): worst cm per sampled frame."""
    s, d = _anim(src), _anim(dst)
    opts = unreal.AnimPoseEvaluationOptions()
    out = []
    for f in frames:
        pd = unreal.AnimPoseExtensions.get_anim_pose_at_frame(d, int(f), opts)
        ps = unreal.AnimPoseExtensions.get_anim_pose_at_frame(s, int(f) + int(offset_frames), opts)
        w = max((unreal.AnimPoseExtensions.get_bone_pose(pd, b, WORLD).translation -
                 unreal.AnimPoseExtensions.get_bone_pose(ps, b, WORLD).translation).length() for b in bones)
        out.append([int(f), round(w, 4)])
    return {"ok": True, "frames": out}
