// Landscape heightmap import/export for BlueprintMCP.
//
// CLAUDE-NOTE (2026-11-18): written because ALandscapeProxy::LandscapeImportHeightmapFromRenderTarget
// (the only heightmap writer exposed to Python) hard-fails with "Cannot import to landscape with Edit
// Layers enabled", and edit layers are the default for new landscapes. These handlers go through the
// same path Landscape mode's sculpt/import tools use: FScopedSetLandscapeEditingLayer selects the
// target edit layer, FLandscapeEditDataInterface writes/reads it, and the layer stack is then
// re-merged so the final heightmap and collision update. Data is raw little-endian uint16 (.r16),
// row-major, one value per landscape vertex, rows running +Y, which is what Landscape mode imports.

#include "BlueprintMCPServer.h"

#include "Editor.h"
#include "EngineUtils.h"
#include "Landscape.h"
#include "LandscapeEdit.h"
#include "LandscapeEditLayer.h"
#include "LandscapeInfo.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Dom/JsonObject.h"

namespace
{
	ALandscape* FindLandscape(const FString& Wanted, FString& OutError)
	{
		UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!World)
		{
			OutError = TEXT("No editor world.");
			return nullptr;
		}
		TArray<ALandscape*> Found;
		for (TActorIterator<ALandscape> It(World); It; ++It)
		{
			if (Wanted.IsEmpty() || It->GetActorLabel() == Wanted || It->GetName() == Wanted)
			{
				Found.Add(*It);
			}
		}
		if (Found.Num() == 0)
		{
			OutError = Wanted.IsEmpty() ? TEXT("No landscape in the current level.")
				: FString::Printf(TEXT("No landscape named '%s' in the current level."), *Wanted);
			return nullptr;
		}
		if (Found.Num() > 1 && Wanted.IsEmpty())
		{
			OutError = TEXT("More than one landscape in the level; pass 'landscape' (actor label).");
			return nullptr;
		}
		return Found[0];
	}

	// Resolves the target edit layer. Empty name = layer 0 (the base layer). Returns an invalid GUID
	// for landscapes without edit layers, which FLandscapeEditDataInterface treats as "no layer".
	bool ResolveLayer(ALandscape* Landscape, const FString& LayerName, FGuid& OutGuid, FString& OutName, FString& OutError)
	{
		OutGuid.Invalidate();
		OutName = TEXT("(no edit layers)");
		if (!Landscape->HasLayersContent())
		{
			return true;
		}
		const ULandscapeEditLayerBase* Layer = LayerName.IsEmpty()
			? Landscape->GetEditLayerConst(0)
			: Landscape->GetEditLayerConst(FName(*LayerName));
		if (!Layer)
		{
			TArray<FString> Names;
			for (const ULandscapeEditLayerBase* L : Landscape->GetEditLayersConst())
			{
				if (L) { Names.Add(L->GetName().ToString()); }
			}
			OutError = FString::Printf(TEXT("Edit layer '%s' not found. Layers: %s"), *LayerName, *FString::Join(Names, TEXT(", ")));
			return false;
		}
		OutGuid = Layer->GetGuid();
		OutName = Layer->GetName().ToString();
		return true;
	}

	FString LayerListJson(ALandscape* Landscape)
	{
		TArray<FString> Names;
		if (Landscape->HasLayersContent())
		{
			for (const ULandscapeEditLayerBase* L : Landscape->GetEditLayersConst())
			{
				if (L) { Names.Add(FString::Printf(TEXT("%s%s"), *L->GetName().ToString(), L->IsVisible() ? TEXT("") : TEXT(" (hidden)"))); }
			}
		}
		return FString::Join(Names, TEXT(", "));
	}
}

// POST /api/landscape-export-heightmap  { file, landscape?, layer? }
FString FBlueprintMCPServer::HandleLandscapeExportHeightmap(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body.")); }

	FString File;
	if (!Json->TryGetStringField(TEXT("file"), File) || File.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'file' (output .r16 path)."));
	}
	FString Wanted, LayerName, Err;
	Json->TryGetStringField(TEXT("landscape"), Wanted);
	Json->TryGetStringField(TEXT("layer"), LayerName);

	ALandscape* Landscape = FindLandscape(Wanted, Err);
	if (!Landscape) { return MakeErrorJson(Err); }
	ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
	int32 MinX, MinY, MaxX, MaxY;
	if (!Info || !Info->GetLandscapeExtent(MinX, MinY, MaxX, MaxY))
	{
		return MakeErrorJson(TEXT("Could not read the landscape extent."));
	}
	FGuid LayerGuid; FString ResolvedLayer;
	if (!ResolveLayer(Landscape, LayerName, LayerGuid, ResolvedLayer, Err)) { return MakeErrorJson(Err); }

	const int32 W = MaxX - MinX + 1, H = MaxY - MinY + 1;
	TArray<uint16> Data;
	Data.SetNumZeroed(W * H);
	{
		FLandscapeEditDataInterface Edit(Info, LayerGuid);
		int32 X1 = MinX, Y1 = MinY, X2 = MaxX, Y2 = MaxY;
		Edit.GetHeightData(X1, Y1, X2, Y2, Data.GetData(), 0);
	}
	uint16 Lo = MAX_uint16, Hi = 0;
	for (uint16 V : Data) { Lo = FMath::Min(Lo, V); Hi = FMath::Max(Hi, V); }

	TArray<uint8> Bytes;
	Bytes.Append(reinterpret_cast<const uint8*>(Data.GetData()), Data.Num() * sizeof(uint16));
	if (!FFileHelper::SaveArrayToFile(Bytes, *File))
	{
		return MakeErrorJson(FString::Printf(TEXT("Could not write '%s'."), *File));
	}
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: landscape_export_heightmap %s layer '%s' %dx%d -> %s"), *Landscape->GetActorLabel(), *ResolvedLayer, W, H, *File);

	TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
	R->SetBoolField(TEXT("success"), true);
	R->SetStringField(TEXT("landscape"), Landscape->GetActorLabel());
	R->SetStringField(TEXT("layer"), ResolvedLayer);
	R->SetStringField(TEXT("layers"), LayerListJson(Landscape));
	R->SetNumberField(TEXT("width"), W);
	R->SetNumberField(TEXT("height"), H);
	R->SetNumberField(TEXT("minValue"), Lo);
	R->SetNumberField(TEXT("maxValue"), Hi);
	R->SetStringField(TEXT("file"), File);
	return JsonToString(R);
}

// POST /api/landscape-import-heightmap  { file, landscape?, layer?, backupFile?, dryRun? }
FString FBlueprintMCPServer::HandleLandscapeImportHeightmap(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body.")); }

	FString File;
	if (!Json->TryGetStringField(TEXT("file"), File) || File.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'file' (.r16 heightmap, uint16 little-endian, one value per vertex)."));
	}
	FString Wanted, LayerName, BackupFile, Err;
	Json->TryGetStringField(TEXT("landscape"), Wanted);
	Json->TryGetStringField(TEXT("layer"), LayerName);
	Json->TryGetStringField(TEXT("backupFile"), BackupFile);
	bool bDryRun = false;
	Json->TryGetBoolField(TEXT("dryRun"), bDryRun);

	ALandscape* Landscape = FindLandscape(Wanted, Err);
	if (!Landscape) { return MakeErrorJson(Err); }
	ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
	int32 MinX, MinY, MaxX, MaxY;
	if (!Info || !Info->GetLandscapeExtent(MinX, MinY, MaxX, MaxY))
	{
		return MakeErrorJson(TEXT("Could not read the landscape extent."));
	}
	FGuid LayerGuid; FString ResolvedLayer;
	if (!ResolveLayer(Landscape, LayerName, LayerGuid, ResolvedLayer, Err)) { return MakeErrorJson(Err); }

	const int32 W = MaxX - MinX + 1, H = MaxY - MinY + 1;
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *File))
	{
		return MakeErrorJson(FString::Printf(TEXT("Could not read '%s'."), *File));
	}
	if (Bytes.Num() != W * H * (int32)sizeof(uint16))
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is %d bytes; this landscape needs %dx%d uint16 = %d bytes."),
			*File, Bytes.Num(), W, H, W * H * (int32)sizeof(uint16)));
	}
	TArray<uint16> NewData;
	NewData.SetNumUninitialized(W * H);
	FMemory::Memcpy(NewData.GetData(), Bytes.GetData(), Bytes.Num());

	// Read the layer as it is now: for the change report and the optional backup.
	TArray<uint16> OldData;
	OldData.SetNumZeroed(W * H);
	{
		FLandscapeEditDataInterface Edit(Info, LayerGuid);
		int32 X1 = MinX, Y1 = MinY, X2 = MaxX, Y2 = MaxY;
		Edit.GetHeightData(X1, Y1, X2, Y2, OldData.GetData(), 0);
	}
	int32 Changed = 0, MaxDelta = 0;
	for (int32 i = 0; i < NewData.Num(); ++i)
	{
		const int32 D = FMath::Abs((int32)NewData[i] - (int32)OldData[i]);
		if (D > 0) { ++Changed; MaxDelta = FMath::Max(MaxDelta, D); }
	}
	if (!BackupFile.IsEmpty())
	{
		TArray<uint8> Old;
		Old.Append(reinterpret_cast<const uint8*>(OldData.GetData()), OldData.Num() * sizeof(uint16));
		if (!FFileHelper::SaveArrayToFile(Old, *BackupFile))
		{
			return MakeErrorJson(FString::Printf(TEXT("Could not write backup '%s'; nothing imported."), *BackupFile));
		}
	}

	if (!bDryRun && Changed > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: landscape_import_heightmap %s layer '%s' %dx%d from %s (%d verts change)"),
			*Landscape->GetActorLabel(), *ResolvedLayer, W, H, *File, Changed);
		Landscape->Modify();
		if (LayerGuid.IsValid())
		{
			// CLAUDE-NOTE (2026-11-18): name the layer on the interface itself. The first version used
			// FScopedSetLandscapeEditingLayer + the shared-layer constructor; outside Landscape mode the
			// landscape's editing layer did not take, so SetHeightData wrote the MERGED heightmap and the
			// re-merge below rebuilt it from the untouched layer: success reported, zero visible change
			// (verified live in LevelUp: exported layer and collision both unchanged). The explicit-GUID
			// constructor is the one the export path uses, and it reads/writes the layer directly.
			FLandscapeEditDataInterface Edit(Info, LayerGuid);
			Edit.SetHeightData(MinX, MinY, MaxX, MaxY, NewData.GetData(), 0, true);
			Edit.Flush();
			// Re-merge the layer stack so the final heightmap, normals and collision update.
			Landscape->RequestLayersContentUpdateForceAll();
		}
		else
		{
			FLandscapeEditDataInterface Edit(Info);
			Edit.SetHeightData(MinX, MinY, MaxX, MaxY, NewData.GetData(), 0, true);
			Edit.Flush();
		}
		Landscape->MarkPackageDirty();
	}

	TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
	R->SetBoolField(TEXT("success"), true);
	R->SetBoolField(TEXT("dryRun"), bDryRun);
	R->SetStringField(TEXT("landscape"), Landscape->GetActorLabel());
	R->SetStringField(TEXT("layer"), ResolvedLayer);
	R->SetStringField(TEXT("layers"), LayerListJson(Landscape));
	R->SetNumberField(TEXT("width"), W);
	R->SetNumberField(TEXT("height"), H);
	R->SetNumberField(TEXT("changedVerts"), Changed);
	R->SetNumberField(TEXT("maxDelta"), MaxDelta);
	if (!BackupFile.IsEmpty()) { R->SetStringField(TEXT("backupFile"), BackupFile); }
	return JsonToString(R);
}
