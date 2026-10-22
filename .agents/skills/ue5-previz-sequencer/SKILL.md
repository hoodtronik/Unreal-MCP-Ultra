---
name: ue5-previz-sequencer
description: Build a storyboard / audio-visual first draft in UE5 Sequencer through BlueprintMCP (pose_* tools + run_python) — pose Control Rig characters (or borrow a pose from a clip), place CineCameras with real lenses, assemble a master sequence of shots, hold poses on constant keys, and lay scratch dialogue/music/SFX. Use for previz, storyboards, animatics, blocking, "the screenshot method", shot timing, or any request to pose a mannequin/MetaHuman in Sequencer. Verified on UE 5.6.1; written to run unchanged on 5.8.
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

**Posing has dedicated MCP tools (2026-10-21)** - prefer them; each write is read back on the next editor
tick and `isError` is set from that readback:

| Tool | Does | Verified (UE 5.6.1) |
|---|---|---|
| `pose_setup_character` | sequence + spawnable mesh + Control Rig track + held clip frame + **measured** facing (corrects clip hip twist) | facing -90 wanted -> -90.0 measured |
| `pose_list_controls` | controls + types (filter `contains`/`type`) | 148 on CR_Mannequin_Body |
| `pose_set_controls` | batch key controls (local or `world`), typed dispatch, per-control readback | unknown control -> error, not "ok" |
| `pose_read` | world bones (roles resolve on prefixed skeletons), facing (shoulders+toes), lowest foot z, control values | |
| `pose_reach` | hand/foot IK to a point/actor/bone, miss distance + reach budget vs limb length | 0.000 cm reachable; 6.1 cm predicted = 6.147 measured out-of-reach |
| `pose_look_at` | head gaze at a point / actor / other character's bone, iterated on measured gaze (head +Y) | 22.9 -> 0.027 deg in one step |
| `pose_ground_check` | per-part contact from the POSED SKIN (GeometryScript copy of the posed mesh): feet, knees, hands, seat vs floor | knee joint z=-1.1 was 6 cm of skin under the floor |
| `pose_ground_fix` | move body_ctrl in Z until one part's skin touches the floor, report all parts after | knee -6.08 -> -0.15 cm in one step |
| `pose_hand` | open / relaxed / fist / point on the finger controls (curl = negative yaw), measured chord ratio | fist 0.60, open 0.99 |
| `pose_palm` | palm faces a point/actor/camera binding with fingers up or along `fingers` (two-vector orientation), next-tick readback | 85 -> 0.01 deg, fingers 7-8 deg from up |
| `prop_attach` | prop as a spawnable on a Sequencer Attach track to a bone; `size`, `color`; `grip:"r"` lays it on the open hand's skin and curls fingers (even arc, bisection) + thumb roll until each touches | 7 cm cup: 5/5 digits, deepest skin -0.20 cm |
| `prop_check` | per-frame: bone-space offset drift, world path, distance to a target (mouth), hand gaps, BODY skin inside the prop | drift 0.000 cm; caught the cup 2 cm inside the face |
| `anim_walk` | walk a path: in-place (root-locked copy) locomotion clip + transform keys at the clip's MEASURED root speed, turns per leg, strips the auto-added rig track, verifies feet and foot-locks corners | L path 9 m: corner slide 9.25 -> 0.67 cm/frame |
| `anim_foot_report` | per-frame planted-ball slide (skating) + floor height for any animated character | right speed 0.4 vs wrong 4.17 cm/frame |
| `create_blend_space` / `set_blend_space_samples` | 1D/2D, replace or merge, every sample validated (exists, skeleton, inside axes) else nothing written; resamples like the editor and evaluates each sample point vs its clip | BS_Loco1D idle/walk/jog: 0.00 cm each |
| `blend_space_check` | read + evaluate any blend space at its sample points | un-resampled: 33-36 cm off -> FAIL |
| ABP tools (`add_state_machine`, `add_anim_state`, `set_state_animation`, `set_state_blend_space`, ...) | now resolve assets first (typo / wrong skeleton = error, nothing changed), auto-wire Output Pose / Entry / state player, compile after each step (unwired = error) | ABP_Loco: idle + BS state compiles clean |
| `anim_bp_check` | compile + run the ABP on a hidden mannequin; fails if it plays the reference pose | unwired ABP -> 0.0 cm -> FAIL; ABP_Loco 30.9 cm |
| `pose_library_save` / `pose_library_apply` | Control Rig pose -> ControlRigPoseAsset (+ bone snapshot metadata); apply keys every stored control and verifies against the snapshot (same mesh 0.5 cm) | wave/handshake/sip onto new Mannys: 17 bones 0.0 cm; Quinn kneel on Manny: proportions <= 11 cm, ground contact ok |
| `pose_mirror` / `pose_library_apply mirror:true` | flip a pose left<->right in place (keys all 148 controls, limbs end in FK); verifies every rendered bone vs the mirror image (0.5 cm) and fails on reflected (negative-scale) bones | 4 library poses mirrored: 82 bones <= 0.04 cm, 0 reflected, foot contact equal |
| `anim_transition_rule` | WHEN a state-machine transition fires: wires `<var> <op> <value>` (float/int) or `<bool> true/false` into Can Enter Transition, names rule graphs "<From> to <To>", exposes the variable, compiles, reads the wiring back | ABP_Locomotion: 4 rules, Compile OK; refuses to overwrite without `replace` |
| `anim_bp_drive` | run the ABP (hidden editor preview or `pie:true`), set variables step by step, report the state from the RENDERED pose (bones vs each state's clip, root-relative, 120 fps); `expect` makes it a test; `place` leaves a visible character for captures | PIE: Idle->Jog chain, hysteresis 55/60/40 all as expected; playing state <= 2.6 cm, others >= 18 cm; caught an unwired Walk->Idle |
| `anim_bake` | bake a Sequencer character's performance (Control Rig keys etc.) into an AnimSequence, then verify every rendered bone vs the clip at sampled frames (1 cm) | SEQ_Wave -> A_Wave_Baked: 89 bones x 9 frames, worst 0.39 cm; empty clip read 12-60 cm |
| `pose_space_switch` | key a Control Rig space switch (control follows another control/null, e.g. body_ctrl, or 'world') at a frame; verifies no pop + the offset held in the new space on sampled frames; reports the effector bone gap | hand_l_ik_ctrl -> body_ctrl: pop 0 cm, body moved 14.4 cm, drift 0 cm |
| `pose_constrain` | Sequencer animation constraint (parent/translation/rotation) of a control to a prop, binding, another rig's control or a bone; verifies follow; `bake` turns it into keys; `remove` | hand_r_ik_ctrl -> sliding Tray: moved 16.8 cm, drift 0; bake keyed 0-48, worst 0 cm |
| `prop_key` | free (unattached) prop keyed in WORLD space - a moving parent for constraints, set dressing | Tray keys 0/48 read back 0 cm |
| `pose_tween` | breakdown / in-between pose with the Control Rig Tween tool (-1 prev .. 1 next) for every control keyed on both sides (or a list); verifies each control vs prev + (next-prev)*(v+1)/2 and its key | SEQ_ShelfReach f8 -0.4 / f16 0.5: worst 0.0006, hand at 30% / 75% exactly |
| `retarget_align_pose` | auto-aligned retarget pose (A vs T pose etc.) on an IK Retargeter, A/B-checked on a clip (absolute limb angle + feet); kept only if better, else restored | Manny->Fab girl walk: 7.8 -> 0.82 deg, feet 3.6 -> 2 cm (kept); mesh_to_mesh 14.2 deg / 13 cm (restored) |
| `pose_snap` | Control Rig Snapper: key controls onto an actor/bone on every frame of a range (plain keys, no live constraint); keepOffset keeps the start offset; verifies drift, start jump, bone gap | SEQ_SnapTray: hand under a lifted tray, tray moved 28 cm, drift 0, jump 0 |
| `prop_socket` | save where a prop sits in the hand (after `prop_attach grip`) as a SKELETON socket, re-attach the prop to it; verifies stored values, no move and no turn; `prop_attach bone:<socket> grip` then puts any prop there and only curls the fingers | SEQ_Toast: Manny's cup grip -> Cup_Grip_R, moved 0 / turned 0; Quinn grips a cup on it, 5/5 digits within 1 cm |
| `pose_layer` | ADDITIVE (layered) Control Rig over a clip (walk/mocap): `add` (legs keyed FK = pass-through, verified vs the muted clip), then `pose_look_at`/`pose_reach`/`pose_palm`/`pose_set_controls` work as offsets; `zero` bounds an edit; `check` reports per region what moved, `keep` regions must stay on the clip | SEQ_WalkWave: walk + glance + wave to camera; legs 0.000 cm off the clip on 8 frames |
| `pose_fk` | auto FK Control Rig on ANY skeleton (imported/Fab characters without a rig), face bones included: `add` (replace / additive), `set` rotation offsets + `locations` in world cm, `aim` a bone's child at a world point (solved + re-measured), `list`; verified vs base * offset with the rig muted | Fab girl (99 bones): wave by `aim` (<= 0.001 deg, 1 step each), smile via lip corners (0.60 cm asked 0.6), jaw, brows |
| `anim_montage` / `anim_montage_play` | montage from clips (trims, rates, loops), sections with order, slot, blends - written by the plugin (/api/montage-edit; Python cannot see tracks/sections) and read back; playback through an ABP Slot on a hidden (or `place`d) mannequin, parked at positions and checked against the clip time each maps to, section jumps, return to base after stop | AM_WaveTwice (wave / idle / 1.5x wave, 3 sections): 5 positions <= 0.043 cm, 3 jumps exact, idle 0.03 cm after stop; no-Slot ABP -> 80 cm + hint |
| `pose_search_build` / `pose_search_query` | Pose Search (Motion Matching) via the optional sibling plugin BlueprintMCPPoseSearch (repo PoseSearchExt/ -> <Project>/Plugins/BlueprintMCPPoseSearch, PoseSearch on): schema (skeleton + default trajectory/foot channels) + database (clips, brute force) built, saved and indexed; offline nearest-pose query (self = cost 0; excludeSameAsset = what it would switch to) | PSD_Loco: 6 clips, 469 poses @30 Hz; 5 self-queries cost 0; walk fwd -> jog fwd, jog -> walk fwd |
| `pose_asset` | Pose Asset from a clip (one pose per key; rename) and a Pose Blender check: weights written as curves on a driver clip, ABP (SequencePlayer driver -> PoseBlender -> Output) run on a hidden mannequin, body compared with the source frame (weight 1) or the base (weight 0) | PA_Wave WaveHigh=1 -> wave @0.6 s 0.000 cm; 0 -> idle 0.01 cm |
| `seq_master` / `seq_audio` | master sequence of shots (Cinematic Shots track; length, head-trim offset) with a cut check (viewport == the camera each shot's own cut selects at the mapped local frame) and scratch audio tracks sized to the sound | SEQ_Master: 3 shots / 136 frames, 5/5 frames 0.00 cm, trimmed shot verified by the walker's position; rendered 136/136 |
| `shot_camera_follow` | keyed tracking camera: 'pan' (fixed position, turns) or 'truck' (travels at bone + offset, height locked) aimed at a bone with a `screen` target (headroom / lead room), focus distance keyed (+ aperture); verified on in-between frames through the live camera | SEQ_Follow: pan + truck on a walker, bone within 0.05 of its screen target, focus within 0.8% |
| `seq_light` / `seq_property` | spawnable light + keyed property tracks on an actor or component (float / bool / colour / vector; auto, linear, constant), verified on the live object at keys and between keys (colours compared in 8-bit sRGB) | SEQ_Lights: light 300 -> 3000 and cool -> warm, f12 midpoints exact |
| `shot_camera exposure` | manual exposure (auto exposure off, EV bias) on a sequence camera, template + live | lab void: -2 EV, figure mean 127 -> 167 across the light-up, <= 2.9% clipped (auto exposure: 50-99% clipped) |
| `shot_rig` | rail dolly / crane: spawnable rig, camera attached to its mount component, position / pitch / yaw / arm keyed, `aim` keeps the camera on a subject's bone (mount-relative rotation keys); verified camera on mount, mount on spline, keys between keys, aim between keys | SEQ_Rail: 3 m dolly, camera on the spline 0 cm, Manny pinned at (0, -0.15); SEQ_Crane: pitch 0 -> 35, yaw -20 -> 20 with aim |
| `shot_render_passes` | MRQ with passes (lit / unlit / detail_lighting / lighting_only / reflections / path_tracer + depth / normal / motion post-process), png / exr / jpg, AA samples, WAV audio muxed into the MP4; checks frames per pass, pixel stats and difference from lit, saturated passes, EXR layers, where the audio has sound | SEQ_Lights passes (unlit 49 / normal 53 luma from lit, 8-bit depth flagged); EXR layers incl. PathTracer; master audio: music to 5.0 s, 1 kHz ping at 1.0 s |
| `shot_camera_shake` | handheld shake keyed into the camera transform on top of its existing motion (location cm / rotation deg / Hz / seed), verified base + noise | SEQ_Lights f24-47: 1.29 cm / 0.57 deg peak; consecutive render frames 0.8-5.3 luma apart vs 0.1 static |
| `add_anim_node` (any `AnimGraphNode_*` + `properties`) / `anim_node_set` | any AnimGraph node by class with property paths (UE text values, read back), exposed pins kept in sync; connect pose pins with `connect_pins` (space conversion is inserted automatically) | TwoBoneIK hand_r -> (-35,25,150) reached exactly; LayeredBoneBlend spine_01: legs = idle 0.008 cm, arms = wave 1.9 cm |
| `anim_clip_info` / `anim_clip_create` | read a clip (length, frames, fps, root travel + speed, curves, notifies, sync markers, sampled bones); author a NEW clip from bone rotation/location keys on the reference pose (eased), verified per key from the saved clip | MF_Unarmed_Walk_Fwd 300 cm/s root, 4 sync markers; A_LookAround neck +-25 / arm 70 deg keys 0.000 deg error |
| `seq_bind` / `seq_fbx` | possess level actors, rebind a binding to other actors (its tracks follow), list bindings; FBX export of bindings and import onto same-named bindings with a frame-by-frame compare | Box rebound A -> B (B on the keys, A restored); keyed pan + truck cameras round-tripped through FBX at 0.000 cm / 0.000 deg |
| `pose_trail` | motion trail of a bone: sampled world path, length, mean / peak speed, pops (step > 4x median); `draw` leaves tinted marker spheres (folder MCP_Trails) for captures, `clear` removes them | Walker head 304 cm/s (walk 300), hand_r 679 cm path with the wave, no pops |
| `anim_fbx` | skeletal animation FBX export / import onto a skeleton; with compareWith: bone-by-bone check + root motion / sync markers / notifies copied back | A_Wave_Baked round trip 0.0002 cm; Quinn-authored walk flagged (4.4 cm, retarget source) |
| `seq_curve` | key interpolation / tangent mode and pre/post infinity (cycle, cycle_with_offset, oscillate, linear) on transform or property channels; modes read back, `expect` checks live values past the keys | Fan 0 -> 90 deg over 24 f: cycle_with_offset 180 @48, 270 @72; oscillate 45 / 0 / 45 @36 / 48 / 60 |
| `anim_stitch` | root-motion clips back to back on one character: swap root bone = Actor, each section's start offsets carry the travel/turn so far (taken at the section's real end), optional cross-fade (overlapping sections, manual ease); every cut checked for pelvis pops against the speed before and after | walk, walk, jog, jog: cuts 14.5 / 25.4 / 28.1 cm vs 11-28 cm/frame speeds; rendered with a trucking camera |
| `aim_offset_check` (+ `create_blend_space dimensions:'aim2d'`) | Aim Offsets: create, set samples (made mesh-space rotation-offset additives, base = the (0,0) sample's frame 0), wire `add_anim_node AnimGraphNode_RotationOffsetBlendSpace` on a base pose, then this check drives the node's X/Y and measures head gaze per axis AND the body vs Alpha 0 | AO_Look: yaw -90/+90 -> head -30/+30 deg, pitch +-90 -> +-44 deg, drift < 6, pelvis/neck unchanged |
| `cr_build` | AUTHOR a Control Rig for any skeletal mesh: bones imported, a control per effector (Epic names hand_r_ik_ctrl / foot_l_ik_ctrl / head_ctrl / pelvis_ctrl), forward solve = pelvis follows its control + Full Body IK, backward solve = controls from bones (clips bake). Verified in a scratch sequence (rest pose, reach, optional clip bake) | Manny: rest 0 cm, hand reach miss 0.014 cm with others held 0.009 cm, walk frame baked: effectors 4.0 cm (same as Epic's rig), elbows 15 cm (no pole controls) |
| `cr_build_modular` | MODULAR Control Rig from Epic's Control Rig Modules (Root, Spine, Neck, shoulders, arms, legs; right side mirrored) for UE5-mannequin skeletons; controls Module/control, posed with pose_set_controls LOCAL values (channel path) | 56 controls, rest 0.14 cm, FK arm moved the hand 49 cm, other hand 0 |
| `seq_constrain` | ACTOR constraints keyed on/off: parent (pick up / carry / put down a prop on a bone), translation, look_at (camera or light locked on a moving bone). Sequencer adds compensation keys so grab and release don't pop; remove bakes first (default) | cup on hand_r 20-40: drift 0.000 cm, released cup stays put, no pops (a 40 cm snap is flagged); camera look_at head: 0.00 deg over 66 frames; bake+remove path change 0.002 cm |
| `take_record` | TAKE RECORDER: record live level actors for N seconds into a take sequence + AnimSequence (own settings: no countdown, lab folder; project settings untouched); optional subject mannequin looping a clip and a pose/rate check against a clip | walk take: 84 frames, worst pose 2.29 cm, rate 0.991 (vs jog: 21-45 cm, fails) |
| `rt_live` | RUNTIME RETARGETING: a target ABP (create_anim_blueprint on its skeleton + add_anim_node AnimGraphNode_RetargetPoseFromMesh {Node.IKRetargeterAsset, Node.bUseAttachedParent:true}) on a target attached to a source mannequin looping a clip; verified against the offline retarget of the clip on a second copy of the target, paused at the same times | Manny -> Fab girl: live == offline within 0.041 cm at 4 times, target moved 97 cm; no-retargeter control 53 cm / 0 motion -> fails |
| `shot_object_ids` | OBJECT ID / segmentation control pass: flat colour per listed binding (1 red, 2 green, 3 blue, ...) on black, rendered by MRQ beside the lit frames (custom-depth stencil on the spawnable templates + post-process material, r.CustomDepth=3 for the render only; no plugin) | SEQ_Constrain 40 frames: walker + cup in every frame, 0.00% off-palette; an invisible object is flagged |
| `shot_stills` | stills from EVERY camera in a sequence at chosen frames (MRQ render_all_cameras, one job per frame, warm-up + no motion blur); savePreset / preset = MRQ config preset assets | 3 cameras x 2 frames, cameras differ by 65 luma; preset reload rendered at the preset's 640x360 |
| `anim_edit` | edit a clip COPY: crop frames, named notifies / notify windows (PlayMontageNotify names), sync markers, float curves, rate scale; all read back, curves evaluated through the runtime pose path, crop vs the shifted source | walk crop 10-30: 0.0001 cm; curve 0.5 at 0.375 s both paths; notify past the end refused |
| `shot_render_graph` | MOVIE RENDER GRAPH asset with a beauty layer + a CLEAN-PLATE layer (everything the sequence spawns hidden: collection IsSpawnable minus `keep` bindings tagged MCPKeep + render-property modifier), rendered by MRQ; checks each sampled frame for removed pixels and background shift | SEQ_Constrain: 6-9% removed, background shift 0.3-0.4 luma with locked exposure; auto exposure flagged (3.6-4.4) |
| `anim_node_measure` | MEASURE any AnimGraph node: sweep its properties, run the ABP on a hidden mannequin, report bone moves/turns per step; `expect` ranges and `aim` (axis-to-target error) make it a check | ModifyBone roll 60 -> forearm 60.1 deg (alpha .5 -> 30.0); LookAt aim error 0.0 deg (axis +Y, world target); TwoWayBlend .5 -> exactly half the local change |
| `viewport_pilot` | PILOT a sequence camera or level camera in the viewport (look through it), `moveTo` keys a sequence camera / moves a level camera, `eject`; verifies the viewport equals the camera | 0.00 cm / 0.00 deg after pilot, keyed move and level move; eject frees the view |
| `skel_fbx` | SKELETAL MESH FBX: export a mesh, import a character .fbx onto an existing skeleton (its clips play directly) or a new one; checks vertices / bounds / bones and, with `clip`, poses both meshes at the same time | Manny/Quinn round trips: bounds 0.00, clip pose 0.000 cm; Quinn +1 vertex (seam split, tolerated); vs another mesh fails |
| `pose_statue` | freeze a character's current pose (level actor or binding at a frame) into a PoseableMesh 'statue' at a location, with additive bone edits; no rig or animation needed | copy 0 cm root-relative, frozen when the source moves; edits 40.0 / 70.0 deg for 40 / 70 |
| `seq_tracks` | FADE track keys (renderCheck renders the cut and checks brightness), MARKED FRAMES, and per-binding track mute (section inactive) / lock / rename / colour | fade 0->1: luma 148 -> 22 -> black; marks read back; muted cup transform: 262 cm -> 0 movement |
| `pose_set_interpolation` | smooth / linear / constant on a character's CR keys (clip bakes are constant -> later keys snap) | constant -> pops at f14, f20; smooth -> none |
| `pose_motion_report` | scrub frame by frame, per-bone path, max step, POPS = spikes vs neighbouring steps | elbow flip 13.8 cm caught; fixed with a keyed pole vector |
| `shot_render` | Movie Render Queue (PIE) PNG sequence -> MP4 via ffmpeg, poster inline; warns editor-hidden actors render | 60 frames 960x540 |
| `anim_preview` | one moment of a clip on a level SkeletalMeshActor, bones read back | skeleton mismatch rejected |
| `ikrig_create` | IK Rig: auto for Epic skeletons, bone-stem name map vs a template rig for custom ones | Manny 28 chains; Fab girl02_* 20 |
| `retarget_setup` | IK Retargeter, chains auto-mapped, scaled-root (glTF) Pelvis Motion compensation | root 0.0093 -> pelvis scale 107 |
| `retarget_animations` | batch retarget into a folder + per-clip verification (limb motion, rendered pelvis height) | walk 1.64 deg, jump 3.39 deg; broken case caught |
| `pose_asset_create` | Pose Asset from a clip, poses renamed in order | 27 poses |
| `shot_camera` | spawnable CineCamera + lens + cut (kept on update) + aim at a measured bone around the subject's facing + framing | aimed bone at u,v 0,0 |
| `shot_frame_check` | project bones through the LIVE lens: u,v in frame, subject turn vs camera, OCCLUSION (visibility trace) | feet out of frame caught; head behind Manny caught |
| `shot_capture` | lock to cut, clear selection, game view, settle, verify viewport == cut camera, image | offset 0.0 cm |

Worked builds (tool calls only, with readbacks and frames): `references/builds.md`.

Lib: `Tools/python/ue_posing.py`; live check: `node Tools/test/manual/posing-e2e.mjs`. Cameras, shots, audio,
bake/retarget below still go through `run_python` + the helper library:

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
| 13 | **A character spawned at yaw 180 renders in profile, not back-to-camera** | The UE5 mannequin *mesh* faces **+Y at actor yaw 0** (toes foot→ball point +Y, `upperarm_l` on +X) — a +90° offset a Character BP cancels with its mesh component's −90° yaw but a bare `SkeletalMeshActor` does not. (Before 2026-10-21 the lib had this as −90° *and* a 180°-wrong `facing_yaw`; the two errors cancelled in the round-trip and shots came out back-to-camera.) Aim with `set_facing(seq, name, visual_yaw)` (applies `MESH_YAW_OFFSET`), never the raw spawn yaw. |
| 14 | Two different "measurements" both confirm a facing that is visibly wrong | Actor yaw describes the actor, not the mesh inside it; **bone/socket rotation is not facing** (the head socket read −180 while the character faced +Y). Only shoulder geometry is convention-free — `facing_yaw()`. Always round-trip: set, then re-measure. |
| 15 | Every captured frame is covered in coloured rig circles | Control Rig gizmos draw in the editor viewport. `presentation_mode(seq)` clears the selection and enables game view — **never** `hide_all_controls` (gotcha 19). |
| 16 | The captured frame shows the *previous* shot's pose or placement | A spawnable's transform track applies on the NEXT evaluation, so one `set_current_time` is not enough. `show_frame(seq, f)` scrubs twice and invalidates the viewport. |
| 17 | In a two-character shot, posing the second character moves the first | `get_rig(seq)` / `cr_section(seq)` are index 0 — the *other* character's rig. Resolve per track with `rig_for(seq, track)`. |
| 18 | `capture_view` returns a frame from the wrong camera | **Plugin bug on UE 5.8.3:** it ignores `location`/`lookAt` and returns the current viewport. See `docs/KNOWN-ISSUE-capture-view-ignores-camera.md`. Use `show_frame()` + the locked viewport instead. |
| 19 | **Held poses snap back to the reference pose after a capture; later bakes write 0 keys but return True** | `ControlRigSequencerLibrary.hide_all_controls` sets the section's controls *mask*, which is saved, stops those controls evaluating, and hides their channels from `get_all_channels()`. The old `presentation_mode` did this — it silently flattened every posed shot it framed. Fixed: the lib now calls `show_all_controls`; to repair an old sequence, `show_all_controls(section)` + save. |
| 20 | A bone/socket read (or the rig hierarchy) says the character is in reference pose while the viewport shows the pose | Sequencer applies the Control Rig pose on the **editor tick**, and none runs inside one `run_python` call. Open + scrub in one call, read in the **next**. Vision-mode frames lag the same way — capture with `viewport_capture` on a later call before judging. |
| 21 | `SequencerTools.export_anim_sequence` returns False for a spawnable | 5.8.3 logs `No skel mesh found in Sequencer`, open or closed. Use `bake_displayed_pose()` (component bone read, on the following call). |
| 22 | Retargeted character sinks into the floor (pelvis ~1 cm) | Target skeleton has a SCALED root bone (Fab/glTF import, `_rootJoint` scale 0.0093) and Pelvis Motion ignores parent scale. `retarget_setup` sets the op's scale to 1/root scale. AnimPose WORLD space also omits that root scale - never judge heights from it raw. |
| 23 | Retargeted clips appear at `/Game/<name>` | `duplicate_and_retarget` ignores folders; `retarget_animations` moves them. |
| 24 | A level SkeletalMeshActor keeps showing the old clip | `override_animation_data` / `set_animation` don't re-evaluate in the editor; `anim_preview` uses `set_update_animation_in_editor(True)` + `play_animation`, applied on the next tick. |
| 25 | Camera lens edit "applied" but the frame is blurred / wrong focal length | Editing a spawnable camera's template doesn't touch the instance already spawned. `shot_camera` edits both and reads the live lens. |
| 26 | Re-aimed camera now covers the next shot | Old behaviour re-ranged the cut to the whole sequence; updates now keep the existing range unless `cut` is passed. |
| 27 | A transform gizmo in a "clean" frame | A selected actor (Sequencer selects a spawned camera) draws its gizmo even in game view; `shot_capture` clears selection. |
| 28 | A typo'd control name "worked" | On 5.6 `find_control()` returns a default EulerTransform element for a missing name; the tools check `get_index() >= 0`. |
| 29 | run_python says `Could not load Python file '.../<your code>'` | ExecuteFile mode treats any `.py` + whitespace in the command as a file path. Avoid it in code/comments (the tools send their libs base64). |
| 30 | A kneel "looks fine" in numbers but the knee is buried | Bone centres are not skin: judge contact with `pose_ground_check` (posed mesh) and fix with `pose_ground_fix`. Mannequin feet rest ~1 cm into the floor by default (sole below ball bone). |
| 31 | Close-up aimed dead centre shows another character's back | Projection cannot see occlusion; `shot_frame_check`/`shot_camera` trace camera->bone and fail when the aimed bone is hidden. |
| 32 | Pose-to-pose keys snap instead of moving | Clip bakes write CONSTANT keys; run `pose_set_interpolation` smooth on the controls you animate. |
| 33 | Elbow/knee flips mid-move | IK plane flips when the effector passes the limb root; key the pole vector (`arm_r_pv_ik_ctrl` world) at the same frames, then `pose_motion_report`. |
| 34 | Actors you hid in the editor show up in the render | "Temporarily hidden in editor" is editor-only; MRQ (PIE) renders them. Delete or really hide them; `shot_render` lists them. |
| 35 | IK switched on at a later frame pops the arm | Key the IK control at frame 0 at the limb's rest position first (read it with pose_read), then the move. |
| 36 | Palm faces the camera but the fingers point down | A shortest-arc rotation ignores twist; `pose_palm` solves palm AND finger direction. |
| 37 | A tool reports "already done" at a frame it never looked at | Readbacks measure the CURRENT frame; scrub to the frame and read on the next tick (pose_palm/pose_look_at do). Single reads after a scrub can still be a tick early - `pose_motion_report` re-reads until stable. |
| 38 | A prop placed from bones sits inside the fingers | Hand skin is 2-3 cm off the bone lines. `prop_attach grip` measures the palm + finger skin (open hand) and curls fingers onto the prop by contact readback. |
| 39 | Uniform finger curls drive the middle phalanx through the prop | Wrapping bends joints about equally (`WRAP` 1/1/0.8); the 'fist' profile (75/95/60) and per-joint sequential solves both penetrated. |
| 40 | Cup reaches the mouth "fine" but goes through the face | Read the body skin vs the prop (`prop_check side`), not just distance to a mouth point; a head look-at changes it again - re-check after head keys. |
| 41 | `get_component_by_class` is None on a spawnable template | Template components are not registered; use `StaticMeshActor.static_mesh_component`, and edit template AND live instance. |
| 42 | Walker slides along in reference pose; the anim section "looks right" | `add_spawnable_from_instance` auto-adds the mesh's default rig (CR_Mannequin_Body) whose track overrides clips. Strip it for clip-driven characters (`anim_walk` does); read FEET per frame, not section properties. |
| 43 | Root-motion clip snaps back every loop | Sequencer does not move the actor by root motion here; play a root-locked copy and key the travel at the clip's root speed (`anim_walk`). |
| 44 | Feet skate at corners | The actor turns about its origin while a foot is planted; `anim_walk` foot-locks (shifts the path by the measured planted slide) and reports the end shift. |
| 45 | A per-frame check measured the same frame every time | Unknown args are silently stripped by the schema (`frame` on a tool without it). Check the tool has the parameter; `shot_frame_check` now takes `frame`. |
| 46 | Blend space written from Python plays the reference pose | `ResampleData()` only runs in the Blend Space editor; `set_blend_space_samples` opens/closes it to rebuild, then evaluates every sample. |
| 47 | ABP "compiles" but the character stands in the reference pose | "visible but ignored" / "not connected to state" are only warnings. The ABP tools now wire Output Pose, Entry and state players and treat those warnings as errors; prove it with `anim_bp_check`. |
| 48 | `add_state_machine` name ignored | The plugin always names it "New State Machine"; the tool says so - use the returned name. |
| 49 | Deleted asset "already exists" on re-create | The editor keeps the deleted object in memory; use a new name (or restart). |
| 50 | `ControlRigPoseAsset.paste_pose(do_key=True)` keys nothing | Outside the Control Rig edit mode it only touches selected controls on the rig instance, which Sequencer re-evaluates. `pose_library_apply` keys the stored values itself. |
| 51 | Pose tools take rotation as [pitch, yaw, roll] | `unreal.Rotator` positional order is (roll, pitch, yaw); a swapped triple silently twists every FK control. |
| 52 | Control Rig reads on a sequence that is not open return defaults | Opening a second sequence closes the first; read the source BEFORE opening the target (the pose tools settle the frame first). |
| 53 | Mirrored pose: arms 12-75 cm off, or a shoulder on the wrong side | FK controls of an IK-mode limb are stale; IK limbs mis-solve with mirrored IK controls on target. `pose_mirror` derives FK targets from the rendered bones and keys limbs in FK. |
| 54 | Mirror "verified" to 0.04 cm but the shoes render dark and speckled, feet sunk 2.8 cm | Right-side controls on CR_Mannequin_Body have a NEGATIVE initial scale; copying it across reflects the bones (inside-out skin). Positions cannot see it - check scale determinants (`pose_mirror` does) and look at a close-up. |
| 55 | Rig hierarchy bone != what renders (ball_l 5 cm off in a kneel, helper bones stale) | Read bones from the skeletal mesh (`get_socket_transform` component space), not `hierarchy.get_global_transform`. |
| 56 | add_node / connect_pins into a transition rule edit the WRONG transition | Every rule graph was named "Transition" and the C++ takes the first name match. `anim_transition_rule` renames them "<From> to <To>" first (Python `BlueprintEditorLibrary.rename_graph`). |
| 57 | ABP variable can't be set from Python / a test ("cannot be edited on instances") | Default BP variables are not Instance Editable and Python has no other setter. `anim_transition_rule` ticks Instance Editable on its variable; Python cannot read the active state either - `anim_bp_drive` reads the rendered pose. |
| 58 | Transition compiles but never fires | "will never be taken" is only a warning; the guards now count it as unwired, and `anim_bp_drive` with `expect` shows the stuck state. `add_state_machine` names are now applied (the C++ ignored them). |
| 59 | Bake / new AnimSequence refuses 24 fps ("not a multiple or factor of 30 fps") | The project enforces clip rates compatible with its animation default (30). `anim_bake` records at 30 when 24 is refused; timing is kept in seconds. Don't change the project setting. |
| 60 | anim_bp_drive says AMBIGUOUS | Two states' clips are within 2 cm (a baked wave's rest frame was 4 cm from idle). Read again at another moment (`wait`) or make the clips more distinct; it refuses to guess. |
| 61 | Space switch to 'world' keys nothing | CR_Mannequin_Body's hand/foot IK controls already hold still in the world when body_ctrl moves; Unreal skips a same-space key (`pose_space_switch` says so). Switch to body_ctrl / chest_space to make a hand ride the body. |
| 62 | Reach / palm on a constrained control misses (palm 35 deg off) | The constraint overrides later edits. Pose first, then `pose_constrain`; to re-pose: `remove`, edit, constrain again. |
| 63 | Constraint added twice / 'remove' removed nothing | `get_constraints_for_handle` with a new handle returns [] (identity compare). `pose_constrain` matches the constraints' child handles by rig + control name instead. |
| 64 | Constrained control follows but the hand bone doesn't | Out of reach (arm at full stretch: bone 3-4 cm short) or limb in FK. The tools report the bone gap separately - move the parent's path closer or crouch the body. |
| 65 | In-between frames hold the previous pose | Clip-held poses (`pose_setup_character clip`) and pose keys step (constant). That is blocking: add breakdowns with `pose_tween`, or `pose_set_interpolation smooth` for a spline. |
| 66 | Tween of a big wrist turn flings the wrist mid-way | The Tween tool blends each Euler channel; a ~100 deg palm turn passes odd orientations. Key the palm at the breakdown too (`pose_palm` at that frame) or turn the wrist less. |
| 67 | Camera from +Y at the origin shows the Loco_* row of build 7/8 | Those actors stand at x 0, y -160..-820. Aim from -Y/front (azimuth 0..30) or check every capture by eye; nothing in the numbers flags a stranger in frame. |
| 68 | Retargeted custom-skeleton character's feet don't match the source | Name-mapped IK Rigs (Fab/custom skeletons) get chains but no goals or solver, so the IK ops do nothing: legs are FK only. `retarget_animations` now prints 'Leg IK OFF' and the feet error (Manny -> Fab girl: 3.6 cm). Copying Manny's goals + FBIK onto the girl made it worse (spine 18-26 deg, legs 11-27 deg) - don't. Epic skeletons (Manny -> Quinn) get IK: feet 1.55 -> 1.01 cm. |
| 69 | Viewport capture shows only sky after a Sequencer build | The viewport is still locked to the sequence's camera cut. Close the sequence (`LevelSequenceEditorBlueprintLibrary.close_level_sequence()`) before `set_viewport_camera`. |
| 70 | Retargeted arms held ~14 deg off the source all clip long | Different rest poses (A vs T). Run `retarget_align_pose` (chain_to_chain); mesh_to_mesh was far worse here. After aligning, judge by ABSOLUTE limb angle - 'motion error' is measured from each skeleton's own rest pose and rises (the verdict takes the better of the two). |
| 71 | Snapped hand jumps 30-42 cm at the start frame | The Snapper's keep_offset took the child from LATER keys in the range (old frame-48 keys) against the parent at start. `pose_snap` clears the controls' keys in (start, end] first and reports the jump. |
| 72 | Snapped control drifts between the parent's keys | The Snapper default keys only the parent's key frames (KEYS_ONLY); `pose_snap` keys every frame by default. |
| 73 | Viewport shows no camera / the wrong camera after removing or adding one | Camera cut sections of removed cameras kept their range, and overlapping cuts let the later one win. `shot_camera` now drops orphan cuts and warns about overlaps. `shot_camera aim` reads the bone at `aim.frame` (default the cut's first frame) - it used to read frame 0 whatever you were working on. |
| 74 | Palm-up hand looks right from the front but the fingers poke through the tray | Front views hide depth: add a side check camera (`shot_camera` with `aim.frame`, a one-frame cut, then remove it). Manny's palm slopes ~29 deg up to the knuckles when its normal points straight up; tilt the palm target ~15 deg forward (`pose_palm` target ahead of the hand) to lay the fingers flat. |
| 75 | A prop moved onto a socket "did not move" but is rotated | The prop sits ON the socket after the switch, so prop-vs-socket is 0 by construction and the position barely changes when only the socket ROTATION is wrong (yaw +30: moved 0.001 cm). `prop_socket` compares the prop's world rotation before/after (turned 30.00 deg in the calibration). |
| 76 | Python cannot add a socket | `SkeletalMeshSocket.socket_name` is read-only and `Skeleton.sockets` is protected in 5.6 Python. Use `add_skeleton_socket` / `prop_socket` (C++ endpoint). Skeleton socket edits are seen by already-spawned characters at once (no respawn). |
| 77 | Gripped cups lie on their side | The grip lays the cup's axis along the knuckle line, so a palm-down hand holds it horizontally. For an upright cup (toast, drink) turn the palm toward the midline with fingers forward first (`pose_palm` target beside the hand, `fingers` = facing). Cups on the palm side then sit toward the other person - space the hands so the cups meet, not cross (measure with `prop_check near`). |
| 78 | Layered Control Rig changes the knees though nothing is keyed | The layer starts with the legs in IK; the re-solve swung the knees 0.8-1.4 cm off the clip (feet exact). `pose_layer add` keys leg_*_fk_ik_switch False - then every bone position matches (spine_01 still twists 0.2-4.3 deg about its own axis, children exact). |
| 79 | Keys set right after creating a layered rig track vanish | Keys written in the same Python call that created the track were dropped (switch still True, no key). Key in a later call; `pose_layer` reads the keys back. |
| 80 | A layered offset (wave, head turn) shows on every frame | One key holds its offset across the whole clip (zero = the clip). Bound it with `pose_layer zero` before and after. The IK arm at zero offset sits up to 0.4 cm off the clip (elbow re-solve). |
| 81 | FK rotation offsets twist the limb instead of raising it | Each bone has its own axes (girl upperarm roll = twist). Use `pose_fk aim` (point the bone's child at a world point) for limbs; raw `rotations` for face/jaw. Girl jaw: roll + opens the mouth, yaw slides it, pitch twists it. |
| 82 | Face bone moves 100x too far / not at all | Custom skeletons can carry a root scale (Fab girl 0.0093: 1 cm ~ 107 bone units). `pose_fk locations` takes world cm and converts per bone; the readback reports the cm moved. Girl lip corners: +Y = up (smile), +X = world +x for both sides (mirror by hand), +Z = back. |
| 83 | `add_anim_node` Slot/PoseBlender reports the graph "incomplete" | Expected: the new node's Source input is wired by the next step (a state machine or pose into it). Missing / wrong-skeleton / ambiguous assets now fail in the plugin itself with nothing changed. Slot names cannot be removed from Python - test with a scratch skeleton or accept the name. |
| 84 | Montage "plays" (active, position advancing) but the character does not move | The ABP has no Slot node for the montage's slot feeding its output: slot weight stays 0. `anim_montage_play` reports it; add one with `add_anim_node nodeType 'Slot'` and wire the base pose into its Source. |
| 85 | Montage pose is half-way between the base and the clip right after playing | Blend-in (default 0.25 s) - measure after the slot weight reaches 1 (the tool waits). A paused montage still finishes its blend. |
| 86 | Pose Search assets cannot be made from Python | Both factories return None (modal picker), the schema skeleton struct and the database clip list are invisible to Python, the index builds in C++. Use `pose_search_build` (sibling plugin). Calling the index before it is built crashes the editor (check in GetSearchIndex) - the plugin waits for Success first. |
| 87 | Pose Search costs are in the hundreds of thousands | The default schema has no normalisation set, so trajectory velocities (cm/s) dominate. Compare costs within one database only. Looping clips are indexed to their end; non-looping ones lose the last 0.3 s. |
| 88 | Pose Blender at weight 0.5 is not half-way | A NON-additive pose asset fills partial weights from another buffer (hand 36 cm from the pose, 63 cm from the source idle). For partial blends convert the asset to additive (editor button; ConvertSpace in C++) - only weight 0 and 1 are exact. The Pose Blender's input pin is `SourcePose` (Slot: `Source`). |
| 89 | Characters from another scene show up in a shot's background | Level actors (placed previews, montage checks) render in EVERY sequence of the level. `seq_master check` passes on cameras only - look at the renders, and delete placed check actors once captured. |
| 90 | A camera "aimed at the subject" cuts its head off | Centring the chest (spine_03) at 50 mm and 4 m crops head and feet. Use a wider lens and `screen` [u, v] (e.g. [-0.2, -0.15]: room ahead, headroom). A truck camera that follows the bone's height copies the walk's bob - the tool locks the height. |
| 91 | `camera_pose` / framing numbers do not match an animated camera | They read the camera's first key / default. Follow checks read the LIVE spawned camera at the current frame. The camera's own look-at tracking cannot target a spawnable - key the aim instead. |
| 92 | Light keys "do nothing" or the character is pure white | Auto exposure meters the lab's black void and blows out a lit figure at any intensity. Set `shot_camera exposure` (manual EV; here -2) and keep a point light a few metres away. Light colour is an 8-bit sRGB FColor on the component: linear 0.4 reads back as 170. |
| 93 | `add_possessable` on a spawned actor's component makes a duplicate binding | Sequencer already created a child binding for it (LightComponent0). `seq_property` reuses the existing child and removes duplicates. |
| 94 | Dolly shot loses the subject at both ends | A camera locked to the rail's heading lets the subject cross out of frame. Use `shot_rig aim` (keys the camera's rotation RELATIVE to the mount). Once attached, a camera's transform channels are relative to the mount - world-space aim values are wrong there. |
| 95 | Depth pass is two flat colours | World depth saturates an 8-bit PNG. Render data passes (depth, normal, motion) as EXR - MRQ writes ONE multilayer EXR per frame (all passes as layers; `{render_pass}` in the name is empty). |
| 96 | Rendered movie has no sound | The image render writes picture only. `shot_render_passes audio` adds MoviePipelineWaveOutput (`<seq>.Audio.wav`) and muxes it into the MP4; the WAV is measured for where sound is. |
| 97 | Sequencer camera-shake track does nothing | A CameraShakeBase Blueprint with a Perlin root pattern on a MovieSceneCameraShakeTrack read back fine but changed neither GetCameraView nor the MRQ render (0.1 luma, same as no shake) - cause not found. Use `shot_camera_shake` (keyed noise), which exports with the shot. |
| 98 | IK / node property set but the node ignores it | If the property is also an exposed PIN (EffectorLocation, Alpha...), the compiler uses the pin default: TwoBoneIK reached for (0,0,0) while the property said (40,30,140). `add_anim_node properties` / `anim_node_set` now mirror the value onto the pin. |
| 99 | `replace_binding_with_actors` TypeError | In 5.6 it takes (actors, binding) and acts on the sequence OPEN in Sequencer - open it first (`seq_bind` does). FBX import matches bindings by NAME: create a same-named camera/actor binding before importing. |
| 100 | Re-imported FBX walk is 2-4 cm off and no longer drives sync groups | FBX drops root-motion flags and sync markers (`anim_fbx` restores them from the source). Clips authored on ANOTHER mesh (retarget source, e.g. the Mannequin walks on SKM_Quinn) come back with raw proportions: 4.4 cm on Manny; copying the retarget source doubled it (5.3) - unresolved. Clips authored on the target skeleton round-trip exactly. |
| 101 | Stitched clips pop back to the start / play in place | Mannequin locomotion clips have force_root_lock: a plain anim section plays them in place. swap_root_bone = Actor moves the actor, but each section restarts at its own origin (438 cm pop) - set start offsets to the accumulated travel at the SECTION end (a 42.48-frame jog in a 42-frame section left a 13 cm gap). A hard walk -> jog cut snaps the pose: overlap and ease (`anim_stitch blend`). `params.play_rate` is a time-warp struct in 5.6 (float rejected). |
| 102 | Aim offset turns the head but the body is huge / stretched | Compressed additive data can be stale (AO_Look evaluated COMPRESSED as the full pose: root scale 2, Manny 4x tall) - a gaze-only check still passes. Re-run `set_blend_space_samples` (it re-writes the additive settings via set_editor_property, which rebuilds them) and use `aim_offset_check`, which compares pelvis height and pelvis->head length with Alpha 0. Author AO poses only against a verified additive; earlier 'roll became pitch' axis findings were an artifact of the broken data. |
| 103 | `pose_setup_character {rig}` gave Epic's rig anyway | A new SKM_Manny_Simple spawnable arrives with the mesh's default animating rig (CR_Mannequin_Body) and find_or_create_control_rig_track returns it whatever class you ask for. Fixed: a new binding gets it swapped for the requested rig; a reused binding with a different rig is an error. Always check the 'with <Rig>_C (N controls)' line. |
| 104 | Authored FBIK rig drifts off a baked clip | PBIK with 20 iterations left the feet 9 cm off a baked walk frame; 200 iterations matches Epic's rig at the effectors. A rig with no root control carries root motion in the pelvis (same world pose). Elbows/shoulders follow the solver (no pole controls). |
| 105 | Look-at camera keeps its old misaim / removed constraint throws the prop to the origin | The look-at constraint stores `axis` = the child's CURRENT local direction to the target: set +X for a real aim (seq_constrain does when maintainOffset is false, the look_at default). While a parent constraint is active Sequencer keys the child in the PARENT's space - remove with bake (default) or those frames jump to near world 0. Find a child's constraints by the transform section that owns them, not get_constraints_for_handle. |
| 106 | Recorded take shows nothing / lands in /Game/Game | Takes start at the recording TIMECODE (e.g. frame 1117149), not 0: scrub from the range take_record reports. RootTakeSaveDir is relative to /Game. TakeRecorderSubsystem is an ENGINE subsystem. |
| 107 | Copy/retarget-from-mesh ABP: 'unwired graph' or 'plays the reference pose' | RetargetPoseFromMesh's mesh-component Source pin warns 'visible but ignored' when bUseAttachedParent is on - not an unwired pose (now ignored by the guard). anim_bp_check's preview actor has no attach parent, so it correctly shows the reference pose: verify these ABPs with rt_live. AnimPose evaluation of clips on a root-scaled mesh (Fab girl, 0.0093) is ~100x off - compare on real meshes. |
| 108 | Object ID / stencil pass renders all black | MRQ renders in PIE, where spawnables are rebuilt from their TEMPLATE: set render_custom_depth / stencil on the template's mesh component (get_components_by_class returns nothing on a template - use skeletal_mesh_component / static_mesh_component). Stencil needs r.CustomDepth=3: put it in the job's console-variable setting. Cryptomatte needs the MRQ mask-pass plugin (not enabled here). |
| 109 | Single-frame MRQ still is smeared / files named CineCameraActor_20 | A one-frame job has no motion history: add warm-up frames and r.MotionBlurQuality 0 (shot_stills does). {camera_name} is the PIE camera actor's NAME (template _0 -> _20...), not the binding; labels on templates do not stick - shot_stills maps by spawn order. |
| 110 | Clip rebuilt from AnimPose samples is a few cm off | AnimPoseEvaluationOptions.should_retarget defaults ON: local translations come back retargeted, and written as raw keys the retarget applies twice (crop 2.5 cm off). Sample RAW with should_retarget False. Resize the clip BEFORE writing keys. An AnimPose at exactly the clip end wraps (curve read 0). |
| 111 | Modular rig: connectors refuse every target / controls don't move | Sockets and controls exist only in a CONSTRUCTED instance: connect with validation off and check a constructed instance. get_connectors_for_module strips spaces ('Spine/SpinePrimary' vs real 'Spine/Spine Primary'). Import bones with import_preview_skeletal_mesh (import_bones_from_skeletal_mesh left 62/89). ControlRigSequencerLibrary get/set no-op on 'Module/control' names - pose_set_controls keys the channels instead (local only). Modules start in FK. Axes per control: Leg thigh_fk yaw lifts the leg forward, pitch swings it sideways, roll twists; Neck head_ctrl yaw turns the head. Measure rotations by direction (gaze), not bone position. Module IK switching not mapped. |
| 112 | Render graph: edges refuse / 1080p output / clean plate brighter or darker | Unnamed pins are 'None' on some nodes and '' on others - try both. Output resolution needs ProfileName="Custom" or the 1080p profile wins. A new modifier node already holds a RenderPropertyModifier (add_modifier returns None). Clean plates need LOCKED exposure (shot_camera exposure) - auto exposure re-adapts once the subject is gone; a very high EV makes the subject's bloom leak into the plate. Sequence-owned set dressing (a table prop) is 'spawned' too - pass it in `keep`. Query fields hidden from dir() still work: ActorTagName.tags_to_match, ActorName.wildcard_search. |
| 113 | AnimGraph node 'does nothing' or twists the head | ModifyBone/LookAt are COMPONENT-space: wrap them in LocalToComponentSpace / ComponentToLocalSpace and wire with connect_pins. LookAt aims the bone's X by default - set Node.LookAt_Axis (Axis=(X=0,Y=1,Z=0)) for the mannequin head - and LookAtLocation without a target bone is WORLD space (a hidden preview mannequin at z=-5000 looked straight up). TwoWayBlend's struct is BlendNode (BlendNode.Alpha), not Node. A ModifyBone roll is the twist along the bone. |
| 114 | Moving the view while piloting does nothing | Piloting syncs camera -> viewport only; set_level_viewport_camera_info snaps back next tick, and a sequence camera is re-posed from its keys every tick. Move the camera (key it) and let the view follow - viewport_pilot moveTo. |
| 115 | Imported character has extra/missing bones or plays wrong | Import ONTO the existing Skeleton to share its clips (the mannequin skeleton has 161 bones; a new skeleton from SKM_Manny_Simple gets only its 89). Materials are off by default (grey mesh) - pass materials:true. Vertex counts can differ by a seam split. |
| 116 | Statue stands metres away / bone edit flips the bone | A copied locomotion pose keeps root motion in the root bone - zero the root translation (pose_statue does). set_bone_rotation_by_name REPLACES the component rotation - compose the delta onto the current one. Poseable poses are runtime state, not saved with the level. |
| 117 | Fade doesn't show in stills / can't mute a track | Fades apply through the player camera: the camera-cut render shows them, multi-camera stills (render_all_cameras) do not. Tracks have no scriptable mute - set their sections inactive (seq_tracks mute); a muted transform also drops the actor's default location (it sits at the origin). |

## MetaHuman-skeleton dummies (decided 2026-09-23)

Previz characters are `/MetaHumanBodyTracker/SKM_Body` + `MetaHuman_ControlRig_Simple` (`MH_BODY_MESH` /
`MH_BODY_RIG`), so markerless-mocap solves (which land on `metahuman_base_skel`) drop straight in with
`pose_from_clip` — no retarget per solve. Facing offset is the same +90° as the mannequin; `set_facing` works (re-verify on the MH body after the 2026-10-21 sign fix).
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

- `references/builds.md` — scene builds done with the MCP tools only (calls, readbacks, what the eyes caught).
- `references/api-recipes.md` — the raw verified snippets behind each helper, with readbacks.
- `references/pose-from-video-ue58.md` — image → video → MetaHuman Animator markerless solve → held pose.
- Epic: *Python Scripting for Animating with Control Rig* (5.8 docs) — the canonical snippet set.
