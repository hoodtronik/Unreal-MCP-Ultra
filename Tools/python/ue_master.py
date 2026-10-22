# ue_master.py - shot assembly on a master sequence (Shots track) and scratch audio, behind seq_master / seq_audio
# (Tools/src/tools/master.ts). Exec'd after ue_posing.py and ue_shot.py (load_sequence, evaluate, camera_pose, _same_id,
# LSE, _eas).
import unreal


def _shots_track(seq):
    t = next((t for t in seq.get_tracks() if isinstance(t, unreal.MovieSceneCinematicShotTrack)), None)
    return t or seq.add_track(unreal.MovieSceneCinematicShotTrack)


def _shot_info(s):
    sub = s.get_sequence()
    return {"shot": str(s.get_shot_display_name()) if hasattr(s, "get_shot_display_name") else "",
            "sequence": sub.get_path_name().split(".")[0] if sub else None,
            "start": s.get_start_frame(), "end": s.get_end_frame(),
            "offset": s.get_editor_property("parameters").get_editor_property("start_frame_offset").value
            if hasattr(s.get_editor_property("parameters"), "get_editor_property") else 0,
            "row": s.get_row_index()}


def master_build(master_path, shots, fps=24, replace=True):
    """shots: [{sequence, name?, start?, length?, offset?}] laid end to end unless start is given. length defaults to
    the shot sequence's playback range; offset trims the shot's head (frames). Master playback = the shots' span."""
    master = load_sequence(master_path, open_it=True, create=True, fps=fps, end=1)
    track = _shots_track(master)
    if replace:
        for s in list(track.get_sections()):
            track.remove_section(s)
    pos = 0
    for sh in shots:
        sub = load_sequence(sh["sequence"], open_it=False)
        length = int(sh.get("length") or (sub.get_playback_end() - sub.get_playback_start()))
        offset = int(sh.get("offset") or 0)
        start = int(sh["start"]) if sh.get("start") is not None else pos
        sec = track.add_section()
        sec.set_sequence(sub)
        sec.set_range(start, start + length)
        params = sec.get_editor_property("parameters")
        params.set_editor_property("start_frame_offset", unreal.FrameNumber(
            offset * int(sub.get_tick_resolution().numerator / max(1, sub.get_display_rate().numerator))))
        sec.set_editor_property("parameters", params)
        if sh.get("name") and hasattr(sec, "set_shot_display_name"):
            sec.set_shot_display_name(sh["name"])
        pos = start + length
    end = max([s.get_end_frame() for s in track.get_sections()] or [1])
    master.set_playback_start(0)
    master.set_playback_end(end)
    unreal.EditorAssetLibrary.save_loaded_asset(master, False)
    return master_info(master_path)


def master_info(master_path):
    master = load_sequence(master_path, open_it=False)
    track = next((t for t in master.get_tracks() if isinstance(t, unreal.MovieSceneCinematicShotTrack)), None)
    shots = [_shot_info(s) for s in (track.get_sections() if track else [])]
    shots.sort(key=lambda x: x["start"])
    audio = []
    for t in master.get_tracks():
        if isinstance(t, unreal.MovieSceneAudioTrack):
            for s in t.get_sections():
                snd = s.get_sound()
                vol = next((c.get_default() for c in s.get_all_channels() if "Volume" in str(c.channel_name)
                            and hasattr(c, "get_default")), None)
                audio.append({"track": str(t.get_display_name()), "sound": snd.get_path_name().split(".")[0] if snd else None,
                              "volume": round(vol, 3) if isinstance(vol, float) else vol,
                              "start": s.get_start_frame(), "end": s.get_end_frame(),
                              "duration_s": round(snd.get_editor_property("duration"), 3) if snd else None})
    return {"ok": True, "master": master_path, "fps": master.get_display_rate().numerator,
            "start": master.get_playback_start(), "end": master.get_playback_end(), "shots": shots, "audio": audio}


def audio_add(seq_path, track_name, sound, start=0, volume=1.0, replace=False):
    seq = load_sequence(seq_path, open_it=False)
    snd = unreal.load_asset(sound)
    if not isinstance(snd, unreal.SoundBase):
        raise ValueError("Not a sound asset: " + sound)
    track = next((t for t in seq.get_tracks() if isinstance(t, unreal.MovieSceneAudioTrack)
                  and str(t.get_display_name()) == track_name), None)
    if track is None:
        track = seq.add_track(unreal.MovieSceneAudioTrack)
        track.set_display_name(track_name)
    if replace:
        for s in list(track.get_sections()):
            track.remove_section(s)
    sec = track.add_section()
    sec.set_sound(snd)
    fps = seq.get_display_rate().numerator / float(seq.get_display_rate().denominator)
    frames = max(1, int(round(snd.get_editor_property("duration") * fps)))
    sec.set_range(int(start), int(start) + frames)
    try:
        ch = next(c for c in sec.get_all_channels() if "Volume" in str(c.channel_name))
        ch.set_default(float(volume))
    except StopIteration:
        pass
    unreal.EditorAssetLibrary.save_loaded_asset(seq, False)
    return {"ok": True, "frames": frames}


def master_view(master_path, frame):
    """Open the master, lock the viewport to its cuts and scrub to frame (pose shows next tick)."""
    master = load_sequence(master_path, open_it=True)
    LSE.set_lock_camera_cut_to_viewport(True)
    evaluate(master, int(frame))
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).editor_invalidate_viewports()
    return {"ok": True}


def master_cam_at(master_path, frame):
    """Which shot plays at master `frame`, its local frame, the camera its cut track selects there, and where the
    viewport camera is now (read after master_view on a previous call)."""
    master = load_sequence(master_path, open_it=False)
    track = next((t for t in master.get_tracks() if isinstance(t, unreal.MovieSceneCinematicShotTrack)), None)
    act = None
    for s in (track.get_sections() if track else []):
        if s.get_start_frame() <= frame < s.get_end_frame():
            act = s
    vloc, vrot = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_level_viewport_camera_info()
    out = {"ok": True, "frame": int(frame), "viewport": [round(vloc.x, 2), round(vloc.y, 2), round(vloc.z, 2)],
           "viewport_yaw": round(vrot.yaw, 3)}
    if act is None:
        out["shot"] = None
        return out
    sub = act.get_sequence()
    ticks = act.get_editor_property("parameters").get_editor_property("start_frame_offset").value
    per = sub.get_tick_resolution().numerator / max(1, sub.get_display_rate().numerator)
    local = int(frame - act.get_start_frame() + sub.get_playback_start() + round(ticks / per))
    out.update({"shot": sub.get_path_name().split(".")[0], "local_frame": local})
    cut = next((t for t in sub.get_tracks() if isinstance(t, unreal.MovieSceneCameraCutTrack)), None)
    for c in (cut.get_sections() if cut else []):
        if c.get_start_frame() <= local < c.get_end_frame():
            gid = c.get_camera_binding_id()
            cb = next((b for b in sub.get_bindings()
                       if _same_id(unreal.MovieSceneSequenceExtensions.get_binding_id(sub, b), gid)), None)
            if cb is not None:
                p = camera_pose(sub, cb)
                out.update({"camera": str(cb.get_display_name()), "camera_location": [round(v, 2) for v in p["location"]],
                            "camera_yaw": round(p["rotation"][1], 3)})
    return out
