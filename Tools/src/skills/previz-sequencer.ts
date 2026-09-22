import type { Skill } from "./types.js";

// CLAUDE-NOTE: Added 2026-09-22. Storyboard / audio-visual first-draft previz in Sequencer via run_python
// (there is no MCP sequencer or control-rig tool). Every call below was executed against a live UE 5.6.1
// editor; the same library functions are what Epic's shipped 5.8 AnimationAssistantToolset calls, so the
// surface exists on 5.8 too (not yet run there). The long-form version with the raw probes and a Python
// helper library lives in .claude/skills/ue5-previz-sequencer/ — this is the condensed hub copy.

export const previzSequencerSkill: Skill = {
  name: "previz-sequencer",
  description: "Storyboard/previz in Sequencer via run_python: pose Control Rig characters or borrow a pose from a clip, per-shot CineCameras with real lenses, master shot track, constant (held) keys, scratch audio",
  content: `# Previz / Storyboard in Sequencer (run_python)

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
same one-frame bake above.
`,
};
