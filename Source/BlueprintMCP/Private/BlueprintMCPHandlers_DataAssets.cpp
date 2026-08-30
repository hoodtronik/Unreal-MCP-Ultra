// Asset creation beyond Blueprints (github.com/mirno-ehf/ue5-mcp#26): DataTable, CurveTable,
// and generic DataAsset creation. Material creation was already done (PRs #49/#50); this covers
// the rest of that issue.

#include "BlueprintMCPServer.h"
#include "Engine/DataTable.h"
#include "Engine/CurveTable.h"
#include "Engine/DataAsset.h"
// UE 5.8 removed the Engine/UserDefinedStruct.h forwarding header. The real StructUtils path
// exists on both 5.6 and 5.8, so use the shared path instead of branching by engine version.
#include "StructUtils/UserDefinedStruct.h"
#include "Factories/DataTableFactory.h"
#include "Factories/CurveTableFactory.h"
#include "Factories/DataAssetFactory.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "UObject/UObjectIterator.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"

namespace
{
	bool SplitAssetPath(const FString& AssetPath, FString& OutPackagePath, FString& OutAssetName)
	{
		int32 LastSlash;
		if (!AssetPath.FindLastChar('/', LastSlash))
		{
			return false;
		}
		OutPackagePath = AssetPath.Left(LastSlash);
		OutAssetName = AssetPath.Mid(LastSlash + 1);
		return !OutAssetName.IsEmpty();
	}

	bool AssetAlreadyExists(const FString& AssetPath, const FString& AssetName)
	{
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		FAssetData Existing = ARM.Get().GetAssetByObjectPath(FSoftObjectPath(AssetPath + TEXT(".") + AssetName));
		return Existing.IsValid();
	}

	// Row structs for a DataTable can be a native C++ USTRUCT or a Blueprint UserDefinedStruct
	// (e.g. one made with create_struct) — check both, matching the resolution style already used
	// for pin type strings elsewhere in this file (BlueprintMCPServer.cpp's ResolveTypeFromString).
	UScriptStruct* FindRowStruct(const FString& StructName)
	{
		FString InternalName = StructName;
		if (InternalName.StartsWith(TEXT("F")))
		{
			InternalName = InternalName.Mid(1);
		}

		if (UScriptStruct* Found = FindFirstObject<UScriptStruct>(*InternalName))
		{
			return Found;
		}
		for (TObjectIterator<UScriptStruct> It; It; ++It)
		{
			if (It->GetName() == InternalName || It->GetName() == StructName)
			{
				return *It;
			}
		}
		return nullptr;
	}
}

// ============================================================
// HandleCreateDataTable — create a new DataTable asset
// ============================================================

FString FBlueprintMCPServer::HandleCreateDataTable(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString AssetPath = Json->GetStringField(TEXT("assetPath"));
	FString RowStructName = Json->GetStringField(TEXT("rowStruct"));
	if (AssetPath.IsEmpty() || RowStructName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: assetPath, rowStruct (e.g. rowStruct='FMyRow' or a UserDefinedStruct name)"), MCPErrorCodes::InvalidInput);
	}

	FString PackagePath, AssetName;
	if (!SplitAssetPath(AssetPath, PackagePath, AssetName))
	{
		return MakeErrorJson(TEXT("assetPath must be a full path (e.g. '/Game/Data/DT_Items')"), MCPErrorCodes::InvalidInput);
	}
	if (AssetAlreadyExists(AssetPath, AssetName))
	{
		return MakeErrorJson(FString::Printf(TEXT("Asset already exists at '%s'"), *AssetPath), MCPErrorCodes::AlreadyExists);
	}

	UScriptStruct* RowStruct = FindRowStruct(RowStructName);
	if (!RowStruct)
	{
		return MakeErrorJson(FString::Printf(TEXT("Row struct '%s' not found"), *RowStructName), MCPErrorCodes::NotFound);
	}

	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
	UDataTableFactory* Factory = NewObject<UDataTableFactory>();
	Factory->Struct = RowStruct;

	UObject* NewAsset = AssetToolsModule.Get().CreateAsset(AssetName, PackagePath, UDataTable::StaticClass(), Factory);
	if (!NewAsset)
	{
		return MakeErrorJson(TEXT("Failed to create DataTable asset"), MCPErrorCodes::OperationFailed);
	}

	const bool bSaved = SaveGenericPackage(NewAsset);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created DataTable '%s' with row struct '%s', save %s"),
		*AssetPath, *RowStructName, bSaved ? TEXT("OK") : TEXT("FAILED"));

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("assetPath"), NewAsset->GetPathName());
	Result->SetStringField(TEXT("rowStruct"), RowStruct->GetName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

// ============================================================
// HandleCreateCurveTable — create a new CurveTable asset
// ============================================================

FString FBlueprintMCPServer::HandleCreateCurveTable(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString AssetPath = Json->GetStringField(TEXT("assetPath"));
	if (AssetPath.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: assetPath (e.g. '/Game/Data/CT_DamageFalloff')"), MCPErrorCodes::InvalidInput);
	}

	FString PackagePath, AssetName;
	if (!SplitAssetPath(AssetPath, PackagePath, AssetName))
	{
		return MakeErrorJson(TEXT("assetPath must be a full path (e.g. '/Game/Data/CT_DamageFalloff')"), MCPErrorCodes::InvalidInput);
	}
	if (AssetAlreadyExists(AssetPath, AssetName))
	{
		return MakeErrorJson(FString::Printf(TEXT("Asset already exists at '%s'"), *AssetPath), MCPErrorCodes::AlreadyExists);
	}

	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
	UCurveTableFactory* Factory = NewObject<UCurveTableFactory>();

	UObject* NewAsset = AssetToolsModule.Get().CreateAsset(AssetName, PackagePath, UCurveTable::StaticClass(), Factory);
	if (!NewAsset)
	{
		return MakeErrorJson(TEXT("Failed to create CurveTable asset"), MCPErrorCodes::OperationFailed);
	}

	const bool bSaved = SaveGenericPackage(NewAsset);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created CurveTable '%s', save %s"),
		*AssetPath, bSaved ? TEXT("OK") : TEXT("FAILED"));

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("assetPath"), NewAsset->GetPathName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

// ============================================================
// HandleCreateDataAsset — create a new instance of a UDataAsset subclass
// ============================================================

FString FBlueprintMCPServer::HandleCreateDataAsset(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString AssetPath = Json->GetStringField(TEXT("assetPath"));
	FString DataAssetClassName = Json->GetStringField(TEXT("dataAssetClass"));
	if (AssetPath.IsEmpty() || DataAssetClassName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: assetPath, dataAssetClass (e.g. 'PrimaryDataAsset' or a Blueprint DataAsset class)"), MCPErrorCodes::InvalidInput);
	}

	FString PackagePath, AssetName;
	if (!SplitAssetPath(AssetPath, PackagePath, AssetName))
	{
		return MakeErrorJson(TEXT("assetPath must be a full path (e.g. '/Game/Data/DA_ItemConfig')"), MCPErrorCodes::InvalidInput);
	}
	if (AssetAlreadyExists(AssetPath, AssetName))
	{
		return MakeErrorJson(FString::Printf(TEXT("Asset already exists at '%s'"), *AssetPath), MCPErrorCodes::AlreadyExists);
	}

	UClass* DataAssetClass = FindClassByName(DataAssetClassName);
	if (!DataAssetClass)
	{
		return MakeErrorJson(FString::Printf(TEXT("Class '%s' not found"), *DataAssetClassName), MCPErrorCodes::NotFound);
	}
	if (!DataAssetClass->IsChildOf(UDataAsset::StaticClass()))
	{
		return MakeErrorJson(FString::Printf(TEXT("Class '%s' is not a UDataAsset subclass"), *DataAssetClassName), MCPErrorCodes::InvalidInput);
	}
	if (DataAssetClass->HasAnyClassFlags(CLASS_Abstract))
	{
		return MakeErrorJson(FString::Printf(TEXT("Class '%s' is abstract and can't be instantiated directly — use a concrete subclass"), *DataAssetClassName), MCPErrorCodes::InvalidInput);
	}

	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
	UDataAssetFactory* Factory = NewObject<UDataAssetFactory>();
	Factory->DataAssetClass = DataAssetClass;

	UObject* NewAsset = AssetToolsModule.Get().CreateAsset(AssetName, PackagePath, DataAssetClass, Factory);
	if (!NewAsset)
	{
		return MakeErrorJson(TEXT("Failed to create DataAsset — the class may require constructor arguments CreateAsset can't supply"), MCPErrorCodes::OperationFailed);
	}

	const bool bSaved = SaveGenericPackage(NewAsset);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created DataAsset '%s' of class '%s', save %s"),
		*AssetPath, *DataAssetClassName, bSaved ? TEXT("OK") : TEXT("FAILED"));

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("assetPath"), NewAsset->GetPathName());
	Result->SetStringField(TEXT("dataAssetClass"), DataAssetClass->GetName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}
