# LED Wall Background Content — Wonderwall Stage (11Weeks project)

<!-- CLAUDE-NOTE: Written 2026-08-04 by Claude Code (wan.git session) at the user's request.
     Source of truth for the 21:9 background plates and how to use them in the UE project.
     Do not modify without user approval. -->

## The stage: Wonderwall pixel map (Crossroads Oakley)

Pixel map reference image: `F:\WonderwallPixelDensityCompensationRaster.png` (raster canvas 12288×11904).

**Authoritative source:** `F:\__PROJECTS\Wonderwall_GEM\ALL\End of Project Documentation\Crossroads_Operations Manual.pdf` §3.4. Panels: doors/legs/Vanish = ROE Black Pearl 2 v2 (500 mm, 176 px/panel; doors/legs ≈ 8 m tall), Floor = ROE Black Marble 4 v2, skirt = ROE Jasper (9792×384 total). Also useful:
- Tile-level unwrapped raster: `F:\Crossroads Church Dropbox\Wonderwall\_PRODUCTION\01_DisguiseSync\Crossroads_Template_0325\objects\VideoFile\00_Utilities\UnwrappedRaster\UnwrappedRaster.png` (10944×7040)
- Content safe area: `F:\__PROJECTS\Wonderwall_GEM\ALL\Wonderwall ContractorResources\SitesLED-Overlays\LED-SAFE_BlackBG.jpg` — safe 3840×1746 inside 3840×2160 (207 px top/bottom)
- Door position presets: `F:\__PROJECTS\Wonderwall_GEM\WONDERWALL PRESETS.png` (P1 Vanish Open … P6 Center Closed)
- Surface/mapping codes: `F:\__PROJECTS\Wonderwall_GEM\Disguise Mappings + Surfaces.xlsx`

| Surface | Pixels | Notes |
|---|---|---|
| VANISH | 3584 × 896 | 4:1 upstage strip |
| LEG 1 / LEG 2 | 1584 × 2816 each | |
| DOOR 1 / DOOR 4 | 1584 × 2816 each | |
| DOOR 2 / DOOR 3 | 2288 × 2816 each | |
| **Full wall row (LEG1→LEG2)** | **10912 × 2816** | legs+doors side by side |
| FLOOR | 2816 × 2944 | |
| SKIRT CENTER | 5184 × 384 | SKIRT L/R: 2304 × 384 |
| IMAG L / R | 1280 × 768 each | |

## The background plates

24 environment panoramas (biomes + settlements), outpainted 16:9 → 21:9 and super-res'd:

- Working masters (2688×1152, exact 21:9): `F:\__PROJECTS\11Weeks\Images\NanoBanana\21x9\`
- 4K+ masters (7672×3288, SeedVR2 7B **standard** — user-preferred): `...\21x9\4K_7b\`
- 4K+ masters (7672×3288, SeedVR2 7B **sharp** — comparison set): `...\21x9\4K_7b_sharp\`
- Inventory/history: `...\NanoBanana\outpaint_inventory.md`

## AS BUILT (2026-08-04): BP_BackgroundSlideshow in VoxelWorld / 11Weeks_C

Working slideshow actor `BackgroundSlideshow` placed at the old BackdropCard_City transform
(old card hidden, not deleted). Assets under `/Game/_Backgrounds/`:
- `Std4K/T_BG_0..23`, `Sharp4K/T_BGS_0..23` (Texture2D, BC7, **Pad-to-POT 8192×4096** + mips),
  `LightHDR/T_LH_0..23` (TextureCube). Index↔scene table: see outpaint_inventory.md (0=Alpine … 6=City2k … 23=Vertical_slum).
- `M_BackgroundSlideshow`: unlit, two-sided, Emissive = Tex("BackgroundTex") × "Brightness"(180),
  **UVs scaled by (7672/8192, 3288/4096)** to crop the POT padding.
- Controls on the actor (Instance Editable): `BackgroundIndex` (0-23), `bUseSharp`,
  `bPlaneEmissiveLighting`, `bEnvironmentLighting` (SkyLight w/ per-index T_LH cubemap).
  Construction Script resolves textures by composing soft object paths from the index
  (typed nodes only — see KNOWN-ISSUE-wildcard-pins.md for why arrays were avoided).
- `r.VirtualTextures=True` added to VoxelWorld DefaultEngine.ini, but **streaming VT refused
  these NPOT textures** (engine requires power-of-two for SVT) — hence the Pad-to-POT route.
- Not yet verified: lighting toggles' visual effect, PIE/runtime behavior, Renderstream
  remote-parameter exposure.

## Using them in Unreal (as backgrounds cast to the LED)

1. **Use the 7672×3288 masters** for anything shown on the wall row. The combined row is 10912 px wide — wider than the masters — so every pixel of source resolution is used; the 2688 versions would need a ~4× soft blowup. Reserve resolution also holds up under virtual-camera punch-ins/pans where only a sub-region of the texture fills the wall.
2. **Enable Virtual Textures** for these imports (project setting + per-texture). 7672×3288 is non-power-of-two; without VT the textures either lose mip streaming or sit fully resident (~100 MB each). VT handles NPOT/large sizes and prevents mip-less shimmer on the LED.
3. **BC7 compression, generate mips.** ~25 MB per texture, sharpness preserved.
4. **Sharp vs standard masters:** default to the `4K_7b` (standard) set. Over-sharpened content can moiré/alias on camera-facing LED, and LED processors typically add their own sharpening. Use `4K_7b_sharp` only if the wall reads soft in person. User will compare both sets and may standardize on one.
5. **Detail ceiling:** resolution beyond ~1× the LED pixel density of the covered region is invisible to the audience (pixel pitch × viewing distance) — don't upres further; it only costs VRAM.
6. VANISH (3584×896) is 4:1, not 21:9 — content for it should be cropped/framed deliberately, not naively scaled.
