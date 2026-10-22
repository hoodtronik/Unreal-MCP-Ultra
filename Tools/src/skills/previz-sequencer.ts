import type { Skill } from "./types.js";

// CLAUDE-NOTE: Added 2026-09-22. Storyboard / audio-visual first-draft previz in Sequencer via run_python.
// CLAUDE-NOTE (2026-10-22): since then ~80 verified pose_/anim_/seq_/shot_ tools exist; the tool map at the top tells
// agents to use them and keep raw run_python for gaps (lesser agents otherwise re-derive these by hand). Every call below was executed against a live UE 5.6.1
// editor; the same library functions are what Epic's shipped 5.8 AnimationAssistantToolset calls, so the
// surface exists on 5.8 too (not yet run there). The long-form version with the raw probes and a Python
// helper library lives in .agents/skills/ue5-previz-sequencer/ — this is the condensed hub copy.

export const previzSequencerSkill: Skill = {
  name: "previz-sequencer",
  description: "Storyboard/previz in Sequencer via run_python: pose Control Rig characters or borrow a pose from a clip, per-shot CineCameras with real lenses, master shot track, constant (held) keys, scratch audio",
  content: `# Previz / Storyboard in Sequencer (run_python)

## Use the verified tools first (raw run_python only for gaps)
Every tool below sets its result from a MEASURED readback (bones, renders, files) - read its report; a line marked
"<-" is a failure even if the call returned. Save the project (save_all) before mutating; serialise calls.
- Character + rig: pose_setup_character (rig honoured) · cr_build / cr_build_modular (author a Control Rig) · pose_list_controls
- Pose: pose_set_controls · pose_read · pose_reach (hand/foot to a point) · pose_look_at · pose_hand / pose_palm ·
  pose_fk · pose_layer (additive over a clip) · pose_tween (breakdowns) · pose_mirror · pose_snap · pose_space_switch ·
  pose_constrain · pose_library_save / _apply · pose_asset / pose_asset_create · pose_statue (freeze a pose as a
  background figure) · pose_ground_check / pose_ground_fix · pose_set_interpolation (held keys)
- Props: prop_attach · prop_key · prop_socket · prop_check · seq_constrain (parent/look-at constraints, bake on remove)
- Animation clips: anim_walk · anim_stitch (join clips, root motion) · anim_edit · anim_bake · anim_fbx / skel_fbx ·
  anim_clip_info · anim_foot_report · pose_motion_report · take_record
- Anim Blueprints / blending: anim_bp_check · anim_bp_drive · add_anim_node · anim_node_measure · anim_transition_rule ·
  create_blend_space · blend_space_check · aim_offset_check · anim_montage · anim_dynamic_montage · set_blend_profile ·
  create_mirror_table · pose_search_build · rt_live
- Retarget / IK: ikrig_create · retarget_setup · retarget_align_pose · retarget_animations
- Sequencer: seq_bind · seq_tracks (fade, marks, mute/lock, material keys) · seq_property · seq_curve ·
  seq_subsequence · seq_master (shots track + audio) · seq_light
- Camera / shot: shot_camera · shot_camera_follow · shot_rig (dolly/crane) · shot_camera_shake · shot_frame_check ·
  shot_sightlines (staging/occlusion) · shot_look (DoF on a subject, white balance, grading, vignette, bloom, fog) ·
  shot_light (key/fill/rim relative to the camera) · viewport_pilot · shot_capture
- Render: shot_render (MP4) · shot_stills (every camera at chosen frames) · shot_render_passes (lit/unlit/
  path_tracer/depth/normal/motion) · shot_object_ids · shot_render_graph (Movie Render Graph, clean plates)
Habits that the tools encode: scrub twice before reading bones (they refresh between calls); look at a render, not
only numbers; a camera added by Sequencer has focus/aperture TRACKS that override component edits; spawnable
templates ignore setter functions (write properties); keep test content in /Game/_MCPLab.

## Raw API notes (for gaps the tools don't cover)
Workflow ("first draft" method): 1 pose characters -> 2 cameras -> 3 shots on a master -> 4 hold poses -> 5 audio.
Turn on vision_mode first: every run_python then returns a viewport frame. Lock the viewport to the shot camera
with LevelSequenceEditorBlueprintLibrary.set_lock_camera_cut_to_viewport(True) so the frames show the shot.

Aliases used below: L = unreal.ControlRigSequencerLibrary; LSE = unreal.LevelSequenceEditorBlueprintLibrary;
FN = unreal.FrameNumber; DR = unreal.MovieSceneTimeUnit.DISPLAY_RATE (ALWAYS pass DR; tick resolution is 24000/s).

## The rule that breaks everything if skipped
LSE.open_level_sequence(seq) BEFORE any Control Rig read or write. ControlRigSequencerLibrary resolves rig
instances through the focused Sequencer; unopened, every getter returns identity and every setter is a silent no-op.

## 1. Characters + Control Rig
- Sequence: AssetTools.create_asset(name, path, unreal.LevelSequence, unreal.LevelSequenceFactoryNew());
  seq.set_display_rate(unreal.FrameRate(24,1)); set_playback_start/end.
- Spawnable character (self-contained shot): spawn a temp SkeletalMeshActor, then
  LevelSequenceEditorSubsystem.add_spawnable_from_instance(seq, actor); destroy the temp actor.
- Rig: rig_class = load_asset(CR_bp).get_control_rig_class();
  L.find_or_create_control_rig_track(world, seq, rig_class, binding); rig = L.get_control_rigs(seq)[0].control_rig.
- Control names: rig.get_hierarchy().get_controls() (Manny body rig: 148). Control TYPE:
  hierarchy.find_control(RigElementKey(type=CONTROL, name)).settings.control_type.
- TYPED ACCESSOR TRAP: mannequin/MetaHuman body controls are EULER_TRANSFORM. get/set_local_control_rig_transform
  on them returns identity and writes NO keys, with no error. Use get/set_local_control_rig_euler_transform
  (unreal.EulerTransform(location, rotation, scale)). Floats/bools (fk_ik switches) use the _float/_bool variants.
- Key a pose: L.set_local_control_rig_euler_transform(seq, rig, name, FN(frame), value, DR, True).
- Rotator positional order is (roll, pitch, yaw) — use keywords.

## Borrow a pose from a clip (fastest human-looking result)
bid = unreal.MovieSceneSequenceExtensions.get_binding_id(seq, binding)
skel = component from LSE.get_bound_objects(bid)   # SequencerTools.get_bound_objects is deprecated and empty for spawnables
L.load_anim_sequence_into_control_rig_section_with_range(section, anim, skel, FN(at), True, FN(f), FN(f+1), DR,
    False, 0.001, unreal.MovieSceneKeyInterpolation.CONSTANT, True, False)   # one clip frame -> ~2 keys/channel, held
(Whole-clip load writes ~230k keys — only do it on purpose.) Then nudge controls with the euler setter.
Two traps: (a) the bake leaves 2 keys/channel (one sub-frame) and re-baking STACKS keys at the same ticks — a later
setter then updates one duplicate while evaluation reads another, so the pose "won't change"; remove all keys before
baking and keep one key per channel after. (b) a spawnable added in the same run_python call is not instantiated
until Sequencer evaluates — call LSE.refresh_current_level_sequence() + LSE.set_current_time(f) before resolving
its components.

## 2. Cameras (one per shot, spawnable)
cam = spawn CineCameraActor; cc = cam.get_cine_camera_component(); cc.set_editor_property("current_focal_length", 35.0)
For previz disable depth of field (default manual focus blurs long lenses): fs = cc.get_editor_property("focus_settings");
fs.focus_method = unreal.CameraFocusMethod.DISABLE; cc.set_editor_property("focus_settings", fs).
cc.set_filmback_preset_by_name(name) — name MUST be in CineCameraComponent.get_filmback_presets_copy()
("Full Frame DSLR", "Super 35mm", "16:9 DSLR", ...); an unknown name is a SILENT no-op.
binding = subsystem.add_spawnable_from_instance(seq, cam); cut = seq.add_track(MovieSceneCameraCutTrack);
cs = cut.add_section(); cs.set_range(0, N); cs.set_camera_binding_id(MovieSceneSequenceExtensions.get_binding_id(seq, binding)).
Editing a spawnable camera later: binding.get_object_template().get_component_by_class(CineCameraComponent)
(get_cine_camera_component() is None on templates); set filmback.sensor_width/height directly.

## 3. Master + shots
st = master.add_track(MovieSceneCinematicShotTrack); ss = st.add_section(); ss.set_sequence(shot);
ss.set_range(start, end); ss.set_shot_display_name("shot0010"). Retime = set_range on the shot section.
Pacing rule from the source video: trim the incoming shot ~25 frames when a beat is slack; don't move the audio.

## 4. Hold poses (animatic steps, no floating)
for ch in section.get_all_channels(): for k in ch.get_keys(): k.set_interpolation_mode(RichCurveInterpMode.RCIM_CONSTANT)
Verified: mid-frame readback equals the earlier key afterwards.

## 5. Audio
at = seq.add_track(MovieSceneAudioTrack); MovieSceneTrackExtensions.set_display_name(at, "Dialogue");
a = at.add_section(); a.set_sound(wave); a.set_range(start, end). One track per layer (Dialogue/Music/SFX).
Import from disk with AssetImportTask (filename, destination_path, automated=True).

## Engine notes
5.6.1: live-verified. 5.8: same functions; extra L.key_controls_at_frames exists there. Deprecated-on-5.6 calls
to avoid: LevelSequence.add_spawnable_from_instance, SequencerTools.get_bound_objects,
L.load_anim_sequence_into_control_rig_section (use _with_range). Pose-from-VIDEO needs the 5.8-only
"MetaHuman Animator Markerless Motion Capture" Fab plugin: its output is an AnimSequence, so it feeds the
same one-frame bake above. Solves land on metahuman_base_skel — previz with /MetaHumanBodyTracker/SKM_Body +
MetaHuman_ControlRig_Simple (FK, headless, same -90 mesh yaw offset) and no retarget is needed.

## Two silent traps (5.8.3, 2026-09-23)
- NEVER L.hide_all_controls to clean up a capture: it saves a controls MASK that stops those controls
  evaluating (held poses snap to reference) and makes later bakes write 0 keys while returning True.
  Repair with L.show_all_controls(section) + save.
- Sequencer applies Control Rig poses on the editor TICK. Inside one run_python call, bone/socket and
  rig-hierarchy reads return the reference pose. Scrub in one call, read or bake in the next.
`,
};
