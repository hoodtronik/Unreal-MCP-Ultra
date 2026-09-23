# Verified API recipes — UE 5.6.1, 2026-09-22

Raw `run_python` probes behind `scripts/previz_lib.py`, with the readbacks that proved each one.
Project: MyLab_5_6, level Cigar_room, SKM_Manny_Simple + CR_Mannequin_Body. `vision_mode` was on, so
each mutation also returned a viewport frame that was inspected.

Conventions used throughout: `L = unreal.ControlRigSequencerLibrary`, `FN = unreal.FrameNumber`,
`DR = unreal.MovieSceneTimeUnit.DISPLAY_RATE`, `LSE = unreal.LevelSequenceEditorBlueprintLibrary`.

## 1. Sequence asset

```python
tools = unreal.AssetToolsHelpers.get_asset_tools()
seq = tools.create_asset("SEQ_Shot10", "/Game/_Previz/Test", unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
seq.set_display_rate(unreal.FrameRate(24, 1)); seq.set_playback_start(0); seq.set_playback_end(48)
# readback: display 24, tick resolution 24000  → always pass DISPLAY_RATE, never raw ticks
```

## 2. Character binding + Control Rig track

```python
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
rig_class = unreal.load_asset("/Game/Characters/Mannequins/Rigs/CR_Mannequin_Body").get_control_rig_class()
track = L.find_or_create_control_rig_track(world, seq, rig_class, binding)   # MovieSceneControlRigParameterTrack, 1 section
rig = L.get_control_rigs(seq)[0].control_rig
names = [str(k.name) for k in rig.get_hierarchy().get_controls()]           # 148 controls
section = track.get_sections()[0]; section.get_all_channels()                # 998 channels, named "ctrl.Location.X" etc.
```

Possessable: `binding = seq.add_possessable(level_actor)`.
Spawnable (preferred): `binding = LevelSequenceEditorSubsystem.add_spawnable_from_instance(seq, temp_actor)` then
destroy the temp actor. `LevelSequence.add_spawnable_from_instance(actor)` also works on 5.6 but is deprecated.

## 3. The sequence MUST be open — proof

Same script run twice. Closed: `get_local_control_rig_euler_transform` → (0,0,0), keys after set → 0.
After `LSE.open_level_sequence(seq)`: keys written, readback f0/f12/f24 hand Z = 0.0 / 0.04 / −1.54.

## 4. Typed accessor trap — proof

`get_local_control_rig_transform(seq, rig, "hand_l_ik_ctrl", FN(0), DR)` → identity, and the matching
setter wrote **no keys** (channel `hand_l_ik_ctrl.Location.Z` had 0 keys), sequence open or not.
`get_local_control_rig_euler_transform` on the same control → real values; the euler setter wrote keys.
Control type lookup that works (no `get_control_settings` on RigHierarchy):

```python
el = rig.get_hierarchy().find_control(unreal.RigElementKey(type=unreal.RigElementType.CONTROL, name="hand_l_ik_ctrl"))
el.settings.control_type      # RigControlType.EULER_TRANSFORM
```

## 5. Keying + constant interpolation

```python
e0 = L.get_local_control_rig_euler_transform(seq, rig, "hand_l_ik_ctrl", FN(0), DR)
L.set_local_control_rig_euler_transform(seq, rig, "hand_l_ik_ctrl", FN(0),  e0, DR, True)
eb = unreal.EulerTransform(location=e0.location + unreal.Vector(0, 0, 40), rotation=e0.rotation, scale=e0.scale)
L.set_local_control_rig_euler_transform(seq, rig, "hand_l_ik_ctrl", FN(24), eb, DR, True)
ch = section.get_channel("hand_l_ik_ctrl.Location.Z"); ks = ch.get_keys()      # 2 keys, MovieSceneScriptingActualFloatKey, RCIM_CUBIC
for c in section.get_all_channels():
    for k in c.get_keys(): k.set_interpolation_mode(unreal.RichCurveInterpMode.RCIM_CONSTANT)   # 36 keys on 2 controls
# readback f12 before: 0.04 (interpolating) → after: 0.0 (held)   ✔
```

## 6. Pose from a clip (single frame) — proof

Whole-clip load (`load_anim_sequence_into_control_rig_section`, deprecated on 5.6) wrote **227,544 keys**
for a 227-frame MM_Idle. Single-frame bake:

```python
bid = unreal.MovieSceneSequenceExtensions.get_binding_id(seq, binding)
skel = next(o.get_component_by_class(unreal.SkeletalMeshComponent) for o in LSE.get_bound_objects(bid))
ok = L.load_anim_sequence_into_control_rig_section_with_range(
        section, anim, skel, FN(0), True, FN(100), FN(101), DR, False, 0.001,
        unreal.MovieSceneKeyInterpolation.CONSTANT, True, False)
# ok=True, 1,996 keys (2 per channel, both at frame 0, RCIM_CONSTANT); hand_l_ik_ctrl f0 = (1.6, 9.6, −23.7)
```

`LSE.get_bound_objects` takes a `MovieSceneObjectBindingID`, not the proxy (TypeError otherwise).
`SequencerTools.get_bound_objects` is deprecated on 5.6 and returned `[]` for the spawnable.

## 7. Camera + camera cut

```python
cam = eas.spawn_actor_from_class(unreal.CineCameraActor, unreal.Vector(0, -380, 130), unreal.Rotator(pitch=-5, yaw=90, roll=0))
cc = cam.get_cine_camera_component(); cc.set_editor_property("current_focal_length", 35.0)
cc.set_filmback_preset_by_name("Full Frame DSLR")     # valid names: get_filmback_presets_copy()
cb = ses.add_spawnable_from_instance(seq, cam); cb.set_display_name("ShotCam"); eas.destroy_actor(cam)
cut = seq.add_track(unreal.MovieSceneCameraCutTrack); cs = cut.add_section(); cs.set_range(0, 48)
cs.set_camera_binding_id(unreal.MovieSceneSequenceExtensions.get_binding_id(seq, cb))   # binding.get_binding_id() does not exist
LSE.set_lock_camera_cut_to_viewport(True); LSE.set_current_time(10)                         # viewport now = shot cam
```

Preset names on 5.6: 16:9 Film, 16:9 Digital Film, 16:9 DSLR, Super 8mm, Super 16mm, Super 35mm,
35mm Academy, 35mm Full Aperture, 35mm VistaVision, IMAX 70mm, APS-C (Canon), Full Frame DSLR, Micro Four Thirds.
Lens presets: 12/30/50/85/105/200mm primes, 24-70 & 70-200 zooms, Universal Zoom.
`set_filmback_preset_by_name("35mm Full Frame")` returned normally and changed nothing (23.76×13.365 stayed).

Spawnable template lens edit: `cb.get_object_template().get_component_by_class(unreal.CineCameraComponent)`
(`get_cine_camera_component()` returns None on the template). Direct `filmback.sensor_width/height` set → 36×24 ✔.

`LevelSequenceEditorSubsystem.create_camera(True)` → `(binding, actor)` tuple; adds `CineCameraActor` +
`CameraComponent` bindings and a cut section on the focused sequence.

## 8. Master sequence, shots, audio

```python
st = master.add_track(unreal.MovieSceneCinematicShotTrack)
ss = st.add_section(); ss.set_sequence(shot10); ss.set_range(0, 48); ss.set_shot_display_name("shot0010")
# readback: [('shot0010', 0, 48), ('shot0020', 48, 96)]
at = master.add_track(unreal.MovieSceneAudioTrack); unreal.MovieSceneTrackExtensions.set_display_name(at, "Dialogue")
a = at.add_section(); a.set_sound(unreal.load_asset("/Engine/VREditor/Sounds/UI/Object_PickUp")); a.set_range(0, 48)
unreal.EditorAssetLibrary.save_directory("/Game/_Previz/Test", False, True)
LSE.open_level_sequence(master)     # get_current_level_sequence() → SEQ_Master
```

## 8b. Library end-to-end (previz_lib.py `selfcheck` + two-shot build) — 2026-09-22

Fresh package, `selfcheck("/Game/_Previz/LibTest")` → `selfcheck OK: 5.6.1-44394996`. Then two shots
(`pose_from_clip` frames 100 / 30, `set_control` head (15, −35, 0) read back exactly, `make_constant` →
975 keys = one per channel), spawnable cams (Super 35mm 50 mm / Full Frame DSLR 85 mm), master with
`shot0010` 0–48 + `shot0020` 48–96, `import_wav(C:/Windows/Media/tada.wav)` → `SFX_tada`, `add_audio`
range 40–79 from the wave's duration, `look_through(master, 60)` showed shot0020's camera.

Two failures on the way, both now handled in the lib:

- **Stacked keys.** `head_ctrl.Rotation.Y` after a second bake: `[(0, 0.0), (0, 0.4), (800, 0.44), (800, 0.44)]`
  (tick, value) — duplicates at tick 0 and a sub-frame key at tick 800. A setter then updated one tick-0 key
  while evaluation read the other: readback stayed at −16.95 after setting −30. Fix: `clear_keys` before the
  bake and collapse to a single key at the target frame after it.
- **Spawnable not yet instantiated.** `LSE.get_bound_objects(binding_id)` → `[]` when the spawnable was added
  earlier in the same call. One forced evaluation (`refresh_current_level_sequence()` + `set_current_time`)
  and it resolves.

## 9. Enum / API presence on 5.6.1

- `MovieSceneKeyInterpolation`: AUTO, BREAK, CONSTANT, LINEAR, SMART_AUTO, USER
- `MovieSceneTimeUnit`: DISPLAY_RATE, TICK_RESOLUTION
- `RichCurveInterpMode`: RCIM_CONSTANT, RCIM_CUBIC, RCIM_LINEAR
- `ControlRigSequencerLibrary.key_controls_at_frames`: **absent** (present on 5.8)
- Deprecated but working: `LSE.set_current_time(int)`, `LSE.get_current_time()`,
  `LevelSequence.add_spawnable_from_instance`, `SequencerTools.get_bound_objects`,
  `L.load_anim_sequence_into_control_rig_section` (→ use `_with_range`), `EditorLevelLibrary.get_editor_world`.
