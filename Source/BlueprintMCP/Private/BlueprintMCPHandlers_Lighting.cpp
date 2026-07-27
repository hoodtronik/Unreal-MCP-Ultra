#include "BlueprintMCPServer.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Engine/Light.h"
#include "Engine/DirectionalLight.h"
#include "Engine/PointLight.h"
#include "Engine/SpotLight.h"
#include "Engine/RectLight.h"
#include "Engine/SkyLight.h"
#include "Components/LightComponent.h"
#include "Components/LightComponentBase.h"
#include "Components/LocalLightComponent.h"
#include "Components/PointLightComponent.h"
#include "Components/SpotLightComponent.h"
#include "Components/RectLightComponent.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Engine/EngineTypes.h"
#include "HAL/IConsoleManager.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"

// ============================================================
// Lighting handlers
// ============================================================
// CLAUDE-NOTE: every property touched here was already reachable through the generic
// set_actor_property, which supports "ComponentName.PropertyName" syntax and ImportText_Direct.
// These tools exist because reachable is not the same as usable: the generic path requires knowing
// the exact UPROPERTY name, which component carries it (lights keep almost everything on the light
// COMPONENT, not the actor), and what units it is in — with no discovery and no validation. The
// three concrete things a typed layer buys that the generic path structurally cannot:
//   1. list_lights — there was no way at all to enumerate a level's lighting. list_actors returns
//      names and classes only, so "look at my lighting and fix it" had no entry point.
//   2. Mobility-correct writes — the engine's Set* light functions are runtime APIs that silently
//      no-op on Static (and, for radius/cone, Stationary) lights. See the long note in
//      ApplyLightProperties. Getting this right requires knowing which writes the setters refuse.
//   3. SkyLight recapture — a sky light does not update from a property change alone. Forgetting
//      RecaptureSky() is the single most common "why is my sky lighting wrong" mistake, and a
//      generic property setter has no way to know it is needed.

namespace
{
	/** Lights split across two unrelated actor hierarchies: ALight, and ASkyLight (an AInfo). */
	ULightComponentBase* GetLightComponentBase(AActor* Actor)
	{
		if (ALight* Light = Cast<ALight>(Actor))
		{
			return Light->GetLightComponent();
		}
		if (ASkyLight* SkyLight = Cast<ASkyLight>(Actor))
		{
			return SkyLight->GetLightComponent();
		}
		return nullptr;
	}

	bool IsLightActor(AActor* Actor)
	{
		return Actor && (Actor->IsA<ALight>() || Actor->IsA<ASkyLight>());
	}

	FString LightTypeName(AActor* Actor)
	{
		if (Actor->IsA<ADirectionalLight>()) return TEXT("directional");
		if (Actor->IsA<ASpotLight>())        return TEXT("spot");   // before point: ASpotLight is a APointLight
		if (Actor->IsA<ARectLight>())        return TEXT("rect");
		if (Actor->IsA<APointLight>())       return TEXT("point");
		if (Actor->IsA<ASkyLight>())         return TEXT("sky");
		return TEXT("other");
	}

	FString MobilityToString(EComponentMobility::Type Mobility)
	{
		switch (Mobility)
		{
		case EComponentMobility::Static:     return TEXT("static");
		case EComponentMobility::Stationary: return TEXT("stationary");
		case EComponentMobility::Movable:    return TEXT("movable");
		default:                             return TEXT("unknown");
		}
	}

	bool ParseMobility(const FString& In, EComponentMobility::Type& Out)
	{
		const FString Lower = In.ToLower();
		if (Lower == TEXT("static"))     { Out = EComponentMobility::Static;     return true; }
		if (Lower == TEXT("stationary")) { Out = EComponentMobility::Stationary; return true; }
		if (Lower == TEXT("movable"))    { Out = EComponentMobility::Movable;    return true; }
		return false;
	}

	FString LightUnitsToString(ELightUnits Units)
	{
		switch (Units)
		{
		case ELightUnits::Unitless: return TEXT("unitless");
		case ELightUnits::Candelas: return TEXT("candelas");
		case ELightUnits::Lumens:   return TEXT("lumens");
		case ELightUnits::EV:       return TEXT("ev");
		case ELightUnits::Nits:     return TEXT("nits");
		default:                    return TEXT("unknown");
		}
	}

	bool ParseLightUnits(const FString& In, ELightUnits& Out)
	{
		const FString Lower = In.ToLower();
		if (Lower == TEXT("unitless")) { Out = ELightUnits::Unitless; return true; }
		if (Lower == TEXT("candelas")) { Out = ELightUnits::Candelas; return true; }
		if (Lower == TEXT("lumens"))   { Out = ELightUnits::Lumens;   return true; }
		if (Lower == TEXT("ev"))       { Out = ELightUnits::EV;       return true; }
		if (Lower == TEXT("nits"))     { Out = ELightUnits::Nits;     return true; }
		return false;
	}

	/** Serialize one light. bDetailed adds the type-specific block. */
	void WriteLightJson(AActor* Actor, const TSharedRef<FJsonObject>& Out, bool bDetailed)
	{
		ULightComponentBase* Base = GetLightComponentBase(Actor);
		const FString Type = LightTypeName(Actor);

		Out->SetStringField(TEXT("label"), Actor->GetActorLabel());
		Out->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
		Out->SetStringField(TEXT("type"), Type);

		const FVector Loc = Actor->GetActorLocation();
		TSharedRef<FJsonObject> LocObj = MakeShared<FJsonObject>();
		LocObj->SetNumberField(TEXT("x"), Loc.X);
		LocObj->SetNumberField(TEXT("y"), Loc.Y);
		LocObj->SetNumberField(TEXT("z"), Loc.Z);
		Out->SetObjectField(TEXT("location"), LocObj);

		const FRotator Rot = Actor->GetActorRotation();
		TSharedRef<FJsonObject> RotObj = MakeShared<FJsonObject>();
		RotObj->SetNumberField(TEXT("pitch"), Rot.Pitch);
		RotObj->SetNumberField(TEXT("yaw"), Rot.Yaw);
		RotObj->SetNumberField(TEXT("roll"), Rot.Roll);
		Out->SetObjectField(TEXT("rotation"), RotObj);

		if (!Base)
		{
			Out->SetStringField(TEXT("warning"), TEXT("Light actor has no light component."));
			return;
		}

		Out->SetStringField(TEXT("mobility"), MobilityToString(Base->Mobility));
		Out->SetNumberField(TEXT("intensity"), Base->Intensity);
		Out->SetBoolField(TEXT("castShadows"), Base->CastShadows != 0);
		Out->SetBoolField(TEXT("affectsWorld"), Base->bAffectsWorld != 0);
		Out->SetNumberField(TEXT("indirectLightingIntensity"), Base->IndirectLightingIntensity);
		Out->SetNumberField(TEXT("volumetricScatteringIntensity"), Base->VolumetricScatteringIntensity);

		const FColor C = Base->LightColor;
		TSharedRef<FJsonObject> ColorObj = MakeShared<FJsonObject>();
		ColorObj->SetNumberField(TEXT("r"), C.R);
		ColorObj->SetNumberField(TEXT("g"), C.G);
		ColorObj->SetNumberField(TEXT("b"), C.B);
		ColorObj->SetStringField(TEXT("hex"), FString::Printf(TEXT("#%02X%02X%02X"), C.R, C.G, C.B));
		Out->SetObjectField(TEXT("color"), ColorObj);

		// Temperature lives on ULightComponent. USkyLightComponent derives from ULightComponentBase
		// directly and has none, so this must be guarded rather than assumed.
		if (ULightComponent* LC = Cast<ULightComponent>(Base))
		{
			Out->SetBoolField(TEXT("useTemperature"), LC->bUseTemperature != 0);
			Out->SetNumberField(TEXT("temperature"), LC->Temperature);
		}

		if (!bDetailed)
		{
			return;
		}

		if (ULocalLightComponent* Local = Cast<ULocalLightComponent>(Base))
		{
			Out->SetNumberField(TEXT("attenuationRadius"), Local->AttenuationRadius);
			Out->SetStringField(TEXT("intensityUnits"), LightUnitsToString(Local->IntensityUnits));
		}
		if (UPointLightComponent* Point = Cast<UPointLightComponent>(Base))
		{
			Out->SetNumberField(TEXT("sourceRadius"), Point->SourceRadius);
			Out->SetNumberField(TEXT("sourceLength"), Point->SourceLength);
		}
		if (USpotLightComponent* Spot = Cast<USpotLightComponent>(Base))
		{
			Out->SetNumberField(TEXT("innerConeAngle"), Spot->InnerConeAngle);
			Out->SetNumberField(TEXT("outerConeAngle"), Spot->OuterConeAngle);
		}
		if (URectLightComponent* Rect = Cast<URectLightComponent>(Base))
		{
			Out->SetNumberField(TEXT("sourceWidth"), Rect->SourceWidth);
			Out->SetNumberField(TEXT("sourceHeight"), Rect->SourceHeight);
			Out->SetNumberField(TEXT("barnDoorAngle"), Rect->BarnDoorAngle);
			Out->SetNumberField(TEXT("barnDoorLength"), Rect->BarnDoorLength);
		}
		if (UDirectionalLightComponent* Dir = Cast<UDirectionalLightComponent>(Base))
		{
			Out->SetNumberField(TEXT("lightSourceAngle"), Dir->LightSourceAngle);
		}
		if (USkyLightComponent* Sky = Cast<USkyLightComponent>(Base))
		{
			Out->SetNumberField(TEXT("cubemapResolution"), Sky->CubemapResolution);
			Out->SetNumberField(TEXT("skyDistanceThreshold"), Sky->SkyDistanceThreshold);
			Out->SetBoolField(TEXT("lowerHemisphereIsBlack"), Sky->bLowerHemisphereIsBlack);
			Out->SetBoolField(TEXT("realTimeCapture"), Sky->bRealTimeCapture);
		}
	}
}

// ============================================================
// HandleListLights — enumerate every light in the level
// ============================================================

FString FBlueprintMCPServer::HandleListLights(const FString& Body)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("list_lights requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);

	bool bDetailed = true;
	FString TypeFilter;
	if (Json.IsValid())
	{
		Json->TryGetBoolField(TEXT("includeProperties"), bDetailed);
		Json->TryGetStringField(TEXT("type"), TypeFilter);
		TypeFilter = TypeFilter.ToLower();
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: list_lights(type='%s')"), *TypeFilter);

	TArray<TSharedPtr<FJsonValue>> Lights;
	TMap<FString, int32> TypeCounts;

	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		if (!IsLightActor(Actor))
		{
			continue;
		}

		const FString Type = LightTypeName(Actor);
		if (!TypeFilter.IsEmpty() && Type != TypeFilter)
		{
			continue;
		}

		TSharedRef<FJsonObject> LightObj = MakeShared<FJsonObject>();
		WriteLightJson(Actor, LightObj, bDetailed);
		Lights.Add(MakeShared<FJsonValueObject>(LightObj));
		TypeCounts.FindOrAdd(Type)++;
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("count"), Lights.Num());
	Result->SetArrayField(TEXT("lights"), Lights);

	TSharedRef<FJsonObject> CountsObj = MakeShared<FJsonObject>();
	for (const TPair<FString, int32>& Pair : TypeCounts)
	{
		CountsObj->SetNumberField(Pair.Key, Pair.Value);
	}
	Result->SetObjectField(TEXT("countsByType"), CountsObj);
	Result->SetStringField(TEXT("level"), World->GetMapName());

	return JsonToString(Result);
}

// ============================================================
// HandleSpawnLight — create a light with its properties in one call
// ============================================================

FString FBlueprintMCPServer::HandleSpawnLight(const FString& Body)
{
	// CLAUDE-NOTE: argument validation runs BEFORE the editor check on purpose, so a malformed call
	// reports the malformed argument in every mode rather than being masked by "requires editor
	// mode" in a headless commandlet. Same reasoning in HandleSetLightProperty.
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString Type;
	if (!Json->TryGetStringField(TEXT("type"), Type) || Type.IsEmpty())
	{
		return MakeErrorJson(
			TEXT("Missing required field: type. Expected 'directional', 'point', 'spot', 'rect', or 'sky'."),
			MCPErrorCodes::InvalidInput);
	}
	Type = Type.ToLower();

	UClass* LightClass = nullptr;
	if (Type == TEXT("directional")) LightClass = ADirectionalLight::StaticClass();
	else if (Type == TEXT("point"))  LightClass = APointLight::StaticClass();
	else if (Type == TEXT("spot"))   LightClass = ASpotLight::StaticClass();
	else if (Type == TEXT("rect"))   LightClass = ARectLight::StaticClass();
	else if (Type == TEXT("sky"))    LightClass = ASkyLight::StaticClass();
	else
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Unknown light type '%s'. Expected 'directional', 'point', 'spot', 'rect', or 'sky'."), *Type),
			MCPErrorCodes::InvalidInput);
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("spawn_light requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	FVector Location = FVector::ZeroVector;
	if (const TSharedPtr<FJsonObject>* LocObj; Json->TryGetObjectField(TEXT("location"), LocObj) && LocObj->IsValid())
	{
		(*LocObj)->TryGetNumberField(TEXT("x"), Location.X);
		(*LocObj)->TryGetNumberField(TEXT("y"), Location.Y);
		(*LocObj)->TryGetNumberField(TEXT("z"), Location.Z);
	}

	FRotator Rotation = FRotator::ZeroRotator;
	if (const TSharedPtr<FJsonObject>* RotObj; Json->TryGetObjectField(TEXT("rotation"), RotObj) && RotObj->IsValid())
	{
		(*RotObj)->TryGetNumberField(TEXT("pitch"), Rotation.Pitch);
		(*RotObj)->TryGetNumberField(TEXT("yaw"), Rotation.Yaw);
		(*RotObj)->TryGetNumberField(TEXT("roll"), Rotation.Roll);
	}

	FActorSpawnParameters SpawnParams;
	SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	AActor* NewActor = World->SpawnActor<AActor>(LightClass, Location, Rotation, SpawnParams);
	if (!NewActor)
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Failed to spawn a '%s' light."), *Type),
			MCPErrorCodes::OperationFailed);
	}

	FString Label;
	if (Json->TryGetStringField(TEXT("label"), Label) && !Label.IsEmpty())
	{
		NewActor->SetActorLabel(Label);
	}

	FString ApplyError;
	TArray<FString> Applied;
	if (!ApplyLightProperties(NewActor, Json, Applied, ApplyError))
	{
		return MakeErrorJson(ApplyError, MCPErrorCodes::InvalidInput);
	}

	GEditor->NoteSelectionChange();
	NewActor->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("label"), NewActor->GetActorLabel());
	Result->SetStringField(TEXT("type"), Type);
	Result->SetStringField(TEXT("class"), LightClass->GetName());

	TSharedRef<FJsonObject> StateObj = MakeShared<FJsonObject>();
	WriteLightJson(NewActor, StateObj, true);
	Result->SetObjectField(TEXT("light"), StateObj);

	TArray<TSharedPtr<FJsonValue>> AppliedArr;
	for (const FString& A : Applied) AppliedArr.Add(MakeShared<FJsonValueString>(A));
	Result->SetArrayField(TEXT("appliedProperties"), AppliedArr);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: spawn_light('%s') -> '%s'"), *Type, *NewActor->GetActorLabel());

	return JsonToString(Result);
}

// ============================================================
// HandleSetLightProperty — typed setters on an existing light
// ============================================================

FString FBlueprintMCPServer::HandleSetLightProperty(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString Label;
	if (!Json->TryGetStringField(TEXT("label"), Label) || Label.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: label"), MCPErrorCodes::InvalidInput);
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("set_light_property requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	AActor* Actor = FindActorByLabel(World, Label);
	if (!Actor)
	{
		return MakeErrorJson(
			FString::Printf(TEXT("No actor labelled '%s' in the level. Use list_lights to see available lights."), *Label),
			MCPErrorCodes::NotFound);
	}

	if (!IsLightActor(Actor))
	{
		return MakeErrorJson(
			FString::Printf(
				TEXT("Actor '%s' is a %s, not a light. set_light_property only works on light actors; ")
				TEXT("use set_actor_property for other actor types."),
				*Label, *Actor->GetClass()->GetName()),
			MCPErrorCodes::InvalidInput);
	}

	TArray<FString> Applied;
	FString ApplyError;
	if (!ApplyLightProperties(Actor, Json, Applied, ApplyError))
	{
		return MakeErrorJson(ApplyError, MCPErrorCodes::InvalidInput);
	}

	if (Applied.Num() == 0)
	{
		return MakeErrorJson(
			TEXT("No light properties supplied. Pass at least one of: intensity, color, temperature, ")
			TEXT("useTemperature, mobility, castShadows, affectsWorld, attenuationRadius, innerConeAngle, ")
			TEXT("outerConeAngle, sourceRadius, sourceLength, sourceWidth, sourceHeight, intensityUnits, ")
			TEXT("indirectLightingIntensity, volumetricScatteringIntensity, lightSourceAngle."),
			MCPErrorCodes::InvalidInput);
	}

	Actor->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("label"), Actor->GetActorLabel());

	TArray<TSharedPtr<FJsonValue>> AppliedArr;
	for (const FString& A : Applied) AppliedArr.Add(MakeShared<FJsonValueString>(A));
	Result->SetArrayField(TEXT("appliedProperties"), AppliedArr);

	TSharedRef<FJsonObject> StateObj = MakeShared<FJsonObject>();
	WriteLightJson(Actor, StateObj, true);
	Result->SetObjectField(TEXT("light"), StateObj);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_light_property('%s') applied %d"), *Label, Applied.Num());

	return JsonToString(Result);
}

// ============================================================
// ApplyLightProperties — shared by spawn_light and set_light_property
// ============================================================

bool FBlueprintMCPServer::ApplyLightProperties(
	AActor* Actor, const TSharedPtr<FJsonObject>& Json, TArray<FString>& OutApplied, FString& OutError)
{
	ULightComponentBase* Base = GetLightComponentBase(Actor);
	if (!Base)
	{
		OutError = FString::Printf(TEXT("Actor '%s' has no light component."), *Actor->GetActorLabel());
		return false;
	}

	Actor->Modify();
	Base->Modify();

	ULightComponent*      LC    = Cast<ULightComponent>(Base);
	ULocalLightComponent* Local = Cast<ULocalLightComponent>(Base);
	UPointLightComponent* Point = Cast<UPointLightComponent>(Base);
	USpotLightComponent*  Spot  = Cast<USpotLightComponent>(Base);
	URectLightComponent*  Rect  = Cast<URectLightComponent>(Base);
	USkyLightComponent*   Sky   = Cast<USkyLightComponent>(Base);
	UDirectionalLightComponent* Dir = Cast<UDirectionalLightComponent>(Base);

	// CLAUDE-NOTE: mobility must be applied BEFORE anything else. A Static light rejects most
	// runtime setters, so setting intensity first and mobility second silently loses the intensity.
	FString MobilityStr;
	if (Json->TryGetStringField(TEXT("mobility"), MobilityStr))
	{
		EComponentMobility::Type Mobility;
		if (!ParseMobility(MobilityStr, Mobility))
		{
			OutError = FString::Printf(
				TEXT("Unknown mobility '%s'. Expected 'static', 'stationary', or 'movable'."), *MobilityStr);
			return false;
		}
		Base->SetMobility(Mobility);
		OutApplied.Add(FString::Printf(TEXT("mobility=%s"), *MobilityToString(Mobility)));
	}

	double Number = 0.0;
	bool bFlag = false;

	// CLAUDE-NOTE: everything below assigns the UPROPERTY directly instead of calling the engine's
	// Set* functions, and that is deliberate. Those setters are RUNTIME APIs gated on
	// AreDynamicDataChangesAllowed(): the lenient form refuses Static lights, and
	// SetAttenuationRadius / SetInnerConeAngle / SetOuterConeAngle use the strict form
	// (AreDynamicDataChangesAllowed(false)) which also refuses STATIONARY — the default mobility for
	// a newly placed light. The setter returns void, so the rejection is completely silent: the tool
	// would report success, list_lights would report the old value, and nothing would explain why.
	// Caught by the spot-cone and attenuation-radius tests, which failed exactly this way.
	//
	// Direct assignment followed by PostEditChangeProperty + MarkRenderStateDirty is what the
	// editor's own details panel does, and it is correct for every mobility — you can freely edit a
	// Static light's intensity in the editor. The single render-state rebuild at the end subsumes
	// the targeted updates (PushRadiusToRenderThread, UpdateColorAndBrightness) the setters would
	// have done. It also removes the ULightComponent-vs-USkyLightComponent branching that the
	// setters forced, since the shared properties all live on ULightComponentBase.
	if (Json->TryGetNumberField(TEXT("intensity"), Number))
	{
		Base->Intensity = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("intensity=%.3f"), Number));
	}

	if (const TSharedPtr<FJsonObject>* ColorObj; Json->TryGetObjectField(TEXT("color"), ColorObj) && ColorObj->IsValid())
	{
		// Accept 0-255 ints (matching what list_lights reports) rather than 0-1 floats, so a
		// round-trip of the reported value does what the caller expects. LightColor is an FColor,
		// so assigning it directly also avoids an sRGB round-trip shifting the channel values.
		double R = 255.0, G = 255.0, B = 255.0;
		(*ColorObj)->TryGetNumberField(TEXT("r"), R);
		(*ColorObj)->TryGetNumberField(TEXT("g"), G);
		(*ColorObj)->TryGetNumberField(TEXT("b"), B);
		const FColor NewColor(
			(uint8)FMath::Clamp(R, 0.0, 255.0),
			(uint8)FMath::Clamp(G, 0.0, 255.0),
			(uint8)FMath::Clamp(B, 0.0, 255.0));
		Base->LightColor = NewColor;
		OutApplied.Add(FString::Printf(TEXT("color=#%02X%02X%02X"), NewColor.R, NewColor.G, NewColor.B));
	}

	if (Json->TryGetNumberField(TEXT("temperature"), Number))
	{
		if (!LC)
		{
			OutError = TEXT("temperature is not supported on a sky light (USkyLightComponent has no colour temperature).");
			return false;
		}
		LC->Temperature = (float)Number;
		// CLAUDE-NOTE: Temperature does nothing unless bUseTemperature is also true — the same
		// inert-without-its-flag trap as FPostProcessSettings' bOverride_ booleans. Setting the
		// temperature without enabling it is never what the caller meant, so enable it implicitly
		// unless they explicitly said otherwise in this same call.
		if (!Json->HasField(TEXT("useTemperature")))
		{
			LC->bUseTemperature = true;
			OutApplied.Add(TEXT("useTemperature=true (implied by temperature)"));
		}
		OutApplied.Add(FString::Printf(TEXT("temperature=%.0fK"), Number));
	}

	if (Json->TryGetBoolField(TEXT("useTemperature"), bFlag))
	{
		if (!LC)
		{
			OutError = TEXT("useTemperature is not supported on a sky light.");
			return false;
		}
		LC->bUseTemperature = bFlag;
		OutApplied.Add(FString::Printf(TEXT("useTemperature=%s"), bFlag ? TEXT("true") : TEXT("false")));
	}

	if (Json->TryGetBoolField(TEXT("castShadows"), bFlag))
	{
		Base->CastShadows = bFlag;
		OutApplied.Add(FString::Printf(TEXT("castShadows=%s"), bFlag ? TEXT("true") : TEXT("false")));
	}

	if (Json->TryGetBoolField(TEXT("affectsWorld"), bFlag))
	{
		Base->bAffectsWorld = bFlag;
		OutApplied.Add(FString::Printf(TEXT("affectsWorld=%s"), bFlag ? TEXT("true") : TEXT("false")));
	}

	if (Json->TryGetNumberField(TEXT("indirectLightingIntensity"), Number))
	{
		Base->IndirectLightingIntensity = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("indirectLightingIntensity=%.3f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("volumetricScatteringIntensity"), Number))
	{
		Base->VolumetricScatteringIntensity = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("volumetricScatteringIntensity=%.3f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("attenuationRadius"), Number))
	{
		if (!Local)
		{
			OutError = TEXT("attenuationRadius applies only to point, spot, and rect lights.");
			return false;
		}
		Local->AttenuationRadius = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("attenuationRadius=%.1f"), Number));
	}

	FString UnitsStr;
	if (Json->TryGetStringField(TEXT("intensityUnits"), UnitsStr))
	{
		if (!Local)
		{
			OutError = TEXT("intensityUnits applies only to point, spot, and rect lights.");
			return false;
		}
		ELightUnits Units;
		if (!ParseLightUnits(UnitsStr, Units))
		{
			OutError = FString::Printf(
				TEXT("Unknown intensityUnits '%s'. Expected 'unitless', 'candelas', 'lumens', 'ev', or 'nits'."), *UnitsStr);
			return false;
		}
		Local->IntensityUnits = Units;
		OutApplied.Add(FString::Printf(TEXT("intensityUnits=%s"), *LightUnitsToString(Units)));
	}

	if (Json->TryGetNumberField(TEXT("sourceRadius"), Number))
	{
		if (!Point)
		{
			OutError = TEXT("sourceRadius applies only to point and spot lights.");
			return false;
		}
		Point->SourceRadius = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("sourceRadius=%.2f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("sourceLength"), Number))
	{
		if (!Point)
		{
			OutError = TEXT("sourceLength applies only to point and spot lights.");
			return false;
		}
		Point->SourceLength = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("sourceLength=%.2f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("innerConeAngle"), Number))
	{
		if (!Spot)
		{
			OutError = TEXT("innerConeAngle applies only to spot lights.");
			return false;
		}
		Spot->InnerConeAngle = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("innerConeAngle=%.1f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("outerConeAngle"), Number))
	{
		if (!Spot)
		{
			OutError = TEXT("outerConeAngle applies only to spot lights.");
			return false;
		}
		Spot->OuterConeAngle = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("outerConeAngle=%.1f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("sourceWidth"), Number))
	{
		if (!Rect)
		{
			OutError = TEXT("sourceWidth applies only to rect lights.");
			return false;
		}
		Rect->SourceWidth = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("sourceWidth=%.2f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("sourceHeight"), Number))
	{
		if (!Rect)
		{
			OutError = TEXT("sourceHeight applies only to rect lights.");
			return false;
		}
		Rect->SourceHeight = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("sourceHeight=%.2f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("lightSourceAngle"), Number))
	{
		if (!Dir)
		{
			OutError = TEXT("lightSourceAngle applies only to directional lights.");
			return false;
		}
		Dir->LightSourceAngle = (float)Number;
		OutApplied.Add(FString::Printf(TEXT("lightSourceAngle=%.3f"), Number));
	}

	// Single render-state rebuild covering every direct assignment above. MarkRenderStateDirty
	// recreates the light's render proxy from the current property values, which is a superset of
	// the targeted pushes (PushRadiusToRenderThread, UpdateColorAndBrightness) the engine's setters
	// perform — so bypassing them costs nothing at this granularity.
	FPropertyChangedEvent ChangedEvent(nullptr);
	Base->PostEditChangeProperty(ChangedEvent);
	Base->MarkRenderStateDirty();

	// CLAUDE-NOTE: a sky light does not pick up ANY of the above until it recaptures. Without this
	// the tool reports success, the details panel shows the new values, and the scene lighting is
	// unchanged — which reads as the tool having silently failed. This is the single most common
	// sky-lighting mistake and is precisely what a generic property setter cannot know to do.
	if (Sky)
	{
		Sky->RecaptureSky();
		OutApplied.Add(TEXT("recapturedSky"));
	}

	return true;
}

// ============================================================
// HandleGetRendererState — what the renderer is actually doing
// ============================================================
// CLAUDE-NOTE: reads live console variables rather than the URendererSettings CDO on purpose. The
// CDO reflects what the .ini says; the cvars reflect what is actually in force right now, which can
// differ after a scalability change, a device profile, or a plain `set_cvar` call from these tools.
// For "why does my scene look like this", the live value is the only useful answer.

FString FBlueprintMCPServer::HandleGetRendererState(const FString& Body)
{
	auto GetIntCVar = [](const TCHAR* Name, int32 Fallback) -> int32
	{
		IConsoleVariable* CVar = IConsoleManager::Get().FindConsoleVariable(Name);
		return CVar ? CVar->GetInt() : Fallback;
	};

	const int32 GIMethod   = GetIntCVar(TEXT("r.DynamicGlobalIlluminationMethod"), -1);
	const int32 ReflMethod = GetIntCVar(TEXT("r.ReflectionMethod"), -1);
	const int32 VSM        = GetIntCVar(TEXT("r.Shadow.Virtual.Enable"), -1);
	const int32 PathTrace  = GetIntCVar(TEXT("r.PathTracing"), -1);
	const int32 LumenHWRT  = GetIntCVar(TEXT("r.Lumen.HardwareRayTracing"), -1);
	const int32 MegaLights = GetIntCVar(TEXT("r.MegaLights.Enable"), -1);
	const int32 AutoExpo   = GetIntCVar(TEXT("r.DefaultFeature.AutoExposure"), -1);

	auto GIName = [](int32 V) -> FString
	{
		switch (V)
		{
		case 0:  return TEXT("None");
		case 1:  return TEXT("Lumen");
		case 2:  return TEXT("ScreenSpace");
		case 3:  return TEXT("Plugin");
		default: return TEXT("unknown");
		}
	};
	auto ReflName = [](int32 V) -> FString
	{
		switch (V)
		{
		case 0:  return TEXT("None");
		case 1:  return TEXT("Lumen");
		case 2:  return TEXT("ScreenSpace");
		default: return TEXT("unknown");
		}
	};

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("globalIllumination"), GIName(GIMethod));
	Result->SetStringField(TEXT("reflections"), ReflName(ReflMethod));
	Result->SetStringField(TEXT("shadowMapMethod"), VSM == 1 ? TEXT("VirtualShadowMaps") : (VSM == 0 ? TEXT("ShadowMaps") : TEXT("unknown")));
	Result->SetBoolField(TEXT("pathTracingEnabled"), PathTrace == 1);
	Result->SetBoolField(TEXT("lumenHardwareRayTracing"), LumenHWRT == 1);
	Result->SetBoolField(TEXT("megaLightsEnabled"), MegaLights == 1);
	Result->SetBoolField(TEXT("autoExposureEnabled"), AutoExpo == 1);

	FString ActiveMode;
	if (PathTrace == 1)
	{
		ActiveMode = TEXT("pathtracer");
	}
	else if (GIMethod == 1)
	{
		ActiveMode = MegaLights == 1 ? TEXT("lumen+megalights") : TEXT("lumen");
	}
	else if (GIMethod == 0)
	{
		ActiveMode = TEXT("baked/none");
	}
	else
	{
		ActiveMode = TEXT("other");
	}
	Result->SetStringField(TEXT("activeMode"), ActiveMode);

	// r.PathTracing only makes the path tracer AVAILABLE. It renders when the viewport view mode is
	// also set to Path Tracing (set_view_mode "PathTracing"), which is a separate piece of state and
	// a very common source of "I enabled it and nothing changed".
	if (PathTrace == 1)
	{
		Result->SetStringField(TEXT("note"),
			TEXT("Path tracing is enabled but only renders in a viewport whose view mode is set to ")
			TEXT("PathTracing — use set_view_mode('PathTracing')."));
	}

	if (GEditor)
	{
		if (UWorld* World = GEditor->GetEditorWorldContext().World())
		{
			int32 LightCount = 0;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				if (IsLightActor(*It)) ++LightCount;
			}
			Result->SetNumberField(TEXT("lightCount"), LightCount);
			Result->SetStringField(TEXT("level"), World->GetMapName());
		}
	}

	return JsonToString(Result);
}
