#include "BlueprintMCPServer.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Engine/Level.h"
#include "GameFramework/Actor.h"
#include "Components/PrimitiveComponent.h"
#include "Editor.h"
#include "Selection.h"
#include "UObject/UnrealType.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/Paths.h"
#include "Misc/PackageName.h"
#include "UObject/SavePackage.h"
#include "UObject/Package.h"
#include "LevelEditorSubsystem.h"
#include "FileHelpers.h"
#include "AssetRegistry/AssetRegistryModule.h"

// ============================================================
// FindActorByLabel — find an actor by its editor display label
// ============================================================

AActor* FBlueprintMCPServer::FindActorByLabel(UWorld* World, const FString& Label)
{
	if (!World) return nullptr;

	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if ((*It)->GetActorLabel().Equals(Label, ESearchCase::IgnoreCase))
		{
			return *It;
		}
	}
	return nullptr;
}

// ============================================================
// SaveLevelPackage — save the UWorld's .umap package to disk
// ============================================================

bool FBlueprintMCPServer::SaveLevelPackage(ULevel* Level)
{
	if (!Level || !Level->OwningWorld) return false;

	UWorld* World = Level->OwningWorld;
	UPackage* Package = World->GetPackage();
	if (!Package) return false;

	FString PackageFilename = FPackageName::LongPackageNameToFilename(
		Package->GetName(), FPackageName::GetMapPackageExtension());
	PackageFilename = FPaths::ConvertRelativePathToFull(PackageFilename);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: SaveLevelPackage — saving '%s'"), *PackageFilename);

	if (FPlatformFileManager::Get().GetPlatformFile().IsReadOnly(*PackageFilename))
	{
		FPlatformFileManager::Get().GetPlatformFile().SetReadOnly(*PackageFilename, false);
	}

	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	SaveArgs.SaveFlags = SAVE_NoError;

	FSavePackageResultStruct Result = UPackage::Save(Package, World, *PackageFilename, SaveArgs);
	const bool bSuccess = (Result.Result == ESavePackageResult::Success);
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: SaveLevelPackage — %s for '%s'"),
		bSuccess ? TEXT("SUCCEEDED") : TEXT("FAILED"), *World->GetMapName());
	return bSuccess;
}

// ============================================================
// HandleGetCurrentLevel — return info about the currently open level
// ============================================================

FString FBlueprintMCPServer::HandleGetCurrentLevel(const TMap<FString, FString>& Params, const FString&)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	int32 ActorCount = 0;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		++ActorCount;
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("levelName"), World->GetMapName());
	Result->SetStringField(TEXT("packageName"), World->GetPackage()->GetName());
	Result->SetNumberField(TEXT("actorCount"), ActorCount);

	return JsonToString(Result);
}

// ============================================================
// HandleGetSelectedActors — return actors currently selected in the editor
// ============================================================

FString FBlueprintMCPServer::HandleGetSelectedActors(const TMap<FString, FString>& Params, const FString&)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	USelection* Selection = GEditor->GetSelectedActors();
	if (!Selection)
	{
		return MakeErrorJson(TEXT("Could not retrieve editor actor selection"));
	}

	TArray<AActor*> SelectedActors;
	Selection->GetSelectedObjects<AActor>(SelectedActors);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: GetSelectedActors — %d actors selected"), SelectedActors.Num());

	TArray<TSharedPtr<FJsonValue>> ActorsArr;

	for (AActor* Actor : SelectedActors)
	{
		if (!Actor) continue;

		FVector  Loc   = Actor->GetActorLocation();
		FRotator Rot   = Actor->GetActorRotation();
		FVector  Scale = Actor->GetActorScale3D();

		TSharedRef<FJsonObject> LocObj = MakeShared<FJsonObject>();
		LocObj->SetNumberField(TEXT("x"), Loc.X);
		LocObj->SetNumberField(TEXT("y"), Loc.Y);
		LocObj->SetNumberField(TEXT("z"), Loc.Z);

		TSharedRef<FJsonObject> RotObj = MakeShared<FJsonObject>();
		RotObj->SetNumberField(TEXT("pitch"), Rot.Pitch);
		RotObj->SetNumberField(TEXT("yaw"),   Rot.Yaw);
		RotObj->SetNumberField(TEXT("roll"),  Rot.Roll);

		TSharedRef<FJsonObject> ScaleObj = MakeShared<FJsonObject>();
		ScaleObj->SetNumberField(TEXT("x"), Scale.X);
		ScaleObj->SetNumberField(TEXT("y"), Scale.Y);
		ScaleObj->SetNumberField(TEXT("z"), Scale.Z);

		TSharedRef<FJsonObject> ActorObj = MakeShared<FJsonObject>();
		ActorObj->SetStringField(TEXT("label"),  Actor->GetActorLabel());
		ActorObj->SetStringField(TEXT("class"),  Actor->GetClass()->GetName());
		ActorObj->SetStringField(TEXT("folder"), Actor->GetFolderPath().ToString());
		ActorObj->SetObjectField(TEXT("location"), LocObj);
		ActorObj->SetObjectField(TEXT("rotation"), RotObj);
		ActorObj->SetObjectField(TEXT("scale"),    ScaleObj);

		ActorsArr.Add(MakeShared<FJsonValueObject>(ActorObj));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("count"),  ActorsArr.Num());
	Result->SetArrayField (TEXT("actors"), ActorsArr);
	return JsonToString(Result);
}

// ============================================================
// HandleListActors — list actors in the current level with optional filters
// ============================================================

FString FBlueprintMCPServer::HandleListActors(const TMap<FString, FString>& Params, const FString&)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	const FString* ClassFilter = Params.Find(TEXT("classFilter"));
	const FString* NameFilter  = Params.Find(TEXT("nameFilter"));
	const FString* FolderFilter = Params.Find(TEXT("folder"));

	TArray<TSharedPtr<FJsonValue>> ActorsArr;

	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		if (!Actor) continue;

		FString Label     = Actor->GetActorLabel();
		FString ClassName = Actor->GetClass()->GetName();
		FString FolderPath = Actor->GetFolderPath().ToString();

		// Apply substring filters
		if (ClassFilter && !ClassFilter->IsEmpty())
		{
			if (!ClassName.Contains(*ClassFilter, ESearchCase::IgnoreCase))
				continue;
		}
		if (NameFilter && !NameFilter->IsEmpty())
		{
			if (!Label.Contains(*NameFilter, ESearchCase::IgnoreCase))
				continue;
		}
		if (FolderFilter && !FolderFilter->IsEmpty())
		{
			if (!FolderPath.StartsWith(*FolderFilter, ESearchCase::IgnoreCase))
				continue;
		}

		FVector Loc = Actor->GetActorLocation();

		TSharedRef<FJsonObject> LocObj = MakeShared<FJsonObject>();
		LocObj->SetNumberField(TEXT("x"), Loc.X);
		LocObj->SetNumberField(TEXT("y"), Loc.Y);
		LocObj->SetNumberField(TEXT("z"), Loc.Z);

		TSharedRef<FJsonObject> ActorObj = MakeShared<FJsonObject>();
		ActorObj->SetStringField(TEXT("label"), Label);
		ActorObj->SetStringField(TEXT("class"), ClassName);
		ActorObj->SetStringField(TEXT("folder"), FolderPath);
		ActorObj->SetObjectField(TEXT("location"), LocObj);

		ActorsArr.Add(MakeShared<FJsonValueObject>(ActorObj));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("level"), World->GetMapName());
	Result->SetNumberField(TEXT("count"), ActorsArr.Num());
	Result->SetArrayField(TEXT("actors"), ActorsArr);
	return JsonToString(Result);
}

// ============================================================
// ExportPropertyFields — export a single property into OutProps.
// Complex structs (>4 edit-able sub-fields) are expanded into
// individual entries so no sub-field is silently omitted.
// Each entry carries isDefault=true when the value matches the CDO.
// ============================================================

static void ExportPropertyFields(
	FProperty*                       Prop,
	void*                            ContainerData,   // actor or component ptr
	void*                            DefaultData,     // CDO ptr (may be nullptr)
	TArray<TSharedPtr<FJsonValue>>& OutProps,
	int32&                           PropCount,
	const int32                      MaxProps)
{
	if (!Prop || PropCount >= MaxProps) return;
	if (!Prop->HasAnyPropertyFlags(CPF_Edit)) return;

	void* PropAddr    = Prop->ContainerPtrToValuePtr<void>(ContainerData);
	void* DefaultAddr = DefaultData ? Prop->ContainerPtrToValuePtr<void>(DefaultData) : nullptr;

	// Is this property's value identical to the CDO?
	const bool bIsDefault = DefaultAddr && Prop->Identical(PropAddr, DefaultAddr, PPF_None);

	// Expand structs that have more than 4 editable sub-fields.
	// Small value types (FVector, FLinearColor, FRotator etc.) stay as blobs.
	if (FStructProperty* StructProp = CastField<FStructProperty>(Prop))
	{
		int32 EditableSubFields = 0;
		for (TFieldIterator<FProperty> It(StructProp->Struct); It; ++It)
		{
			if ((*It)->HasAnyPropertyFlags(CPF_Edit)) ++EditableSubFields;
		}

		if (EditableSubFields > 4)
		{
			// Use the CDO's struct data as the sub-field default reference.
			// If unavailable, default-initialize a scratch buffer.
			TArray<uint8> DefaultBuffer;
			void* StructDefaultData = DefaultAddr;
			if (!StructDefaultData)
			{
				DefaultBuffer.SetNumZeroed(StructProp->Struct->GetStructureSize());
				StructProp->Struct->InitializeStruct(DefaultBuffer.GetData());
				StructDefaultData = DefaultBuffer.GetData();
			}

			const FString StructFieldName = Prop->GetName();

			for (TFieldIterator<FProperty> SubIt(StructProp->Struct); SubIt; ++SubIt)
			{
				FProperty* SubProp = *SubIt;
				if (!SubProp || !SubProp->HasAnyPropertyFlags(CPF_Edit)) continue;
				if (PropCount >= MaxProps) break;

				void* SubAddr        = SubProp->ContainerPtrToValuePtr<void>(PropAddr);
				void* DefaultSubAddr = SubProp->ContainerPtrToValuePtr<void>(StructDefaultData);

				const bool bSubIsDefault = SubProp->Identical(SubAddr, DefaultSubAddr, PPF_None);

				// Always export the actual value (never pass default to ExportTextItem
				// so no sub-fields are silently skipped)
				FString SubValue;
				SubProp->ExportTextItem_Direct(SubValue, SubAddr, nullptr, nullptr, PPF_None);

				TSharedRef<FJsonObject> PropObj = MakeShared<FJsonObject>();
				PropObj->SetStringField(TEXT("name"),      SubProp->GetName());
				PropObj->SetStringField(TEXT("type"),      SubProp->GetCPPType());
				PropObj->SetStringField(TEXT("value"),     SubValue);
				PropObj->SetBoolField  (TEXT("isDefault"), bSubIsDefault);
				PropObj->SetStringField(TEXT("struct"),    StructFieldName);
				OutProps.Add(MakeShared<FJsonValueObject>(PropObj));
				++PropCount;
			}
			return; // struct fully expanded — do not emit the blob entry
		}
	}

	// Simple property or small struct — emit as a single entry
	FString Value;
	Prop->ExportTextItem_Direct(Value, PropAddr, nullptr, nullptr, PPF_None);

	TSharedRef<FJsonObject> PropObj = MakeShared<FJsonObject>();
	PropObj->SetStringField(TEXT("name"),      Prop->GetName());
	PropObj->SetStringField(TEXT("type"),      Prop->GetCPPType());
	PropObj->SetStringField(TEXT("value"),     Value);
	PropObj->SetBoolField  (TEXT("isDefault"), bIsDefault);
	OutProps.Add(MakeShared<FJsonValueObject>(PropObj));
	++PropCount;
}

// ============================================================
// HandleGetActorProperties — get CPF_Edit properties of a named actor
// ============================================================

FString FBlueprintMCPServer::HandleGetActorProperties(const TMap<FString, FString>& Params, const FString&)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	const FString* LabelPtr = Params.Find(TEXT("label"));
	if (!LabelPtr || LabelPtr->IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required parameter: label"));
	}

	AActor* Actor = FindActorByLabel(World, *LabelPtr);
	if (!Actor)
	{
		return MakeErrorJson(FString::Printf(TEXT("Actor with label '%s' not found"), **LabelPtr));
	}

	const int32 MaxProps = 1000;

	// Gather all components for discovery (always included in response)
	TArray<UActorComponent*> AllComponents;
	Actor->GetComponents(AllComponents);

	TArray<TSharedPtr<FJsonValue>> CompArr;
	for (UActorComponent* Comp : AllComponents)
	{
		if (!Comp) continue;
		TSharedRef<FJsonObject> CompObj = MakeShared<FJsonObject>();
		CompObj->SetStringField(TEXT("name"), Comp->GetName());
		CompObj->SetStringField(TEXT("class"), Comp->GetClass()->GetName());
		CompArr.Add(MakeShared<FJsonValueObject>(CompObj));
	}

	// If 'component' param is given, list that component's properties instead
	const FString* ComponentPtr = Params.Find(TEXT("component"));
	if (ComponentPtr && !ComponentPtr->IsEmpty())
	{
		UActorComponent* TargetComp = nullptr;
		for (UActorComponent* Comp : AllComponents)
		{
			if (Comp && Comp->GetName().Equals(*ComponentPtr, ESearchCase::IgnoreCase))
			{
				TargetComp = Comp;
				break;
			}
		}
		if (!TargetComp)
		{
			return MakeErrorJson(FString::Printf(
				TEXT("Component '%s' not found on actor '%s'. Available components: see get_actor_properties without 'component' param."),
				**ComponentPtr, **LabelPtr));
		}

		void* CompCDO = TargetComp->GetClass()->GetDefaultObject();

		TArray<TSharedPtr<FJsonValue>> PropsArr;
		int32 PropCount = 0;
		for (TFieldIterator<FProperty> PropIt(TargetComp->GetClass()); PropIt; ++PropIt)
		{
			ExportPropertyFields(*PropIt, TargetComp, CompCDO, PropsArr, PropCount, MaxProps);
		}

		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("label"),     *LabelPtr);
		Result->SetStringField(TEXT("component"), *ComponentPtr);
		Result->SetStringField(TEXT("class"),     TargetComp->GetClass()->GetName());
		Result->SetNumberField(TEXT("count"),     PropsArr.Num());
		Result->SetArrayField (TEXT("properties"), PropsArr);
		return JsonToString(Result);
	}

	// Default: list actor-level properties + component list for discovery
	void* ActorCDO = Actor->GetClass()->GetDefaultObject();

	TArray<TSharedPtr<FJsonValue>> PropsArr;
	int32 PropCount = 0;
	for (TFieldIterator<FProperty> PropIt(Actor->GetClass()); PropIt; ++PropIt)
	{
		ExportPropertyFields(*PropIt, Actor, ActorCDO, PropsArr, PropCount, MaxProps);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("label"),      *LabelPtr);
	Result->SetStringField(TEXT("class"),      Actor->GetClass()->GetName());
	Result->SetNumberField(TEXT("count"),      PropsArr.Num());
	Result->SetArrayField (TEXT("properties"), PropsArr);
	Result->SetArrayField (TEXT("components"), CompArr);
	return JsonToString(Result);
}

// ============================================================
// HandleSetActorTransform — move/rotate/scale an actor in the level
// ============================================================

FString FBlueprintMCPServer::HandleSetActorTransform(const TMap<FString, FString>&, const FString& Body)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString Label = Json->GetStringField(TEXT("label"));
	if (Label.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: label"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	AActor* Actor = FindActorByLabel(World, Label);
	if (!Actor)
	{
		return MakeErrorJson(FString::Printf(TEXT("Actor with label '%s' not found"), *Label));
	}

	Actor->Modify();

	bool bMoved = false;

	if (Json->HasField(TEXT("location")))
	{
		TSharedPtr<FJsonObject> LocObj = Json->GetObjectField(TEXT("location"));
		if (LocObj.IsValid())
		{
			FVector NewLocation = Actor->GetActorLocation();
			if (LocObj->HasField(TEXT("x"))) NewLocation.X = LocObj->GetNumberField(TEXT("x"));
			if (LocObj->HasField(TEXT("y"))) NewLocation.Y = LocObj->GetNumberField(TEXT("y"));
			if (LocObj->HasField(TEXT("z"))) NewLocation.Z = LocObj->GetNumberField(TEXT("z"));
			Actor->SetActorLocation(NewLocation, false, nullptr, ETeleportType::TeleportPhysics);
			bMoved = true;
		}
	}

	if (Json->HasField(TEXT("rotation")))
	{
		TSharedPtr<FJsonObject> RotObj = Json->GetObjectField(TEXT("rotation"));
		if (RotObj.IsValid())
		{
			FRotator NewRotation = Actor->GetActorRotation();
			if (RotObj->HasField(TEXT("pitch"))) NewRotation.Pitch = RotObj->GetNumberField(TEXT("pitch"));
			if (RotObj->HasField(TEXT("yaw")))   NewRotation.Yaw   = RotObj->GetNumberField(TEXT("yaw"));
			if (RotObj->HasField(TEXT("roll")))  NewRotation.Roll  = RotObj->GetNumberField(TEXT("roll"));
			Actor->SetActorRotation(NewRotation, ETeleportType::TeleportPhysics);
			bMoved = true;
		}
	}

	if (Json->HasField(TEXT("scale")))
	{
		TSharedPtr<FJsonObject> ScaleObj = Json->GetObjectField(TEXT("scale"));
		if (ScaleObj.IsValid())
		{
			FVector NewScale = Actor->GetActorScale3D();
			if (ScaleObj->HasField(TEXT("x"))) NewScale.X = ScaleObj->GetNumberField(TEXT("x"));
			if (ScaleObj->HasField(TEXT("y"))) NewScale.Y = ScaleObj->GetNumberField(TEXT("y"));
			if (ScaleObj->HasField(TEXT("z"))) NewScale.Z = ScaleObj->GetNumberField(TEXT("z"));
			Actor->SetActorScale3D(NewScale);
			bMoved = true;
		}
	}

	if (bMoved)
	{
		Actor->PostEditMove(true);
		Actor->MarkPackageDirty();
		GEditor->RedrawAllViewports(true);
	}

	FVector Loc   = Actor->GetActorLocation();
	FRotator Rot  = Actor->GetActorRotation();
	FVector Scale = Actor->GetActorScale3D();

	TSharedRef<FJsonObject> LocResult = MakeShared<FJsonObject>();
	LocResult->SetNumberField(TEXT("x"), Loc.X);
	LocResult->SetNumberField(TEXT("y"), Loc.Y);
	LocResult->SetNumberField(TEXT("z"), Loc.Z);

	TSharedRef<FJsonObject> RotResult = MakeShared<FJsonObject>();
	RotResult->SetNumberField(TEXT("pitch"), Rot.Pitch);
	RotResult->SetNumberField(TEXT("yaw"),   Rot.Yaw);
	RotResult->SetNumberField(TEXT("roll"),  Rot.Roll);

	TSharedRef<FJsonObject> ScaleResult = MakeShared<FJsonObject>();
	ScaleResult->SetNumberField(TEXT("x"), Scale.X);
	ScaleResult->SetNumberField(TEXT("y"), Scale.Y);
	ScaleResult->SetNumberField(TEXT("z"), Scale.Z);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("label"), Label);
	Result->SetObjectField(TEXT("location"), LocResult);
	Result->SetObjectField(TEXT("rotation"), RotResult);
	Result->SetObjectField(TEXT("scale"), ScaleResult);
	return JsonToString(Result);
}

// ============================================================
// HandleSetActorProperty — set a named property on a level actor via reflection
// ============================================================

FString FBlueprintMCPServer::HandleSetActorProperty(const TMap<FString, FString>&, const FString& Body)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString Label         = Json->GetStringField(TEXT("label"));
	FString PropertyName  = Json->GetStringField(TEXT("property"));
	FString PropertyValue = Json->GetStringField(TEXT("value"));

	if (Label.IsEmpty() || PropertyName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: label, property"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	AActor* Actor = FindActorByLabel(World, Label);
	if (!Actor)
	{
		return MakeErrorJson(FString::Printf(TEXT("Actor with label '%s' not found"), *Label));
	}

	// Support "ComponentName.PropertyName" syntax for component sub-properties
	FString ComponentName, ActualPropertyName;
	const bool bIsComponentProp = PropertyName.Split(TEXT("."), &ComponentName, &ActualPropertyName);

	if (bIsComponentProp)
	{
		// Find the named component on the actor
		TArray<UActorComponent*> Components;
		Actor->GetComponents(Components);

		UActorComponent* TargetComp = nullptr;
		for (UActorComponent* Comp : Components)
		{
			if (Comp && Comp->GetName().Equals(ComponentName, ESearchCase::IgnoreCase))
			{
				TargetComp = Comp;
				break;
			}
		}

		// CLAUDE-NOTE: fall back to matching by component CLASS. UE suffixes default subobject
		// instances with an index, so a freshly spawned AStaticMeshActor carries a component named
		// "StaticMeshComponent0" — meaning the obvious
		// set_actor_property(label, "StaticMeshComponent.StaticMesh", ...) failed, and there was no
		// way to discover the "0" short of calling get_actor_properties first. Since the whole point
		// of the dotted syntax is to address a component by what it IS, resolve by class when the
		// literal name misses. Ambiguity is reported rather than guessed at.
		if (!TargetComp)
		{
			TArray<UActorComponent*> ClassMatches;
			for (UActorComponent* Comp : Components)
			{
				if (Comp && Comp->GetClass()->GetName().Equals(ComponentName, ESearchCase::IgnoreCase))
				{
					ClassMatches.Add(Comp);
				}
			}
			if (ClassMatches.Num() == 1)
			{
				TargetComp = ClassMatches[0];
			}
			else if (ClassMatches.Num() > 1)
			{
				TArray<FString> Names;
				for (UActorComponent* Comp : ClassMatches) { Names.Add(Comp->GetName()); }
				return MakeErrorJson(FString::Printf(
					TEXT("Actor '%s' has %d components of class '%s' (%s). Name the one you mean."),
					*Label, ClassMatches.Num(), *ComponentName, *FString::Join(Names, TEXT(", "))));
			}
		}

		if (!TargetComp)
		{
			TArray<FString> Available;
			for (UActorComponent* Comp : Components)
			{
				if (Comp)
				{
					Available.Add(FString::Printf(TEXT("%s (%s)"), *Comp->GetName(), *Comp->GetClass()->GetName()));
				}
			}
			return MakeErrorJson(FString::Printf(
				TEXT("Component '%s' not found on actor '%s'. Available: %s."),
				*ComponentName, *Label,
				Available.Num() > 0 ? *FString::Join(Available, TEXT(", ")) : TEXT("none")));
		}

		FProperty* Prop = FindFProperty<FProperty>(TargetComp->GetClass(), *ActualPropertyName);
		if (!Prop)
		{
			return MakeErrorJson(FString::Printf(
				TEXT("Property '%s' not found on component '%s' (%s). Use get_actor_properties(label, component) to list component properties."),
				*ActualPropertyName, *ComponentName, *TargetComp->GetClass()->GetName()));
		}

		TargetComp->Modify();

		void* PropAddr = Prop->ContainerPtrToValuePtr<void>(TargetComp);
		const TCHAR* ImportResult = Prop->ImportText_Direct(*PropertyValue, PropAddr, TargetComp, 0);
		if (!ImportResult)
		{
			return MakeErrorJson(FString::Printf(
				TEXT("Failed to set property '%s' to '%s' — value incompatible with type '%s'"),
				*ActualPropertyName, *PropertyValue, *Prop->GetCPPType()));
		}

		FPropertyChangedEvent ChangedEvent(Prop);
		TargetComp->PostEditChangeProperty(ChangedEvent);

		// Force render state update so the change is visible in the viewport immediately
		if (UPrimitiveComponent* PrimComp = Cast<UPrimitiveComponent>(TargetComp))
		{
			PrimComp->MarkRenderStateDirty();
		}
		TargetComp->ReregisterComponent();
		Actor->MarkPackageDirty();
		GEditor->RedrawAllViewports(true);

		FString ExportedValue;
		Prop->ExportTextItem_Direct(ExportedValue, PropAddr, nullptr, TargetComp, PPF_None);

		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("success"), true);
		Result->SetStringField(TEXT("label"), Label);
		Result->SetStringField(TEXT("component"), ComponentName);
		Result->SetStringField(TEXT("property"), ActualPropertyName);
		Result->SetStringField(TEXT("value"), ExportedValue);
		return JsonToString(Result);
	}

	// Actor-level property (no dot in property name)
	FProperty* Prop = FindFProperty<FProperty>(Actor->GetClass(), *PropertyName);
	if (!Prop)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Property '%s' not found on class '%s'. For component properties use 'ComponentName.PropertyName' (e.g. 'StaticMeshComponent0.StaticMesh')."),
			*PropertyName, *Actor->GetClass()->GetName()));
	}

	Actor->Modify();

	void* PropAddr = Prop->ContainerPtrToValuePtr<void>(Actor);
	const TCHAR* ImportResult = Prop->ImportText_Direct(*PropertyValue, PropAddr, Actor, 0);
	if (!ImportResult)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Failed to set property '%s' to '%s' — value incompatible with type '%s'"),
			*PropertyName, *PropertyValue, *Prop->GetCPPType()));
	}

	FPropertyChangedEvent ChangedEvent(Prop);
	Actor->PostEditChangeProperty(ChangedEvent);
	Actor->MarkPackageDirty();

	// Read back the exported value to confirm the write
	FString ExportedValue;
	Prop->ExportTextItem_Direct(ExportedValue, PropAddr, nullptr, Actor, PPF_None);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("label"), Label);
	Result->SetStringField(TEXT("property"), PropertyName);
	Result->SetStringField(TEXT("value"), ExportedValue);
	return JsonToString(Result);
}

// ============================================================
// HandleSpawnActor — spawn a new actor in the current level
// ============================================================

FString FBlueprintMCPServer::HandleSpawnActor(const TMap<FString, FString>&, const FString& Body)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString ClassName = Json->GetStringField(TEXT("class"));
	if (ClassName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: class"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	// Resolve the actor class — try exact name, then without "A" prefix
	UClass* ActorClass = FindClassByName(ClassName);
	if (!ActorClass && ClassName.StartsWith(TEXT("A")) && ClassName.Len() > 1)
	{
		ActorClass = FindClassByName(ClassName.Mid(1));
	}
	if (!ActorClass)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Class '%s' not found. Use the class name without prefix, e.g. 'StaticMeshActor', 'DirectionalLight', 'PointLight'"),
			*ClassName));
	}

	if (!ActorClass->IsChildOf(AActor::StaticClass()))
	{
		return MakeErrorJson(FString::Printf(TEXT("Class '%s' is not an Actor class"), *ActorClass->GetName()));
	}

	// Build spawn location
	FVector Location = FVector::ZeroVector;
	if (Json->HasField(TEXT("location")))
	{
		TSharedPtr<FJsonObject> LocObj = Json->GetObjectField(TEXT("location"));
		if (LocObj.IsValid())
		{
			if (LocObj->HasField(TEXT("x"))) Location.X = LocObj->GetNumberField(TEXT("x"));
			if (LocObj->HasField(TEXT("y"))) Location.Y = LocObj->GetNumberField(TEXT("y"));
			if (LocObj->HasField(TEXT("z"))) Location.Z = LocObj->GetNumberField(TEXT("z"));
		}
	}

	// Build spawn rotation
	FRotator Rotation = FRotator::ZeroRotator;
	if (Json->HasField(TEXT("rotation")))
	{
		TSharedPtr<FJsonObject> RotObj = Json->GetObjectField(TEXT("rotation"));
		if (RotObj.IsValid())
		{
			if (RotObj->HasField(TEXT("pitch"))) Rotation.Pitch = RotObj->GetNumberField(TEXT("pitch"));
			if (RotObj->HasField(TEXT("yaw")))   Rotation.Yaw   = RotObj->GetNumberField(TEXT("yaw"));
			if (RotObj->HasField(TEXT("roll")))  Rotation.Roll  = RotObj->GetNumberField(TEXT("roll"));
		}
	}

	FActorSpawnParameters SpawnParams;
	SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	AActor* NewActor = World->SpawnActor<AActor>(ActorClass, Location, Rotation, SpawnParams);
	if (!NewActor)
	{
		return MakeErrorJson(FString::Printf(TEXT("Failed to spawn actor of class '%s'"), *ActorClass->GetName()));
	}

	// Set label if provided
	FString Label;
	if (Json->HasField(TEXT("label")) && !Json->GetStringField(TEXT("label")).IsEmpty())
	{
		Label = Json->GetStringField(TEXT("label"));
		NewActor->SetActorLabel(Label);
	}
	else
	{
		Label = NewActor->GetActorLabel();
	}

	// Set outliner folder if provided
	if (Json->HasField(TEXT("folder")) && !Json->GetStringField(TEXT("folder")).IsEmpty())
	{
		NewActor->SetFolderPath(FName(*Json->GetStringField(TEXT("folder"))));
	}

	NewActor->MarkPackageDirty();

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Spawned actor '%s' (%s) at (%.1f, %.1f, %.1f)"),
		*Label, *ActorClass->GetName(), Location.X, Location.Y, Location.Z);

	TSharedRef<FJsonObject> LocResult = MakeShared<FJsonObject>();
	LocResult->SetNumberField(TEXT("x"), Location.X);
	LocResult->SetNumberField(TEXT("y"), Location.Y);
	LocResult->SetNumberField(TEXT("z"), Location.Z);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("label"), Label);
	Result->SetStringField(TEXT("class"), ActorClass->GetName());
	Result->SetObjectField(TEXT("location"), LocResult);
	return JsonToString(Result);
}

// ============================================================
// HandleDeleteActor — delete a named actor from the current level
// ============================================================

FString FBlueprintMCPServer::HandleDeleteActor(const TMap<FString, FString>&, const FString& Body)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("GEditor not available — not running in editor mode"));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString Label = Json->GetStringField(TEXT("label"));
	if (Label.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: label"));
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available"));
	}

	AActor* Actor = FindActorByLabel(World, Label);
	if (!Actor)
	{
		return MakeErrorJson(FString::Printf(TEXT("Actor with label '%s' not found"), *Label));
	}

	FString ActorClass = Actor->GetClass()->GetName();

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Deleting actor '%s' (%s)"), *Label, *ActorClass);

	Actor->Modify();
	const bool bDestroyed = World->DestroyActor(Actor, false, true);
	if (!bDestroyed)
	{
		return MakeErrorJson(FString::Printf(TEXT("Failed to destroy actor '%s'"), *Label));
	}

	if (World->GetCurrentLevel())
	{
		World->GetCurrentLevel()->MarkPackageDirty();
	}

	GEditor->RedrawAllViewports(true);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("label"), Label);
	Result->SetStringField(TEXT("class"), ActorClass);
	return JsonToString(Result);
}

// ============================================================
// Level open / create
// ============================================================
// CLAUDE-NOTE: before these, the MCP could inspect the current level and manage sublevels but had
// no way to SWITCH levels or make a new one â€” an agent was stuck with whatever map happened to be
// open when the editor started, which makes any level-authoring or lighting workflow a dead end.
//
// Both go through ULevelEditorSubsystem, which wraps its work in
// TGuardValue<bool>(GIsRunningUnattendedScript, true). That is what makes them safe to call from an
// MCP request at all: without it UE would raise a modal "save these assets?" dialog, which would
// block the HTTP handler on the game thread and freeze the whole editor with no way out.
//
// The flip side is that the same guard makes unsaved changes disappear SILENTLY. So these refuse to
// run while packages are dirty unless the caller explicitly says what to do about it â€” losing an
// hour of someone's unsaved level work because an agent decided to look at a different map is not
// an acceptable default.

namespace
{
	/** Collect dirty package names, so the refusal can name them. */
	TArray<FString> GetDirtyPackageNames()
	{
		TArray<UPackage*> DirtyPackages;
		FEditorFileUtils::GetDirtyPackages(DirtyPackages);
		TArray<FString> Names;
		for (UPackage* Package : DirtyPackages)
		{
			if (Package)
			{
				Names.Add(Package->GetName());
			}
		}
		Names.Sort();
		return Names;
	}
}

FString FBlueprintMCPServer::ResolveMapAssetPath(const FString& NameOrPath) const
{
	// An explicit package path is taken at face value.
	if (NameOrPath.StartsWith(TEXT("/")))
	{
		return NameOrPath;
	}
	for (const FAssetData& Asset : AllMapAssets)
	{
		if (Asset.AssetName.ToString().Equals(NameOrPath, ESearchCase::IgnoreCase))
		{
			return Asset.PackageName.ToString();
		}
	}
	return FString();
}

FString FBlueprintMCPServer::HandleOpenLevel(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString Level;
	if (!Json->TryGetStringField(TEXT("level"), Level) || Level.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: level"), MCPErrorCodes::InvalidInput);
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("open_level requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	if (GEditor->PlayWorld)
	{
		return MakeErrorJson(
			TEXT("Cannot change level while Play In Editor is running. Call stop_pie first."),
			MCPErrorCodes::OperationFailed);
	}

	const FString AssetPath = ResolveMapAssetPath(Level);
	if (AssetPath.IsEmpty())
	{
		return MakeErrorJson(
			FString::Printf(TEXT("No level named '%s' found. Pass a full package path like ")
				TEXT("'/Game/Maps/MyLevel', or a map asset name that exists in the project."), *Level),
			MCPErrorCodes::NotFound);
	}

	bool bSaveFirst = false;
	bool bDiscardUnsaved = false;
	Json->TryGetBoolField(TEXT("saveFirst"), bSaveFirst);
	Json->TryGetBoolField(TEXT("discardUnsaved"), bDiscardUnsaved);

	TArray<FString> Dirty = GetDirtyPackageNames();
	TArray<FString> Saved;
	if (Dirty.Num() > 0)
	{
		if (bSaveFirst)
		{
			FEditorFileUtils::SaveDirtyPackages(
				/*bPromptUserToSave=*/false, /*bSaveMapPackages=*/true, /*bSaveContentPackages=*/true);
			Saved = Dirty;
			Dirty = GetDirtyPackageNames();
		}
		else if (!bDiscardUnsaved)
		{
			return MakeErrorJson(
				FString::Printf(
					TEXT("%d unsaved package(s) would be silently discarded by switching level: %s. ")
					TEXT("Pass saveFirst=true to save them, or discardUnsaved=true to throw them away."),
					Dirty.Num(), *FString::Join(Dirty, TEXT(", "))),
				MCPErrorCodes::OperationFailed);
		}
	}

	ULevelEditorSubsystem* LevelSubsystem = GEditor->GetEditorSubsystem<ULevelEditorSubsystem>();
	if (!LevelSubsystem)
	{
		return MakeErrorJson(TEXT("LevelEditorSubsystem unavailable."), MCPErrorCodes::OperationFailed);
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: open_level('%s')"), *AssetPath);

	if (!LevelSubsystem->LoadLevel(AssetPath))
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Failed to load level '%s'. It may be corrupt or from an incompatible engine version."), *AssetPath),
			MCPErrorCodes::OperationFailed);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("level"), AssetPath);

	if (UWorld* World = GEditor->GetEditorWorldContext().World())
	{
		Result->SetStringField(TEXT("currentLevel"), World->GetMapName());
		int32 ActorCount = 0;
		for (ULevel* Lvl : World->GetLevels())
		{
			if (Lvl) { ActorCount += Lvl->Actors.Num(); }
		}
		Result->SetNumberField(TEXT("actorCount"), ActorCount);
	}

	if (Saved.Num() > 0)
	{
		TArray<TSharedPtr<FJsonValue>> SavedArr;
		for (const FString& S : Saved) { SavedArr.Add(MakeShared<FJsonValueString>(S)); }
		Result->SetArrayField(TEXT("savedBeforeSwitch"), SavedArr);
	}
	if (bDiscardUnsaved && Dirty.Num() > 0)
	{
		TArray<TSharedPtr<FJsonValue>> DiscardedArr;
		for (const FString& D : Dirty) { DiscardedArr.Add(MakeShared<FJsonValueString>(D)); }
		Result->SetArrayField(TEXT("discarded"), DiscardedArr);
	}

	return JsonToString(Result);
}

FString FBlueprintMCPServer::HandleNewLevel(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString AssetPath;
	if (!Json->TryGetStringField(TEXT("path"), AssetPath) || AssetPath.IsEmpty())
	{
		return MakeErrorJson(
			TEXT("Missing required field: path (e.g. '/Game/Maps/MyNewLevel')"),
			MCPErrorCodes::InvalidInput);
	}
	if (!AssetPath.StartsWith(TEXT("/")))
	{
		return MakeErrorJson(
			FString::Printf(TEXT("path must be a full package path starting with '/', got '%s'."), *AssetPath),
			MCPErrorCodes::InvalidInput);
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("new_level requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	if (GEditor->PlayWorld)
	{
		return MakeErrorJson(
			TEXT("Cannot create a level while Play In Editor is running. Call stop_pie first."),
			MCPErrorCodes::OperationFailed);
	}

	bool bSaveFirst = false;
	bool bDiscardUnsaved = false;
	bool bPartitioned = false;
	Json->TryGetBoolField(TEXT("saveFirst"), bSaveFirst);
	Json->TryGetBoolField(TEXT("discardUnsaved"), bDiscardUnsaved);
	Json->TryGetBoolField(TEXT("worldPartition"), bPartitioned);

	TArray<FString> Dirty = GetDirtyPackageNames();
	TArray<FString> Saved;
	if (Dirty.Num() > 0)
	{
		if (bSaveFirst)
		{
			FEditorFileUtils::SaveDirtyPackages(false, true, true);
			Saved = Dirty;
			Dirty = GetDirtyPackageNames();
		}
		else if (!bDiscardUnsaved)
		{
			return MakeErrorJson(
				FString::Printf(
					TEXT("%d unsaved package(s) would be silently discarded by creating a new level: %s. ")
					TEXT("Pass saveFirst=true to save them, or discardUnsaved=true to throw them away."),
					Dirty.Num(), *FString::Join(Dirty, TEXT(", "))),
				MCPErrorCodes::OperationFailed);
		}
	}

	ULevelEditorSubsystem* LevelSubsystem = GEditor->GetEditorSubsystem<ULevelEditorSubsystem>();
	if (!LevelSubsystem)
	{
		return MakeErrorJson(TEXT("LevelEditorSubsystem unavailable."), MCPErrorCodes::OperationFailed);
	}

	FString Template;
	Json->TryGetStringField(TEXT("template"), Template);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: new_level('%s', template='%s')"), *AssetPath, *Template);

	const bool bOk = Template.IsEmpty()
		? LevelSubsystem->NewLevel(AssetPath, bPartitioned)
		: LevelSubsystem->NewLevelFromTemplate(AssetPath, Template);

	if (!bOk)
	{
		return MakeErrorJson(
			FString::Printf(
				TEXT("Failed to create level at '%s'%s. The path may already exist or its directory may not be writable."),
				*AssetPath,
				Template.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" from template '%s'"), *Template)),
			MCPErrorCodes::OperationFailed);
	}

	// Keep the cached map list current so the new level is immediately resolvable by name.
	FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	ARM.Get().GetAssetsByClass(UWorld::StaticClass()->GetClassPathName(), AllMapAssets, false);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("path"), AssetPath);
	Result->SetBoolField(TEXT("worldPartition"), bPartitioned);
	if (!Template.IsEmpty())
	{
		Result->SetStringField(TEXT("template"), Template);
	}
	if (UWorld* World = GEditor->GetEditorWorldContext().World())
	{
		Result->SetStringField(TEXT("currentLevel"), World->GetMapName());
	}
	if (Saved.Num() > 0)
	{
		TArray<TSharedPtr<FJsonValue>> SavedArr;
		for (const FString& S : Saved) { SavedArr.Add(MakeShared<FJsonValueString>(S)); }
		Result->SetArrayField(TEXT("savedBeforeSwitch"), SavedArr);
	}

	return JsonToString(Result);
}

