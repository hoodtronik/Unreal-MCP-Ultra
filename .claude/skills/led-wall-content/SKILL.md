---
name: led-wall-content
description: Import and rig the 11Weeks/Wonderwall LED stage background plates in UE5 — texture import settings, the background slideshow blueprint design, lighting from SDR-derived HDR maps, and Renderstream/disguise constraints. Use when working on LED wall backgrounds, the background slideshow, or stage content in VoxelWorld/ElevenWeekFallSeries projects.
---

# LED wall background content workflow (Wonderwall / 11Weeks)

Authoritative stage specs + asset locations: read `docs/led-wall-background-content.md`
in this repo FIRST. Key numbers: wall row LEG1→LEG2 = 10912×2816 px (ROE BP2v2,
2.84 mm); Vanish 3584×896 (4:1); pipeline is disguise Designer → RX III render nodes →
Unreal via Renderstream, GhostFrame + MegaPixel HELIOS processing downstream.

## Asset sets (F:\__PROJECTS\11Weeks\Images\NanoBanana\21x9\)

- `*.png` — 24 masters, 2688×1152, exact 21:9
- `4K_7b\` — 7672×3288 SeedVR2 7B standard (**default choice**)
- `4K_7b_sharp\` — same, sharp variant (A/B only; sharpening stacks with HELIOS processing → moiré risk on camera)
- `lighting_2to1\` — ~2:1 light plates and `.hdr` highlight-expanded versions for image-based lighting

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
- `bPlaneEmissiveLighting` (bool) — toggles mesh component "Emissive Light Source"/"Affect Dynamic Indirect Lighting" flags (Lumen area-light bounce), NOT a material swap
- `bEnvironmentLighting` (bool) — large inverted sphere, same/HDR texture, `RenderInMainPass=false`, `RenderInDepthPass=false`, `AffectDynamicIndirectLighting=true` → camera-invisible Lumen wraparound light. Verify per-engine-version; fallback = SkyLight with specified cubemap from the `.hdr` set
- Add a TextRender showing current plate name for review sessions
- `PopulateFromFolder` editor function (EditorAssetLibrary.ListAssets, sorted) to fill arrays — never hand-wire 24 entries

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
