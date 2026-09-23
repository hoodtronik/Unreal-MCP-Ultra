---
name: ue5-previz-sequencer
description: Build a storyboard / audio-visual first draft in UE5 Sequencer through BlueprintMCP run_python — pose Control Rig characters (or borrow a pose from a clip), place CineCameras with real lenses, assemble a master sequence of shots, hold poses on constant keys, and lay scratch dialogue/music/SFX. Use for previz, storyboards, animatics, blocking, "the screenshot method", shot timing, or any request to pose a mannequin/MetaHuman in Sequencer. Verified on UE 5.6.1; written to run unchanged on 5.8.
---

# UE5 previz in Sequencer (via BlueprintMCP `run_python`)

<!-- CLAUDE-NOTE: every call in this skill was executed against a live editor — UE 5.6.1 (MyLab_5_6)
on 2026-09-22 and UE 5.8.3 (MyLab_5_8) on 2026-09-23, where a full 5-shot storyboard with two characters,
audio and a master shot track was built end to end. Gotchas 13-18 all came out of that 5.8 build. -->

The workflow is the "first draft" method from Curry Barker's *Obsession* previz: lock story, framing,
pacing and sound with mannequins and a grid before any lighting or polish.

```
1 pose characters  →  2 place cameras  →  3 assemble shots  →  4 hold poses (constant keys)  →  5 lay audio
```

There is no dedicated MCP tool for any of this. Everything goes through `run_python` with
`ControlRigSequencerLibrary` + `MovieSceneSequenceExtensions`. Load the helper library once per
session and call its functions instead of re-deriving the API:

```python
exec(open(r"<this skill's base directory>/scripts/previz_lib.py").read())
```

## Before you start

1. `server_status` — confirm the editor mode server and **which project** is on port 9847.
2. `vision_mode(enabled=true)` — every `run_python` then returns a viewport frame. Combine with
   `look_through(seq, frame)` (locks the viewport to the camera cut) and you see each shot as you build it.
3. Find assets with the asset registry, never guess paths. Manny ships at
   `/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple`, rig `/Game/Characters/Mannequins/Rigs/CR_Mannequin_Body`,
   clips under `/Game/Characters/Mannequins/Anims/`. MetaHumans use their own body rig.

## Step 1 — pose characters

Make the character a **spawnable** inside the shot (self-contained; no level actor to lose), add a
Control Rig track, then either borrow a pose from a clip or set controls directly:

```python
seq = get_or_create_sequence("/Game/Previz/Scene01", "SEQ_0010", fps=24, end=48)
open_sequence(seq)                                   # REQUIRED — see gotcha 1
manny = add_spawnable_character(seq, "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple", "Manny",
                                location=(0, 0, 0), rotation=(0, 0, 0))
add_control_rig(seq, manny, "/Game/Characters/Mannequins/Rigs/CR_Mannequin_Body")
rig = get_rig(seq)

# fastest human-looking result: hold one frame of an existing clip
pose_from_clip(seq, manny, "/Game/Characters/Mannequins/Anims/Unarmed/MM_Idle", clip_frame=100, at_frame=0)

# then nudge individual controls (local space; rotation = (pitch, yaw, roll) degrees)
set_control(seq, rig, "hand_l_ik_ctrl", 0, location=(1.6, 9.6, 10.0))
set_control(seq, rig, "head_ctrl", 0, rotation=(10, -30, 0))
```

`list_controls(rig)` returns `(name, type)` pairs — 148 on the mannequin rig. Body/limb handles are
`EULER_TRANSFORM`; switches like `arm_l_fk_ik_switch` are `FLOAT`/`BOOL` (`set_control_float`).

Judge the pose from the frame, not the numbers. Iterate: set → look → adjust. **Facing is the one thing
to settle numerically first** — `set_facing(seq, name, 180)` then confirm with `facing_yaw()`. The spawn
`rotation` is not the direction the character appears to face (gotchas 13-14).

## Step 2 — cameras

One CineCamera **per shot**, spawnable, with a real lens, and a camera-cut section:

```python
add_shot_camera(seq, "ShotCam", location=(0, -400, 140), rotation=(-5, 90, 0),
                focal_length=35, filmback="Full Frame DSLR")
look_through(seq, 0)     # viewport now shows the shot; vision_mode frames show it too
```

Filmback names must match `CineCameraComponent.get_filmback_presets_copy()` exactly
(`"Full Frame DSLR"`, `"Super 35mm"`, `"16:9 DSLR"`, …) — an unknown name is a **silent no-op** (gotcha 3).
`set_camera_lens(seq, cam, focal_length=85, sensor=(36, 24))` edits the spawnable's template directly.

## Step 3 — shots on a master

```python
master = get_or_create_sequence("/Game/Previz/Scene01", "SEQ_Master", end=96)
add_shots(master, [(shot10, 0, 48, "shot0010"), (shot20, 48, 96, "shot0020")])
```

Retiming is `section.set_range(start, end)` on the shot section (master frames). The video's pacing
rule: when a beat feels slack, trim the incoming shot by ~25 frames rather than moving the audio.

## Step 4 — hold poses

Poses in an animatic should **step**, not float. `pose_from_clip` already writes constant keys.
After hand-set keys call `make_constant(cr_section(seq))` — it walks every keyed channel of the
Control Rig section and sets `RCIM_CONSTANT` (verified: mid-frame readback equals the earlier key).

## Step 5 — audio

```python
wave = import_wav(r"C:/path/dialogue_take1.wav", "/Game/Previz/Audio")
add_audio(master, "Dialogue", wave, start=0)
add_audio(master, "Music",    "/Game/Previz/Audio/sting", start=40)
save("/Game/Previz/Scene01")
```

One track per layer (Dialogue / Music / SFX), sections positioned in master frames.

## Gotchas (each cost real time)

| # | Symptom | Cause / fix |
|---|---|---|
| 1 | Every Control Rig getter returns identity, setters write nothing, no keys appear | The sequence is not open in the Sequencer editor. `ControlRigSequencerLibrary` resolves rig instances through the focused Sequencer. `open_level_sequence(seq)` first, every time. |
| 2 | Same symptom on a *specific* control | Typed accessor mismatch. Mannequin/MetaHuman body controls are `EULER_TRANSFORM`; `get/set_local_control_rig_transform` silently returns identity for them. Check `control_type()` and use the euler variants — `set_control()` does this for you. |
| 3 | Filmback still 23.76×13.365 after "35mm Full Frame" | Preset name doesn't exist; `set_filmback_preset_by_name` returns nothing either way. Use a listed name or set `sensor_width/height`. |
| 4 | `get_cine_camera_component()` is `None` on a spawnable | Templates don't expose the accessor; use `template.get_component_by_class(CineCameraComponent)`. |
| 5 | `load_anim_sequence_into_control_rig_section` needs a SkeletalMeshComponent and `SequencerTools.get_bound_objects` returns nothing for a spawnable | Spawnables only exist while the sequence is open; resolve with `LevelSequenceEditorBlueprintLibrary.get_bound_objects(binding_id)` where `binding_id = MovieSceneSequenceExtensions.get_binding_id(seq, binding)`. |
| 6 | Loading a whole clip creates ~230k keys | Use the `_with_range` variant with `clip_frame → clip_frame+1` to bake one frame (≈2 keys per channel). |
| 7 | Frame numbers off by 1000× | Always pass `MovieSceneTimeUnit.DISPLAY_RATE`; tick resolution is 24000/s. |
| 8 | `Rotator(a, b, c)` posed the wrong axis | Positional order is **(roll, pitch, yaw)**. The lib takes `(pitch, yaw, roll)` and uses keywords. |
| 9 | `create_camera()` left extra bindings | It returns a tuple and adds `CineCameraActor` + `CameraComponent` bindings and a cut; fine for one-offs, but `add_shot_camera` gives you naming and lens control. |
| 10 | `set_control` "did nothing" **after** a clip bake, only on the second run | Baking stacks keys: the one-frame bake writes 2 keys per channel (one at a sub-frame tick) and re-baking adds more at the *same ticks*. A setter updates one duplicate while evaluation reads another. `pose_from_clip` now clears the section first and collapses to one key per channel. |
| 11 | `get_bound_objects` empty for a spawnable created in the same `run_python` call | Spawnables are instantiated on Sequencer's next evaluation. Force one (`refresh_current_level_sequence()` + `set_current_time`) before resolving components — `bound_skeletal_mesh_component` does this. |
| 12 | Long lens = blurry frame | CineCamera default manual focus + DoF. `add_shot_camera(sharp=True)` (default) sets `focus_settings.focus_method = DISABLE`. |
| 13 | **A character spawned at yaw 180 renders in profile, not back-to-camera** | The UE5 mannequin *mesh* faces **−Y at actor yaw 0** — a −90° offset a Character BP normally cancels on its mesh component but a bare `SkeletalMeshActor` does not. Aim with `set_facing(seq, name, visual_yaw)` (applies `MESH_YAW_OFFSET`), never the raw spawn yaw. |
| 14 | Two different "measurements" both confirm a facing that is visibly wrong | Actor yaw describes the actor, not the mesh inside it; **bone/socket rotation is not facing** (the head socket read −180 while the character faced +Y). Only shoulder geometry is convention-free — `facing_yaw()`. Always round-trip: set, then re-measure. |
| 15 | Every captured frame is covered in coloured rig circles | Control Rig gizmos draw in the editor viewport. `presentation_mode(seq)` clears the selection and enables game view — **never** `hide_all_controls` (gotcha 19). |
| 16 | The captured frame shows the *previous* shot's pose or placement | A spawnable's transform track applies on the NEXT evaluation, so one `set_current_time` is not enough. `show_frame(seq, f)` scrubs twice and invalidates the viewport. |
| 17 | In a two-character shot, posing the second character moves the first | `get_rig(seq)` / `cr_section(seq)` are index 0 — the *other* character's rig. Resolve per track with `rig_for(seq, track)`. |
| 18 | `capture_view` returns a frame from the wrong camera | **Plugin bug on UE 5.8.3:** it ignores `location`/`lookAt` and returns the current viewport. See `docs/KNOWN-ISSUE-capture-view-ignores-camera.md`. Use `show_frame()` + the locked viewport instead. |
| 19 | **Held poses snap back to the reference pose after a capture; later bakes write 0 keys but return True** | `ControlRigSequencerLibrary.hide_all_controls` sets the section's controls *mask*, which is saved, stops those controls evaluating, and hides their channels from `get_all_channels()`. The old `presentation_mode` did this — it silently flattened every posed shot it framed. Fixed: the lib now calls `show_all_controls`; to repair an old sequence, `show_all_controls(section)` + save. |
| 20 | A bone/socket read (or the rig hierarchy) says the character is in reference pose while the viewport shows the pose | Sequencer applies the Control Rig pose on the **editor tick**, and none runs inside one `run_python` call. Open + scrub in one call, read in the **next**. Vision-mode frames lag the same way — capture with `viewport_capture` on a later call before judging. |
| 21 | `SequencerTools.export_anim_sequence` returns False for a spawnable | 5.8.3 logs `No skel mesh found in Sequencer`, open or closed. Use `bake_displayed_pose()` (component bone read, on the following call). |

## MetaHuman-skeleton dummies (decided 2026-09-23)

Previz characters are `/MetaHumanBodyTracker/SKM_Body` + `MetaHuman_ControlRig_Simple` (`MH_BODY_MESH` /
`MH_BODY_RIG`), so markerless-mocap solves (which land on `metahuman_base_skel`) drop straight in with
`pose_from_clip` — no retarget per solve. Facing offset is the same −90° as the mannequin; `set_facing` works.
Two costs: the rig is **FK only** (one control per bone, no IK handles), and the body is **headless**.

Poses authored on Manny/Quinn move across once via `/Game/Previz/Retarget/RTG_UE5Mannequin_To_MetaHuman`
(built with `IKRigController.apply_auto_generated_retarget_definition` + `IKRetargeterController.auto_map_chains(EXACT)`;
chain names match `IK_Metahuman` 1:1):

```python
# call 1: open_sequence(manny_shot); show_frame(manny_shot, 0)
# call 2 (the pose is only applied on the tick between calls — gotcha 20):
anim, mesh = bake_displayed_pose(manny_shot, "QUINN", "/Game/Previz/Retarget/Baked", "AS_Pose_X_Manny")
mh_path = retarget_anim(anim, mesh, "/Game/Previz/Retarget/RTG_UE5Mannequin_To_MetaHuman", "/Game/Previz/Retarget/Baked")
pose_from_clip(mh_shot, binding, mh_path, 0, 0, section=track.get_sections()[0])
```

## Aiming and framing without guessing

Two habits remove most of the iteration:

```python
set_facing(seq, "QUINN", 180)          # the direction she VISUALLY faces (0=+X, 180=-X)
assert abs(facing_yaw(seq, "QUINN")) > 179    # round-trip it; do not trust the spawn yaw

frame_on_bone(seq, "QUINN", dist=260, azimuth=34, pitch=-4)   # camera in front of her MEASURED head
show_frame(seq, 0)                     # lock to the shot camera, settle, clean plate
```

`frame_on_bone` beats hand-written camera coordinates: it reads the actual bone position after the
pose is baked, so a close-up stays on the face when the pose changes. Judge the result from the frame —
but establish *facing* numerically first, because a grey mannequin at 6 m is genuinely ambiguous to the eye.

## Engine compatibility

| Call | 5.6.1 | 5.8.3 |
|---|---|---|
| Everything in `previz_lib.py` | **live-verified 2026-09-22** (MyLab_5_6) | **live-verified 2026-09-22** — `selfcheck()` green in MyLab_5_8 on the dual-engine plugin build |
| `ControlRigSequencerLibrary.key_controls_at_frames` | missing | present — batch-keys named controls at frames |
| `RigHierarchy.find_control().settings` | the only way to read a control's type | deprecated → `get_control_settings(key)`; the lib feature-detects |
| `LevelSequence.add_spawnable_from_instance` / `SequencerTools.get_bound_objects` / `set_current_time(int)` / `get_control_rig_class` | deprecated or fine, all work | still present, deprecation warnings only; the lib already uses the subsystem / binding-id replacements where one exists |
| Pose from a **video** (markerless mocap) | n/a | 5.8-only, see `references/pose-from-video-ue58.md` |

On any new engine version, run `selfcheck("/Game/Previz/_check")` first and record drift here.

## References

- `references/api-recipes.md` — the raw verified snippets behind each helper, with readbacks.
- `references/pose-from-video-ue58.md` — image → video → MetaHuman Animator markerless solve → held pose.
- Epic: *Python Scripting for Animating with Control Rig* (5.8 docs) — the canonical snippet set.
