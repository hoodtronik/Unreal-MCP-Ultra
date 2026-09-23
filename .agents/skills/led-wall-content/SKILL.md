---
name: led-wall-content
description: Import and rig the 11Weeks/Wonderwall LED stage background plates in UE5 — texture import settings, the background slideshow blueprint design, lighting from SDR-derived HDR maps, and Renderstream/disguise constraints. Use when working on LED wall backgrounds, the background slideshow, or stage content in VoxelWorld/ElevenWeekFallSeries projects.
---

# LED wall background content workflow (Wonderwall / 11Weeks)

Authoritative stage specs + asset locations: read `docs/led-wall-background-content.md`
in this repo FIRST. Key numbers: wall row LEG1→LEG2 = 10912×2816 px (ROE BP2v2,
2.84 mm); Vanish 3584×896 (4:1); pipeline is disguise Designer → RX III render nodes →
Unreal via Renderstream, GhostFrame + MegaPixel HELIOS processing downstream.

## Asset sets

21:9 wall-row plates (`F:\__PROJECTS\11Weeks\Images\NanoBanana\21x9\`):
- `*.png` — 24 masters, 2688×1152, exact 21:9
- `4K_7b\` — 7672×3288 SeedVR2 7B standard (**default choice**)
- `4K_7b_sharp\` — same, sharp variant (A/B only; sharpening stacks with HELIOS processing → moiré risk on camera)
- `lighting_2to1\` — ~2:1 light plates and `.hdr` highlight-expanded versions for image-based lighting

4:1 VANISH-strip plates (all 7680×1920 exact 4:1, all-sharp, no standard/sharp split):
- Batch 1 (indices 0–22): `F:\__PROJECTS\11Weeks\Images\GPT-Image\batch_20260813_120031\` —
  scene names in filenames + `VANISH_4x1_LEGEND.md` there (covers both batches).
- Batch 2 (indices 23–27): `F:\__PROJECTS\11Weeks\Images\Vanish Options for 11- Week Fall Series\batch_20260813_163032\`
- In UE: `/Game/_Backgrounds/Vanish4x1/T_VBG_<i>`, driven by `BP_BackgroundSlideshow-Vanish` (below).
  **Copies have diverged:** MyLab_5_6 (`F:\_UnrealProjects\!MyLab\MyLab_5_6`) has all 28 (0–27);
  VoxelWorld has only 0–22. Appending a batch = import+rename numeric, bump the CS Clamp Max,
  refill `SlideTextures_MigrationAnchor`.

## Texture import rules (large NPOT stills)

1. Enable **Virtual Textures** (project setting, needs restart) and import the 7672×3288 plates as VT — NPOT textures can't stream mips otherwise (fully resident ~100 MB each or mip-less shimmer on LED).
2. BC7, generate mips, sRGB on. `.hdr` light maps import as TextureCube (LongLat).
3. Keep asset names ASCII (source filenames contain `…` — sanitize on import).

## BP_BackgroundSlideshow design (asset-review slideshow)

Single actor; plane mesh + unlit emissive material with `TextureSampleParameter2D`;
Dynamic Material Instance set from arrays. Control surface (all Instance Editable →
Renderstream remote parameters so the d3 operator can drive them):

- `BackgroundIndex` (int) — applied in **Construction Script** so scrubbing the number in Details swaps plates live in-editor without PIE
- `bUseSharp` (bool) — resolves same index against `BackgroundsSharp[]` vs `BackgroundsStandard[]`; HDR lighting array stays shared (both variants derive from identical masters)
- `bPlaneEmissiveLighting` (bool) — toggles mesh component "Emissive Light Source" **and** "Affect Dynamic Indirect Lighting" flags (Lumen area-light bounce), NOT a material swap. AffectDynamicIndirectLighting is the flag that actually gates Lumen bounce; EmissiveLightSource alone gates nothing. The plate mesh must have `CastShadow=true` or the level's sun/sky shines straight through it and reads as un-killable "plate light"
- `bEnvironmentLighting` (bool) — as built: camera-invisible RectLight at the plate with SourceTexture = current plate (image-tinted wash), intensity 500 000 cd × `EnvLightIntensity` (Instance Editable float, default 1). Rejected designs, verified dead: hidden emissive booster meshes leave the Lumen scene (`RenderInMainPass=false`/`Visible=false` both); SkyLights can't reach a sealed set and silently replace the level's sky light. Rect lights silently stop rendering at wall-scale source sizes — keep sources ≲ 10 m. The 500k base compensates the level's EV100 6.5 exposure lock
- Add a TextRender showing current plate name for review sessions
- `PopulateFromFolder` editor function (EditorAssetLibrary.ListAssets, sorted) to fill arrays — never hand-wire 24 entries

### Variants that exist (VoxelWorld, /Game/_Backgrounds/)

- `BP_BackgroundSlideshow-fix` — the portable 21:9 wall-row variant (fresh drag-in works).
- `BP_BackgroundSlideshow-Vanish` — 4:1 VANISH-strip variant (2026-08-13): 23 `Vanish4x1/T_VBG_<i>`
  plates, index 0–22, no `bUseSharp`, plane scale (0.235, 103.4, 25.85), material
  `M_BackgroundSlideshow_Vanish` (TexCoord tiling 0.9375 crops the POT pad).
  **`PlateBrightness`** (Instance Editable, default 180) drives the DMI `Brightness` scalar —
  180 assumes the stage level's EV100-6.5 lock; under auto-exposure use ~1–10 or it blows out.
  Better: kill auto-exposure the way the stage level does — unbound PostProcessVolume with
  `auto_exposure_min_brightness = auto_exposure_max_brightness = 6.5` (+ both overrides true);
  then 180 reads correctly everywhere. Verified in MyLab/NewMap 2026-08-13.
- **Both** BPs carry the 2026-08-13 exec-chain fix: `SetAffectDynamicIndirectLighting` must be IN the
  CS exec chain (it was dangling → `bPlaneEmissiveLighting` looked dead under Lumen). If a new variant
  is duplicated, verify that node's exec pin is wired.
- Labels are numeric asset names (`T_VBG_<i>`) — scene-name labels need Array_Get, blocked by the
  wildcard-pin bug (`docs/KNOWN-ISSUE-wildcard-pins.md`, re-confirmed 2026-08-13).

## Video plates (post-CD-review phase)

Keep encodes at true 4K (3840-4096 wide), NOT 7672 — decode limits. UE media textures
have **no mips** (shimmer when minified) and Media Player looping can hitch; across the
12-node RX cluster ordinary video is not frame-deterministic — use ImgMedia image
sequences, or better: let disguise play looping plates natively (the GX 3s exist for
this) and reserve UE for 3D/parallax/lighting content. Material already takes a
MediaTexture in the same parameter slot — stills→video is an asset swap, not a rebuild.

## Working with the plates' source pipeline

Regeneration/expansion of plates (aspect changes, new HDRs, upscales) happens on the
Wan2GP side — see the user-level skill `wan2gp-outpaint-batch` and
`F:\__PROJECTS\11Weeks\Images\NanoBanana\outpaint_inventory.md` for provenance.
