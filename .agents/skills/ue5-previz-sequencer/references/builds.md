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
