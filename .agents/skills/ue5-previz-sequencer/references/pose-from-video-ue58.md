# Pose from an AI image, without hand-posing — UE 5.8 markerless mocap

**Status: COMPLETED end to end on 2026-09-23** (UE 5.8.3, MyLab_5_8, RTX 6000 Ada).
Qwen image → LTX-2.5 video → MetaHuman markerless solve → AnimSequence → posed mesh in engine.
Every claim below was measured. The failures are recorded because each one cost real time.

## The chain that works

```
Qwen Image 2.1 7B (wan2gp)        896x1344 pose plate            ~90 s
  → LTX-2 2.5 Distilled (wan2gp)  73 frames @24fps, 3.04 s        ~82 s
  → ffmpeg → H.264 MP4            (see the format trap below)
  → Capture Manager "Mono Video Ingest"  → CD_* FootageCaptureData
  → MetaHumanPerformance, body_tracking, Process   [UI BUTTON — see below]
  → export_animation_sequence()   → AnimSequence on metahuman_base_skel   [scriptable]
  → previz_lib.pose_from_clip()   → held Control Rig pose
```

## Generation side (wan2gp)

- **Use a Deepy template, not a hand-built settings dict.** `wangp_deepy_templates` →
  `deepy_templates {tool_id}` → `deepy_template_settings {tool_id, template}`. Hand-assembling
  settings is how you end up on the wrong model at the wrong step count without noticing.
- **`gen_video` → template `LTX-2 2.5 Distilled`** = `ltx2_25_22B_distilled`, **8 steps**, and its
  `media_inputs.image` includes `start` + `end`. Measured **82 s** for 3 s at 768x1152.
  For contrast, `flf2v_720p` (Wan2.1 **14B, non-distilled, 30 steps**) on the same job was still
  running after **40 minutes**. Roughly 30x. Always check for a distilled variant first.
- **First and last frame set to the same image** (`image_prompt_type: "SE"`) pins the pose at both
  ends while the model invents believable breathing and weight shifts in between — which the solver
  needs. A dead-static clip gives a tracker almost no temporal signal.
- **Gallery media IDs do not survive a wan2gp restart**, and direct filesystem paths are disabled by
  default (`--mcp-allow-read-file-system` enables them). After a restart the gallery is empty and
  `add_to_gallery` also demands a media ID, so the only way back in is to regenerate. Keep the
  server alive across a session, or enable filesystem reads.
- wan2gp is **single-threaded**: while generating it answers nothing, not even a status query, so a
  long render is indistinguishable from a hung server. Set a per-server `"timeout"` in
  your MCP client's config (`~/.claude.json` for Claude Code; see `docs/mcp-clients.md` for others) — the default silent-timeout aborts the *call* while the render keeps going.

## Ingest — the Capture Manager is not optional

**`.mov` is rejected. Transcode to H.264 MP4 first.** This stops you at step one and the docs do
not mention it.

```
ffmpeg -i clip.mov -c:v libx264 -pix_fmt yuv420p clip.mp4
```

Then **Tools > Live Link Hub > Capture Manager**, add a **Mono Video Ingest** device pointed at the
folder, Add to Queue, Start. Output lands in `/Game/CaptureManager/Imports/Mono_Video_Ingest/<clip>/`
as `CD_*` (FootageCaptureData) and `IS_V_video_*` (ImgMediaSource).

**A hand-built FootageCaptureData is not equivalent.** Measured differences that matter:

| | Capture Manager ingest | Hand-built from a PNG sequence |
|---|---|---|
| `ImgMediaSource.frame_rate_override` | `24000/1000` | `24/1` (what you would type) |
| Sequence path | transcoded media under `%LOCALAPPDATA%/CaptureManager/Media/...` | wherever the PNGs are |
| Performance frame range | **auto-populates 0–73** on assignment | never populates; stays at whatever you set |

The frame range is the tell. `UpdateFrameRanges()` fills the `MediaFrameRanges` map that the solver
indexes, and it is plain C++ with **no `UFUNCTION`**, so Python cannot call it.

## Three silent failures in the Performance asset

1. **`footage_capture_data` refuses assignment while `Metadata.FrameRate` is 0.**
   `SetFootageCaptureData` nulls the pointer and logs "assignment rejected"; from Python the property
   simply reads back `None` with no exception. Set `fcd.metadata.frame_rate = 24.0` first — that is
   what finally flipped `can_process()` to True.
2. **The real setters are `BlueprintSetter`s that are NOT exposed to Python**
   (`SetFootageCaptureData`, `SetInputType`, `SetBodyTracking`). `set_editor_property` writes the raw
   property and skips the side effects; `call_method("SetFootageCaptureData", ...)` also did nothing.
3. **`contains_animation_data()` and `get_number_of_processed_frames()` lie.** After a *successful*
   UI process and a *successful* export of 72 real frames they still reported `False` and `0`.
   `can_export_animation()` was `True` throughout, including when there was genuinely nothing to
   export. None of the three can gate anything. **Trust the exported AnimSequence and verify it by
   measuring bone rotations.**

## Processing: use the UI button

`start_pipeline(is_scripted_processing=True)` returns `EStartPipelineErrorType::NONE` and runs for
~85 s, but produced **0 frames every time** on 5.8.3 — against both a hand-built and a properly
ingested capture data. `StartPipeline` returns as soon as it has kicked off `StartPipelineStage()`;
it is not synchronous even with `set_blocking_processing(True)`, and the async stages appear not to
advance from inside a blocking `run_python` call.

**`StartPipeline` calls `ResetOutput()` first.** Re-running it after a successful UI process
*destroys* that result. That happened here by accident and wiped a good solve twice.

So: **press Process in the Performance editor.** Open it from Python with
`AssetEditorSubsystem.open_editor_for_assets([perf])`, which also triggers `UpdateFrameRanges()`.
Success looks like a purple solved skeleton in the A|B viewport matching the plate.

## Export: fully scriptable

```python
U = unreal.MetaHumanPerformanceExportUtils
s = U.get_export_animation_sequence_settings(perf)
s.set_editor_property("show_export_dialog", False)     # headless, no modal
s.set_editor_property("auto_save_anim_sequence", True)
s.set_editor_property("export_body", True)
s.set_editor_property("export_face", False)
s.set_editor_property("package_path", "/Game/Previz/Mocap")
s.set_editor_property("asset_name", "AS_PoseClip_Body")
anim = U.export_animation_sequence(perf, s)            # -> AnimSequence
```

Default target is **`/MetaHumanBodyTracker/SKM_Body`**; output lands on skeleton
**`metahuman_base_skel`** with 342 tracks. Measured: 72 frames, 3.0 s. A benign
`RuntimeWarning: Track with name root already exists` accompanies a successful export.

## Verify the result numerically

Local bone *translations* are constant (they are bone lengths) — comparing them proves nothing.
Compare **rotations** across frames:

```python
ts = unreal.AnimationLibrary.get_bone_poses_for_frame(anim, ["upperarm_l", "upperarm_r"], f, False)
```

Measured here: `upperarm_l` pitch **−60°** against `upperarm_r` **−17°** — the asymmetry of one arm
extended forward — varying frame to frame and returning near its start value at the end, exactly as
a held pose should.

## Plugins to enable (and to leave alone)

Tick **MetaHuman Animator** only; it pulls its 19 dependencies (CoreTech, SDK, PerformanceCaptureCore,
CaptureData, CaptureManagerEditor, NNERuntimeORT, IKRig, DNACalib…). Add **MetaHumanBodyTracker**
(the Fab plugin) and **PerformanceCaptureWorkflow** for the Mocap Manager panel. Leave off: CoreML
(Apple-only), Calibration Diagnostics/Processing (multi-camera rigs), Creator, Crowd (drags in Mass),
Generator, Live Link (realtime streaming), MetaHumanRuntime (deprecated in favour of the SDK).

The Fab plugin is **MetaHuman Animator Markerless Motion Capture v1.0.0**, experimental,
Win64/Mac/Linux, installing to `Engine/Plugins/Marketplace/MetaHumanBodyTracker_5.8/`.

## Using the result

The AnimSequence is on `metahuman_base_skel`, not the UE5 Mannequin. **Decided 2026-09-23:** previz
characters are MetaHuman-skeleton dummies (`/MetaHumanBodyTracker/SKM_Body` + `MetaHuman_ControlRig_Simple`),
so solves need no retarget — see "MetaHuman-skeleton dummies" in SKILL.md. Then `pose_from_clip(seq, binding, anim_path, clip_frame=N)`
turns any frame into a held Control Rig pose — the step already proven in SKILL.md.

## Sources

- [Import your footage](https://dev.epicgames.com/documentation/metahuman/metahuman-animator-01-import-your-footage-in-unreal-engine)
- [Process and export](https://dev.epicgames.com/documentation/metahuman/metahuman-animator-02-process-and-export-your-animation-in-unreal-engine)
- [Apply to a MetaHuman](https://dev.epicgames.com/documentation/metahuman/metahuman-animator-03-apply-your-animation-to-a-metahuman-in-unreal-engine)
- [Fab listing](https://www.fab.com/listings/4095b8e0-3eff-44f1-acb4-cb40b99228b9)
