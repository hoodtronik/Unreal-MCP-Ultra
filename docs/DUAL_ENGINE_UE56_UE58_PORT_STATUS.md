# Dual-engine UE 5.6.1 / UE 5.8.1 port status

This document tracks the effort to make the current `hoodtronik/Unreal-MCP-Ultra` source tree support both Unreal Engine 5.6.1 and 5.8.1 without maintaining two drifting products.

## Branch policy

- `main` remains the current development authority until this port is proven.
- `release/ue5.6-stable` is a frozen safety branch cut from `main` at commit `96dd3004c42191d7d5956a3dea2abf310663b62c` before dual-engine work began.
- `feature/dual-ue56-ue58` is the active compatibility branch.
- `hoodtronik/Unreal-MCP-Ultra-5.8` is reference evidence from the earlier successful UE 5.8.1 port. It is not the current product authority because it stopped evolving on 2026-07-31 while the 5.6 main continued through 2026-08-27.

## Source-of-truth rule

1. Current `Unreal-MCP-Ultra/main` owns feature behavior and current tool surface.
2. The old `Unreal-MCP-Ultra-5.8` repo owns known UE 5.8.1 compatibility evidence.
3. A real compile, link, editor load, test run, and runtime proof on each engine outrank both documents and assumptions.

Do not merge old 5.8 files wholesale into current main. Forward-port current main using the earlier 5.8 repo as a compatibility map.

## Previously proven 5.6 -> 5.8 differences

The earlier UE 5.8.1 port identified four important differences in commit `cfe8cc943554a021e36c6f1f96301fa1ada14944`:

1. `Engine/UserDefinedStruct.h` forwarding header was removed in 5.8. `StructUtils/UserDefinedStruct.h` exists on both 5.6 and 5.8.
2. `UMaterial::GetMaterialResource()` differs: UE 5.6.1 used the `ERHIFeatureLevel::Type` form while UE 5.8.1 uses the `EShaderPlatform` form.
3. `FJsonObject::Values` keys changed from `FString` to `UE::FSharedString` in 5.8. Rebuilding via `FString(*Key)` was deliberately chosen because that expression works in both versions.
4. Mass was restructured in 5.8. Base Mass element/fragment types moved into `MassCore`, producing link failures if the dependency is missing. `MassCore` does not exist in 5.6.

## Work completed on this branch

### Shared UserDefinedStruct include

`Source/BlueprintMCP/Private/BlueprintMCPHandlers_DataAssets.cpp` now includes:

```cpp
#include "StructUtils/UserDefinedStruct.h"
```

instead of the removed forwarding header. This change is expected to be source-compatible with both 5.6.1 and 5.8.1 based on the prior live-proven 5.8 port.

Commit: `66e72dcfcd0915bc7ec64aab954df970c3b673c8`

## Next safe source changes

These should be applied incrementally, not as a bulk old-repo merge:

1. Apply the same shared `StructUtils/UserDefinedStruct.h` include to every remaining current-main use of `Engine/UserDefinedStruct.h`.
2. Change JSON snapshot key rebuilding to `FString(*GraphPair.Key)` where the old 5.8 port proved it dual-compatible.
3. Audit current main for any new post-July uses of APIs touched by the 5.8 port.
4. Add explicit engine-version handling around `GetMaterialResource()` only after verifying the exact version macros/types against both installed engine headers.
5. Add engine-version handling in `BlueprintMCPRiotCrowd.Build.cs` for `MassCore`, with no `MassCore` dependency on 5.6.
6. Re-run the deprecation audit previously performed on the old 5.8 port.

## Required verification matrix before merge

The dual-engine branch is not merge-ready until all relevant rows are proven on both engines.

| Gate | UE 5.6.1 | UE 5.8.1 |
|---|---|---|
| UBT compile | TODO | TODO |
| Link | TODO | TODO |
| Plugin loads in real editor | TODO | TODO |
| MCP server starts and binds | TODO | TODO |
| TypeScript test suite | TODO | TODO |
| Tool registration/baseline | TODO | TODO |
| Blueprint read/mutation smoke | TODO | TODO |
| DataAsset/UserDefinedStruct smoke | TODO | TODO |
| Material validation smoke | TODO | TODO |
| Animation mutation smoke | TODO | TODO |
| PIE/runtime tool smoke | TODO | TODO |
| Vision/capture smoke | TODO | TODO |

A compile-only pass is insufficient. The prior Mass port demonstrated that some 5.8 failures appear at link time.

## Merge policy

- Never merge this branch into `main` based only on static review.
- Protect `release/ue5.6-stable` while the dual-engine effort is underway.
- After both engines are green, prefer one shared `main` with minimal version gates over two independently developed 5.6 and 5.8 trees.
- Prebuilt binaries remain engine-specific even if source is shared.
