# Pose from an image, without hand-posing — UE 5.8 markerless mocap path

**Status: plugin installed and its API probed live on 2026-09-23 (UE 5.8.3, MyLab_5_8). A real clip has
not been solved yet.** Everything under "Verified on this machine" is measured; the rest is the plan.

## The feature

**MetaHuman Animator Markerless Motion Capture** — "Turns single-camera footage of an actor into body
animation within MetaHuman Animator." Free on Fab, **experimental**, v1.0.0.

| | |
|---|---|
| Installs to | `Engine/Plugins/Marketplace/MetaHumanBodyTracker_5.8/` |
| Modules | `MetaHumanBodyTracker` (Editor), `BodyTracker` (Runtime), `Segmentation` (Runtime), `MetaHumanBodyOptimizer` (Editor) |
| Depends on | `MetaHumanCoreTech`, `MetaHuman` (= MetaHuman Animator), `IKRig` |
| Platforms | Win64 / Mac / Linux |
| Enable in the project | `MetaHuman`, `MetaHumanBodyTracker` (+ `PerformanceCaptureWorkflow` for the Mocap Manager panel) |
| Input | one static mono camera; full body visible, unoccluded; face ≥ 1/30 of frame width |
| Solve | offline, local, ~1 min per second of 1080p |
| Output | an AnimSequence on the **MetaHuman body skeleton** |

Enabling **MetaHuman Animator** alone pulls in its 19 dependencies (CoreTech, SDK, PerformanceCaptureCore,
CaptureData, CaptureManagerEditor, NNERuntimeORT, IKRig, DNACalib…). Do not tick the rest of the MetaHuman
family: CoreML is Apple-only, Calibration Diagnostics/Processing are for multi-camera rigs, Crowd pulls
Mass, Live Link is for realtime streaming, and MetaHumanRuntime is deprecated in favour of the SDK.

## Verified on this machine: the solve is SCRIPTABLE

This corrects an earlier note in this file that said the solve had no Python entry point and would be a
GUI click. It does have one, and Epic named the argument for us:

```python
perf = unreal.load_asset("/Game/.../MyPerformance")          # UMetaHumanPerformance
perf.set_editor_property("footage_capture_data", footage)     # ingested clip
perf.set_editor_property("body_tracking", True)               # body solve (face_tracking is separate)
perf.set_editor_property("identity", identity)                # MetaHumanIdentity, if the flow needs one
perf.set_processing_range(start_frame, end_frame)
perf.set_blocking_processing(True)                            # run synchronously
err = perf.start_pipeline(is_scripted_processing=True)        # <-- built for scripting
...
perf.export_animation(export_range)
```

Confirmed present on `unreal.MetaHumanPerformance`: `body_tracking`, `face_tracking`,
`footage_capture_data`, `identity`, `audio`, `input_type`, `control_rig_class`,
`set_processing_range(start, end)`, `set_depth_distance_range`, `set_blocking_processing`,
`start_pipeline(is_scripted_processing=True) -> StartPipelineErrorType`, `can_process`, `is_processing`,
`get_number_of_processed_frames`, `contains_animation_data`, `can_export_animation`,
`export_animation(export_range)`, `cancel_pipeline`, `on_processing_finished_dynamic`.
Also `unreal.MetaHumanPerformanceExportUtils.export_animation_sequence` / `export_level_sequence`, each
with a matching `get_export_*_settings`.

**The unproven step is ingest.** `MetaHumanCaptureSourceType` offers only `HMC_ARCHIVES`,
`LIVE_LINK_FACE_ARCHIVES`, `LIVE_LINK_FACE_CONNECTION`, `UNDEFINED` — there is no generic "mono video"
source, so getting an arbitrary MP4 into a `FootageCaptureData` may still go through the Capture Manager
panel. Settle that against a real clip before promising an unattended pipeline.

## Pipeline

```
pose reference image
   → image-to-video (a 3-5 s "hold the pose" clip, STATIC camera, whole body in frame)
   → ingest as FootageCaptureData                                   [ingest route unproven]
   → MetaHumanPerformance + body_tracking → start_pipeline          [scriptable, verified]
   → export_animation → AnimSequence on the MetaHuman skeleton      [scriptable, verified]
   → previz_lib.pose_from_clip(seq, binding, anim_path, clip_frame=N)
```

The last step is the point: a solved clip is just another AnimSequence, so one frame of it becomes a held
Control Rig pose through the verified `_with_range` bake. Nothing in the Sequencer half changes.

## Decisions to make on first use

- **Mannequin or MetaHuman dummies?** The solve lands on the MetaHuman skeleton. MetaHuman-skeleton previz
  characters skip retargeting entirely; Manny/Quinn need an IK Retargeter pass (`RTG_UE5Mannequin_To_MetaHuman`
  supplies the IK rigs).
- **Which frame?** Generated video drifts — pick the frame by eye with `show_frame` rather than assuming 0.
- **Feet.** Foot float is expected; for a still, drop `foot_l_ik_ctrl` / `foot_r_ik_ctrl` to the floor
  with `set_control` after the bake.

## Sources

- [Epic docs — MetaHuman animation from mono video capture](https://dev.epicgames.com/documentation/metahuman/metahuman-animation-from-mono-video-capture-in-unreal-engine)
- [Fab listing](https://www.fab.com/listings/4095b8e0-3eff-44f1-acb4-cb40b99228b9)
- [Performance capture guidelines](https://dev.epicgames.com/documentation/metahuman/facial-performance-capture-guidelines)
