# Wonderwall Stage — Physical Geometry (Crossroads Oakley)

<!-- CLAUDE-NOTE (2026-09-01): Written by Claude Code while building a UE5 graybox of the
     stage from the pixel map. Companion to led-wall-background-content.md, which covers
     CONTENT (plates, slideshow BPs). This file covers PHYSICAL SPACE. Verified against an
     as-surveyed calibration file; do not change numbers without re-checking that source. -->

## Where the real geometry lives

**`F:\__PROJECTS\Wonderwall_GEM\Oakley — Site-Specific Stuff\SP - GRID\25_11_13_Crossroads_Camera-Tracking_EOD.grid`**

A 106 MB Stage Precision project — JSON behind a 4-byte `SP\0\0` header. It holds the
as-surveyed position and rotation of every LED surface in **metres**. This is the only
source on this machine with real stage geometry.

**`Crossroads_Operations Manual.pdf` §3.4 has no physical dimensions at all** — only panel
counts and pixel counts. Pitch appears solely as Helios tile-profile labels in §2.9.2/§2.10.1
(pp. 170–171): `BP2v2 (2.8)`, `V8S (8.9)`, `BM4 (4.7)`, `JA (2.6)`. There are no drawings,
plans or elevations anywhere in its 231 pages, nor in the Diversified or FP SD companion sets.

## Deriving physical size from the pixel map alone

`F:\PixelDensityCompensationRaster.jpg` (and `F:\WonderwallPixelDensityCompensationRaster.png`)
are 12288×11904. Being a *density-compensation* raster, each surface's drawn area is
proportional to its **physical** size while its label gives native pixels — so the drawing is
a scale plan and the ratio drawn:native recovers each product's pitch.

Base density is **2.6042 mm per drawn pixel** (the Jasper skirt is drawn 1:1, which sets it).
Anchor on the wall row: 62 × 500 mm panels = 31.00 m wide, 16 = 8.00 m tall.

Measure the regions by thresholding luminance > 25 and matching signed jumps in the
row/column occupancy profiles (regions overlap in both axes, so plain connected components
will not do it). Result:

| Surface | Drawn px | Native px | Scale | Pitch | Physical |
|---|---|---|---|---|---|
| VANISH | 12288 × 3072 | 3584 × 896 | 3.429 | 8.93 mm | 32.00 × 8.00 m |
| Wall row | 11904 × 3072 | 10912 × 2816 | 1.091 | 2.84 mm | 31.00 × 8.00 m |
| FLOOR | 5144 × 5376 | 2816 × 2944 | 1.827 | 4.76 mm | 13.41 × 14.02 m |
| SKIRT centre | 5184 × 384 | 5184 × 384 | 1.000 | 2.60 mm | 13.50 × 1.00 m |
| SKIRT L / R | 384 × 2304 | 2304 × 384 | 1.000 | 2.60 mm | 6.00 × 1.00 m each |
| SWR | 1920 × 1152 | 3840 × 2160 | 0.500 | — | separate 4K surface, not set geometry |

Every pitch that falls out is isotropic and lands on a real ROE product — Vanish V8S 8.93,
Black Pearl 2 v2 2.841, Black Marble 4 v2 4.7625, Jasper 2.604. That mutual consistency is
the check that the method worked.

The floor is **22 wide × 23 deep of 2 ft (609.6 mm) BM4 tiles** = 13.41 × 14.02 m. §3.4.9
prints "23×22" — it is the wrong way round. A 600 mm tile (13.20 × 13.80) is ruled out by
the survey's measured 0.609 column spacing.

The net is an unfolded box: floor is the top, the three skirts are its folded-down front and
side faces. Side skirts are 6.00 m against a 14.02 m floor, which means **the main deck stops
6.00 m short of the floor's downstage edge and the last 6.00 m is a thrust** with three
exposed faces. Skirt height 1.00 m implies a **~1.0 m deck**; §3.4.14 ("mounted upright
against the concrete pad that supports the LED floor") supports it but never states it.

Unconfirmed: the 13.50 m centre skirt run. 27+12+12 = 51 matches §3.4's panel total, but the
Helios centre mapping allocates 15×2 = 30 tile slots, not 27. Treat it as an inference.

## As-surveyed 3D layout — the wall is NOT flat

SP frame: `+X` stage left, `+Y` up, `+Z` upstage; `y=0` is the LED floor top, `z=0` the
floor's downstage edge. Offsets below are restated from the Vanish plane.

| Surface | Downstage of Vanish | Yaw | Size |
|---|---|---|---|
| Vanish | 0 | ~0° | 32.00 × 8.00 |
| Doors 2 & 3 | 2.63 m | ±0.4° | 6.50 × 8.00 |
| Doors 1 & 4 | 3.59 m | ±17.7° | 4.50 × 8.00 |
| Legs (USR / USL) | 5.17 m | ±14.2° | 4.50 × 8.00 |

A shallow faceted arc, legs furthest downstage and overlapping the doors in plan. The wall
stands **on** the LED floor (bottom y ≈ 0.03 m, top ≈ 8.03 m) and the floor's upstage edge
lands within 10 mm of the Vanish plane.

Doors run on traveller tracks (TAIT Navigator/Atlas, position fed to Disguise). Doors 1/4
travel ≈ 7.60 m on rails yawed 3.6° off X; Doors 2/3 travel ≈ 16.2 m parallel to X. Door
centre X (metres, SP frame):

| Preset | Door 1 | Door 2 | Door 3 | Door 4 |
|---|---|---|---|---|
| Vanish Only | −16.235 | −19.457 | +19.465 | +16.262 |
| Walk In | −12.668 | −19.471 | +19.476 | +12.685 |
| Presentation | −12.664 | −3.242 | +3.255 | +12.681 |
| Staggered | −11.074 | −3.246 | +3.254 | +11.080 |
| VP | −8.635 | −3.239 | +3.258 | +8.650 |
| Center Closed | −16.230 | −3.238 | +3.257 | +16.242 |

Legs sit at ±15.96. Only in **VP** do the four doors close into one continuous 22.0 m wall.
The raster's contiguous 31 m strip is the pixel map, not a physical position.

The SP project contains no Skirt and no IMAG — those are not tracked or calibrated.

Manual errata, for the record: Tech Spec §2.1.1 gives Door 1 as 1584×2160; its own mappings
and §3.4.1 both say 1584×2816 (2160 is wrong). §3.4.13 says 51 skirt panels but the Helios
mappings allocate 54 tile slots — likely 3 unpopulated in the centre block.

## The graybox

`/Game/_Wonderwall_Graybox/Wonderwall_Graybox` in `F:\_UnrealProjects\!MyLab\MyLab_5_6`.

Built **flat and contiguous** (user's choice 2026-09-01) — the pixel-map arrangement, correct
for content mapping, not for physical space. Convention: `+X` downstage, `+Y` audience-left,
`+Z` up; origin at house floor / centreline / Vanish plane. Deck top Z = 1.0 m, panels
1.0–9.0 m, Vanish 0.40 m thick, doors/legs 0.60 m thick with 0.60 m face-to-face clearance.
`SKM_Manny_Simple` at scale 1.0 (1.81 m) as the human reference. Materials are flat-albedo
MICs off `M_GB_Base` under `/Game/_Wonderwall_Graybox/Materials`.

Two traps hit while building it, both only visible in a capture:
- **UE is left-handed**: a camera facing −X has screen-right = −Y. Audience-left is **+Y**,
  so LEG 1 / DOOR 1 go at positive Y to read left-to-right like the raster.
- **TextRenderActor faces +X at yaw 0**, not yaw 180. Guessing 180 renders every label
  mirrored.

## v2: the production Walls BP and its graybox derivative (2026-09-01)

The user's official line-up tool is `/Game/BP/Walls` (in MyLab_5_6): one component per LED
surface (meshes at scale 99, rot r90/y90), a `StageSetup` enum (P1 Vanish Open, P2
Presentation, P3 Staggered, P4 Upstage VP, P5 Walkin, P6 Center Closed, Stage Off) whose
switch repositions the four door components, WireFrame/StageVisibility/LegsBlackout toggles,
and a LiveLink tick hook. Its whole update path hangs off **Event Tick**, so in the editor
the enum does nothing until PIE. Its depth layout is staggered like the survey (its own
values, ~2.51/3.05/5.31 m; legs at ±15.5 m).

`Wonderwall_Graybox_v2` + `/Game/_Wonderwall_Graybox/BP_Walls_Graybox` (duplicate; original
untouched): solid MI_GB_* materials in the runtime solid chain AND a new construction script
that re-applies visibility, materials, and the full preset switch — so presets and the nine
per-piece Show* checkboxes work live in the editor. Alignment to the tool is by construction
(same components), not by measurement. Level adopts the tool's frame (floor top = Z0, origin
at the floor's downstage edge). `Anchor_Door1..4` TargetPoints are attached to the door
*components* and verified to ride preset changes — parent scene pieces to those.

The v1 flat-contiguous graybox actors remain in v2, hidden, under
`Wonderwall_Graybox/FlatReference_Hidden`.
