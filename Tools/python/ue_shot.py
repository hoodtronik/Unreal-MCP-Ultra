# ue_shot - shot cameras for previz: spawnable CineCameras with real lenses, camera cuts, aim-at-measured-bone,
# framing check, and look-through for captures. Shipped base64 + exec()'d together with the posing lib
# (Tools/src/tools/shot.ts), so it can use load_sequence/find_binding/skel_comp/measure_facing/resolve_role.
#
# CLAUDE-NOTE (2026-10-21): ported from previz_lib (add_shot_camera/set_camera_lens/frame_on_bone/look_through,
# live-verified 5.6.1 + 5.8.3) with three changes: idempotent per camera name (re-running updates the camera
# instead of stacking bindings and cuts), framing is CHECKED by projecting the subject bones through the lens
# (a camera "aimed" at the wrong facing used to put the back of the head in frame), and the aim uses the
# corrected facing measurement (mesh faces +Y at yaw 0).
import math

import unreal

LSE = unreal.LevelSequenceEditorBlueprintLibrary


def _same_id(a, b):
    # MovieSceneObjectBindingID exposes no guid field to Python; its text form is a stable identity.
    return a.export_text() == b.export_text()


def _cam_xform_section(binding):
    for t in binding.get_tracks():
        if isinstance(t, unreal.MovieScene3DTransformTrack) and t.get_sections():
            return t.get_sections()[0]
    t = binding.add_track(unreal.MovieScene3DTransformTrack)
    s = t.add_section()
    s.set_range(-100000, 100000)
    return s


def _cine_comp(binding):
    tpl = binding.get_object_template()
    cc = tpl.get_component_by_class(unreal.CineCameraComponent) if tpl else None
    if not cc and tpl:
        for prop in ("camera_component", "cine_camera_component"):
            try:
                cc = tpl.get_editor_property(prop)
            except Exception:
                cc = None
            if cc:
                break
    return cc


def _set_cam_transform(seq, binding, location, rotation):
    sec = _cam_xform_section(binding)
    vals = {"Location.X": location[0], "Location.Y": location[1], "Location.Z": location[2],
            "Rotation.X": rotation[2], "Rotation.Y": rotation[0], "Rotation.Z": rotation[1]}   # roll, pitch, yaw
    for ch, v in vals.items():
        if not _write_channel(sec, ch, v):
            raise RuntimeError("camera transform has no channel " + ch)


def camera(seq_path, name, location=None, rotation=None, focal_length=None, filmback=None, sensor=None,
           cut=None, sharp=True):
    seq = load_sequence(seq_path, open_it=True, create=False)
    created = False
    try:
        b = find_binding(seq, name)
    except ValueError:
        cam = _eas().spawn_actor_from_class(unreal.CineCameraActor, unreal.Vector(0, 0, 0), unreal.Rotator())
        b = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).add_spawnable_from_instance(seq, cam)
        b.set_display_name(name)
        _eas().destroy_actor(cam)
        created = True
    tpl = _cine_comp(b)
    if tpl is None:
        raise RuntimeError("could not resolve the CineCameraComponent of camera '%s'" % name)
    # CLAUDE-NOTE (2026-10-21, live 5.6.1): editing a spawnable's TEMPLATE does not touch the instance Sequencer
    # already spawned - the viewport kept a 35 mm lens with MANUAL focus (blurred frame) while the template said
    # 50 mm / DISABLE, and framing math computed from the template described a camera nobody was looking through.
    # Apply lens edits to the template (persists) AND the live instance (what renders now).
    live = bound_actor(seq, b)
    comps = [tpl] + ([live.get_cine_camera_component()] if live else [])
    if filmback:
        names = [str(p.name) for p in unreal.CineCameraComponent.get_filmback_presets_copy()]
        if filmback not in names:
            raise ValueError("filmback '%s' is not a preset; valid: %s" % (filmback, ", ".join(names)))
    for cc in comps:
        if filmback:
            cc.set_filmback_preset_by_name(filmback)
        if sensor:
            fb = cc.get_editor_property("filmback")
            fb.sensor_width, fb.sensor_height = float(sensor[0]), float(sensor[1])
            cc.set_editor_property("filmback", fb)
        if focal_length is not None:
            cc.set_editor_property("current_focal_length", float(focal_length))
        if sharp:
            fs = cc.get_editor_property("focus_settings")
            fs.focus_method = unreal.CameraFocusMethod.DISABLE
            cc.set_editor_property("focus_settings", fs)
    cc = comps[-1]
    if location is not None or rotation is not None:
        cur = camera_pose(seq, b)
        _set_cam_transform(seq, b, location if location is not None else cur["location"],
                           rotation if rotation is not None else cur["rotation"])
    # camera cut: one section per camera name, re-ranged on re-run
    cut_track = next((t for t in seq.get_tracks() if isinstance(t, unreal.MovieSceneCameraCutTrack)), None) \
        or seq.add_track(unreal.MovieSceneCameraCutTrack)
    bid = unreal.MovieSceneSequenceExtensions.get_binding_id(seq, b)
    # CLAUDE-NOTE (2026-10-21, live): a cut section whose camera binding was removed kept winning its range (the
    # viewport showed no camera); drop such orphans. Overlapping cuts are reported - the later section wins.
    live = [unreal.MovieSceneSequenceExtensions.get_binding_id(seq, x) for x in seq.get_bindings()]
    orphans = [s for s in cut_track.get_sections() if not any(_same_id(s.get_camera_binding_id(), x) for x in live)]
    for s in orphans:
        cut_track.remove_section(s)
    sec = None
    for s in cut_track.get_sections():
        if _same_id(s.get_camera_binding_id(), bid):
            sec = s
    if sec is None:
        sec = cut_track.add_section()
        sec.set_camera_binding_id(bid)
        r = cut or [seq.get_playback_start(), seq.get_playback_end()]
        sec.set_range(int(r[0]), int(r[1]))
    elif cut:
        r = cut
        sec.set_range(int(r[0]), int(r[1]))
    else:
        # CLAUDE-NOTE (2026-10-21): an update without `cut` keeps the existing range - re-ranging to the full playback
        # range made a re-aimed camera overlap the next shot's cut (TwoShot 0-36 became 0-72 over CU_Quinn 36-72).
        r = [sec.get_start_frame(), sec.get_end_frame()]
    overlaps = []
    for s in cut_track.get_sections():
        if s is not sec and s.get_start_frame() < int(r[1]) and int(r[0]) < s.get_end_frame():
            overlaps.append([s.get_start_frame(), s.get_end_frame()])
    evaluate(seq)
    fb = cc.get_editor_property("filmback")
    return {"ok": True, "camera": name, "created": created, "focal_length": round(cc.get_editor_property("current_focal_length"), 3),
            "sensor": [round(fb.sensor_width, 3), round(fb.sensor_height, 3)], "cut": [int(r[0]), int(r[1])],
            "focus": str(cc.get_editor_property("focus_settings").focus_method).split(".")[-1].split(":")[0],
            "orphan_cuts_removed": len(orphans), "overlapping_cuts": overlaps}


def camera_pose(seq, binding):
    sec = _cam_xform_section(binding)
    v = {}
    for ch in sec.get_all_channels():
        n = str(ch.channel_name)
        keys = ch.get_keys() if hasattr(ch, "get_keys") else []
        v[n] = keys[0].get_value() if keys else (ch.get_default() if hasattr(ch, "get_default") else 0.0)
    return {"location": [v.get("Location.X", 0.0), v.get("Location.Y", 0.0), v.get("Location.Z", 0.0)],
            "rotation": [v.get("Rotation.Y", 0.0), v.get("Rotation.Z", 0.0), v.get("Rotation.X", 0.0)]}


def aim(seq_path, cam_name, subject, bone="head", distance=300.0, azimuth=0.0, rise=0.0, pitch=None):
    """Place cam_name `distance` cm from the subject's MEASURED bone, `azimuth` deg around its facing
    (0 = straight in front, +90 = its left side, 180 = behind), `rise` cm above the bone, aimed at the bone."""
    seq = load_sequence(seq_path)
    sb = find_binding(seq, subject)
    sk = skel_comp(seq, sb)
    if sk is None:
        raise RuntimeError("subject '%s' has no skeletal mesh bound" % subject)
    real = resolve_role(_bone_map(sk), bone) if bone not in _bone_map(sk) else bone
    if not real:
        raise ValueError("bone/role '%s' not found" % bone)
    p = sk.get_socket_location(real)
    f = measure_facing(sk)
    face = f.get("shoulders", f.get("toes"))
    if face is None:
        raise RuntimeError("could not measure the subject's facing")
    # CLAUDE-NOTE: UE yaw is clockwise seen from above (+90 = +Y), so the subject's LEFT is at facing - 90.
    a = math.radians(face - azimuth)
    loc = [p.x + distance * math.cos(a), p.y + distance * math.sin(a), p.z + rise]
    yaw = math.degrees(math.atan2(p.y - loc[1], p.x - loc[0]))
    horiz = math.hypot(p.x - loc[0], p.y - loc[1])
    pt = pitch if pitch is not None else math.degrees(math.atan2(p.z - loc[2], horiz))
    cb = find_binding(seq, cam_name)
    _set_cam_transform(seq, cb, loc, [pt, yaw, 0.0])
    # CLAUDE-NOTE (2026-10-21, live): stay on the frame the bone was read at - evaluate(seq) jumped to the playback
    # start, and the caller aims at the bone on a chosen frame (shot_camera aim.frame).
    evaluate(seq, current_frame())
    return {"ok": True, "camera": cam_name, "frame": current_frame(), "location": [round(x, 2) for x in loc], "rotation": [round(pt, 2), round(yaw, 2), 0.0],
            "subject_facing": face, "bone": real, "bone_location": _v(p)}


def _occluder(seq, start, end, subject_actor):
    """First thing between the camera and a bone (visibility trace, skeletal meshes hit via their physics asset).
    CLAUDE-NOTE (2026-10-21, live): a close-up aimed dead-centre on Quinn's head (u,v = 0,0) rendered nothing but
    Manny's back - projection alone cannot see occlusion. Spawned SkeletalMeshActors use the PhysicsActor profile,
    so a visibility trace hits them (it hit Manny's upperarm_l at 65% of the way)."""
    hit = unreal.SystemLibrary.line_trace_single(
        unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world(), start, end,
        unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, True, [subject_actor], unreal.DrawDebugTrace.NONE, True)
    if not hit:
        return None
    t = hit.to_tuple()
    if not t[0]:
        return None
    actor = t[9]
    name = actor.get_actor_label() if actor else "?"
    for b in seq.get_bindings():
        try:
            if bound_actor(seq, b) == actor:
                name = str(b.get_display_name())
        except Exception:
            pass
    out = {"by": name, "at": round(float(t[2]), 3)}
    if t[11] is not None and str(t[11]) not in ("None", ""):
        out["bone"] = str(t[11])
    # CLAUDE-NOTE (2026-10-21, live): a cup held in hand_r 'occluded' the hand it is attached to. A prop riding
    # the subject is reported as held_prop (informational), not as a blocked shot.
    par = actor.get_attach_parent_actor() if actor else None
    if par is not None and par == subject_actor:
        out["held_prop"] = True
    return out


def framing(seq_path, cam_name, subject, bones=None):
    """Project subject bones through the camera lens: u,v in [-1,1] = inside the frame (0,0 = centre)."""
    seq = load_sequence(seq_path)
    cb = find_binding(seq, cam_name)
    live = bound_actor(seq, cb)
    cc = live.get_cine_camera_component() if live else _cine_comp(cb)
    pose = camera_pose(seq, cb)
    fl = cc.get_editor_property("current_focal_length")
    fb = cc.get_editor_property("filmback")
    hh = math.atan(fb.sensor_width / 2.0 / fl)
    vh = math.atan(fb.sensor_height / 2.0 / fl)
    rot = unreal.Rotator(pitch=pose["rotation"][0], yaw=pose["rotation"][1], roll=pose["rotation"][2])
    fwd, right, up = rot.get_forward_vector(), rot.get_right_vector(), rot.get_up_vector()
    c = unreal.Vector(*pose["location"])
    sk = skel_comp(seq, find_binding(seq, subject))
    allb = _bone_map(sk)
    out = {}
    for w in bones or ["head", "pelvis", "hand_l", "hand_r", "foot_l", "foot_r"]:
        real = w if w in allb else resolve_role(allb, w)
        if not real:
            continue
        d = sk.get_socket_location(real) - c
        z = d.dot(fwd)
        if z <= 0:
            out[w] = {"behind_camera": True}
            continue
        u = math.atan2(d.dot(right), z) / hh
        v = math.atan2(d.dot(up), z) / vh
        out[w] = {"u": round(u, 3), "v": round(v, 3), "in_frame": abs(u) <= 1 and abs(v) <= 1, "dist": round(d.length(), 1)}
        occ = _occluder(seq, c, sk.get_socket_location(real), sk.get_owner())
        if occ:
            out[w]["occluded_by"] = occ
    # is the subject facing the camera? angle between its facing and the direction to the camera
    f = measure_facing(sk)
    face = f.get("shoulders", f.get("toes"))
    h = sk.get_socket_location(resolve_role(allb, "pelvis") or allb[0])
    to_cam = math.degrees(math.atan2(c.y - h.y, c.x - h.x))
    rel = (to_cam - face + 540) % 360 - 180 if face is not None else None
    return {"ok": True, "camera": cam_name, "focal_length": round(fl, 2), "hfov": round(math.degrees(2 * hh), 2),
            "bones": out, "subject_to_camera_deg": round(rel, 1) if rel is not None else None}


def look_through(seq_path, frame=0, game_view=True):
    seq = load_sequence(seq_path)
    LSE.set_lock_camera_cut_to_viewport(True)
    # CLAUDE-NOTE (2026-10-21, live): a SELECTED actor (here the spawned camera, selected when Sequencer created it)
    # draws its transform gizmo even in game view - it showed up in a "clean" two-shot. Clear actor selection too.
    _eas().clear_actor_selection_set()
    for pr in unreal.ControlRigSequencerLibrary.get_control_rigs(seq):
        pr.control_rig.clear_control_selection()
        unreal.ControlRigSequencerLibrary.show_all_controls(pr.track.get_sections()[0])   # never hide_all_controls
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).editor_set_game_view(bool(game_view))
    evaluate(seq, frame)
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).editor_invalidate_viewports()
    return {"ok": True, "frame": int(frame)}


def viewport_vs_cut(seq_path, frame=0):
    """Is the editor viewport really looking through the active camera cut? (compare transforms)"""
    seq = load_sequence(seq_path)
    cut_track = next((t for t in seq.get_tracks() if isinstance(t, unreal.MovieSceneCameraCutTrack)), None)
    if cut_track is None:
        return {"ok": False, "error": "sequence has no camera cut track"}
    active = None
    for s in cut_track.get_sections():
        if s.get_start_frame() <= frame < s.get_end_frame():
            active = s
    if active is None:
        return {"ok": False, "error": "no camera cut section at frame %d" % frame}
    gid = active.get_camera_binding_id()
    cb = next(b for b in seq.get_bindings() if _same_id(unreal.MovieSceneSequenceExtensions.get_binding_id(seq, b), gid))
    want = camera_pose(seq, cb)
    vloc, vrot = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_level_viewport_camera_info()
    dl = math.dist(want["location"], [vloc.x, vloc.y, vloc.z])
    dy = abs((vrot.yaw - want["rotation"][1] + 540) % 360 - 180)
    return {"ok": dl < 1.0 and dy < 0.5, "camera": str(cb.get_display_name()), "viewport_offset_cm": round(dl, 3),
            "viewport_yaw_diff": round(dy, 3)}


# ------------------------------------------------------------------ render (Movie Render Queue)

def render_start(seq_path, out_dir=None, width=960, height=540, start=None, end=None, map_path=None):
    """Queue ONE Movie Render Queue job (PIE executor) for the sequence and start it. Returns immediately; poll
    render_status(). Output: PNG sequence {sequence_name}.{frame_number}.png in out_dir.
    CLAUDE-NOTE (2026-10-21, live 5.6.1): 72 frames 960x540 rendered in ~20 s. Actors hidden only with
    'temporarily hidden in editor' DO appear in MRQ renders (they showed up in the first test) - reported here."""
    import os
    seq = load_sequence(seq_path, open_it=False)
    subsys = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    if subsys.is_rendering():
        raise RuntimeError("a Movie Render Queue render is already running")
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    mp = map_path or world.get_path_name().split(".")[0]
    name = seq.get_name()
    od = out_dir or os.path.abspath(unreal.Paths.project_saved_dir() + "MovieRenders/" + name).replace("\\", "/")
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):   # stale frames from an earlier render would be encoded with the new ones
        if f.startswith(name + ".") and f.endswith(".png"):
            os.remove(os.path.join(od, f))
    q = subsys.get_queue()
    for j in list(q.get_jobs()):
        q.delete_job(j)
    job = q.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.sequence = unreal.SoftObjectPath(seq.get_path_name())
    job.map = unreal.SoftObjectPath(mp + "." + mp.rsplit("/", 1)[1])
    job.job_name = "mcp_" + name
    cfg = job.get_configuration()
    out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    out.output_directory = unreal.DirectoryPath(od)
    out.output_resolution = unreal.IntPoint(int(width), int(height))
    out.file_name_format = "{sequence_name}.{frame_number}"
    if start is not None and end is not None:
        out.use_custom_playback_range = True
        out.custom_start_frame = int(start)
        out.custom_end_frame = int(end)
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_PNG)
    hidden = [a.get_actor_label() for a in _eas().get_all_level_actors()
              if a.is_temporarily_hidden_in_editor() and not a.is_hidden()]
    subsys.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)
    fps = seq.get_display_rate()
    return {"ok": True, "out_dir": od, "prefix": name, "fps": [fps.numerator, fps.denominator],
            "expected_frames": int((end if end is not None else seq.get_playback_end()) - (start if start is not None else seq.get_playback_start())),
            "editor_hidden_actors_will_render": hidden}


def render_status(out_dir, prefix):
    import os
    files = sorted(f for f in os.listdir(out_dir) if f.startswith(prefix + ".") and f.endswith(".png")) if os.path.isdir(out_dir) else []
    return {"ok": True, "rendering": unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem).is_rendering(),
            "frames": len(files), "first": files[0] if files else None, "last": files[-1] if files else None}


def camera_exposure(seq_path, cam_name, bias):
    """Manual exposure on a sequence camera (template + live): auto exposure off, fixed EV bias.
    CLAUDE-NOTE (2026-10-22, live): a lit white figure against the lab's black void was blown out at every light level
    - auto exposure metered the dark background. Manual exposure (no physical-camera exposure) makes light keys read
    as intended."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, cam_name)
    live = bound_actor(seq, b)
    comps = [c for c in (_cine_comp(b), live.get_cine_camera_component() if live else None) if c]
    for cc in comps:
        pp = cc.get_editor_property("post_process_settings")
        pp.set_editor_property("override_auto_exposure_method", True)
        pp.set_editor_property("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL)
        pp.set_editor_property("override_auto_exposure_apply_physical_camera_exposure", True)
        pp.set_editor_property("auto_exposure_apply_physical_camera_exposure", False)
        pp.set_editor_property("override_auto_exposure_bias", True)
        pp.set_editor_property("auto_exposure_bias", float(bias))
        cc.set_editor_property("post_process_settings", pp)
        cc.set_editor_property("post_process_blend_weight", 1.0)
    back = comps[-1].get_editor_property("post_process_settings")
    return {"ok": True, "method": str(back.auto_exposure_method).split(".")[-1].split(":")[0],
            "bias": round(back.auto_exposure_bias, 3), "components": len(comps)}


PASS_CLASSES = {"lit": "MoviePipelineDeferredPassBase", "unlit": "MoviePipelineDeferredPass_Unlit",
                "detail_lighting": "MoviePipelineDeferredPass_DetailLighting", "lighting_only": "MoviePipelineDeferredPass_LightingOnly",
                "reflections": "MoviePipelineDeferredPass_ReflectionsOnly", "path_tracer": "MoviePipelineDeferredPass_PathTracer"}
PP_MATERIALS = {"depth": "/MovieRenderPipeline/Materials/MovieRenderQueue_WorldDepth",
                "normal": "/MovieRenderPipeline/Materials/MovieRenderQueue_WorldNormal",
                "motion": "/MovieRenderPipeline/Materials/MovieRenderQueue_MotionVectors"}


def render_passes_start(seq_path, passes, out_dir=None, width=960, height=540, start=None, end=None, fmt="png",
                        spatial=None, temporal=None, warmup=None, audio=False, cvars=None):
    """One MRQ job with several passes (lit/unlit/detail_lighting/lighting_only/reflections/path_tracer + post-process
    material passes depth/normal/motion on the lit pass), optional AA sample counts and WAV audio. File names
    {sequence_name}.{render_pass}.{frame_number}.{ext}."""
    import os
    seq = load_sequence(seq_path, open_it=False)
    subsys = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    if subsys.is_rendering():
        raise RuntimeError("a Movie Render Queue render is already running")
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    mp = world.get_path_name().split(".")[0]
    name = seq.get_name()
    od = out_dir or os.path.abspath(unreal.Paths.project_saved_dir() + "MovieRenders/" + name + "_passes").replace("\\", "/")
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        if f.startswith(name + "."):
            os.remove(os.path.join(od, f))
    q = subsys.get_queue()
    for j in list(q.get_jobs()):
        q.delete_job(j)
    job = q.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.sequence = unreal.SoftObjectPath(seq.get_path_name())
    job.map = unreal.SoftObjectPath(mp + "." + mp.rsplit("/", 1)[1])
    job.job_name = "mcp_passes_" + name
    cfg = job.get_configuration()
    out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    out.output_directory = unreal.DirectoryPath(od)
    out.output_resolution = unreal.IntPoint(int(width), int(height))
    out.file_name_format = "{sequence_name}.{render_pass}.{frame_number}"
    if start is not None and end is not None:
        out.use_custom_playback_range = True
        out.custom_start_frame = int(start)
        out.custom_end_frame = int(end)
    unknown = [p for p in passes if p not in PASS_CLASSES and p not in PP_MATERIALS]
    if unknown:
        raise ValueError("unknown pass(es): %s (valid: %s)" % (", ".join(unknown), ", ".join(list(PASS_CLASSES) + list(PP_MATERIALS))))
    pp = [p for p in passes if p in PP_MATERIALS]
    base_passes = [p for p in passes if p in PASS_CLASSES] or (["lit"] if pp else [])
    if pp and "lit" not in base_passes:
        base_passes.insert(0, "lit")
    for p in base_passes:
        s = cfg.find_or_add_setting_by_class(getattr(unreal, PASS_CLASSES[p]))
        if p == "lit" and pp:
            mats = []
            for m in pp:
                e = unreal.MoviePipelinePostProcessPass()
                e.set_editor_property("enabled", True)
                e.set_editor_property("material", unreal.load_asset(PP_MATERIALS[m]))
                mats.append(e)
            s.set_editor_property("additional_post_process_materials", mats)
    if spatial or temporal or warmup is not None:
        aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
        if spatial:
            aa.spatial_sample_count = int(spatial)
        if temporal:
            aa.temporal_sample_count = int(temporal)
        if warmup is not None:
            aa.engine_warm_up_count = int(warmup)
    cls = {"png": unreal.MoviePipelineImageSequenceOutput_PNG, "exr": unreal.MoviePipelineImageSequenceOutput_EXR,
           "jpg": unreal.MoviePipelineImageSequenceOutput_JPG}[fmt]
    cfg.find_or_add_setting_by_class(cls)
    if audio:
        cfg.find_or_add_setting_by_class(unreal.MoviePipelineWaveOutput)
    if cvars:
        # scoped to this render (the job's console-variable setting), never the project's settings
        cv = cfg.find_or_add_setting_by_class(unreal.MoviePipelineConsoleVariableSetting)
        for k, v in cvars.items():
            cv.add_or_update_console_variable(k, float(v))
    subsys.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)
    fps = seq.get_display_rate()
    return {"ok": True, "out_dir": od, "prefix": name, "fps": [fps.numerator, fps.denominator], "passes": base_passes + pp,
            "expected_frames": int((end if end is not None else seq.get_playback_end()) - (start if start is not None else seq.get_playback_start()))}


def render_passes_status(out_dir, prefix):
    import os
    files = sorted(f for f in os.listdir(out_dir) if f.startswith(prefix + ".")) if os.path.isdir(out_dir) else []
    groups = {}
    for f in files:
        parts = f.split(".")
        if len(parts) >= 4:
            groups.setdefault(parts[1], []).append(f)
        else:
            groups.setdefault(parts[-1], []).append(f)
    return {"ok": True, "rendering": unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem).is_rendering(),
            "groups": {k: {"count": len(v), "first": v[0], "last": v[-1]} for k, v in groups.items()}, "files": len(files)}
