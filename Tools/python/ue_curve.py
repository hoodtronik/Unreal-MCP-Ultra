# ue_curve.py - curve editing on sequence channels (interpolation, tangents, pre/post infinity), behind seq_curve
# (Tools/src/tools/seq-curve.ts). Exec'd after ue_posing.py, ue_shot.py, ue_props_track.py.
import unreal

INTERP = {"constant": unreal.RichCurveInterpMode.RCIM_CONSTANT, "linear": unreal.RichCurveInterpMode.RCIM_LINEAR,
          "cubic": unreal.RichCurveInterpMode.RCIM_CUBIC}
TANGENT = {"auto": unreal.RichCurveTangentMode.RCTM_AUTO, "user": unreal.RichCurveTangentMode.RCTM_USER,
           "break": unreal.RichCurveTangentMode.RCTM_BREAK}
EXTRAP = {"constant": unreal.RichCurveExtrapolation.RCCE_CONSTANT, "linear": unreal.RichCurveExtrapolation.RCCE_LINEAR,
          "cycle": unreal.RichCurveExtrapolation.RCCE_CYCLE, "cycle_with_offset": unreal.RichCurveExtrapolation.RCCE_CYCLE_WITH_OFFSET,
          "oscillate": unreal.RichCurveExtrapolation.RCCE_OSCILLATE}


def _section(seq, binding_name, component, prop):
    b = find_binding(seq, binding_name)
    if component:
        kids = [c for c in b.get_child_possessables() if str(c.get_display_name()) == component]
        if not kids:
            raise ValueError("'%s' has no component binding '%s'" % (binding_name, component))
        b = kids[0]
    if not prop or prop == "Transform":
        t = next((t for t in b.get_tracks() if isinstance(t, unreal.MovieScene3DTransformTrack)), None)
    else:
        t = next((t for t in b.get_tracks() if hasattr(t, "get_property_path") and str(t.get_property_path()) == prop), None)
    if t is None or not t.get_sections():
        raise ValueError("no %s track with keys on '%s'" % (prop or "Transform", binding_name))
    return t.get_sections()[0]


def curve_set(seq_path, binding_name, component, prop, channels, interp=None, tangent=None, pre=None, post=None):
    seq = load_sequence(seq_path, open_it=True)
    sec = _section(seq, binding_name, component, prop)
    chans = [c for c in sec.get_all_channels() if hasattr(c, "get_keys") and (not channels or str(c.channel_name) in channels)]
    if not chans:
        raise ValueError("no matching channels (have: %s)" % ", ".join(str(c.channel_name) for c in sec.get_all_channels()))
    out = []
    for c in chans:
        for k in c.get_keys():
            if interp:
                k.set_interpolation_mode(INTERP[interp])
            if tangent and hasattr(k, "set_tangent_mode"):
                k.set_tangent_mode(TANGENT[tangent])
        if pre and hasattr(c, "set_pre_infinity_extrapolation"):
            c.set_pre_infinity_extrapolation(EXTRAP[pre])
        if post and hasattr(c, "set_post_infinity_extrapolation"):
            c.set_post_infinity_extrapolation(EXTRAP[post])
        keys = c.get_keys()
        out.append({"channel": str(c.channel_name), "keys": len(keys),
                    "interp": sorted(set(str(k.get_interpolation_mode()).split(".")[-1].split(":")[0] for k in keys)),
                    "tangent": sorted(set(str(k.get_tangent_mode()).split(".")[-1].split(":")[0] for k in keys)) if keys and hasattr(keys[0], "get_tangent_mode") else [],
                    "pre": str(c.get_pre_infinity_extrapolation()).split(".")[-1].split(":")[0] if hasattr(c, "get_pre_infinity_extrapolation") else None,
                    "post": str(c.get_post_infinity_extrapolation()).split(".")[-1].split(":")[0] if hasattr(c, "get_post_infinity_extrapolation") else None})
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "channels": out}


def live_rot(seq_path, binding_name, next_frame=None):
    seq = load_sequence(seq_path)
    a = bound_actor(seq, find_binding(seq, binding_name))
    r = a.get_actor_rotation()
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(),
           "rot": [round(r.pitch, 3), round(r.yaw, 3), round(r.roll, 3)]}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out


def channel_live(seq_path, binding_name, component, prop, channel):
    """CURRENT frame value of a channel on the live object: transform channels from the actor's root (relative =
    what the track writes), property channels via prop_read (Color.R -> index 0, ...)."""
    seq = load_sequence(seq_path)
    a = bound_actor(seq, find_binding(seq, binding_name))
    if a is None:
        raise RuntimeError("'%s' has no live actor" % binding_name)
    if not prop or prop == "Transform":
        rc = a.root_component
        l, r, s = rc.get_editor_property("relative_location"), rc.get_editor_property("relative_rotation"), rc.get_editor_property("relative_scale3d")
        table = {"Location.X": l.x, "Location.Y": l.y, "Location.Z": l.z, "Rotation.X": r.roll, "Rotation.Y": r.pitch,
                 "Rotation.Z": r.yaw, "Scale.X": s.x, "Scale.Y": s.y, "Scale.Z": s.z}
        if channel not in table:
            raise ValueError("unknown transform channel " + channel)
        v = table[channel]
    else:
        v = prop_read(seq_path, binding_name, component, prop)["value"]
        if isinstance(v, list):
            idx = {"R": 0, "G": 1, "B": 2, "A": 3, "X": 0, "Y": 1, "Z": 2}[channel.split(".")[-1]]
            v = v[idx]
    return {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "value": round(float(v), 4)}
