// CLAUDE-NOTE: Bakes the Voxel Sandbox Toolkit's runtime voxel chunks into saved assets.
// Each chunk is an AVoxelActor (confirmed in the plugin source, not just the docs) whose
// geometry lives in a UProceduralMeshComponent built only during PIE via CreateMeshSection.
// Two console commands so the whole flow can be driven through the MCP exec_command tool:
//   Voxel.BakeChunks [all|single] [cellSize]  -> run DURING PIE; bakes chunk PMCs to UStaticMesh
//                                                assets and records (mesh,transform) in a manifest.
//   Voxel.AssembleLevel [/Game/.../LevelName] -> run AFTER stopping PIE; builds a fresh level from
//                                                the manifest and saves it as a .umap.
// We split read (PIE-only geometry) from level-write (editor new-map path) on purpose: fabricating
// a world during PIE is fragile, whereas the editor's blank-map path produces a clean, loadable umap.
// The baker is intentionally DECOUPLED from the VoxelSandbox module: chunks are found generically as
// any actor owning a UProceduralMeshComponent, so we never have to link the marketplace plugin.

#include "CoreMinimal.h"
#include "Misc/EngineVersionComparison.h"
#include "HAL/IConsoleManager.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"

#if WITH_EDITOR
#include "ProceduralMeshComponent.h"
#include "ProceduralMeshConversion.h"          // BuildMeshDescription() — exported PROCEDURALMESHCOMPONENT_API
#include "MeshDescription.h"
#include "StaticMeshAttributes.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMeshSourceData.h"       // FStaticMeshSourceModel
#include "Components/StaticMeshComponent.h"
#include "StaticMeshResources.h"
#include "Materials/Material.h"
#include "Materials/MaterialInterface.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/SoftObjectPath.h"
#include "Misc/PackageName.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor.h"                             // GEditor
#include "FileHelpers.h"                        // UEditorLoadingAndSavingUtils
#endif

DEFINE_LOG_CATEGORY_STATIC(LogVoxelBake, Log, All);

#if WITH_EDITOR

namespace VoxelBake
{
	// One baked chunk: where its mesh asset lives and the exact world transform to place it at.
	struct FBakedRecord
	{
		FString MeshObjectPath;   // e.g. /Game/BakedVoxels/Meshes/SM_Voxel_x2_y-1.SM_Voxel_x2_y-1
		FTransform WorldTransform;
	};

	// Manifest survives between the two console commands within one editor session.
	static TArray<FBakedRecord> GManifest;

	static const TCHAR* kMeshFolder   = TEXT("/Game/BakedVoxels/Meshes");
	static const TCHAR* kDefaultLevel = TEXT("/Game/BakedVoxels/BakedWorld");

	// Geometry only exists in the PIE world; find it explicitly rather than trusting the
	// world the console hands us (it differs between editor- and PIE-context execution).
	static UWorld* FindPIEWorld()
	{
		if (GEngine)
		{
			for (const FWorldContext& Ctx : GEngine->GetWorldContexts())
			{
				if (Ctx.WorldType == EWorldType::PIE && Ctx.World())
				{
					return Ctx.World();
				}
			}
		}
		return nullptr;
	}

	// Stable, human-readable per-chunk name derived from its grid cell (cosmetic only —
	// correctness comes from the actual actor transform, not the name).
	static FString GridName(const FVector& Loc, float CellSize)
	{
		const int32 CX = FMath::RoundToInt(Loc.X / CellSize);
		const int32 CY = FMath::RoundToInt(Loc.Y / CellSize);
		return FString::Printf(TEXT("x%d_y%d"), CX, CY);
	}

	// Mirrors ProceduralMeshComponentDetails::ClickedOnConvertToStaticMesh (engine 5.6) without the
	// interactive path dialog, plus an explicit package save. BuildMeshDescription carries vertex
	// colors (face-direction lives in the color's alpha) and per-section materials through verbatim.
	static UStaticMesh* BakePmcToStaticMesh(UProceduralMeshComponent* Pmc, const FString& AssetName, const FString& MeshFolder, FOutputDevice& Ar)
	{
		FMeshDescription MeshDescription = BuildMeshDescription(Pmc);
		if (MeshDescription.Polygons().Num() == 0)
		{
			Ar.Logf(ELogVerbosity::Warning, TEXT("[VoxelBake] %s produced 0 polygons; skipped."), *AssetName);
			return nullptr;
		}

		const FString PackageName = MeshFolder / AssetName;
		UPackage* Package = CreatePackage(*PackageName);
		check(Package);

		UStaticMesh* StaticMesh = NewObject<UStaticMesh>(Package, *AssetName, RF_Public | RF_Standalone);
		StaticMesh->InitResources();
		StaticMesh->SetLightingGuid();

		FStaticMeshSourceModel& SrcModel = StaticMesh->AddSourceModel();
		SrcModel.BuildSettings.bRecomputeNormals          = false;
		SrcModel.BuildSettings.bRecomputeTangents         = false;
		SrcModel.BuildSettings.bRemoveDegenerates         = false;
		SrcModel.BuildSettings.bUseHighPrecisionTangentBasis = false;
		SrcModel.BuildSettings.bUseFullPrecisionUVs       = false;
		SrcModel.BuildSettings.bGenerateLightmapUVs       = true;
		SrcModel.BuildSettings.SrcLightmapIndex           = 0;
		SrcModel.BuildSettings.DstLightmapIndex           = 1;
		StaticMesh->CreateMeshDescription(0, MoveTemp(MeshDescription));
		StaticMesh->CommitMeshDescription(0);

		// Copy each section's material. The face texture (top/side/bottom) is chosen INSIDE these
		// materials from the vertex-color alpha, so preserving material + colors == correct faces.
		// FStaticMaterial(Mat) sets the slot name to Mat->GetFName(), matching the polygon-group
		// names BuildMeshDescription assigned, so slots bind to the right polygons after Build().
		TSet<UMaterialInterface*> Unique;
		const int32 NumSections = Pmc->GetNumSections();
		for (int32 S = 0; S < NumSections; ++S)
		{
			UMaterialInterface* Mat = Pmc->GetMaterial(S);
			if (!Mat) { Mat = UMaterial::GetDefaultMaterial(MD_Surface); }
			if (!Unique.Contains(Mat))
			{
				Unique.Add(Mat);
				StaticMesh->GetStaticMaterials().Add(FStaticMaterial(Mat));
			}
		}

		// CLAUDE-NOTE (dual-engine, 2026-09-22): SetImportVersion() does not exist on 5.6 (StaticMesh.h has no
		// such symbol there) and is the non-deprecated form from 5.7 on. Plain inline setter onto the same member.
#if UE_VERSION_OLDER_THAN(5, 7, 0)
		StaticMesh->ImportVersion = EImportStaticMeshVersion::LastVersion;
#else
		StaticMesh->SetImportVersion(EImportStaticMeshVersion::LastVersion);
#endif
		StaticMesh->Build(false);
		StaticMesh->PostEditChange();

		FAssetRegistryModule::AssetCreated(StaticMesh);
		Package->MarkPackageDirty();

		const FString FileName = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
		FSavePackageArgs SaveArgs;
		SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
		SaveArgs.SaveFlags     = SAVE_NoError;
		const bool bSaved = UPackage::SavePackage(Package, StaticMesh, *FileName, SaveArgs);

		Ar.Logf(TEXT("[VoxelBake] Baked %s  (sections=%d, saved=%s)"), *PackageName, NumSections, bSaved ? TEXT("yes") : TEXT("NO"));
		return bSaved ? StaticMesh : nullptr;
	}

	// ---- Voxel.BakeChunks [all|single] [cellSize] -------------------------------------------------
	static void BakeChunks(const TArray<FString>& Args, UWorld* /*World*/, FOutputDevice& Ar)
	{
		const bool bAll = Args.ContainsByPredicate([](const FString& A){ return A.Equals(TEXT("all"), ESearchCase::IgnoreCase); });
		float CellSize = 2000.f; // default chunk world size (chunkLineElements 10 * voxelSize 200)
		// CLAUDE-NOTE: optional output-folder arg lets variants (e.g. denser v2 vs sparser v3) bake to
		// separate, coexisting asset sets. A bare name -> /Game/BakedVoxels/<name>; a /Path is used as-is.
		FString MeshFolder = kMeshFolder;
		for (const FString& A : Args)
		{
			if (A.Equals(TEXT("all"), ESearchCase::IgnoreCase) || A.Equals(TEXT("single"), ESearchCase::IgnoreCase)) { continue; }
			if (A.IsNumeric()) { CellSize = FCString::Atof(*A); continue; }
			MeshFolder = A.StartsWith(TEXT("/")) ? A : (FString(TEXT("/Game/BakedVoxels/")) / A);
		}

		UWorld* PIEWorld = FindPIEWorld();
		if (!PIEWorld)
		{
			Ar.Logf(ELogVerbosity::Error, TEXT("[VoxelBake] No PIE world. Press Play first — chunk geometry only exists during PIE."));
			return;
		}

		// Collect every actor that owns a populated UProceduralMeshComponent (the voxel chunks).
		struct FFound { UProceduralMeshComponent* Pmc; FTransform Xf; FString Name; };
		TArray<FFound> Found;
		for (TActorIterator<AActor> It(PIEWorld); It; ++It)
		{
			AActor* Actor = *It;
			UProceduralMeshComponent* Pmc = Actor ? Actor->FindComponentByClass<UProceduralMeshComponent>() : nullptr;
			if (!Pmc || Pmc->GetNumSections() == 0) { continue; }
			Found.Add({ Pmc, Actor->GetActorTransform(), GridName(Actor->GetActorLocation(), CellSize) });
		}

		if (Found.Num() == 0)
		{
			Ar.Logf(ELogVerbosity::Error, TEXT("[VoxelBake] Found 0 actors with a UProceduralMeshComponent in the PIE world."));
			return;
		}

		const int32 Count = bAll ? Found.Num() : 1;
		Ar.Logf(TEXT("[VoxelBake] %d chunk(s) present; baking %d [mode=%s, cellSize=%.0f]."), Found.Num(), Count, bAll ? TEXT("all") : TEXT("single"), CellSize);

		GManifest.Reset();
		TSet<FString> UsedNames;
		for (int32 i = 0; i < Count; ++i)
		{
			FString AssetName = FString::Printf(TEXT("SM_Voxel_%s"), *Found[i].Name);
			const FString Base = AssetName;
			int32 Suffix = 1;
			while (UsedNames.Contains(AssetName)) { AssetName = FString::Printf(TEXT("%s_%d"), *Base, Suffix++); }
			UsedNames.Add(AssetName);

			UStaticMesh* Mesh = BakePmcToStaticMesh(Found[i].Pmc, AssetName, MeshFolder, Ar);
			if (Mesh)
			{
				GManifest.Add({ Mesh->GetPathName(), Found[i].Xf });
			}
		}

		Ar.Logf(TEXT("[VoxelBake] BakeChunks done: %d mesh asset(s) written to %s. Now stop PIE and run 'Voxel.AssembleLevel'."), GManifest.Num(), *MeshFolder);
	}

	// ---- Voxel.AssembleLevel [/Game/.../LevelName] ------------------------------------------------
	static void AssembleLevel(const TArray<FString>& Args, UWorld* /*World*/, FOutputDevice& Ar)
	{
		if (GManifest.Num() == 0)
		{
			Ar.Logf(ELogVerbosity::Error, TEXT("[VoxelBake] Manifest is empty. Run 'Voxel.BakeChunks' during PIE first (same editor session)."));
			return;
		}
		if (GEditor && GEditor->PlayWorld != nullptr)
		{
			Ar.Logf(ELogVerbosity::Error, TEXT("[VoxelBake] Stop PIE before assembling the level."));
			return;
		}

		FString LevelPackage = kDefaultLevel;
		for (const FString& A : Args) { if (A.StartsWith(TEXT("/"))) { LevelPackage = A; } }

		// Fresh blank map via the editor's own path => a clean, loadable .umap. This replaces the
		// currently-open level in the editor (the on-disk asset of that level is NOT modified).
		UEditorLoadingAndSavingUtils::NewBlankMap(/*bSaveExistingMap=*/false);
		UWorld* World = GEditor->GetEditorWorldContext().World();
		if (!World)
		{
			Ar.Logf(ELogVerbosity::Error, TEXT("[VoxelBake] Could not obtain a fresh editor world."));
			return;
		}

		int32 Spawned = 0;
		for (const FBakedRecord& Rec : GManifest)
		{
			UStaticMesh* Mesh = Cast<UStaticMesh>(FSoftObjectPath(Rec.MeshObjectPath).TryLoad());
			if (!Mesh)
			{
				Ar.Logf(ELogVerbosity::Warning, TEXT("[VoxelBake] Could not load baked mesh %s; skipping."), *Rec.MeshObjectPath);
				continue;
			}

			FActorSpawnParameters SP;
			SP.OverrideLevel = World->PersistentLevel;
			AStaticMeshActor* SMA = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), Rec.WorldTransform, SP);
			if (SMA)
			{
				UStaticMeshComponent* Comp = SMA->GetStaticMeshComponent();
				Comp->SetMobility(EComponentMobility::Static);
				Comp->SetStaticMesh(Mesh);
				SMA->SetActorLabel(Mesh->GetName());
				++Spawned;
			}
		}

		const bool bSaved = UEditorLoadingAndSavingUtils::SaveMap(World, LevelPackage);
		Ar.Logf(TEXT("[VoxelBake] AssembleLevel done: spawned %d actor(s), level '%s' saved=%s."), Spawned, *LevelPackage, bSaved ? TEXT("yes") : TEXT("NO"));
	}
}

static FAutoConsoleCommandWithWorldArgsAndOutputDevice GVoxelBakeChunksCmd(
	TEXT("Voxel.BakeChunks"),
	TEXT("Bake Voxel Sandbox runtime chunks to saved StaticMesh assets. Usage: Voxel.BakeChunks [all|single] [cellSize] [outFolderNameOrPath]. Run DURING PIE."),
	FConsoleCommandWithWorldArgsAndOutputDeviceDelegate::CreateStatic(&VoxelBake::BakeChunks));

static FAutoConsoleCommandWithWorldArgsAndOutputDevice GVoxelAssembleLevelCmd(
	TEXT("Voxel.AssembleLevel"),
	TEXT("Assemble baked voxel meshes into a fresh level and save it as a .umap. Usage: Voxel.AssembleLevel [/Game/Path/LevelName]. Run AFTER stopping PIE."),
	FConsoleCommandWithWorldArgsAndOutputDeviceDelegate::CreateStatic(&VoxelBake::AssembleLevel));

#endif // WITH_EDITOR
