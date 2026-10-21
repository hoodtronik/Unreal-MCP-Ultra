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
