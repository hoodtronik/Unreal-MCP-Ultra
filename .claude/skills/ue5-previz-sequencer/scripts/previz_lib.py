# previz_lib.py — helper functions for building a Sequencer storyboard through BlueprintMCP run_python.
#
# Load inside run_python with:   exec(open(r"<skill dir>/scripts/previz_lib.py").read())
#
# CLAUDE-NOTE (2026-09-22): every function here is assembled from calls that were executed against a live
# UE 5.6.1 editor (see references/api-recipes.md for the raw probes and readbacks). Deprecated-on-5.6
# calls were deliberately avoided so the same file should run on 5.8; run selfcheck() there first.

import unreal

L = unreal.ControlRigSequencerLibrary
LSE = unreal.LevelSequenceEditorBlueprintLibrary
FN = unreal.FrameNumber
DR = unreal.MovieSceneTimeUnit.DISPLAY_RATE


def _tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


def _eas():
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def _ses():
    return unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem)


def _world():
    return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()


def _rot(rotation):
    # CLAUDE-NOTE: unreal.Rotator's POSITIONAL order is (roll, pitch, yaw). The lib takes the film-friendly
    # (pitch, yaw, roll) and always passes keywords so no caller can silently pose the wrong axis.
    p, y, r = rotation
    return unreal.Rotator(pitch=float(p), yaw=float(y), roll=float(r))


# ---------------------------------------------------------------- sequences

def get_or_create_sequence(package_path, name, fps=24, start=0, end=48):
    """Load or create a LevelSequence and set its display rate + playback range (display frames)."""
    seq = unreal.load_asset(f"{package_path}/{name}")
    if not seq:
        seq = _tools().create_asset(name, package_path, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    seq.set_display_rate(unreal.FrameRate(fps, 1))
    seq.set_playback_start(start)
    seq.set_playback_end(end)
    return seq


def open_sequence(seq):
    """Open the sequence in the Sequencer editor. REQUIRED before any Control Rig read/write:
    ControlRigSequencerLibrary resolves rig instances through the focused Sequencer; unopened, every
    getter returns identity and every setter is a silent no-op."""
    LSE.open_level_sequence(seq)
    return LSE.get_focused_level_sequence()


def find_binding(seq, name):
    return next((b for b in seq.get_bindings() if str(b.get_display_name()) == name), None)


def save(package_path):
    unreal.EditorAssetLibrary.save_directory(package_path, False, True)


# ---------------------------------------------------------------- characters + control rig

def add_spawnable_character(seq, skeletal_mesh_path, name, location=(0, 0, 0), rotation=(0, 0, 0)):
    """Add a SkeletalMesh as a SPAWNABLE owned by the shot (self-contained: no level actor to lose).
    Spawns a temporary level actor, converts it, and destroys the level copy."""
    existing = find_binding(seq, name)
    if existing:
        return existing
    mesh = unreal.load_asset(skeletal_mesh_path)
    tmp = _eas().spawn_actor_from_object(mesh, unreal.Vector(*location), _rot(rotation))
    binding = _ses().add_spawnable_from_instance(seq, tmp)
    binding.set_display_name(name)
    _eas().destroy_actor(tmp)
    return binding


def add_possessable(seq, actor, name=None):
    """Bind an existing level actor (possessable). Prefer add_spawnable_character for previz."""
    b = seq.add_possessable(actor)
    if name:
        b.set_display_name(name)
    return b


def add_control_rig(seq, binding, control_rig_bp_path):
    """Add (or find) a Control Rig track for the binding. Returns the MovieSceneControlRigParameterTrack."""
    rig_class = unreal.load_asset(control_rig_bp_path).get_control_rig_class()
    return L.find_or_create_control_rig_track(_world(), seq, rig_class, binding)


def get_rig(seq, index=0):
    return L.get_control_rigs(seq)[index].control_rig


def cr_section(seq, index=0):
    return L.get_control_rigs(seq)[index].track.get_sections()[0]


def control_type(rig, name):
    """'EULER_TRANSFORM' | 'TRANSFORM' | 'FLOAT' | 'BOOL' | 'INTEGER' | 'VECTOR2D' | 'POSITION' | 'ROTATOR' | 'SCALE' | None"""
    key = unreal.RigElementKey(type=unreal.RigElementType.CONTROL, name=name)
    el = rig.get_hierarchy().find_control(key)
    # str() of a UE enum value is "<RigControlType.EULER_TRANSFORM: 9>" — keep only the member name.
    return str(el.settings.control_type).split(".")[-1].split(":")[0].strip("<> ") if el else None


def list_controls(rig, kind=None):
    """[(name, type), ...] for every control on the rig; optionally filter by type string."""
    out = []
    for k in rig.get_hierarchy().get_controls():
        t = control_type(rig, str(k.name))
        if kind is None or t == kind:
            out.append((str(k.name), t))
    return out


def get_control(seq, rig, name, frame):
    """Local-space value at a frame as (location Vector, rotation Rotator, scale Vector) for transform-type
    controls, or a scalar for float/bool/int."""
    t = control_type(rig, name)
    if t == "EULER_TRANSFORM":
        e = L.get_local_control_rig_euler_transform(seq, rig, name, FN(frame), DR)
        return e.location, e.rotation, e.scale
    if t == "TRANSFORM":
        x = L.get_local_control_rig_transform(seq, rig, name, FN(frame), DR)
        return x.translation, x.rotation.rotator(), x.scale3d
    if t == "FLOAT":
        return L.get_local_control_rig_float(seq, rig, name, FN(frame), DR)
    if t == "BOOL":
        return L.get_local_control_rig_bool(seq, rig, name, FN(frame), DR)
    if t == "INTEGER":
        return L.get_local_control_rig_int(seq, rig, name, FN(frame), DR)
    raise ValueError(f"{name}: unsupported control type {t}")


def set_control(seq, rig, name, frame, location=None, rotation=None, scale=None, key=True):
    """Pose one transform-type control at a frame (local space). Omitted parts keep their current value.
    rotation is (pitch, yaw, roll) in degrees. Picks the typed setter that matches the control — the
    wrong typed setter is a silent no-op, which is the #1 way a pose 'does nothing'."""
    t = control_type(rig, name)
    if t == "EULER_TRANSFORM":
        cur = L.get_local_control_rig_euler_transform(seq, rig, name, FN(frame), DR)
        v = unreal.EulerTransform(
            location=unreal.Vector(*location) if location is not None else cur.location,
            rotation=_rot(rotation) if rotation is not None else cur.rotation,
            scale=unreal.Vector(*scale) if scale is not None else cur.scale)
        L.set_local_control_rig_euler_transform(seq, rig, name, FN(frame), v, DR, key)
    elif t == "TRANSFORM":
        cur = L.get_local_control_rig_transform(seq, rig, name, FN(frame), DR)
        v = unreal.Transform(
            location=unreal.Vector(*location) if location is not None else cur.translation,
            rotation=_rot(rotation) if rotation is not None else cur.rotation.rotator(),
            scale=unreal.Vector(*scale) if scale is not None else cur.scale3d)
        L.set_local_control_rig_transform(seq, rig, name, FN(frame), v, DR, key)
    else:
        raise ValueError(f"{name} is {t}; use set_control_float / set_control_bool")


def set_control_float(seq, rig, name, frame, value, key=True):
    L.set_local_control_rig_float(seq, rig, name, FN(frame), float(value), DR, key)


def set_control_bool(seq, rig, name, frame, value, key=True):
    L.set_local_control_rig_bool(seq, rig, name, FN(frame), bool(value), DR, key)


def _evaluate(seq):
    """Force Sequencer to (re)evaluate the open sequence so spawnables exist and key edits are applied."""
    if hasattr(LSE, "refresh_current_level_sequence"):
        LSE.refresh_current_level_sequence()
    LSE.set_current_time(int(seq.get_playback_start()))


def bound_skeletal_mesh_component(seq, binding):
    """Resolve the live SkeletalMeshComponent behind a binding (works for spawnables, which only exist
    while the sequence is open). SequencerTools.get_bound_objects is deprecated on 5.6 and returned
    nothing for spawnables; this path is the one that worked."""
    bid = unreal.MovieSceneSequenceExtensions.get_binding_id(seq, binding)

    def _find():
        for o in LSE.get_bound_objects(bid):
            if isinstance(o, unreal.SkeletalMeshComponent):
                return o
            if isinstance(o, unreal.Actor):
                c = o.get_component_by_class(unreal.SkeletalMeshComponent)
                if c:
                    return c
        return None

    found = _find()
    if not found:
        # CLAUDE-NOTE: a spawnable added earlier in the SAME run_python call has not been instantiated
        # yet — Sequencer spawns it on its next evaluation. One forced evaluation is enough.
        _evaluate(seq)
        found = _find()
    return found


def clear_keys(section):
    """Remove every key from every channel of a section. Returns the number removed."""
    n = 0
    for ch in section.get_all_channels():
        if not hasattr(ch, "get_keys"):
            continue
        for k in list(ch.get_keys()):
            ch.remove_key(k)
            n += 1
    return n


def _collapse_to_single_key(section, at_frame):
    """Keep exactly one key per channel at at_frame; drop sub-frame and duplicate keys.
    CLAUDE-NOTE: the one-frame bake produces two keys per channel (the second at a sub-frame tick),
    and baking again STACKS keys at identical ticks. Duplicate keys at one tick are poison: a later
    setter updates one copy while evaluation reads the other, so set_control 'does nothing'."""
    target = int(at_frame)
    for ch in section.get_all_channels():
        if not hasattr(ch, "get_keys"):
            continue
        kept = False
        for k in list(ch.get_keys()):
            t = k.get_time(DR)
            on_frame = t.frame_number.value == target and abs(t.sub_frame) < 1e-6
            if on_frame and not kept:
                kept = True
                continue
            ch.remove_key(k)


def pose_from_clip(seq, binding, anim_path, clip_frame, at_frame=0, constant=True, section=None):
    """Bake ONE frame of an AnimSequence onto the Control Rig as a held pose at at_frame (≈2 keys per
    channel). This is the fastest way to a human-looking pose; nudge controls afterwards with set_control.
    clip_frame is in the CLIP's frame rate."""
    sec = section or cr_section(seq)
    anim = unreal.load_asset(anim_path)
    skel = bound_skeletal_mesh_component(seq, binding)
    if not skel:
        raise RuntimeError("no SkeletalMeshComponent bound — is the sequence open?")
    interp = unreal.MovieSceneKeyInterpolation.CONSTANT if constant else unreal.MovieSceneKeyInterpolation.SMART_AUTO
    clear_keys(sec)   # a held pose REPLACES whatever was keyed; re-baking on top stacks duplicate keys
    ok = L.load_anim_sequence_into_control_rig_section_with_range(
        sec, anim, skel, FN(at_frame), True, FN(clip_frame), FN(clip_frame + 1), DR,
        False, 0.001, interp, True, False)
    if ok:
        _collapse_to_single_key(sec, at_frame)
        _evaluate(seq)
    return ok


def load_clip(seq, binding, anim_path, at_frame=0, section=None):
    """Load a WHOLE clip onto the Control Rig (every frame keyed — hundreds of thousands of keys)."""
    sec = section or cr_section(seq)
    anim = unreal.load_asset(anim_path)
    skel = bound_skeletal_mesh_component(seq, binding)
    return L.load_anim_sequence_into_control_rig_section_with_range(
        sec, anim, skel, FN(at_frame), False, FN(0), FN(0), DR,
        False, 0.001, unreal.MovieSceneKeyInterpolation.SMART_AUTO, True, False)


def make_constant(section):
    """Set every key on every channel of a section to constant interpolation (stepped animatic poses).
    Returns the number of keys changed."""
    n = 0
    for ch in section.get_all_channels():
        for k in (ch.get_keys() if hasattr(ch, "get_keys") else []):
            if hasattr(k, "set_interpolation_mode"):
                k.set_interpolation_mode(unreal.RichCurveInterpMode.RCIM_CONSTANT)
                n += 1
    return n


# ---------------------------------------------------------------- cameras

def add_shot_camera(seq, name="ShotCam", location=(0, -400, 140), rotation=(-5, 90, 0),
                    focal_length=35.0, filmback="Full Frame DSLR", cut_range=None, sharp=True):
    """Spawnable CineCameraActor owned by the shot + a camera-cut section pointing at it.
    filmback must be a name from CineCameraComponent.get_filmback_presets_copy() — an unknown name is a
    silent no-op (the default stays 16:9 DSLR 23.76x13.365). rotation = (pitch, yaw, roll).
    sharp=True disables depth of field: a CineCamera's default manual focus turns long lenses into a blur
    in previz, where nothing is ever placed at the focus distance."""
    cam = _eas().spawn_actor_from_class(unreal.CineCameraActor, unreal.Vector(*location), _rot(rotation))
    cc = cam.get_cine_camera_component()
    cc.set_editor_property("current_focal_length", float(focal_length))
    if sharp:
        fs = cc.get_editor_property("focus_settings")
        fs.focus_method = unreal.CameraFocusMethod.DISABLE
        cc.set_editor_property("focus_settings", fs)
    if filmback:
        names = [str(p.name) for p in unreal.CineCameraComponent.get_filmback_presets_copy()]
        if filmback not in names:
            raise ValueError(f"filmback '{filmback}' not a preset; valid: {names}")
        cc.set_filmback_preset_by_name(filmback)
    binding = _ses().add_spawnable_from_instance(seq, cam)
    binding.set_display_name(name)
    _eas().destroy_actor(cam)
    cut = next((t for t in seq.get_tracks() if isinstance(t, unreal.MovieSceneCameraCutTrack)), None) \
        or seq.add_track(unreal.MovieSceneCameraCutTrack)
    cs = cut.add_section()
    r = cut_range or (seq.get_playback_start(), seq.get_playback_end())
    cs.set_range(int(r[0]), int(r[1]))
    cs.set_camera_binding_id(unreal.MovieSceneSequenceExtensions.get_binding_id(seq, binding))
    return binding


def set_camera_lens(seq, binding, focal_length=None, sensor=None):
    """Edit a spawnable camera's template. sensor=(width_mm, height_mm). Returns (focal, w, h)."""
    tpl = binding.get_object_template()
    # CLAUDE-NOTE: on a spawnable template get_cine_camera_component() is None and get_component_by_class
    # is unreliable (worked once, returned None on a fresh template); the camera_component property is
    # the dependable handle.
    cc = tpl.get_component_by_class(unreal.CineCameraComponent)
    if not cc:
        for prop in ("camera_component", "cine_camera_component"):
            try:
                cc = tpl.get_editor_property(prop)
            except Exception:
                cc = None
            if cc:
                break
    if not cc:
        raise RuntimeError("could not resolve the CineCameraComponent on the spawnable template")
    if focal_length is not None:
        cc.set_editor_property("current_focal_length", float(focal_length))
    if sensor:
        fb = cc.get_editor_property("filmback")
        fb.sensor_width, fb.sensor_height = float(sensor[0]), float(sensor[1])
        cc.set_editor_property("filmback", fb)
    fb = cc.get_editor_property("filmback")
    return cc.get_editor_property("current_focal_length"), fb.sensor_width, fb.sensor_height


def look_through(seq, frame=0):
    """Open the sequence, lock the viewport to its camera cut and scrub to frame — so the editor
    viewport (and vision_mode frames) show the shot."""
    open_sequence(seq)
    LSE.set_lock_camera_cut_to_viewport(True)
    LSE.set_current_time(int(frame))


# ---------------------------------------------------------------- master + audio

def add_shots(master, shots):
    """shots = [(shot_sequence, master_start, master_end, 'shot0010'), ...]. Returns the shot sections."""
    st = next((t for t in master.get_tracks() if isinstance(t, unreal.MovieSceneCinematicShotTrack)), None) \
        or master.add_track(unreal.MovieSceneCinematicShotTrack)
    out = []
    for s, s0, s1, nm in shots:
        ss = st.add_section()
        ss.set_sequence(s)
        ss.set_range(int(s0), int(s1))
        ss.set_shot_display_name(nm)
        out.append(ss)
    return out


def import_wav(disk_path, package_path, name=None):
    """Import a .wav/.mp3 from disk as a SoundWave. Returns the asset path."""
    task = unreal.AssetImportTask()
    task.filename = disk_path
    task.destination_path = package_path
    if name:
        task.destination_name = name
    task.automated = True
    task.replace_existing = True
    task.save = True
    _tools().import_asset_tasks([task])
    paths = list(task.get_editor_property("imported_object_paths"))
    return paths[0].split(".")[0] if paths else None


def add_audio(seq, track_name, sound_path, start, end=None):
    """New audio track named track_name with one section of the SoundWave at [start, end) in display
    frames. end defaults to the wave's duration."""
    at = seq.add_track(unreal.MovieSceneAudioTrack)
    unreal.MovieSceneTrackExtensions.set_display_name(at, track_name)
    wave = unreal.load_asset(sound_path)
    sec = at.add_section()
    sec.set_sound(wave)
    if end is None:
        dur = float(wave.get_editor_property("duration"))
        end = start + max(1, int(round(dur * seq.get_display_rate().numerator / seq.get_display_rate().denominator)))
    sec.set_range(int(start), int(end))
    return sec


# ---------------------------------------------------------------- self-check

def selfcheck(package_path="/Game/Previz/_check",
              mesh="/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple",
              rig_bp="/Game/Characters/Mannequins/Rigs/CR_Mannequin_Body",
              clip="/Game/Characters/Mannequins/Anims/Unarmed/MM_Idle"):
    """Builds a one-shot storyboard and asserts the readbacks. Run this first on a new engine version.
    Always starts from a fresh asset so stacked keys from a previous run cannot mask a failure."""
    if unreal.EditorAssetLibrary.does_asset_exist(f"{package_path}/SEQ_check"):
        LSE.close_level_sequence()
        unreal.EditorAssetLibrary.delete_asset(f"{package_path}/SEQ_check")
    seq = get_or_create_sequence(package_path, "SEQ_check", end=24)
    open_sequence(seq)
    b = add_spawnable_character(seq, mesh, "Manny", location=(0, 0, 0))
    add_control_rig(seq, b, rig_bp)
    rig = get_rig(seq)
    assert control_type(rig, "body_ctrl") == "EULER_TRANSFORM", control_type(rig, "body_ctrl")
    assert pose_from_clip(seq, b, clip, clip_frame=100, at_frame=0), "pose_from_clip failed"
    loc, rot, _ = get_control(seq, rig, "hand_l_ik_ctrl", 0)
    assert abs(loc.x) + abs(loc.y) + abs(loc.z) > 0.5, "pose readback is identity — sequence not open?"
    set_control(seq, rig, "head_ctrl", 0, rotation=(0, -30, 0))
    assert abs(get_control(seq, rig, "head_ctrl", 0)[1].yaw + 30) < 0.5, "set_control did not stick"
    make_constant(cr_section(seq))
    cam = add_shot_camera(seq, "ShotCam", location=(0, -400, 140), rotation=(-5, 90, 0), focal_length=35)
    f, w, h = set_camera_lens(seq, cam, focal_length=50, sensor=(36, 24))
    assert (round(f), round(w), round(h)) == (50, 36, 24), (f, w, h)
    look_through(seq, 0)
    return "selfcheck OK: " + unreal.SystemLibrary.get_engine_version()
