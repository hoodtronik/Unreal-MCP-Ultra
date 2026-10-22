# Scene builds (MCP tools only)

Each build uses only the dedicated tools (no run_python), reads every result back, and is judged from captured
frames. Run the same calls through `node Tools/test/manual/mcp-call.mjs <tool> '<json>' [out.png]` when the
agent's own MCP connection predates the tools.

## 1. Handoff two-shot (2026-10-21, UE 5.6.1, MyLab_5_6 `/Game/_MCPLab/Scenes/SEQ_Handoff`)

Two mannequins shake hands; side two-shot (0-36) then an over-the-shoulder close-up on Quinn (36-72).

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny, location [0,-42,0], facing 90, clip MM_Idle f10, end 72 | facing 90.0 measured after -22 deg clip-twist correction |
| 2 | `pose_setup_character` Quinn, SKM_Quinn_Simple, [0,42,0], facing -90, MM_Idle f60 | facing -90.0 |
| 3 | `pose_reach` Manny hand_r -> [-14,-2,112] | miss 0.000 cm, budget 48.8 of 55.0 cm |
| 4 | `pose_reach` Quinn hand_l -> [-14,6,112] | miss 0.000 cm, budget 45.9 cm |
| 5 | `pose_look_at` each at the other's head (+5 cm) | 22.9 -> 0.027 deg; 0.037 deg |
| 6 | `shot_camera` TwoShot 30 mm, [-440,0,100], [-2,0,0], cut 0-36 | both bodies in frame (feet v -0.73..-0.83) |
| 7 | `shot_camera` CU_Quinn 85 mm, aim Quinn head, distance 260, azimuth -25, rise 4, cut 36-72 | head at u,v 0,0; turned 23.9 deg |
| 8 | `shot_capture` frame 10 and frame 50 | viewport == cut camera, offset 0.0 cm |

What the eyes caught that the numbers did not, each now fixed in the tools:
- a 35 mm first TwoShot cut both characters' feet off (found by `shot_frame_check` before capturing: v -1.2..-1.4);
- gaze drifting off into space in the close-up -> `pose_look_at` added;
- a transform gizmo in the clean plate (selected spawned camera) -> `shot_capture` clears selection;
- re-aiming TwoShot silently extended its cut over the close-up -> updates keep the cut range.

## 2. Kneel and offer (2026-10-21, `/Game/_MCPLab/Scenes/SEQ_Kneel`)

Quinn kneels on her right knee and offers her right hand up to Manny, who reaches down; they look at each other.
Wide side shot (0-16), high over-the-shoulder on Quinn (16-32), low reverse on Manny (32-48).

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Quinn [0,0,0] facing -90, MM_Idle f10 | facing -90.0 |
| 2 | `pose_set_controls` world: leg_l/r_fk_ik_switch true, body_ctrl [-1,8,54], foot_l_ik [-14,-34,8.5], leg_l_pv [-14,-90,50], foot_r_ik [13,46,11], leg_r_pv [13,-30,-20] | 7/7 verified; knee joint z -1.1 |
| 3 | `pose_ground_check` | knee_r skin -6.08 cm PENETRATING |
| 4 | `pose_ground_fix` region knee_r | -0.15 cm after one step (body +6.08) |
| 5 | `pose_set_controls` foot_r_ik z 9.2 | back toes -0.03 cm contact |
| 6 | `pose_setup_character` Manny [2,-78,0] facing 90 (moved in from -105: reach budget said 16.4 cm short) | facing 90.0 |
| 7 | `pose_reach` Quinn hand_r [14,-34,116], Manny hand_l [14,-38,119], Quinn hand_l on knee [-12,-30,63] | 0.000 / 0.000 / 0.274 cm |
| 8 | `pose_look_at` both heads | 47.0 -> 0.025 deg, 24.6 -> 0.035 deg |
| 9 | `shot_camera` Wide 28 mm [400,-38,95]; CU_Quinn 70 mm aim head d 220 az -40 rise 30; CU_Manny 50 mm aim head d 240 az 15 rise -45 | Manny head v 0.77 (was 0.99 at 32 mm); CU_Quinn head clear |

Eyes vs numbers: the first CU_Quinn (az -18) put her head at u,v 0,0 and rendered only Manny's back -> occlusion
trace added to the framing check; the knee "contact" from bone centres was 6 cm of buried skin -> skin contact tools.

## 3. Wave (2026-10-21, `/Game/_MCPLab/Scenes/SEQ_Wave`, first animation + MRQ render)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny facing -90, MM_Idle f10, end 60 | facing -90.0 |
| 2 | `pose_reach` hand_r at f0 = rest [25.8,-6.5,89.8] (IK on with no pop), f14 raised [32,-14,168], f20/32 out [43,-14,165], f26/38 in [26,-16,170], f52 rest | all 0.000 cm |
| 3 | `pose_set_interpolation` smooth on hand_r_ik_ctrl | 63 keys |
| 4 | `pose_motion_report` 0-56 | elbow (lowerarm_r) 10-14 cm/frame around f9-10, f43-45 (IK plane flip) |
| 5 | `pose_set_controls` arm_r_pv_ik_ctrl world [80,10,110] at f0/14/26/38/52 + smooth | no pops (spike rule; calibrated: constant keys -> pops at f14 78.8 cm, f20) |
| 6 | `shot_camera` Cam 30 mm aim pelvis d 440 az 12 rise 15; `pose_look_at` {binding:'Cam'} | head v 0.69, feet -0.86; gaze 0.039 deg into the lens |
| 7 | `shot_render` 960x540 | 60/60 frames + MP4 |

Eyes: the wave read, but as a fist with the palm inward -> `pose_hand` open + `pose_palm` to {binding:'Cam'} at
f14-38. First palm version faced the palm but pointed the fingers down (shortest arc) -> two-vector solve; it also
measured the wrong frame for f20-38 (no scrub) -> scrub first. Final: palm error <= 0.022 deg, fingers 7-8 deg from
up, no pops (motion report re-reads until stable after one stale read showed a false 10.8 cm pop).

## 4. Drink (2026-10-21, `/Game/_MCPLab/Scenes/SEQ_Prop`, first held prop)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny facing -90, MM_Idle f10 | facing -90.0 |
| 2 | `pose_reach` hand_r f0 [14,-34,112]; `pose_palm` target [-100,-34,112] fingers [0,-1,0] | 0.000 cm; palm 0.028 deg, fingers 0 deg |
| 3 | `prop_attach` Cup, Cylinder size [7,7,11], color, grip r, f0 | palm gap 0.6, fingers -0.09..-0.20 cm, thumb roll 20; curls 27/27/22 |
| 4 | `pose_reach`+`pose_palm` f18 mouth [6,-20,150]; f26/34 [6,-22,151] fingers [0,-0.82,0.57] (35 deg tilt); f46 = f0 | all 0.000 cm / <0.03 deg |
| 5 | `pose_look_at` f0/46 level, f18 slightly up, f26/34 [-1,-110,190] (sip, head back 16 deg) | <= 0.23 deg |
| 6 | `pose_set_interpolation` smooth; `pose_motion_report` | no pops |
| 7 | `prop_check` 9 frames side r near mouth | drift 0.000 cm; lips touch rim 0.33 cm at f26-34 |
| 8 | `shot_camera` 35 mm aim spine_05 d 190 az 40; `shot_render` | 48/48 + MP4 |

Eyes vs numbers: bone-only grip = fingers 3.5 cm in the cup; palm-only skin = straight fingers 2.6 cm in; cup centred on
the knuckle hinge = every curl went INTO it (moved one radius back over the palm); whole-finger and per-segment
sequential solves both failed -> even-arc wrap. The first tilt put the cup 2 cm into the face (prop_check BODY) -> hand
3 cm forward. The held cup also "occluded" its own hand in the framing check -> reported as held prop.

## 5. Walk (2026-10-21, `/Game/_MCPLab/Scenes/SEQ_Walk`, first locomotion)

| Step | Call | Readback |
|---|---|---|
| 1 | `anim_walk` Walker straight [-300,0,0]->[300,0,0] | MF_Unarmed_Walk_Fwd root 300 cm/s; planted slide mean 0.4 / max 1.16 cm/frame |
| 2 | calibration: same with speed 200 | SKATING 4.19 cm/frame (predicted 100/24 = 4.17) |
| 3 | `anim_walk` L path [-450,-150,0] -> [0,-150,0] -> [0,300,0] | corner f34 slide 9.25 -> foot lock pass 1 (6 frames, path end shifted 15 cm) -> max 0.67 |
| 4 | `shot_camera` 24 mm static [450,-500,160] rot [-5,140,0] cut 0-72; `shot_frame_check` f0/36/71 | head u 0.71 / 0.08 / -0.77, all in frame |
| 5 | `shot_render` 72 frames | MP4 |

Eyes vs numbers: the first walk slid in reference pose while every section property read back fine (auto-added rig
track); the first render had a scratch test mannequin standing in the shot (deleted); framing at three frames
measured one frame (frame arg silently dropped -> added).

## 6. Mirror pairs (2026-10-21, `/Game/_MCPLab/Scenes/SEQ_Mirror`, pose mirroring)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Src / Dst (Manny, CR_Mannequin_Body), side by side at y -70 / +70 | 148 controls each |
| 2 | `pose_library_apply` CRP_Wave/Handshake/KneelOffer/Sip on Src at f0/12/24/36 | 17 bones 0.0 cm (kneel: Quinn source, proportions) |
| 3 | same on Dst with `mirror: true` | 82 rendered bones <= 0.04 cm, 0 reflected |
| 4 | `pose_mirror` Dst f0 twice (back to the original, then mirrored again) | both verified |
| 5 | `shot_camera` 28 mm [430,0,100] rot [-3,180,0]; `shot_capture` f0/12/24/36 + a 35 mm foot close-up | grid + feet |

Eyes vs numbers: the first passing mirror (0.04 cm) had inside-out shoes and feet 2.8 cm in the floor - negative
initial scale copied from the right-side controls (gotcha 54); the kneel failed at ball_r 5 cm until bones were read
from the mesh instead of the rig hierarchy (gotcha 55).

## 7. Locomotion switch (2026-10-21, `/Game/_MCPLab/Anim/ABP_Locomotion`, first state-machine rules + PIE test)

| Step | Call | Readback |
|---|---|---|
| 1 | `create_anim_blueprint` ABP_Locomotion (SK_Mannequin); `add_state_machine` name Locomotion | machine named Locomotion (was "New State Machine"), wired to Output Pose |
| 2 | `add_anim_state` Idle/Walk/Jog (MM_Idle, MF_Unarmed_Walk_Fwd, MF_Unarmed_Jog_Fwd); `add_anim_transition` Idle<->Walk, Walk<->Jog; `add_variable` Speed (float), bRun (bool) | 3 states, 4 transitions |
| 3 | `anim_transition_rule` Idle->Walk Speed >= 60, Walk->Idle Speed < 50, Walk->Jog bRun true, Jog->Walk bRun false | Compile OK after the 4th (the first three report the rest as unwired) |
| 4 | `anim_bp_check` | animates, 30.9 cm from ref |
| 5 | `anim_bp_drive pie:true` bRun -> Speed 200 -> bRun off -> Speed 55 -> Speed 0 | Idle (no Idle->Jog), Jog (chained via Walk), Walk, Walk (hysteresis), Idle |
| 6 | `anim_bp_drive place` Loco_Idle/Walk/Jog at y -820/-600/-380 facing +X; viewport 60 deg from [900,-600,130]; `screenshot_graph` Locomotion + "Walk to Idle" | trio + graph images |

Eyes vs numbers: a drive on a half-wired probe ABP stayed in Walk at Speed 0 (Walk->Idle unwired; compile only warned) -
the test is what showed it. Clip matching first failed by 25-70 cm: the state player strips root motion, the raw clip
walks its root forward - compare root-relative. Placed characters drift forward through the cycle and snap back (root
motion not consumed by a SkeletalMeshActor); fine for stills, use anim_walk for travel.

## 8. Posed wave -> gameplay state (2026-10-21, `/Game/_MCPLab/Anim/A_Wave_Baked` in ABP_Locomotion)

| Step | Call | Readback |
|---|---|---|
| 1 | `anim_bake` SEQ_Wave / Manny -> A_Wave_Baked (Control Rig keyed wave from build 3) | 2.5 s, 75 frames @ 30 fps; 89 bones x 9 frames, worst 0.39 cm |
| 2 | `add_anim_state` Wave (A_Wave_Baked) in ABP_Locomotion; transitions Idle<->Wave; `add_variable` bWave; `anim_transition_rule` bWave true / false | Compile OK |
| 3 | `anim_bp_drive pie:true` bWave -> wait -> Speed 200 -> bWave off -> Speed 0 | Wave, Wave, Wave (no Wave->Walk), Walk (via Idle), Idle |
| 4 | `anim_bp_drive place` Loco_Wave at y -160; close SEQ_Wave; viewport 55 deg from [1000,-490,125], 5 captures | waver hand up, 4 states in one frame |

Eyes vs numbers: the first placement (y -1040) stood past the floor edge over the void and passed every check; the
open SEQ_Wave's own Manny stood in the shot until the sequence was closed. The baked wave's rest frame is 4 cm from
idle - the state check now reports AMBIGUOUS below a 2 cm margin.

## 9. Hand on a sliding tray, hand on hip (2026-10-21, `/Game/_MCPLab/Seq/SEQ_HandPlant`, space switch + constraint)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny facing 0, MM_Idle f10, end 48 | facing 0.0 |
| 2 | `prop_key` Counter [50,60,92] at [30,32,46]; Tray [24,24,3] keyed f0 [25,24,93.5] -> f48 [20,40,93.5] | 0 cm at every key |
| 3 | `pose_reach` hand_r [25,24,99]; `pose_palm` r down, fingers +X; hand_l [-3,-24,100], palm to hip | miss 0; palms 0.04 deg |
| 4 | `pose_set_controls` body_ctrl f0 / f48 (-12 z, +8 y); `pose_set_interpolation` smooth | verified |
| 5 | `pose_constrain` hand_r_ik_ctrl -> Tray (parent) | tray moved 16.8 cm, offset drift 0 cm |
| 6 | `pose_space_switch` hand_l_ik_ctrl -> body_ctrl f0 | pop 0, body moved 14.4 cm, drift 0 |
| 7 | `pose_constrain replace bake` | keys 0-48, constraint keys gone, worst 0 cm |
| 8 | `shot_camera` 35 mm, azimuth -8, rise 70, cut [0,49]; captures 0/24/48 | all in frame |

Eyes vs numbers: the first camera sat behind the counter and cut the head; the second had a Manny from build 7/8 in
the foreground. The first constraint was added before the palm was set and the palm call silently could not turn
the hand (reported 35 deg) - pose first, constrain last. The first tray path ran past arm's reach: the control
followed perfectly while the hand bone stopped 3-4 cm short, which is why the bone gap is its own line.

## 10. Blocking + breakdowns: reach to a shelf (2026-10-21, `/Game/_MCPLab/Seq/SEQ_ShelfReach`, Tween tool)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny facing 0, MM_Idle f10, end 24 | facing 0.0 |
| 2 | `prop_key` Shelf [34,80,4] at [55,20,138], Post, Box [14] at [48,26,147] | 0 cm |
| 3 | `pose_reach` hand_r f0 [8,26,92]; f24 [37,26,148]; `pose_palm` r -> box, fingers up; `pose_look_at` box f24 | miss 0; palm 0.03 deg; gaze 0.03 deg |
| 4 | `pose_tween` f8 value -0.4; f16 value 0.5 | worst 0.0006; hand_r [16.7,26,108.8] (30%) / [31.9,26,138.2] (75% of 8->24) |
| 5 | `shot_camera` 35 mm aim spine_03, 470 cm, azimuth 28, rise 20; captures 0/8/16/24 | clean frame |

Eyes vs numbers: the first layout put the shelf at head height (looked like it sat on his head) with the box out of
frame and the hand apparently touching his forehead; a camera from +Y had Loco_Wave (build 8) standing behind the
shelf. The tween numbers were exact every time - only the captures showed the scene was wrong. The first tween call
reported failure because Unreal keys only controls whose neighbours differ; the check now counts changing controls.

## 11. Carry a lifted tray (2026-10-21, `/Game/_MCPLab/Seq/SEQ_SnapTray`, Snapper)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny facing 0, MM_Idle f10, end 48 | facing 0.0 |
| 2 | `prop_key` Tray [24,24,3] f0 [27,24,100.5], f24 [31,22,117], f48 [25,30,128] | 0 cm |
| 3 | `pose_reach` hand_r [21,24,97.5]; `pose_palm` r target [47,24,193] (normal 15 deg forward of up), fingers +X; `pose_reach` again; `pose_hand` r open | miss 0; palm 0.02 deg; knuckles level with the wrist |
| 4 | `pose_snap` hand_r_ik_ctrl -> Tray 0-48 (keepOffset, rotation, every frame) | tray moved 28.2 cm, drift 0, jump 0 |
| 5 | `shot_camera` Cam 35 mm spine_03 420 cm azimuth -10; captures 0/24/48 | clean |

Eyes vs numbers: the first layout put the palm ON a floating tray (read as the tray lifting the hand); palm-up under
the tray at the old height was 4.3 cm out of reach (bone inside the tray - flagged by the gap line); the idle hand's
curled fingers poked through until `pose_hand open`. A re-snap after re-posing jumped the hand 42 cm (Snapper took the
offset from old later keys) - caught by the tool's jump check. A side check camera (left in the sequence) stole the
cut; `shot_camera` now cleans orphan cuts. The side camera, once it aimed at the right frame (`aim.frame`), showed the
fingers poking UP through the tray from below - invisible from the front: Manny's palm slopes ~29 deg up to the
knuckles when its normal points straight up, so the palm target was tilted 15 deg forward.

## 12. A toast with a shared grip socket (2026-10-22, `/Game/_MCPLab/Seq/SEQ_Toast`, sockets)

| Step | Call | Readback |
|---|---|---|
| 1 | `pose_setup_character` Manny [300,-42,0] facing 90 MM_Idle f10; Quinn SKM_Quinn_Simple [300,42,0] facing -90 f60 | facing 90.0 / -90.1 |
| 2 | `pose_reach` hand_r f24 Manny [287.7,-5,120], Quinn [312.3,5,120]; f0 [284,-24,98] / [316,24,98] | miss 0 |
| 3 | `pose_palm` r, palm to the midline (target 100 cm beside the hand), fingers = facing, f0 and f24 | 0.03 deg |
| 4 | `prop_attach` CupM grip r [8,8,11] on Manny | 5/5 digits within 1 cm, deepest -0.19 cm |
| 5 | `prop_socket` CupM -> Cup_Grip_R (SK_Mannequin) | stored 0.000 cm / 0.000 deg; moved 0, turned 0 |
| 6 | `prop_attach` CupQ bone Cup_Grip_R grip r on Quinn | offset 0 (socket); 5/5 digits, palm gap 0.85 cm, curls 30-36 deg (Manny 25-27) |
| 7 | `pose_look_at` each other's head f0/f24; `pose_set_interpolation` smooth | 0.03 deg |
| 8 | `prop_check` both cups 0-48, near CupQ | drift 0; cup centres 9.08 cm apart at f24 (1 cm gap) |
| 9 | `shot_camera` Cam 35 mm spine_03 330 cm az -75 rise 35 cut 0-30; CU 50 mm hand_r 90 cm az -60 rise 35 cut 30-49 | heads and hands in frame |

Eyes vs numbers: every number passed on the first pose, but the capture showed the cups lying on their side (palm-down
hand -> knuckle-line axis horizontal) and the fists overlapping like a handshake. After turning the palms inward the
cups sat on the palm side, i.e. toward the other person, and crossed through each other (centres 3.8 cm apart) -
`prop_check near` caught it, re-spacing the hands along x fixed it. The two-shot hides the cups inside the fists; the
close-up cut shows the grips.

## 13. Walk, glance and wave over a clip (2026-10-22, `/Game/_MCPLab/Seq/SEQ_WalkWave`, layered Control Rig)

| Step | Call | Readback |
|---|---|---|
| 1 | `anim_walk` Walker [600,-300,0] -> [600,300,0] | 300 cm/s, slide max 1.16 cm/frame |
| 2 | `pose_layer add` | legs FK keyed; whole body <= 0.007 cm off the clip on 5 frames |
| 3 | `shot_camera` Cam 24 mm [200,520,160] rot [-5.2,-44,0] | walker in frame 0-47 |
| 4 | `pose_look_at` Cam f10/20/30/40; `pose_layer zero` head_ctrl f0 | gaze <= 0.24 deg, head 31-48 deg off the body |
| 5 | `pose_reach` hand_r + `pose_palm` to Cam at f16-36 (wave points ride the walker, +-7 cm side to side) | miss 0.000 cm, palm <= 0.044 deg |
| 6 | `pose_layer zero` hand_r_ik_ctrl f8/f44; `pose_set_interpolation` smooth | - |
| 7 | `pose_layer check` 8 frames | legs 0.000 cm all frames; arm_r edited f16-36, <= 0.42 cm at the bounds |

Eyes vs numbers: the first `add` reported the knees 1.4 cm off the clip (pass-through keys dropped in the creating call -
fixed by keying in a second call); a side camera put the glance at 90 deg (camera moved ahead of him); the 28 mm lens
lost him off the edge at the end (24 mm).

## 14. A custom-skeleton character waves and smiles (2026-10-22, `/Game/_MCPLab/Seq/SEQ_GirlFK`, auto FK Control Rig)

| Step | Call | Readback |
|---|---|---|
| 1 | Girl (Fab handpaint girl, own skeleton, no Control Rig) spawnable at [900,600,0]; `pose_fk add` | FKControlRig, 99 bone controls, REPLACE |
| 2 | `pose_fk aim` f0 upperarm/lowerarm l+r down at the sides | 119/46/36/32 -> <= 0.001 deg, 1 step each |
| 3 | `pose_fk set` f0 face zero; f20 jaw roll 1.5, lip corners [+-0.55,0.75,0.3] cm, brows/cheeks up | worst 0.000 deg; corners moved 0.98 cm |
| 4 | `pose_fk aim` f24 upperarm_r out at shoulder height, lowerarm_r up; f32/40/48 lowerarm_r side to side | 0.000 deg each |
| 5 | `shot_camera` Cam 40 mm spine_03 380 cm az 10 rise 25 cut 0-36; CU 85 mm head 130 cm cut 36-49 | hand in frame |

Eyes vs numbers: raw rotation offsets twisted the arm instead of raising it (-> `aim`); the background had the Loco
mannequins (character moved to x 900); the first wave went straight up out of frame (read as hailing) and the first
smile (jaw 4 deg) bared the teeth like a snarl - jaw 1.5, corners wider.

## 15. One montage, three moments (2026-10-22, `/Game/_MCPLab/Anim/AM_WaveTwice` + `ABP_Montage`, montages)

| Step | Call | Readback |
|---|---|---|
| 1 | `create_anim_blueprint` ABP_Montage (SK_Mannequin); `add_anim_node` Slot (-> Output), SequencePlayer MM_Idle; `connect_pins` Pose -> Source | compile OK, 0 warnings |
| 2 | `anim_montage create` clips wave [0-2.5], MM_Idle [0-1], wave [0.5-2.0] x1.5; sections Wave@0 -> Rest@2.5 -> QuickWave@3.5 (end); blend 0.2/0.3 | 4.5 s, verified from the saved asset |
| 3 | `anim_montage_play` positions 0.6/2.0/2.9/3.8/4.3, jumps Rest/QuickWave/Wave, base MM_Idle | <= 0.043 cm, jumps on the section starts, idle 0.03 cm after stop |
| 4 | `anim_montage_play place` Mont_Wave/Rest/Quick at [1500,-120..120,0] facing 180, held 0.6/2.9/3.8 | each verified; captured side by side |

Eyes vs numbers: the first playback check failed at 0.6 s with the hand 42 cm off - the montage was still blending in
(slot weight 0.36); the tool now waits for full weight. Negative control: ABP_Locomotion (no Slot) -> 80 cm, weight 0.
The montage editor (sections, segments) has no Python access - added /api/montage-read|edit to the plugin.
