# Pose from an image, without hand-posing — UE 5.8 markerless mocap path

**Status: researched 2026-09-22, not yet run.** Everything below the "Pipeline" heading is the plan;
the facts above it come from Epic's documentation and the plugin's Fab listing.

## The feature

UE 5.8 added **"Animation from Mono Video Capture"** to MetaHuman Animator. Body (and optionally face)
capture from a single ordinary camera — webcam or phone footage — with no markers, suit or helmet cam.

| | |
|---|---|
| Plugin | **MetaHuman Animator Markerless Motion Capture** — free on Fab, listing `4095b8e0-3eff-44f1-acb4-cb40b99228b9` |
| Requires | UE **5.8+**, MetaHuman Animator plugin enabled, **Windows only** |
| Input | one static mono camera; full body visible, no occlusion by props/furniture/people; face ≥ 1/30 of frame width |
| Solve | offline, local, batch; ~1 minute per second of 1080p |
| Output | a standard **AnimSequence on the MetaHuman body skeleton** (fingers included); no retarget needed onto any MetaHuman |
| Caveats | experimental; moving cameras degrade the solve; some foot float is expected |
| Scripting | no documented Python entry point for the body solve — expect the solve itself to be a GUI click |

Not installed on this machine as of 2026-09-22 (grep of `UE_5.8/Engine/Plugins` and `F:/_UnrealProjects` for `markerless` found nothing).

## Pipeline

```
pose reference image
   → image-to-video (Kling MCP `image_to_video` / `motion_control`): 3-5 s, static camera, whole body in frame, "hold the pose"
   → import the clip into a 5.8 project as a Capture Source, run the markerless body solve   [GUI]
   → AnimSequence on the MetaHuman skeleton
   → previz_lib.pose_from_clip(seq, binding, anim_path, clip_frame=N)   ← the same step this skill already uses
```

The last step is the point: a solved clip is just another AnimSequence, so one frame of it becomes a
held Control Rig pose through the verified `_with_range` bake. Nothing in the Sequencer half changes.

## Decisions to make on first use

- **Mannequin or MetaHuman dummies?** The solve lands on the MetaHuman skeleton. Using MetaHuman-skeleton
  previz characters skips retargeting entirely. If the dummies must stay Manny, run the clip through an IK
  Retargeter first (the prebuilt `RTG_UE5Mannequin_To_MetaHuman` gives the IK rigs; build the reverse).
- **Which frame?** Generated video drifts; pick the frame closest to the reference by eye with
  `look_through` + `vision_mode` rather than assuming frame 0.
- **Feet.** Foot float is expected; for a still, drop `foot_l_ik_ctrl` / `foot_r_ik_ctrl` to the floor with
  `set_control` after the bake.

## Alternatives if the plugin path is blocked

- Single-image 3D pose estimation outside UE → FBX → `ControlRigSequencerLibrary.import_fbx_to_control_rig_track`
  (present on 5.6). Needs an external tool; nothing in this toolkit does it today.
- Blender MCP: `blender_retarget_animation` / Auto-Rig Pro for retargeting a mocap FBX before import.

## Sources

- Epic docs — MetaHuman animation from mono video capture:
  https://dev.epicgames.com/documentation/metahuman/metahuman-animation-from-mono-video-capture-in-unreal-engine
- Fab listing: https://www.fab.com/listings/4095b8e0-3eff-44f1-acb4-cb40b99228b9
- CG Channel, 2026-06: https://www.cgchannel.com/2026/06/get-the-free-metahuman-animator-markerless-mocap-plugin/
- MetaHuman 5.8 release notes: https://dev.epicgames.com/documentation/metahuman/metahuman-5-8-release-notes-in-unreal-engine
- Performance capture guidelines: https://dev.epicgames.com/documentation/metahuman/facial-performance-capture-guidelines
