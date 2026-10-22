# ue_look.py - the camera "look": depth of field focused on a subject, white balance, saturation, contrast, gain,
# vignette, bloom and film grain on a sequence camera's post-process settings (template + live instance). Behind
# shot_look (Tools/src/tools/shot-look.ts), which renders before/after stills (ue_stills.stills_start) and measures them.
# Exec'd after ue_posing.py (load_sequence, find_binding, bound_actor, _eas) and ue_shot.py (_cine_comp).
import unreal

# PostProcessSettings fields set as scalars / as uniform Vector4 grading wheels (x=y=z=w)
SCALARS = {"white_temp": "white_temp", "white_tint": "white_tint", "vignette": "vignette_intensity",
           "bloom": "bloom_intensity", "grain": "film_grain_intensity"}
WHEELS = {"saturation": "color_saturation", "contrast": "color_contrast", "gain": "color_gain"}


def _comps(seq, b):
    live = bound_actor(seq, b)
    return [c for c in (_cine_comp(b), live.get_cine_camera_component() if live else None) if c], live


def _subject_point(seq, name, bone):
    try:
        a = bound_actor(seq, find_binding(seq, name))
    except ValueError:
        a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == name), None)
    if a is None:
        raise ValueError("no binding or level actor '%s'" % name)
    sk = a.get_component_by_class(unreal.SkinnedMeshComponent)
    if sk is not None and bone and sk.get_bone_index(bone) >= 0:
        return sk.get_socket_location(bone)
    o, _ = a.get_actor_bounds(False)
    return o


def _set_track_default(b, name, value):
    """A camera spawned by Sequencer comes with Current Aperture / Manual Focus Distance / Focal Length tracks that
    re-write the component every evaluation. Set their default; refuse to flatten a keyed (animated) one."""
    hits = 0
    for owner in [b] + list(b.get_child_possessables()):
        for t in owner.get_tracks():
            if name not in str(t.get_display_name()):
                continue
            for s in t.get_sections():
                for ch in s.get_all_channels():
                    if hasattr(ch, "get_keys") and ch.get_keys():
                        raise RuntimeError("'%s' is keyed on this camera (an animated pull); edit its keys with "
                                           "seq_property instead" % name)
                    ch.set_default(float(value))
                    hits += 1
    return hits


def look_apply(seq_path, cam_name, settings):
    """settings: focus {subject, bone='head', fstop} | focus_distance cm | fstop, and SCALARS / WHEELS keys.
    Focus distance is measured from the LIVE camera to the subject at the current frame."""
    seq = load_sequence(seq_path, open_it=True)
    b = find_binding(seq, cam_name)
    comps, live = _comps(seq, b)
    if not comps:
        raise RuntimeError("camera '%s' has no CineCameraComponent" % cam_name)
    unknown = set(settings) - set(SCALARS) - set(WHEELS) - {"focus", "focus_distance", "fstop"}
    if unknown:
        raise ValueError("unknown look keys: %s" % ", ".join(sorted(unknown)))
    dist = settings.get("focus_distance")
    fstop = settings.get("fstop")
    f = settings.get("focus")
    if f:
        if live is None:
            raise RuntimeError("camera '%s' is not spawned at this frame; scrub into its cut first" % cam_name)
        p = _subject_point(seq, f["subject"], f.get("bone", "head"))
        dist = (p - live.get_actor_location()).length()
        fstop = f.get("fstop", fstop)
    # CLAUDE-NOTE (2026-10-22, live): SEQ_Build22's camera had these tracks; setting only the component gave a render
    # focused at 100000 cm (default of the track) with f/2.8 from the template - everything blurred.
    if dist is not None:
        _set_track_default(b, "Manual Focus Distance", dist)
    if fstop is not None:
        _set_track_default(b, "Current Aperture", fstop)
    for cc in comps:
        if dist is not None:
            fs = cc.get_editor_property("focus_settings")
            fs.focus_method = unreal.CameraFocusMethod.MANUAL
            fs.manual_focus_distance = float(dist)
            cc.set_editor_property("focus_settings", fs)
        if fstop is not None:
            cc.set_editor_property("current_aperture", float(fstop))
        pp = cc.get_editor_property("post_process_settings")
        for k, prop in SCALARS.items():
            if k in settings:
                pp.set_editor_property("override_" + prop, True)
                pp.set_editor_property(prop, float(settings[k]))
        for k, prop in WHEELS.items():
            if k in settings:
                v = float(settings[k])
                pp.set_editor_property("override_" + prop, True)
                pp.set_editor_property(prop, unreal.Vector4(v, v, v, v))
        cc.set_editor_property("post_process_settings", pp)
        cc.set_editor_property("post_process_blend_weight", 1.0)
    evaluate(seq)
    return look_read(seq_path, cam_name)


def look_read(seq_path, cam_name):
    seq = load_sequence(seq_path)
    comps, _ = _comps(seq, find_binding(seq, cam_name))
    cc = comps[-1]
    pp = cc.get_editor_property("post_process_settings")
    fs = cc.get_editor_property("focus_settings")
    out = {"focus_method": str(fs.focus_method).split(".")[-1].split(":")[0],
           "focus_distance": round(fs.manual_focus_distance, 2), "fstop": round(cc.get_editor_property("current_aperture"), 3),
           "focal_length": round(cc.get_editor_property("current_focal_length"), 2)}
    for k, prop in SCALARS.items():
        if pp.get_editor_property("override_" + prop):
            out[k] = round(pp.get_editor_property(prop), 4)
    for k, prop in WHEELS.items():
        if pp.get_editor_property("override_" + prop):
            out[k] = round(pp.get_editor_property(prop).x, 4)
    return {"ok": True, "look": out, "components": len(comps)}


def look_render(seq_path, frame, width, height, tag):
    """One still of the camera cut at `frame` into Saved/MovieRenders/<seq>_look_<tag> (warm-up, no motion blur)."""
    import os
    seq = load_sequence(seq_path, open_it=False)
    od = os.path.abspath(unreal.Paths.project_saved_dir() + "MovieRenders/%s_look_%s" % (seq.get_name(), tag)).replace("\\", "/")
    return stills_start(seq_path, [int(frame)], int(width), int(height), od, None, None, False)


FOG_LABEL = "MCP_Fog"


def look_fog(settings):
    """Level height fog (spawned as MCP_Fog when the level has none): density, falloff, start (cm), color [r,g,b]
    linear, volumetric bool; remove=True deletes MCP_Fog. Level-wide, not per camera."""
    fogs = [a for a in _eas().get_all_level_actors() if isinstance(a, unreal.ExponentialHeightFog)]
    if settings.get("remove"):
        gone = [a.get_actor_label() for a in fogs if a.get_actor_label() == FOG_LABEL]
        for a in fogs:
            if a.get_actor_label() == FOG_LABEL:
                _eas().destroy_actor(a)
        return {"ok": True, "removed": gone}
    a = fogs[0] if fogs else None
    if a is None:
        a = _eas().spawn_actor_from_class(unreal.ExponentialHeightFog, unreal.Vector(0, 0, 0))
        a.set_actor_label(FOG_LABEL)
    c = a.component
    if "density" in settings:
        c.set_fog_density(float(settings["density"]))
    if "falloff" in settings:
        c.set_fog_height_falloff(float(settings["falloff"]))
    if "start" in settings:
        c.set_start_distance(float(settings["start"]))
    if "color" in settings:
        r, g, b = settings["color"]
        c.set_fog_inscattering_color(unreal.LinearColor(r, g, b, 1.0))
        # CLAUDE-NOTE (live): with a SkyAtmosphere in the level the fog takes the SKY's colour (a dark blue-grey fog
        # rendered sky-blue); an explicit colour turns the sky's ambient contribution off so the colour asked is used.
        c.set_sky_atmosphere_ambient_contribution_color_scale(unreal.LinearColor(0, 0, 0, 1))
    if "volumetric" in settings:
        c.set_volumetric_fog(bool(settings["volumetric"]))
    return {"ok": True, "fog": a.get_actor_label(), "density": round(c.get_editor_property("fog_density"), 4),
            "falloff": round(c.get_editor_property("fog_height_falloff"), 4), "start": round(c.get_editor_property("start_distance"), 1),
            "volumetric": bool(c.get_editor_property("enable_volumetric_fog"))}
