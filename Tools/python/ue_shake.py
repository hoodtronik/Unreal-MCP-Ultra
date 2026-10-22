# ue_shake.py - camera shake assets (Perlin noise) and Sequencer camera-shake tracks, behind shot_shake
# (Tools/src/tools/shot-shake.ts). Exec'd after ue_posing.py and ue_shot.py.
import unreal


def shake_asset(path, location_amp=3.0, rotation_amp=1.0, frequency=1.0, duration=0.0):
    """Blueprint subclass of CameraShakeBase whose root pattern is Perlin noise. Amplitudes: cm on X/Y/Z and degrees on
    pitch/yaw/roll (multipliers on the pattern's per-axis defaults). duration 0 = infinite (plays for the section)."""
    pkg, name = path.rsplit("/", 1)
    bp = unreal.load_asset(path)
    if bp is None:
        f = unreal.BlueprintFactory()
        f.set_editor_property("parent_class", unreal.CameraShakeBase)
        bp = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, pkg, unreal.Blueprint, f)
        if bp is None:
            raise RuntimeError("could not create " + path)
    unreal.BlueprintEditorLibrary.compile_blueprint(bp)
    cdo = unreal.get_default_object(bp.generated_class())
    pat = cdo.get_root_shake_pattern()
    if not isinstance(pat, unreal.PerlinNoiseCameraShakePattern):
        pat = unreal.new_object(unreal.PerlinNoiseCameraShakePattern, outer=cdo)
        cdo.set_root_shake_pattern(pat)
    pat.set_editor_property("location_amplitude_multiplier", float(location_amp))
    pat.set_editor_property("rotation_amplitude_multiplier", float(rotation_amp))
    pat.set_editor_property("location_frequency_multiplier", float(frequency))
    pat.set_editor_property("rotation_frequency_multiplier", float(frequency))
    try:
        d = pat.get_editor_property("duration")
        pat.set_editor_property("duration", float(duration))
    except Exception:
        pass
    unreal.EditorAssetLibrary.save_loaded_asset(bp, False)
    back = unreal.get_default_object(bp.generated_class()).get_root_shake_pattern()
    return {"ok": True, "path": path, "pattern": back.get_class().get_name() if back else None,
            "location_amp": round(back.get_editor_property("location_amplitude_multiplier"), 3) if back else None,
            "rotation_amp": round(back.get_editor_property("rotation_amplitude_multiplier"), 3) if back else None}


def shake_track(seq_path, cam_name, shake_path, start, end, scale=1.0):
    seq = load_sequence(seq_path, open_it=True)
    cb = find_binding(seq, cam_name)
    bp = unreal.load_asset(shake_path)
    cls = bp.generated_class()
    tr = next((t for t in cb.get_tracks() if isinstance(t, unreal.MovieSceneCameraShakeTrack)), None) or cb.add_track(unreal.MovieSceneCameraShakeTrack)
    for s in list(tr.get_sections()):
        tr.remove_section(s)
    sec = tr.add_section()
    data = sec.get_editor_property("shake_data")
    data.set_editor_property("shake_class", cls)
    data.set_editor_property("play_scale", float(scale))
    sec.set_editor_property("shake_data", data)
    sec.set_range(int(start), int(end))
    unreal.EditorAssetLibrary.save_loaded_asset(seq, False)
    back = sec.get_editor_property("shake_data")
    return {"ok": True, "range": [sec.get_start_frame(), sec.get_end_frame()],
            "class": back.get_editor_property("shake_class").get_name() if back.get_editor_property("shake_class") else None,
            "scale": back.get_editor_property("play_scale")}


def shake_remove(seq_path, cam_name):
    seq = load_sequence(seq_path, open_it=True)
    cb = find_binding(seq, cam_name)
    n = 0
    for t in list(cb.get_tracks()):
        if isinstance(t, unreal.MovieSceneCameraShakeTrack):
            cb.remove_track(t)
            n += 1
    return {"ok": True, "removed": n}


CH = ("Location.X", "Location.Y", "Location.Z", "Rotation.Y", "Rotation.Z", "Rotation.X")   # x, y, z, pitch, yaw, roll


def cam_base(seq_path, cam_name, next_frame=None):
    """CURRENT frame: the camera's channel-space transform (relative to its attach parent if mounted) - the value its
    transform track evaluates to. Then scrub to next_frame."""
    seq = load_sequence(seq_path)
    cam = bound_actor(seq, find_binding(seq, cam_name))
    rc = cam.root_component
    l, r = rc.get_editor_property("relative_location"), rc.get_editor_property("relative_rotation")
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(),
           "v": [l.x, l.y, l.z, r.pitch, r.yaw, r.roll]}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out


def handheld_key(seq_path, cam_name, frames, values):
    """Key every channel at each frame to values[i] = [x, y, z, pitch, yaw, roll] (base + noise, computed by the
    caller from bases read BEFORE any key was added)."""
    seq = load_sequence(seq_path, open_it=True)
    sec = _cam_xform_section(find_binding(seq, cam_name))
    chans = {str(c.channel_name): c for c in sec.get_all_channels()}
    for f, vals in zip(frames, values):
        for name, v in zip(CH, vals):
            ch = chans[name]
            for k in list(ch.get_keys()):
                if k.get_time().frame_number.value == int(f):
                    ch.remove_key(k)
            ch.add_key(unreal.FrameNumber(int(f)), float(v))
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "keys": len(frames)}
