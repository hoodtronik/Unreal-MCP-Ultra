---
name: gaussian-splat-360
description: Turn 360 camera footage (DJI Osmo 360 / any equirectangular video) into Gaussian splats and 360 HDRI backdrops in UE 5.6 — clip triage, DJI Studio stitching, sharpest-frame extraction, COLMAP panorama-rig tracking, YOLO masking of riders/crowds, LichtFeld training, levelling/scaling from camera poses, NanoGS import, and clean-plate backdrops. Use for "gaussian splat", "3DGS", "360 footage", "splat from video", "HDRI backdrop from 360", Osmo/.OSV files, LichtFeld, NanoGS, or the Splat360 project.
---

# 360 footage -> Gaussian splats + backdrops in UE 5.6

Living playbook: **append what each new clip teaches you** (Lessons log at the bottom) and keep
the steps current. Verified end to end 2026-10-06/07 on Ephesus, Tarsus, Phillipi and Athens footage.

**Where things live**
- Pipeline repo: `F:\__PROJECTS\Splat360` (private: github.com/hoodtronik/Splat360). All scripts
  are in `scripts/`; use its `.venv` (`uv`-managed, so there is no pip: `uv pip install --python .venv/Scripts/python.exe ...`).
- Tools: `tools/colmap`, LichtFeld at `tools/lichtfeld/bin/LichtFeld-Studio.exe` (built from source, CUDA).
- UE project: `UE/Splat360UE` (UE 5.6, NanoGS + BlueprintMCP + HDRI Backdrop, **SM6** — NanoGS
  crashes the editor on SM5).
- Footage: `F:\__PROJECTS\!R&D\360Footage\<Site>\` (`.OSV` originals, stitched exports in `DJI_Export\`).
- Work dirs: `work/<site><nn>/` (gitignored). Imported splat assets are gitignored too; maps and
  backdrop cubemaps are committed.

## 1. Triage every clip first (contact sheet, 2 minutes)

`ffprobe` the duration, grab ~8 frames with ffmpeg (`-ss t -frames:v 1 -vf scale=640:320`),
tile them (`-vf tile=2x4`) and look. Decide per clip:

| What the camera does | Output | Route |
|---|---|---|
| Moves through the scene (walking, vehicle) | **Splat** | steps 3-6 |
| Locked off on a tripod/ground mount | **360 backdrop** | step 7 |
| Operator fiddling in frame the whole time | nothing | skip |

Also note: crowds (need masking), riders/vehicle in shot (need masking), night (noise, blur),
time windows where people leave the frame.

## 2. Stitch (the user does this — GUI only)

`.OSV` = two fisheye streams. DJI Studio (no CLI, no automation) exports **360 equirectangular
MP4, max resolution/bitrate, horizon levelling ON**. Horizon levelling matters: it is what makes
"pano down = gravity" true for step 5. ffmpeg approximate stitches have broken seams — test only.

## 3. Frames + camera tracking

```
.venv/Scripts/python.exe scripts/prep_splat.py VIDEO work/<name> --fps 3 [--mask-dynamic]
```
- Sharpest of every `--window` (3) frames per kept pano; 12 overlapping perspective views per pano;
  pycolmap panorama rig, SEQUENTIAL matching, **CPU only** (Windows wheel) — budget ~2 s/image
  of matching: 92 panos (1,104 views) ~45 min.
- `--mask-dynamic`: YOLO11x-seg masks person/bicycle/motorcycle in every view, merged in pano
  space and projected back (catches bodies cut off at a view edge), ANDed into the SfM feature masks
  and written to `dataset/masks/` for training. **Required for vehicle footage and crowds.**
- Not resumable: a rerun wipes `colmap/`. `--skip-extract` reuses `panos/`.
- Good result: every frame registered, mean reprojection error < ~1.2 px.

## 4. Train (LichtFeld, GPU)

```
tools/lichtfeld/bin/LichtFeld-Studio.exe -d <abs>/dataset -o <abs>/splat --headless \
  -i 30000 --strategy=mcmc --max-cap 3000000 --bilateral-grid [--mask-mode ignore]
```
3M splats / 30k iters = 13.5 min on the RTX 6000 Ada, 744 MB `.ply`. Add `--mask-mode ignore`
whenever `dataset/masks` exists (0 = ignore, 255 = keep). `--bilateral-grid` absorbs per-frame
exposure drift.

## 5. Level + scale

```
.venv/Scripts/python.exe scripts/align_splat.py work/<name>/dataset/sparse/0 work/<name>/align.json [--cam-height 1.6]
```
Up comes from the rig's pitch-0 views (check `up_spread_deg` < ~2); scale from camera height above
the ground points (`--cam-height` in metres: handheld 1.6, stick/monopod 1.5, ground mount 0.15-0.2,
vehicle selfie-stick ~1.5-2). Writes a GaussianSplatActor transform; the .ply is never rewritten
(NanoGS evaluates SH in actor-local space, so rotating the actor is correct).

## 6. Import into UE

```
scripts\ue_import_splat.ps1 -Ply work\<name>\splat\splat_30000.ply -Name <Name> -Align work\<name>\align.json
```
Opens the editor (ask the user before launching it), imports to `/Game/Splats/<Name>`, new map
`/Game/Maps/<Name>`, applies the transform, puts the viewport at the first camera. Verify by eye:
horizon level, people/doors at plausible size from the start position. Expect quality only near the
camera path.

## 7. 360 backdrop from a locked-off clip

```
.venv/Scripts/python.exe scripts/clean_plate.py VIDEO work/<n>/<Name>_plate.png --frames 15 --start S --end S+5
```
- Use a **few-second people-free window**: a long-span median smears moving clouds into swirls.
- Busy clip: long-span plate (removes crowd) + short-window plate, then
  `scripts/sky_blend.py GROUND.png SKY.png OUT.png` (sky above ~0.40-0.46 of height from the short one).
- Camera drift: measure yaw with phase correlation on the horizon band before worrying; DJI levelling
  kept a "rotating in the wind" clip within 0.15 deg.
- `.hdr` = sRGB-decoded linear float of the plate (`sky_blend.py` writes it; for `clean_plate`
  output convert with cv2). Then in the editor run `scripts/ue_backdrop.py` with env
  `BACKDROP_HDR`, `BACKDROP_NAME`, `BACKDROP_CAM_HEIGHT` (cm) → `/Game/Maps/<Name>_Backdrop`
  (HDRI Backdrop, 4096 cubemap, exposure locked at EV0).
- Someone sitting by the camera all clip: add `--mask-people` (YOLO + median over unmasked samples;
  writes `<plate>.holes.png` of pixels never seen clear), then
  `scripts/fill_holes.py PLATE HOLES OUT` (LaMa inpaint, model `tools/models/big-lama.pt`). Do this to
  both ground and sky plates before `sky_blend.py`.
- Handheld stick: check yaw drift (phase correlation on the band just below the horizon) and add
  `--derotate`. Horizon levelling fixes pitch/roll, not yaw.
- `ue_backdrop.py` leaves the viewport at the new-level default; put it at (0,0,cam height) to judge.
- Still left after all this: shadows of removed people, the holder's hands at the nadir.

## Driving the editor

The BlueprintMCP MCP tools refuse to run when the agent session's cwd has no `.uproject`. Call the
editor's HTTP API directly: `POST localhost:9847/api/run-python {"code": ...}` and
`POST /api/viewport-capture {"target":"level","maxSize":1024,"settle":true}` → `imageBase64`. Write
the Python to a file and JSON-encode it (Windows paths with `\_`/`\u` break inline strings; use `/`).
`-ExecutePythonScript` quits the editor when the script ends; launch with `-ExecCmds "py <file>"`.

## Lessons log (append newest last)

- 2026-10-06 Ephesus walking clip: crowd + film crew ghost; the operator barely moved (~2 m), so
  the splat collapses beyond the path. Coverage beats resolution — walk, don't stand.
- 2026-10-07 Phillipi: 3-min median smeared clouds → short windows for sky.
- 2026-10-07 Ephesus theatre: crowd for the whole clip → ground/sky blend.
- 2026-10-07 Athens motorcycle (night): rider + passenger + bike fixed in every frame → `--mask-dynamic`.
  YOLO misses partial bodies at view edges (an arm scored 0 even at conf 0.08); pano-space mask
  union fixed it. Installing ultralytics tried to swap OpenCV to 5.0 and failed while another
  process held cv2.pyd — do installs while nothing in the venv is running.
- 2026-10-07 Athens motorcycle RESULT: SfM looked perfect (215/215 frames, 0.81 px) but the splat
  FAILED — held-out PSNR 12.6 (13.3 without masks, so not the masks) vs 20.5 for Ephesus on the same
  eval. Mean track length 4.7 vs 14.5: at ~16 km/h and 3 fps panos are ~1.5 m apart, so every
  surface is seen from too few views; night blur makes it worse. **Good SfM numbers do not mean a
  trainable dataset — check track length, and run a 7k `--eval --test-every 25` before the 30k
  train** (Ephesus-quality ~20 at 7k). Masked LichtFeld training ran ~10x slower than unmasked.
- 2026-10-07 Athens moto DENSE SEGMENT (44-64 s at `--fps 8`, 160 panos): 7k PSNR **21.9** (vs 12.6 at
  3 fps), so spacing was the problem, not the night. Track length only rose 4.7 → 5.8, so it is a weak
  predictor across clips; trust the 7k eval. **Vehicle footage: `--fps 8` (≈0.5 m between panos at
  16 km/h).** Close side surfaces (a van beside the bike) stay soft from motion blur.
- 2026-10-07 Athens static clips: someone sat beside the camera the whole clip → `clean_plate.py
  --mask-people` (YOLO, nan-median over unmasked samples, writes `.holes.png` of never-seen pixels).
  1007(1) was handheld on a stick and yawed 14° over 2 min (horizon levelling does not fix yaw) →
  `--derotate` (phase correlation on the band just below the horizon; the sky band measures cloud
  drift instead).
- 2026-10-07 AthensMotoSeg in UE: a good street splat (cars, facades, lamps) along the 86 m path, but
  the masked rider zone right around the camera holds unconstrained floaters (never supervised).
  Judge from points ON the path: get them from `dataset/sparse/0` camera centres through
  align.json (UE = R·(to_ue(C)·100·scale) + t); straight +X runs off a curving road into fog.
  Possible fix: crop splats within ~1 m of the camera path.
