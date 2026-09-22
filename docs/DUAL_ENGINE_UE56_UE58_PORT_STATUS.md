# Dual-engine UE 5.6.1 / UE 5.8.1 port status

One source tree that builds and passes its suite on both UE 5.6.1 and UE 5.8.1, so the 5.6 install used
at work and the 5.8 install used for previz never drift into two products.

## Branch policy

- `main` — 5.6.1 authority until this branch is proven on both engines.
- `release/ue5.6-stable` — frozen safety branch, **cut 2026-09-22 at `dfe361f`** (the last main commit before
  dual-engine verification). An earlier version of this document claimed the branch had been cut at
  `96dd300`; it never existed on local or origin. The work PC should install from this branch.
- `feature/dual-ue56-ue58` — this branch. Checked out as a worktree at `F:\__PROJECTS\ue5-mcp-dual`.
- `hoodtronik/Unreal-MCP-Ultra-5.8` — the July 2026 fork. Reference evidence only; it stopped at
  2026-07-31 and is 13+ commits behind main. Every 5.8 change it proved has now been forward-ported here.

## Source-of-truth rule

1. Current `main` owns feature behaviour and tool surface.
2. The old 5.8 fork owns the *map* of what breaks between engines.
3. A real compile, link, editor load, test run and runtime proof on each engine outrank both.

Do not merge the fork wholesale. Forward-port with version gates, one difference at a time.

## The engine differences, with the version each one actually lands in

Every gate below was set by reading the installed engine headers (5.6, 5.7 and 5.8 are all on this machine),
not from release notes. Two of the five were previously attributed to the wrong version.

| Difference | Lands in | Gate | File |
|---|---|---|---|
| `Engine/UserDefinedStruct.h` forwarding header removed | 5.8 | none — `StructUtils/UserDefinedStruct.h` exists on every engine | `Handlers_DataAssets.cpp`, `Handlers_UserTypes.cpp` |
| `UMaterial::GetMaterialResource()` takes `EShaderPlatform` again | **5.7** (not 5.8) | `#if UE_VERSION_OLDER_THAN(5, 7, 0)` → `GMaxRHIFeatureLevel` else `GMaxRHIShaderPlatform` | `Handlers_MaterialRead.cpp` |
| `FJsonObject::Values` keyed by `UE::FSharedString` (link-time) | 5.8 | none — `FString(*Key)` compiles on both | `Handlers_Snapshot.cpp` |
| `UMaterial::SetUsageByFlag()` becomes public | **5.8** (private on 5.6 *and* 5.7) | `#if UE_VERSION_OLDER_THAN(5, 8, 0)` → assign `bUsedWith*` else `SetUsageByFlag()` | `Handlers_MaterialMutation.cpp` |
| `UStaticMesh::SetImportVersion()` exists | **5.7** (absent on 5.6) | `#if UE_VERSION_OLDER_THAN(5, 7, 0)` → assign `ImportVersion` else `SetImportVersion()` | `BlueprintMCPVoxelBaker.cpp` |
| `GetCameraSpeedSetting()` deprecated | 5.7 | none — `GetCameraSpeed()` on both; emitted `cameraSpeed` is now the float speed | `Handlers_Camera.cpp` |
| Mass restructured into `Runtime/Mass/MassCore` (link-time) | 5.8 | **not gated — Riot Crowd is out of scope for the dual tree (owner's call, 2026-09-22)** | `RiotCrowd/…Build.cs` |

Also carried from the fork: `HairStrands` + `ProceduralMeshComponent` declared in `BlueprintMCP.uplugin`
(5.8 no longer loads them implicitly), a per-call `uePost` timeout so the unfiltered validate sweep
(measured 59.1 s on 5.8) does not trip the 30 s client abort, and `BPMCP_ENGINE_VERSION` on the test
bootstrap so one tree can boot either engine.

## Build hosts

The canonical repo is never inside a project, so each engine has a throwaway host whose
`Plugins/BlueprintMCP` is a **junction to the worktree**:

| Engine | Host | Junction → |
|---|---|---|
| 5.6 | `F:\.bpmcp-build\BuildHost\BuildHost.uproject` | `F:\__PROJECTS\ue5-mcp-dual` (retargeted 2026-09-22; was `F:\__PROJECTS\ue5-mcp`) |
| 5.8 | `F:\.bpmcp-build-58\BuildHost58\BuildHost58.uproject` | `F:\__PROJECTS\ue5-mcp-dual` (retargeted 2026-09-22; was the fork) |

```
"C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" UnrealEditor Win64 Development -Project="F:\.bpmcp-build\BuildHost\BuildHost.uproject" -waitmutex
"C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" UnrealEditor Win64 Development -Project="F:\.bpmcp-build-58\BuildHost58\BuildHost58.uproject" -waitmutex
```

**The worktree's `Binaries/Win64` holds whichever engine was built last.** Run the suite for an engine
right after building for it, and set `BPMCP_ENGINE_VERSION` to match. Both Riot Crowd junctions were
removed from both hosts.

**Any running UE editor blocks UBT** ("Unable to build while Live Coding is active"). Killing
`LiveCodingConsole.exe` unblocks it without closing the editor.

## Verification matrix

| Gate | UE 5.6.1 | UE 5.8.1 |
|---|---|---|
| UBT compile | **PASS** 2026-09-22 — 0 warnings from our sources, 0 C4996 | **PASS** 2026-09-22 — 0 warnings, 0 C4996 |
| Link | **PASS** | **PASS** |
| TypeScript test suite | **PASS** 703 passed / 68 skipped / 0 failed (771), 136 s | **PASS** 703 passed / 68 skipped / 0 failed (771), 177 s |
| Plugin loads in real editor | TODO — re-run after a 5.6 rebuild (DLL currently 5.8) | TODO — MyLab_5_8 has the junction; restart the editor |
| MCP server starts and binds 9847 | TODO | TODO |
| Blueprint read/mutation smoke | TODO | TODO |
| Material validation smoke (`resourceChecked: true`) | TODO | TODO |
| Vision/capture smoke | TODO | TODO |
| Previz skill `selfcheck()` | PASS (main, 2026-09-22) | TODO |
| Riot Crowd | out of scope | out of scope |

A compile-only pass is insufficient; the Mass port showed failures that appear only at link, and the
`validate_material` bug showed one that appears only in a real editor.

## Merge policy

- Never merge into `main` on static review; both editor-load columns must be green first.
- `release/ue5.6-stable` stays frozen regardless.
- After merge, prefer one shared `main` with these minimal gates over two trees. Prebuilt binaries remain
  engine-specific (separate `BlueprintMCP-prebuilt` branches) even though the source is shared.
