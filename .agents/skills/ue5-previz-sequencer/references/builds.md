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
