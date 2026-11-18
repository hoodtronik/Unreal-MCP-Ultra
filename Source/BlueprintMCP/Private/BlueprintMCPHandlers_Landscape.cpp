// Landscape heightmap import/export for BlueprintMCP.
//
// CLAUDE-NOTE (2026-11-18): written because ALandscapeProxy::LandscapeImportHeightmapFromRenderTarget
// (the only heightmap writer exposed to Python) hard-fails with "Cannot import to landscape with Edit
// Layers enabled", and edit layers are the default for new landscapes. Heights are read and written
// through FLandscapeEditDataInterface bound to an explicit edit-layer GUID, then the layer stack is
// re-merged so the final heightmap and collision update. Data is raw little-endian uint16 (.r16),
// row-major, one value per landscape vertex, rows running +Y, which is what Landscape mode imports.
//
// The logic lives in UBlueprintMCPLandscapeLibrary (Python/Blueprint-callable); the HTTP handlers at
// the bottom only parse the request and forward.

#include "BlueprintMCPLandscapeLibrary.h"
#include "BlueprintMCPServer.h"

#include "Editor.h"
#include "EngineUtils.h"
#include "Landscape.h"
#include "LandscapeEdit.h"
#include "LandscapeEditLayer.h"
#include "LandscapeInfo.h"
#include "Misc/FileHelper.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	FString ToJson(const TSharedRef<FJsonObject>& Obj)
	{
		FString Out;
		TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(Obj, W);
		return Out;
	}

	FString LandscapeError(const FString& Msg)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("error"), Msg);
		return ToJson(O);
	}

	// Resolves the target edit layer. Empty name = layer 0 (the base layer). Leaves OutGuid invalid
	// for landscapes without edit layers, where FLandscapeEditDataInterface writes the heightmap itself.
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

	FString LayerList(ALandscape* Landscape)
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

	bool GetExtent(ALandscape* Landscape, ULandscapeInfo*& OutInfo, int32& MinX, int32& MinY, int32& MaxX, int32& MaxY)
	{
		OutInfo = Landscape ? Landscape->GetLandscapeInfo() : nullptr;
		return OutInfo && OutInfo->GetLandscapeExtent(MinX, MinY, MaxX, MaxY);
	}

	void ReadLayer(ULandscapeInfo* Info, const FGuid& LayerGuid, int32 MinX, int32 MinY, int32 MaxX, int32 MaxY, TArray<uint16>& Out)
	{
		Out.SetNumZeroed((MaxX - MinX + 1) * (MaxY - MinY + 1));
		FLandscapeEditDataInterface Edit(Info, LayerGuid);
		int32 X1 = MinX, Y1 = MinY, X2 = MaxX, Y2 = MaxY;
		Edit.GetHeightData(X1, Y1, X2, Y2, Out.GetData(), 0);
	}

	bool SaveR16(const TArray<uint16>& Data, const FString& File)
	{
		TArray<uint8> Bytes;
		Bytes.Append(reinterpret_cast<const uint8*>(Data.GetData()), Data.Num() * sizeof(uint16));
		return FFileHelper::SaveArrayToFile(Bytes, *File);
	}
}

ALandscape* UBlueprintMCPLandscapeLibrary::FindEditorLandscape(const FString& Label)
{
	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	if (!World) { return nullptr; }
	TArray<ALandscape*> Found;
	for (TActorIterator<ALandscape> It(World); It; ++It)
	{
		if (Label.IsEmpty() || It->GetActorLabel() == Label || It->GetName() == Label)
		{
			Found.Add(*It);
		}
	}
	return (Found.Num() == 1 || (!Label.IsEmpty() && Found.Num() > 0)) ? Found[0] : nullptr;
}

FString UBlueprintMCPLandscapeLibrary::ExportLandscapeHeightmap(ALandscape* Landscape, const FString& File, const FString& Layer)
{
	if (!Landscape) { return LandscapeError(TEXT("No landscape (none in the level, more than one without a label, or the label did not match).")); }
	if (File.IsEmpty()) { return LandscapeError(TEXT("Missing required field: 'file' (output .r16 path).")); }
	ULandscapeInfo* Info; int32 MinX, MinY, MaxX, MaxY;
	if (!GetExtent(Landscape, Info, MinX, MinY, MaxX, MaxY)) { return LandscapeError(TEXT("Could not read the landscape extent.")); }
	FGuid LayerGuid; FString ResolvedLayer, Err;
	if (!ResolveLayer(Landscape, Layer, LayerGuid, ResolvedLayer, Err)) { return LandscapeError(Err); }

	TArray<uint16> Data;
	ReadLayer(Info, LayerGuid, MinX, MinY, MaxX, MaxY, Data);
	uint16 Lo = MAX_uint16, Hi = 0;
	for (uint16 V : Data) { Lo = FMath::Min(Lo, V); Hi = FMath::Max(Hi, V); }
	if (!SaveR16(Data, File)) { return LandscapeError(FString::Printf(TEXT("Could not write '%s'."), *File)); }
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: landscape_export_heightmap %s layer '%s' -> %s"), *Landscape->GetActorLabel(), *ResolvedLayer, *File);

	const FTransform T = Landscape->GetActorTransform();
	TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
	R->SetBoolField(TEXT("success"), true);
	R->SetStringField(TEXT("landscape"), Landscape->GetActorLabel());
	R->SetStringField(TEXT("layer"), ResolvedLayer);
	R->SetStringField(TEXT("layers"), LayerList(Landscape));
	R->SetNumberField(TEXT("width"), MaxX - MinX + 1);
	R->SetNumberField(TEXT("height"), MaxY - MinY + 1);
	R->SetNumberField(TEXT("minValue"), Lo);
	R->SetNumberField(TEXT("maxValue"), Hi);
	// World mapping, so callers can convert vertex <-> world without guessing:
	// x = originX + i * scaleX, y = originY + j * scaleY, z = originZ + (v - 32768) / 128 * scaleZ.
	R->SetNumberField(TEXT("originX"), T.GetLocation().X + MinX * T.GetScale3D().X);
	R->SetNumberField(TEXT("originY"), T.GetLocation().Y + MinY * T.GetScale3D().Y);
	R->SetNumberField(TEXT("originZ"), T.GetLocation().Z);
	R->SetNumberField(TEXT("scaleX"), T.GetScale3D().X);
	R->SetNumberField(TEXT("scaleY"), T.GetScale3D().Y);
	R->SetNumberField(TEXT("scaleZ"), T.GetScale3D().Z);
	R->SetStringField(TEXT("file"), File);
	return ToJson(R);
}

FString UBlueprintMCPLandscapeLibrary::ImportLandscapeHeightmap(ALandscape* Landscape, const FString& File, const FString& Layer, const FString& BackupFile, bool bDryRun)
{
	if (!Landscape) { return LandscapeError(TEXT("No landscape (none in the level, more than one without a label, or the label did not match).")); }
	if (File.IsEmpty()) { return LandscapeError(TEXT("Missing required field: 'file' (.r16 heightmap, uint16 little-endian, one value per vertex).")); }
	ULandscapeInfo* Info; int32 MinX, MinY, MaxX, MaxY;
	if (!GetExtent(Landscape, Info, MinX, MinY, MaxX, MaxY)) { return LandscapeError(TEXT("Could not read the landscape extent.")); }
	FGuid LayerGuid; FString ResolvedLayer, Err;
	if (!ResolveLayer(Landscape, Layer, LayerGuid, ResolvedLayer, Err)) { return LandscapeError(Err); }

	const int32 W = MaxX - MinX + 1, H = MaxY - MinY + 1;
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *File)) { return LandscapeError(FString::Printf(TEXT("Could not read '%s'."), *File)); }
	if (Bytes.Num() != W * H * (int32)sizeof(uint16))
	{
		return LandscapeError(FString::Printf(TEXT("'%s' is %d bytes; this landscape needs %dx%d uint16 = %d bytes."),
			*File, Bytes.Num(), W, H, W * H * (int32)sizeof(uint16)));
	}
	TArray<uint16> NewData;
	NewData.SetNumUninitialized(W * H);
	FMemory::Memcpy(NewData.GetData(), Bytes.GetData(), Bytes.Num());

	TArray<uint16> OldData;
	ReadLayer(Info, LayerGuid, MinX, MinY, MaxX, MaxY, OldData);
	int32 Changed = 0, MaxDelta = 0;
	for (int32 i = 0; i < NewData.Num(); ++i)
	{
		const int32 D = FMath::Abs((int32)NewData[i] - (int32)OldData[i]);
		if (D > 0) { ++Changed; MaxDelta = FMath::Max(MaxDelta, D); }
	}
	if (!BackupFile.IsEmpty() && !SaveR16(OldData, BackupFile))
	{
		return LandscapeError(FString::Printf(TEXT("Could not write backup '%s'; nothing imported."), *BackupFile));
	}

	if (!bDryRun && Changed > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: landscape_import_heightmap %s layer '%s' %dx%d from %s (%d verts change)"),
			*Landscape->GetActorLabel(), *ResolvedLayer, W, H, *File, Changed);
		Landscape->Modify();
		// CLAUDE-NOTE (2026-11-18): name the layer on the interface itself. The first version used
		// FScopedSetLandscapeEditingLayer + the shared-layer constructor; outside Landscape mode the
		// landscape's editing layer did not take, so SetHeightData wrote the MERGED heightmap and the
		// re-merge rebuilt it from the untouched layer: success reported, zero visible change (verified
		// live in LevelUp). An invalid GUID (no edit layers) writes the heightmap directly, as intended.
		FLandscapeEditDataInterface Edit(Info, LayerGuid);
		Edit.SetHeightData(MinX, MinY, MaxX, MaxY, NewData.GetData(), 0, true);
		Edit.Flush();
		if (LayerGuid.IsValid())
		{
			// Re-merge the layer stack so the final heightmap, normals and collision update.
			Landscape->RequestLayersContentUpdateForceAll();
		}
		Landscape->MarkPackageDirty();
	}

	TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
	R->SetBoolField(TEXT("success"), true);
	R->SetBoolField(TEXT("dryRun"), bDryRun);
	R->SetStringField(TEXT("landscape"), Landscape->GetActorLabel());
	R->SetStringField(TEXT("layer"), ResolvedLayer);
	R->SetStringField(TEXT("layers"), LayerList(Landscape));
	R->SetNumberField(TEXT("width"), W);
	R->SetNumberField(TEXT("height"), H);
	R->SetNumberField(TEXT("changedVerts"), Changed);
	R->SetNumberField(TEXT("maxDelta"), MaxDelta);
	if (!BackupFile.IsEmpty()) { R->SetStringField(TEXT("backupFile"), BackupFile); }
	return ToJson(R);
}

// ---- HTTP handlers --------------------------------------------------------------------------

// POST /api/landscape-export-heightmap  { file, landscape?, layer? }
FString FBlueprintMCPServer::HandleLandscapeExportHeightmap(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body.")); }
	FString File, Label, Layer;
	if (!Json->TryGetStringField(TEXT("file"), File) || File.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'file' (output .r16 path)."));
	}
	Json->TryGetStringField(TEXT("landscape"), Label);
	Json->TryGetStringField(TEXT("layer"), Layer);
	return UBlueprintMCPLandscapeLibrary::ExportLandscapeHeightmap(UBlueprintMCPLandscapeLibrary::FindEditorLandscape(Label), File, Layer);
}

// POST /api/landscape-import-heightmap  { file, landscape?, layer?, backupFile?, dryRun? }
FString FBlueprintMCPServer::HandleLandscapeImportHeightmap(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body.")); }
	FString File, Label, Layer, Backup;
	if (!Json->TryGetStringField(TEXT("file"), File) || File.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'file' (.r16 heightmap, uint16 little-endian, one value per vertex)."));
	}
	Json->TryGetStringField(TEXT("landscape"), Label);
	Json->TryGetStringField(TEXT("layer"), Layer);
	Json->TryGetStringField(TEXT("backupFile"), Backup);
	bool bDryRun = false;
	Json->TryGetBoolField(TEXT("dryRun"), bDryRun);
	return UBlueprintMCPLandscapeLibrary::ImportLandscapeHeightmap(UBlueprintMCPLandscapeLibrary::FindEditorLandscape(Label), File, Layer, Backup, bDryRun);
}
