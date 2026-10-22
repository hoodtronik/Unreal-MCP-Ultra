# ue_seqtracks.py - Sequencer utility tracks: fade, marked frames, mute (section active) / lock / rename / colour of a
# binding's tracks. Behind seq_tracks (Tools/src/tools/seq-tracks.ts). Exec'd after ue_posing.py.
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
