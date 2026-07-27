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
#include "Engine/PostProcessVolume.h"
#include "Engine/Scene.h"
#include "Engine/ExponentialHeightFog.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/VolumetricCloudComponent.h"
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

namespace
{
	int32 GetIntCVar(const TCHAR* Name, int32 Fallback)
	{
		IConsoleVariable* CVar = IConsoleManager::Get().FindConsoleVariable(Name);
		return CVar ? CVar->GetInt() : Fallback;
	}

	bool SetIntCVar(const TCHAR* Name, int32 Value)
	{
		IConsoleVariable* CVar = IConsoleManager::Get().FindConsoleVariable(Name);
		if (!CVar)
		{
			return false;
		}
		CVar->Set(Value, ECVF_SetByCode);
		return true;
	}
}

FString FBlueprintMCPServer::HandleGetRendererState(const FString& Body)
{
	const int32 GIMethod   = GetIntCVar(TEXT("r.DynamicGlobalIlluminationMethod"), -1);
	const int32 ReflMethod = GetIntCVar(TEXT("r.ReflectionMethod"), -1);
	const int32 VSM        = GetIntCVar(TEXT("r.Shadow.Virtual.Enable"), -1);
	const int32 PathTrace  = GetIntCVar(TEXT("r.PathTracing"), -1);
	const int32 LumenHWRT  = GetIntCVar(TEXT("r.Lumen.HardwareRayTracing"), -1);
	// CLAUDE-NOTE: the cvar is r.MegaLights.EnableForProject in 5.6, NOT r.MegaLights.Enable —
	// that name does not exist, so reading it silently returned the fallback and this always
	// reported MegaLights as off. Verified against Renderer/Private cvar registrations.
	const int32 MegaLights = GetIntCVar(TEXT("r.MegaLights.EnableForProject"), -1);
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

// ============================================================
// HandleSetRendererMode — switch the renderer between coherent configurations
// ============================================================
// CLAUDE-NOTE: "switch to Lumen" is not one setting, it is a coherent SET of them
// (r.DynamicGlobalIlluminationMethod + r.ReflectionMethod + turning path tracing off), and getting
// a partial combination is how you end up with Lumen GI but screen-space reflections and no idea
// why the scene looks wrong. Setting these through set_cvar individually requires knowing all of
// them and their integer encodings; this applies them as a unit.

FString FBlueprintMCPServer::HandleSetRendererMode(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString Mode;
	if (!Json->TryGetStringField(TEXT("mode"), Mode) || Mode.IsEmpty())
	{
		return MakeErrorJson(
			TEXT("Missing required field: mode. Expected 'lumen', 'pathtracer', or 'baked'."),
			MCPErrorCodes::InvalidInput);
	}
	Mode = Mode.ToLower();

	if (Mode != TEXT("lumen") && Mode != TEXT("pathtracer") && Mode != TEXT("baked"))
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Unknown mode '%s'. Expected 'lumen', 'pathtracer', or 'baked'."), *Mode),
			MCPErrorCodes::InvalidInput);
	}

	// Reject mode-specific parameters aimed at the wrong mode rather than silently ignoring them —
	// same contract as set_light_property's per-type validation.
	double Number = 0.0;
	bool bFlag = false;
	const bool bWantsPathTracerParams =
		Json->HasField(TEXT("samplesPerPixel")) || Json->HasField(TEXT("maxBounces"));
	if (bWantsPathTracerParams && Mode != TEXT("pathtracer"))
	{
		return MakeErrorJson(
			TEXT("samplesPerPixel and maxBounces apply only to mode='pathtracer'."),
			MCPErrorCodes::InvalidInput);
	}
	if (Json->HasField(TEXT("hardwareRayTracing")) && Mode != TEXT("lumen"))
	{
		return MakeErrorJson(
			TEXT("hardwareRayTracing applies only to mode='lumen'."),
			MCPErrorCodes::InvalidInput);
	}

	TArray<FString> Applied;
	TArray<FString> Unavailable;

	auto Apply = [&Applied, &Unavailable](const TCHAR* Name, int32 Value)
	{
		if (SetIntCVar(Name, Value))
		{
			Applied.Add(FString::Printf(TEXT("%s=%d"), Name, Value));
		}
		else
		{
			Unavailable.Add(Name);
		}
	};

	if (Mode == TEXT("lumen"))
	{
		Apply(TEXT("r.PathTracing"), 0);
		Apply(TEXT("r.DynamicGlobalIlluminationMethod"), 1); // Lumen
		Apply(TEXT("r.ReflectionMethod"), 1);                // Lumen
		if (Json->TryGetBoolField(TEXT("hardwareRayTracing"), bFlag))
		{
			Apply(TEXT("r.Lumen.HardwareRayTracing"), bFlag ? 1 : 0);
		}
	}
	else if (Mode == TEXT("pathtracer"))
	{
		Apply(TEXT("r.PathTracing"), 1);
		if (Json->TryGetNumberField(TEXT("samplesPerPixel"), Number))
		{
			Apply(TEXT("r.PathTracing.SamplesPerPixel"), FMath::Max(1, (int32)Number));
		}
		if (Json->TryGetNumberField(TEXT("maxBounces"), Number))
		{
			Apply(TEXT("r.PathTracing.MaxBounces"), FMath::Max(0, (int32)Number));
		}
	}
	else // baked
	{
		Apply(TEXT("r.PathTracing"), 0);
		Apply(TEXT("r.DynamicGlobalIlluminationMethod"), 0); // None — GI comes from lightmaps
		Apply(TEXT("r.ReflectionMethod"), 2);                // Screen space
	}

	// Orthogonal to the mode: MegaLights is a light-culling technique, not a GI method, and virtual
	// shadow maps are independent of both.
	if (Json->TryGetBoolField(TEXT("megaLights"), bFlag))
	{
		Apply(TEXT("r.MegaLights.EnableForProject"), bFlag ? 1 : 0);
	}
	if (Json->TryGetBoolField(TEXT("virtualShadowMaps"), bFlag))
	{
		Apply(TEXT("r.Shadow.Virtual.Enable"), bFlag ? 1 : 0);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("mode"), Mode);

	TArray<TSharedPtr<FJsonValue>> AppliedArr;
	for (const FString& A : Applied) AppliedArr.Add(MakeShared<FJsonValueString>(A));
	Result->SetArrayField(TEXT("appliedCVars"), AppliedArr);

	if (Unavailable.Num() > 0)
	{
		// Surface rather than swallow: a console variable that does not exist in this build means
		// the setting silently did nothing, which is exactly the failure this tool exists to avoid.
		TArray<TSharedPtr<FJsonValue>> UnavailArr;
		for (const FString& U : Unavailable) UnavailArr.Add(MakeShared<FJsonValueString>(U));
		Result->SetArrayField(TEXT("unavailableCVars"), UnavailArr);
	}

	if (Mode == TEXT("pathtracer"))
	{
		Result->SetStringField(TEXT("note"),
			TEXT("Path tracing is enabled but only renders in a viewport whose view mode is set to ")
			TEXT("PathTracing — call set_view_mode('PathTracing')."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_renderer_mode('%s') applied %d cvars"), *Mode, Applied.Num());

	return JsonToString(Result);
}

// ============================================================
// HandleConfigurePostProcess — exposure, bloom and Lumen quality on a post-process volume
// ============================================================
// CLAUDE-NOTE: this is the tool that most justifies a typed layer existing at all. Every field of
// FPostProcessSettings is INERT unless its paired bOverride_<Field> boolean is also true. Setting
// Settings.AutoExposureMinBrightness through the generic set_actor_property silently does nothing,
// because bOverride_AutoExposureMinBrightness stays false — the value is stored and then ignored.
// A generic property setter has no way to know about the paired flag. Every write below sets both.

FString FBlueprintMCPServer::HandleConfigurePostProcess(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString ExposureMethod;
	if (Json->TryGetStringField(TEXT("exposureMethod"), ExposureMethod))
	{
		const FString Lower = ExposureMethod.ToLower();
		if (Lower != TEXT("histogram") && Lower != TEXT("basic") && Lower != TEXT("manual"))
		{
			return MakeErrorJson(
				FString::Printf(TEXT("Unknown exposureMethod '%s'. Expected 'histogram', 'basic', or 'manual'."), *ExposureMethod),
				MCPErrorCodes::InvalidInput);
		}
		ExposureMethod = Lower;
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("configure_post_process requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	// Resolve the target volume: an explicit label, else the first unbound ("global") volume.
	FString VolumeLabel;
	APostProcessVolume* Volume = nullptr;
	const bool bHasLabel = Json->TryGetStringField(TEXT("volume"), VolumeLabel) && !VolumeLabel.IsEmpty();

	if (bHasLabel)
	{
		AActor* Actor = FindActorByLabel(World, VolumeLabel);
		if (!Actor)
		{
			return MakeErrorJson(
				FString::Printf(TEXT("No actor labelled '%s' in the level."), *VolumeLabel),
				MCPErrorCodes::NotFound);
		}
		Volume = Cast<APostProcessVolume>(Actor);
		if (!Volume)
		{
			return MakeErrorJson(
				FString::Printf(TEXT("Actor '%s' is a %s, not a PostProcessVolume."),
					*VolumeLabel, *Actor->GetClass()->GetName()),
				MCPErrorCodes::InvalidInput);
		}
	}
	else
	{
		for (TActorIterator<APostProcessVolume> It(World); It; ++It)
		{
			if (It->bUnbound)
			{
				Volume = *It;
				break;
			}
		}

		if (!Volume)
		{
			bool bCreateGlobal = false;
			Json->TryGetBoolField(TEXT("createGlobal"), bCreateGlobal);
			if (!bCreateGlobal)
			{
				return MakeErrorJson(
					TEXT("No unbound (global) PostProcessVolume in the level. Pass createGlobal=true to ")
					TEXT("spawn one, or pass volume=<label> to target a specific volume."),
					MCPErrorCodes::NotFound);
			}

			FActorSpawnParameters SpawnParams;
			SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
			Volume = World->SpawnActor<APostProcessVolume>(
				APostProcessVolume::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator, SpawnParams);
			if (!Volume)
			{
				return MakeErrorJson(TEXT("Failed to spawn a global PostProcessVolume."), MCPErrorCodes::OperationFailed);
			}
			Volume->bUnbound = true;
			Volume->SetActorLabel(TEXT("GlobalPostProcess"));
		}
	}

	Volume->Modify();
	FPostProcessSettings& S = Volume->Settings;

	TArray<FString> Applied;
	double Number = 0.0;

	if (!ExposureMethod.IsEmpty())
	{
		S.bOverride_AutoExposureMethod = true;
		S.AutoExposureMethod =
			ExposureMethod == TEXT("manual")    ? AEM_Manual :
			ExposureMethod == TEXT("basic")     ? AEM_Basic  : AEM_Histogram;
		Applied.Add(FString::Printf(TEXT("exposureMethod=%s"), *ExposureMethod));
	}

	if (Json->TryGetNumberField(TEXT("exposureBias"), Number))
	{
		S.bOverride_AutoExposureBias = true;
		S.AutoExposureBias = (float)Number;
		Applied.Add(FString::Printf(TEXT("exposureBias=%.3f"), Number));
	}

	// Convenience: locking exposure means pinning min and max to the same EV100 value. Doing it by
	// hand means remembering to set two values AND their two override flags.
	if (Json->TryGetNumberField(TEXT("lockExposure"), Number))
	{
		S.bOverride_AutoExposureMinBrightness = true;
		S.bOverride_AutoExposureMaxBrightness = true;
		S.AutoExposureMinBrightness = (float)Number;
		S.AutoExposureMaxBrightness = (float)Number;
		Applied.Add(FString::Printf(TEXT("lockExposure=%.3f (min=max EV100)"), Number));
	}
	else
	{
		if (Json->TryGetNumberField(TEXT("exposureMinEV"), Number))
		{
			S.bOverride_AutoExposureMinBrightness = true;
			S.AutoExposureMinBrightness = (float)Number;
			Applied.Add(FString::Printf(TEXT("exposureMinEV=%.3f"), Number));
		}
		if (Json->TryGetNumberField(TEXT("exposureMaxEV"), Number))
		{
			S.bOverride_AutoExposureMaxBrightness = true;
			S.AutoExposureMaxBrightness = (float)Number;
			Applied.Add(FString::Printf(TEXT("exposureMaxEV=%.3f"), Number));
		}
	}

	if (Json->TryGetNumberField(TEXT("bloomIntensity"), Number))
	{
		S.bOverride_BloomIntensity = true;
		S.BloomIntensity = (float)Number;
		Applied.Add(FString::Printf(TEXT("bloomIntensity=%.3f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("lumenSceneLightingQuality"), Number))
	{
		S.bOverride_LumenSceneLightingQuality = true;
		S.LumenSceneLightingQuality = (float)Number;
		Applied.Add(FString::Printf(TEXT("lumenSceneLightingQuality=%.2f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("lumenFinalGatherQuality"), Number))
	{
		S.bOverride_LumenFinalGatherQuality = true;
		S.LumenFinalGatherQuality = (float)Number;
		Applied.Add(FString::Printf(TEXT("lumenFinalGatherQuality=%.2f"), Number));
	}

	if (Json->TryGetNumberField(TEXT("lumenMaxTraceDistance"), Number))
	{
		S.bOverride_LumenMaxTraceDistance = true;
		S.LumenMaxTraceDistance = (float)Number;
		Applied.Add(FString::Printf(TEXT("lumenMaxTraceDistance=%.1f"), Number));
	}

	if (Applied.Num() == 0)
	{
		return MakeErrorJson(
			TEXT("No post-process settings supplied. Pass at least one of: exposureMethod, ")
			TEXT("exposureBias, lockExposure, exposureMinEV, exposureMaxEV, bloomIntensity, ")
			TEXT("lumenSceneLightingQuality, lumenFinalGatherQuality, lumenMaxTraceDistance."),
			MCPErrorCodes::InvalidInput);
	}

	FPropertyChangedEvent ChangedEvent(nullptr);
	Volume->PostEditChangeProperty(ChangedEvent);
	Volume->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("volume"), Volume->GetActorLabel());
	Result->SetBoolField(TEXT("unbound"), Volume->bUnbound != 0);

	TArray<TSharedPtr<FJsonValue>> AppliedArr;
	for (const FString& A : Applied) AppliedArr.Add(MakeShared<FJsonValueString>(A));
	Result->SetArrayField(TEXT("appliedSettings"), AppliedArr);

	// Read back through the same override flags the renderer consults, so the response proves the
	// setting is actually live rather than merely stored.
	TSharedRef<FJsonObject> StateObj = MakeShared<FJsonObject>();
	StateObj->SetBoolField(TEXT("exposureMethodOverridden"), S.bOverride_AutoExposureMethod != 0);
	StateObj->SetNumberField(TEXT("exposureMethod"), (int32)S.AutoExposureMethod);
	StateObj->SetBoolField(TEXT("exposureBiasOverridden"), S.bOverride_AutoExposureBias != 0);
	StateObj->SetNumberField(TEXT("exposureBias"), S.AutoExposureBias);
	StateObj->SetBoolField(TEXT("exposureMinOverridden"), S.bOverride_AutoExposureMinBrightness != 0);
	StateObj->SetNumberField(TEXT("exposureMinEV"), S.AutoExposureMinBrightness);
	StateObj->SetBoolField(TEXT("exposureMaxOverridden"), S.bOverride_AutoExposureMaxBrightness != 0);
	StateObj->SetNumberField(TEXT("exposureMaxEV"), S.AutoExposureMaxBrightness);
	StateObj->SetBoolField(TEXT("bloomIntensityOverridden"), S.bOverride_BloomIntensity != 0);
	StateObj->SetNumberField(TEXT("bloomIntensity"), S.BloomIntensity);
	Result->SetObjectField(TEXT("settings"), StateObj);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: configure_post_process('%s') applied %d"),
		*Volume->GetActorLabel(), Applied.Num());

	return JsonToString(Result);
}

// ============================================================
// HandleSpawnSky â€” the coherent outdoor lighting set, in one call
// ============================================================
// CLAUDE-NOTE: an outdoor sky is five actors that only work together: a directional light flagged
// as the atmosphere sun, a sky light for ambient, a SkyAtmosphere, height fog, and optionally
// volumetric clouds. Building it by hand means five spawns plus the two links people forget â€”
// bAtmosphereSunLight on the directional light (without it the atmosphere has no sun and renders
// with no sun disc or scattering), and the sky light capture (a non-realtime sky light shows
// whatever the level looked like when it was last captured, i.e. usually nothing). Both handled.

FString FBlueprintMCPServer::HandleSpawnSky(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString Preset = TEXT("daylight");
	Json->TryGetStringField(TEXT("preset"), Preset);
	Preset = Preset.ToLower();

	float SunPitch, SunIntensity, SunTemperature, SkyIntensity;
	if (Preset == TEXT("daylight"))
	{
		SunPitch = -45.0f; SunIntensity = 10.0f; SunTemperature = 6500.0f; SkyIntensity = 1.0f;
	}
	else if (Preset == TEXT("sunset"))
	{
		SunPitch = -4.0f;  SunIntensity = 4.0f;  SunTemperature = 2700.0f; SkyIntensity = 0.6f;
	}
	else if (Preset == TEXT("overcast"))
	{
		// CLAUDE-NOTE: measured against a locked EV100=1 exposure, the original 3 lux / 1.6 sky put
		// overcast at 56% of daylight and sunset at 60% — near-identical brightness, so the two
		// presets were distinguishable only by colour temperature. Overcast's defining quality is
		// FLATNESS, not dimness: cut the sun further and raise the ambient so shadows fill in.
		SunPitch = -60.0f; SunIntensity = 1.5f;  SunTemperature = 7200.0f; SkyIntensity = 2.6f;
	}
	else if (Preset == TEXT("night"))
	{
		// CLAUDE-NOTE: night sits at ~4% of daylight brightness and geometry reads as black
		// silhouettes at a daylight exposure. That is physically correct, not a bug — but note that
		// SKY LIGHT INTENSITY IS THE WRONG LEVER TO FIX IT. Measured: raising it from 0.25 to 0.9
		// (3.6x) moved mean frame luma from 5.6 to 5.9 out of 255, i.e. nothing. The sky light uses
		// real-time capture, so it derives its colour from the atmosphere — which at night is very
		// nearly black, and any multiple of black is still black. To actually see a night scene,
		// raise exposure (configure_post_process) or add practical lights; do not reach for the sky
		// light. 0.6 is kept as a mild ambient that pays off once exposure is raised.
		SunPitch = -12.0f; SunIntensity = 0.15f; SunTemperature = 9000.0f; SkyIntensity = 0.6f;
	}
	else
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Unknown preset '%s'. Expected 'daylight', 'sunset', 'overcast', or 'night'."), *Preset),
			MCPErrorCodes::InvalidInput);
	}

	double Number = 0.0;
	float SunYaw = 0.0f;
	if (Json->TryGetNumberField(TEXT("sunPitch"), Number))     { SunPitch = (float)Number; }
	if (Json->TryGetNumberField(TEXT("sunYaw"), Number))       { SunYaw = (float)Number; }
	if (Json->TryGetNumberField(TEXT("sunIntensity"), Number)) { SunIntensity = (float)Number; }

	bool bIncludeClouds = true;
	bool bIncludeFog = true;
	bool bReplaceExisting = false;
	Json->TryGetBoolField(TEXT("includeClouds"), bIncludeClouds);
	Json->TryGetBoolField(TEXT("includeFog"), bIncludeFog);
	Json->TryGetBoolField(TEXT("replaceExisting"), bReplaceExisting);

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("spawn_sky requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	// Refuse to stack a second sky on an existing one rather than quietly doubling the lighting â€”
	// two directional lights both flagged as the atmosphere sun is a confusing state to debug.
	TArray<AActor*> Existing;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->IsA<ASkyAtmosphere>() || It->IsA<ASkyLight>() || It->IsA<AVolumetricCloud>())
		{
			Existing.Add(*It);
		}
	}
	if (Existing.Num() > 0 && !bReplaceExisting)
	{
		TArray<FString> Names;
		for (AActor* A : Existing) { Names.Add(A->GetActorLabel()); }
		return MakeErrorJson(
			FString::Printf(
				TEXT("The level already has sky actors (%s). Pass replaceExisting=true to delete them and ")
				TEXT("build a fresh sky, or adjust the existing ones with set_light_property."),
				*FString::Join(Names, TEXT(", "))),
			MCPErrorCodes::AlreadyExists);
	}

	TArray<FString> Removed;
	if (bReplaceExisting)
	{
		// Also sweep directional lights and fog, which belong to the set even though the presence
		// check above ignores them (a level can legitimately have a directional light and no sky).
		TArray<AActor*> ToRemove = Existing;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if (It->IsA<ADirectionalLight>() || It->IsA<AExponentialHeightFog>())
			{
				ToRemove.AddUnique(*It);
			}
		}
		for (AActor* A : ToRemove)
		{
			if (A)
			{
				Removed.Add(A->GetActorLabel());
				World->EditorDestroyActor(A, /*bShouldModifyLevel=*/true);
			}
		}
	}

	FActorSpawnParameters SpawnParams;
	SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	TArray<FString> Created;

	// --- Sun ---
	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(
		ADirectionalLight::StaticClass(), FVector(0, 0, 500), FRotator(SunPitch, SunYaw, 0), SpawnParams);
	if (!Sun)
	{
		return MakeErrorJson(TEXT("Failed to spawn the directional light."), MCPErrorCodes::OperationFailed);
	}
	Sun->SetActorLabel(TEXT("Sun"));
	if (UDirectionalLightComponent* SunComp = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		SunComp->Modify();
		SunComp->SetMobility(EComponentMobility::Movable);
		SunComp->Intensity = SunIntensity;
		SunComp->Temperature = SunTemperature;
		SunComp->bUseTemperature = true;
		// Without this the SkyAtmosphere has no sun: no sun disc, no scattering, black horizon.
		SunComp->bAtmosphereSunLight = true;
		FPropertyChangedEvent Evt(nullptr);
		SunComp->PostEditChangeProperty(Evt);
		SunComp->MarkRenderStateDirty();
	}
	Created.Add(TEXT("Sun (DirectionalLight)"));

	// --- Sky light ---
	if (ASkyLight* SkyLight = World->SpawnActor<ASkyLight>(
		ASkyLight::StaticClass(), FVector(0, 0, 500), FRotator::ZeroRotator, SpawnParams))
	{
		SkyLight->SetActorLabel(TEXT("SkyLight"));
		if (USkyLightComponent* SkyComp = SkyLight->GetLightComponent())
		{
			SkyComp->Modify();
			SkyComp->SetMobility(EComponentMobility::Movable);
			SkyComp->Intensity = SkyIntensity;
			// Real-time capture sidesteps the whole "did you remember to recapture" problem: the
			// sky light tracks the atmosphere automatically as the sun moves.
			SkyComp->bRealTimeCapture = true;
			SkyComp->SourceType = SLS_CapturedScene;
			FPropertyChangedEvent Evt(nullptr);
			SkyComp->PostEditChangeProperty(Evt);
			SkyComp->MarkRenderStateDirty();
			SkyComp->RecaptureSky();
		}
		Created.Add(TEXT("SkyLight"));
	}

	// --- Atmosphere ---
	if (ASkyAtmosphere* Atmosphere = World->SpawnActor<ASkyAtmosphere>(
		ASkyAtmosphere::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator, SpawnParams))
	{
		Atmosphere->SetActorLabel(TEXT("SkyAtmosphere"));
		Created.Add(TEXT("SkyAtmosphere"));
	}

	// --- Fog ---
	if (bIncludeFog)
	{
		if (AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(
			AExponentialHeightFog::StaticClass(), FVector(0, 0, 100), FRotator::ZeroRotator, SpawnParams))
		{
			Fog->SetActorLabel(TEXT("HeightFog"));
			if (UExponentialHeightFogComponent* FogComp = Fog->GetComponent())
			{
				FogComp->Modify();
				FogComp->bEnableVolumetricFog = true;
				FPropertyChangedEvent Evt(nullptr);
				FogComp->PostEditChangeProperty(Evt);
				FogComp->MarkRenderStateDirty();
			}
			Created.Add(TEXT("HeightFog (volumetric)"));
		}
	}

	// --- Clouds ---
	if (bIncludeClouds)
	{
		if (AVolumetricCloud* Clouds = World->SpawnActor<AVolumetricCloud>(
			AVolumetricCloud::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator, SpawnParams))
		{
			Clouds->SetActorLabel(TEXT("VolumetricCloud"));
			Created.Add(TEXT("VolumetricCloud"));
		}
	}

	GEditor->NoteSelectionChange();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("preset"), Preset);
	Result->SetNumberField(TEXT("sunPitch"), SunPitch);
	Result->SetNumberField(TEXT("sunYaw"), SunYaw);
	Result->SetNumberField(TEXT("sunIntensity"), SunIntensity);
	Result->SetNumberField(TEXT("sunTemperature"), SunTemperature);
	Result->SetNumberField(TEXT("skyLightIntensity"), SkyIntensity);

	TArray<TSharedPtr<FJsonValue>> CreatedArr;
	for (const FString& C : Created) { CreatedArr.Add(MakeShared<FJsonValueString>(C)); }
	Result->SetArrayField(TEXT("created"), CreatedArr);

	if (Removed.Num() > 0)
	{
		TArray<TSharedPtr<FJsonValue>> RemovedArr;
		for (const FString& R : Removed) { RemovedArr.Add(MakeShared<FJsonValueString>(R)); }
		Result->SetArrayField(TEXT("removed"), RemovedArr);
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: spawn_sky('%s') created %d actors"), *Preset, Created.Num());

	return JsonToString(Result);
}

// ============================================================
// HandleValidateLighting â€” the mistakes that make a scene look wrong
// ============================================================
// CLAUDE-NOTE: every check here is a failure mode that produces a plausible-looking scene rather
// than an error, which is exactly why they are worth automating â€” nothing in the editor tells you
// about any of them. Severity is advisory: "error" means the scene is almost certainly broken,
// "warning" means it is probably not what was intended, "info" is worth knowing.

FString FBlueprintMCPServer::HandleValidateLighting(const FString& Body)
{
	if (!GEditor)
	{
		return MakeErrorJson(TEXT("validate_lighting requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	TArray<TSharedPtr<FJsonValue>> Issues;
	int32 ErrorCount = 0, WarningCount = 0, InfoCount = 0;

	auto AddIssue = [&](const TCHAR* Severity, const TCHAR* Code, const FString& Message, const FString& ActorLabel)
	{
		TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
		Obj->SetStringField(TEXT("severity"), Severity);
		Obj->SetStringField(TEXT("code"), Code);
		Obj->SetStringField(TEXT("message"), Message);
		if (!ActorLabel.IsEmpty()) { Obj->SetStringField(TEXT("actor"), ActorLabel); }
		Issues.Add(MakeShared<FJsonValueObject>(Obj));
		if (FCString::Strcmp(Severity, TEXT("error")) == 0)        { ++ErrorCount; }
		else if (FCString::Strcmp(Severity, TEXT("warning")) == 0) { ++WarningCount; }
		else                                                       { ++InfoCount; }
	};

	int32 DirectionalCount = 0, SkyLightCount = 0, TotalLights = 0;
	bool bHasAtmosphereSun = false;
	bool bHasSkyAtmosphere = false;
	TArray<ULocalLightComponent*> StationaryLocals;

	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;

		if (Actor->IsA<ASkyAtmosphere>()) { bHasSkyAtmosphere = true; }
		if (!IsLightActor(Actor)) { continue; }

		++TotalLights;
		ULightComponentBase* Base = GetLightComponentBase(Actor);
		if (!Base) { continue; }

		const FString Label = Actor->GetActorLabel();

		if (Actor->IsA<ADirectionalLight>())
		{
			++DirectionalCount;
			if (UDirectionalLightComponent* Dir = Cast<UDirectionalLightComponent>(Base))
			{
				if (Dir->bAtmosphereSunLight) { bHasAtmosphereSun = true; }
			}
		}

		if (ASkyLight* Sky = Cast<ASkyLight>(Actor))
		{
			++SkyLightCount;
			if (USkyLightComponent* SkyComp = Sky->GetLightComponent())
			{
				if (SkyComp->SourceType == SLS_CapturedScene && !SkyComp->bRealTimeCapture)
				{
					AddIssue(TEXT("warning"), TEXT("skylight_needs_recapture"),
						TEXT("Sky light captures the scene but real-time capture is off, so it shows whatever the ")
						TEXT("level looked like when it was last captured. Enable real-time capture, or recapture ")
						TEXT("after changing the sky (set_light_property on this light recaptures automatically)."),
						Label);
				}
			}
		}

		if (Base->Intensity <= 0.0f)
		{
			AddIssue(TEXT("warning"), TEXT("zero_intensity"),
				TEXT("Light has zero intensity and contributes nothing. Set an intensity or delete it."), Label);
		}

		if (Base->bAffectsWorld == 0)
		{
			AddIssue(TEXT("info"), TEXT("affects_world_off"),
				TEXT("Light is disabled via affectsWorld=false. Intentional, but it renders nothing."), Label);
		}

		if (Base->Mobility == EComponentMobility::Stationary)
		{
			if (ULocalLightComponent* Local = Cast<ULocalLightComponent>(Base))
			{
				StationaryLocals.Add(Local);
			}
		}
	}

	if (TotalLights == 0)
	{
		AddIssue(TEXT("error"), TEXT("no_lights"),
			TEXT("The level has no lights at all. Use spawn_sky for an outdoor set, or spawn_light."), FString());
	}
	else
	{
		if (DirectionalCount == 0)
		{
			AddIssue(TEXT("warning"), TEXT("no_directional_light"),
				TEXT("No directional light, so there is no sun or key light."), FString());
		}
		if (SkyLightCount == 0)
		{
			AddIssue(TEXT("warning"), TEXT("no_sky_light"),
				TEXT("No sky light, so ambient fill is missing and shadowed areas will read as flat black."),
				FString());
		}
	}

	if (DirectionalCount > 1)
	{
		AddIssue(TEXT("warning"), TEXT("multiple_directional_lights"),
			FString::Printf(TEXT("%d directional lights. More than one sun is rarely intended and doubles up lighting."),
				DirectionalCount), FString());
	}

	if (bHasSkyAtmosphere && !bHasAtmosphereSun)
	{
		AddIssue(TEXT("error"), TEXT("atmosphere_without_sun"),
			TEXT("A SkyAtmosphere exists but no directional light is flagged as its sun, so the sky renders ")
			TEXT("with no sun disc and no atmospheric scattering."), FString());
	}

	// UE packs stationary-light shadows into a limited set of channels; above four overlapping
	// stationary lights the extras fall back to fully dynamic shadows, silently.
	//
	// CLAUDE-NOTE: use ULightComponent::GetBoundingSphere() rather than the raw attenuation radius.
	// USpotLightComponent overrides it to bound the CONE, which for a narrow spot is dramatically
	// smaller than its attenuation sphere — comparing raw radii reported overlaps between spots
	// that cannot physically illuminate the same surface. This is also the bound the engine's own
	// stationary-light overlap accounting works from, so the answer now agrees with the editor's
	// "Stationary Light Overlap" view mode instead of being a looser guess.
	constexpr int32 OverlapScanLimit = 200;
	if (StationaryLocals.Num() > 1 && StationaryLocals.Num() <= OverlapScanLimit)
	{
		TArray<FSphere> Bounds;
		Bounds.Reserve(StationaryLocals.Num());
		for (ULocalLightComponent* Light : StationaryLocals)
		{
			Bounds.Add(Light->GetBoundingSphere());
		}

		for (int32 i = 0; i < StationaryLocals.Num(); ++i)
		{
			int32 Overlaps = 0;
			for (int32 j = 0; j < StationaryLocals.Num(); ++j)
			{
				if (i == j) { continue; }
				const double RadiusSum = Bounds[i].W + Bounds[j].W;
				if (FVector::DistSquared(Bounds[i].Center, Bounds[j].Center) < RadiusSum * RadiusSum)
				{
					++Overlaps;
				}
			}
			if (Overlaps >= 4)
			{
				AddIssue(TEXT("warning"), TEXT("stationary_shadow_overflow"),
					FString::Printf(
						TEXT("%d other stationary lights overlap this one. Above four overlapping stationary ")
						TEXT("lights UE runs out of shadow channels and the extras fall back to dynamic shadows ")
						TEXT("without reporting it. Make some Movable or Static, or reduce their radii."), Overlaps),
					StationaryLocals[i]->GetOwner() ? StationaryLocals[i]->GetOwner()->GetActorLabel() : FString());
			}
		}
	}
	else if (StationaryLocals.Num() > OverlapScanLimit)
	{
		AddIssue(TEXT("info"), TEXT("overlap_scan_skipped"),
			FString::Printf(TEXT("Skipped the stationary-light overlap check: %d stationary local lights exceeds ")
				TEXT("the %d scan limit."), StationaryLocals.Num(), OverlapScanLimit), FString());
	}

	// Auto-exposure silently re-normalises the image, so intensity edits appear to do nothing.
	const int32 AutoExpo = GetIntCVar(TEXT("r.DefaultFeature.AutoExposure"), -1);
	if (AutoExpo == 1)
	{
		bool bExposureLocked = false;
		for (TActorIterator<APostProcessVolume> It(World); It; ++It)
		{
			const FPostProcessSettings& S = It->Settings;
			if (S.bOverride_AutoExposureMinBrightness && S.bOverride_AutoExposureMaxBrightness &&
				FMath::IsNearlyEqual(S.AutoExposureMinBrightness, S.AutoExposureMaxBrightness))
			{
				bExposureLocked = true;
				break;
			}
			if (S.bOverride_AutoExposureMethod && S.AutoExposureMethod == AEM_Manual)
			{
				bExposureLocked = true;
				break;
			}
		}
		if (!bExposureLocked)
		{
			AddIssue(TEXT("warning"), TEXT("auto_exposure_unlocked"),
				TEXT("Auto-exposure is on and no post-process volume locks it, so the image re-normalises after ")
				TEXT("every lighting change and intensity edits appear to do nothing. Use ")
				TEXT("configure_post_process(lockExposure=...) while tuning lights."), FString());
		}
	}

	const int32 GIMethod = GetIntCVar(TEXT("r.DynamicGlobalIlluminationMethod"), -1);
	if (GIMethod == 0 && TotalLights > 0)
	{
		AddIssue(TEXT("info"), TEXT("no_dynamic_gi"),
			TEXT("Dynamic global illumination is off, so indirect light comes only from baked lightmaps and ")
			TEXT("unbuilt lighting will look flat. Use set_renderer_mode('lumen') for dynamic GI."), FString());
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("level"), World->GetMapName());
	Result->SetNumberField(TEXT("lightCount"), TotalLights);
	Result->SetNumberField(TEXT("issueCount"), Issues.Num());
	Result->SetNumberField(TEXT("errors"), ErrorCount);
	Result->SetNumberField(TEXT("warnings"), WarningCount);
	Result->SetNumberField(TEXT("infos"), InfoCount);
	Result->SetArrayField(TEXT("issues"), Issues);
	Result->SetBoolField(TEXT("passed"), ErrorCount == 0 && WarningCount == 0);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: validate_lighting â€” %d issues (%d errors, %d warnings)"),
		Issues.Num(), ErrorCount, WarningCount);

	return JsonToString(Result);
}

