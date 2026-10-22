# ue_seqtracks.py - Sequencer utility tracks: fade, marked frames, mute (section active) / lock / rename / colour of a
# binding's tracks, material parameter keys. Behind seq_tracks (Tools/src/tools/seq-tracks.ts). Exec'd after ue_posing.py and ue_props_track.py (_target).
import unreal


def fade(seq_path, keys):
    """Fade track keys [[frame, value 0..1]] (1 = black)."""
    seq = load_sequence(seq_path, open_it=True)
    t = next(iter(seq.find_tracks_by_exact_type(unreal.MovieSceneFadeTrack)), None) or seq.add_track(unreal.MovieSceneFadeTrack)
    sec = t.get_sections()[0] if t.get_sections() else t.add_section()
    sec.set_range(-100000, 100000)
    ch = sec.get_all_channels()[0]
    for k in list(ch.get_keys()):
        ch.remove_key(k)
    for f, v in keys:
        ch.add_key(FN(int(f)), float(v))
    got = [[k.get_time().frame_number.value, round(k.get_value(), 4)] for k in ch.get_keys()]
    return {"ok": True, "keys": got}


def marks(seq_path, items, clear=False):
    seq = load_sequence(seq_path, open_it=True)
    if clear:
        seq.delete_marked_frames()
    for it in items:
        m = unreal.MovieSceneMarkedFrame()
        m.set_editor_property("frame_number", FN(int(it["frame"])))
        m.set_editor_property("label", it["label"])
        seq.add_marked_frame(m)
    got = [{"frame": m.get_editor_property("frame_number").value, "label": str(m.get_editor_property("label"))} for m in seq.get_marked_frames()]
    return {"ok": True, "marks": got, "tick_per_frame": FN(1).value}


def _tracks(seq, binding, kind):
    b = find_binding(seq, binding)
    want = {"transform": unreal.MovieScene3DTransformTrack, "animation": unreal.MovieSceneSkeletalAnimationTrack,
            "controlrig": unreal.MovieSceneControlRigParameterTrack}.get(kind)
    ts = [t for t in b.get_tracks() if (want is None and type(t).__name__ == kind) or (want is not None and isinstance(t, want))]
    if not ts:
        raise ValueError("'%s' has no %s track (has %s)" % (binding, kind, ", ".join(type(t).__name__ for t in b.get_tracks())))
    return ts


def track_set(seq_path, binding, kind, active=None, locked=None, name=None, color=None):
    seq = load_sequence(seq_path, open_it=True)
    out = []
    for t in _tracks(seq, binding, kind):
        for s in t.get_sections():
            if active is not None:
                s.set_is_active(bool(active))
            if locked is not None:
                s.set_is_locked(bool(locked))
        if name:
            t.set_display_name(name)
        if color:
            t.set_color_tint(unreal.Color(r=int(color[0]), g=int(color[1]), b=int(color[2]), a=255))
        out.append({"track": type(t).__name__, "name": str(t.get_display_name()),
                    "active": [s.is_active() for s in t.get_sections()], "locked": [s.is_locked() for s in t.get_sections()]})
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "tracks": out}


def actor_pos(seq_path, binding, next_frame=None):
    seq = load_sequence(seq_path)
    a = bound_actor(seq, find_binding(seq, binding))
    l = a.get_actor_location()
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "p": [round(l.x, 3), round(l.y, 3), round(l.z, 3)]}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out


def material_keys(seq_path, binding, component, param, kind, keys, index=0):
    """Material parameter track on a binding's mesh component (element `index`): kind 'color' keys [[frame,[r,g,b,a?]]]
    or 'scalar' keys [[frame, v]]. Sequencer drives a dynamic material instance on the live component."""
    seq = load_sequence(seq_path, open_it=True)
    cb, comp = _target(seq, binding, component)
    t = next((x for x in cb.get_tracks() if isinstance(x, unreal.MovieSceneComponentMaterialTrack)), None)
    if t is None:
        t = cb.add_track(unreal.MovieSceneComponentMaterialTrack)
    t.set_material_index(int(index))
    sec = t.get_sections()[0] if t.get_sections() else t.add_section()
    sec.set_range(-100000, 100000)
    # CLAUDE-NOTE (live 5.6): the component material section takes a MaterialParameterInfo + layer/asset names (the
    # base parameter-section signature (name, time, value) is rejected).
    pinfo = unreal.MaterialParameterInfo()
    pinfo.set_editor_property("name", param)
    # this section API takes TICK-resolution frame numbers (scripting channels take display frames): keys at "40" landed
    # 40 ticks in and every frame after f0 read the last key (live)
    tr, dr = seq.get_tick_resolution(), seq.get_display_rate()
    tick = lambda f: unreal.FrameNumber(int(round(f * tr.numerator * dr.denominator / float(tr.denominator * dr.numerator))))
    for ch in list(sec.get_all_channels()):
        for k in list(ch.get_keys()):
            ch.remove_key(k)
    for f, v in keys:
        if kind == "color":
            c = list(v) + [1.0] * (4 - len(v))
            sec.add_color_parameter_key(pinfo, tick(f), unreal.LinearColor(*[float(x) for x in c[:4]]), "", "")
        else:
            sec.add_scalar_parameter_key(pinfo, tick(f), float(v), "", "")
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "track": type(t).__name__, "channels": [str(c.channel_name) for c in sec.get_all_channels()][:8]}


def material_live(seq_path, binding, component, param, kind, index=0, next_frame=None):
    """CURRENT value of the parameter on the live component's material (the one the renderer uses)."""
    seq = load_sequence(seq_path)
    _, comp = _target(seq, binding, component)
    m = comp.get_material(int(index))
    if kind == "color":
        v = m.get_vector_parameter_value(param) if hasattr(m, "get_vector_parameter_value") else None
        val = [round(v.r, 4), round(v.g, 4), round(v.b, 4)] if v is not None else None
    else:
        val = round(m.get_scalar_parameter_value(param), 4) if hasattr(m, "get_scalar_parameter_value") else None
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "material": type(m).__name__, "value": val}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out
