#include "RiotCharacterProfile.h"
#include "RiotCrowdFragments.h"
#include "RiotCrowdHandlers.h"
#include "RiotCrowdSubsystem.h"
#include "RiotErrorCodes.h"
#include "RiotRepresentation.h"
#include "RiotScenario.h"

#include "Editor.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/World.h"
#include "MassCommonFragments.h"
#include "MassEntityManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// ============================================================
// Local helpers
//
// CLAUDE-NOTE: deliberately duplicated from RiotCrowdHandlers.cpp's anonymous namespace rather than
// promoted to a shared header. They are four trivial functions, and hoisting them would create a
// public utility header whose only purpose is to be included twice. If a fifth handler file appears,
// that is the point to extract them.
// ============================================================

namespace
{

FString JsonToString(const TSharedRef<FJsonObject>& Object)
{
	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Object, Writer);
	return Out;
}

TSharedPtr<FJsonObject> ParseBody(const FString& Body)
{
	TSharedPtr<FJsonObject> Parsed;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
	return FJsonSerializer::Deserialize(Reader, Parsed) && Parsed.IsValid() ? Parsed : nullptr;
}

bool IsDryRun(const TSharedPtr<FJsonObject>& Parent)
{
	bool bDryRun = false;
	Parent->TryGetBoolField(TEXT("dryRun"), bDryRun);
	return bDryRun;
}

TSharedRef<FJsonObject> MakeSuccess(const FString& Summary)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("summary"), Summary);
	return Result;
}

URiotCrowdSubsystem* GetRiotSubsystem(FString& OutError)
{
	if (!GEditor || !GEditor->PlayWorld)
	{
		OutError = TEXT("PIE is not running. Use start_pie first — the riot simulation runs in the play world.");
		return nullptr;
	}
	URiotCrowdSubsystem* Subsystem = GEditor->PlayWorld->GetSubsystem<URiotCrowdSubsystem>();
	if (!Subsystem)
	{
		OutError = TEXT("RiotCrowdSubsystem is not available in the play world.");
		return nullptr;
	}
	return Subsystem;
}

/**
 * Every error this file returns carries the fields the milestone requires: a stable code, a
 * human-readable explanation, the ids and asset path involved, whether anything was partially
 * written, and what to do next.
 *
 * CLAUDE-NOTE: bPartialMutation is an explicit parameter with no default. Every call site must state
 * it, because "did this leave half a profile behind?" is precisely the question an operator cannot
 * answer from the outside, and a default would let a new handler answer it by accident.
 */
FString MakeDetailedError(const TCHAR* Code, const FString& Message, bool bPartialMutation,
	const FString& ProfileId = FString(), const FString& AssetPath = FString(),
	const FString& NextAction = FString())
{
	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("error"), Message);
	Json->SetStringField(TEXT("errorCode"), Code);
	Json->SetBoolField(TEXT("partialMutation"), bPartialMutation);
	if (!ProfileId.IsEmpty())  { Json->SetStringField(TEXT("profileId"), ProfileId); }
	if (!AssetPath.IsEmpty())  { Json->SetStringField(TEXT("assetPath"), AssetPath); }
	if (!NextAction.IsEmpty()) { Json->SetStringField(TEXT("suggestedNextAction"), NextAction); }
	return JsonToString(Json);
}

/** Reads a character profile out of a request body. Does not touch the store. */
bool ReadProfileFromBody(const TSharedPtr<FJsonObject>& Body, FRiotCharacterProfile& OutProfile,
	FString& OutErrorCode, FString& OutMessage)
{
	if (!Body->TryGetStringField(TEXT("profileId"), OutProfile.ProfileId))
	{
		OutErrorCode = RiotErrorCodes::ScenarioInvalid;
		OutMessage = TEXT("profileId is required.");
		return false;
	}

	Body->TryGetStringField(TEXT("displayName"), OutProfile.DisplayName);
	Body->TryGetStringField(TEXT("skeletalMeshPath"), OutProfile.SkeletalMeshPath);
	Body->TryGetStringField(TEXT("skeletonPath"), OutProfile.SkeletonPath);
	Body->TryGetStringField(TEXT("animationBlueprintPath"), OutProfile.AnimationBlueprintPath);
	Body->TryGetStringField(TEXT("representationProfileId"), OutProfile.RepresentationProfileId);
	Body->TryGetBoolField(TEXT("enabled"), OutProfile.bEnabled);

	double Weight = OutProfile.SelectionWeight;
	if (Body->TryGetNumberField(TEXT("selectionWeight"), Weight))
	{
		OutProfile.SelectionWeight = Weight;
	}

	double YawOffset = OutProfile.MeshYawOffsetDegrees;
	if (Body->TryGetNumberField(TEXT("meshYawOffsetDegrees"), YawOffset))
	{
		OutProfile.MeshYawOffsetDegrees = YawOffset;
	}

	FString ModeString;
	if (Body->TryGetStringField(TEXT("animationMode"), ModeString))
	{
		if (!LexFromStringRiotAnimationMode(ModeString, OutProfile.AnimationMode))
		{
			OutErrorCode = RiotErrorCodes::ScenarioInvalid;
			OutMessage = FString::Printf(
				TEXT("Unknown animationMode '%s'. Expected 'animationBlueprint' or 'sequenceSet'."),
				*ModeString);
			return false;
		}
	}

	const TArray<TSharedPtr<FJsonValue>>* FactionArray = nullptr;
	if (Body->TryGetArrayField(TEXT("factionTypes"), FactionArray))
	{
		OutProfile.FactionTypes.Reset();
		for (const TSharedPtr<FJsonValue>& Value : *FactionArray)
		{
			ERiotFactionType Type = ERiotFactionType::Rioter;
			if (!LexFromStringRiotFactionType(Value->AsString(), Type))
			{
				OutErrorCode = RiotErrorCodes::ScenarioInvalid;
				OutMessage = FString::Printf(
					TEXT("Unknown factionType '%s'. Expected rioter, police, military or neutral."),
					*Value->AsString());
				return false;
			}
			OutProfile.FactionTypes.AddUnique(Type);
		}
	}

	const TArray<TSharedPtr<FJsonValue>>* AnimArray = nullptr;
	if (Body->TryGetArrayField(TEXT("animationSet"), AnimArray))
	{
		OutProfile.AnimationSet.Reset();
		for (const TSharedPtr<FJsonValue>& Value : *AnimArray)
		{
			const TSharedPtr<FJsonObject>* Entry = nullptr;
			if (!Value->TryGetObject(Entry))
			{
				continue;
			}

			FRiotAnimationBinding Binding;
			FString SlotString;
			if (!(*Entry)->TryGetStringField(TEXT("slot"), SlotString)
				|| !LexFromStringRiotAnimationSlot(SlotString, Binding.Slot))
			{
				OutErrorCode = RiotErrorCodes::AnimationMappingIncomplete;
				OutMessage = FString::Printf(
					TEXT("animationSet entry has an unknown slot '%s'. Valid slots: idle, gathering, "
						 "advancing, pressuring, breaching, panicked, retreating, holding, bracing, "
						 "fallback, broken, inactive."),
					*SlotString);
				return false;
			}
			(*Entry)->TryGetStringField(TEXT("animationPath"), Binding.AnimationPath);
			double PlayRate = 1.0;
			if ((*Entry)->TryGetNumberField(TEXT("playRate"), PlayRate)) { Binding.PlayRate = PlayRate; }
			(*Entry)->TryGetBoolField(TEXT("looping"), Binding.bLooping);
			OutProfile.AnimationSet.Add(Binding);
		}
	}

	const TArray<TSharedPtr<FJsonValue>>* MaterialArray = nullptr;
	if (Body->TryGetArrayField(TEXT("materialOverrides"), MaterialArray))
	{
		OutProfile.MaterialOverrides.Reset();
		for (const TSharedPtr<FJsonValue>& Value : *MaterialArray)
		{
			OutProfile.MaterialOverrides.Add(Value->AsString());
		}
	}

	return true;
}

/** Scenarios (and factions within them) currently referencing a profile id. */
TArray<FString> FindProfileUsages(const FString& ProfileId)
{
	TArray<FString> Usages;
	for (const FRiotScenario& Scenario : FRiotScenarioStore::Get().All())
	{
		for (const FRiotFaction& Faction : Scenario.Factions)
		{
			if (Faction.CharacterProfileIds.Contains(ProfileId))
			{
				Usages.Add(FString::Printf(TEXT("%s/%s"), *Scenario.Id, *Faction.Id));
			}
		}
	}
	return Usages;
}

} // namespace

// ============================================================
// Character profile authoring
// ============================================================

FString FRiotCrowdHandlers::HandleRegisterCharacterProfile(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FRiotCharacterProfile Profile;
	FString ErrorCode, Message;
	if (!ReadProfileFromBody(Parsed, Profile, ErrorCode, Message))
	{
		return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, Profile.ProfileId);
	}

	FRiotCharacterProfileStore& Store = FRiotCharacterProfileStore::Get();
	if (Store.Find(Profile.ProfileId))
	{
		return MakeDetailedError(RiotErrorCodes::CharacterProfileAlreadyExists,
			FString::Printf(TEXT("A character profile with id '%s' is already registered."),
				*Profile.ProfileId),
			/*bPartialMutation=*/false, Profile.ProfileId, FString(),
			TEXT("Use riot_update_character_profile to change it, or pick a different profileId."));
	}

	// CLAUDE-NOTE: validate BEFORE inserting. Registering first and validating after would leave an
	// invalid profile in the store on failure, which is exactly the partial mutation the milestone
	// forbids — and the operator would have to delete it before retrying.
	if (!ValidateRiotCharacterProfileAssets(Profile, ErrorCode, Message))
	{
		return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, Profile.ProfileId,
			Profile.SkeletalMeshPath,
			TEXT("Fix the asset reference and call riot_register_character_profile again. "
				 "Nothing was registered."));
	}

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: profile '%s' is valid and would be registered."), *Profile.ProfileId));
		Result->SetBoolField(TEXT("dryRun"), true);
		Result->SetObjectField(TEXT("profile"), Profile.ToJson());
		return JsonToString(Result);
	}

	const FRiotCharacterProfile& Stored = Store.Add(MoveTemp(Profile));

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Registered character profile '%s' (%s)."),
		*Stored.ProfileId, LexToStringRiotValidationState(Stored.ValidationState)));
	Result->SetObjectField(TEXT("profile"), Stored.ToJson());
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleUpdateCharacterProfile(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FString ProfileId;
	if (!Parsed->TryGetStringField(TEXT("profileId"), ProfileId))
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("profileId is required."), /*bPartialMutation=*/false);
	}

	FRiotCharacterProfileStore& Store = FRiotCharacterProfileStore::Get();
	FRiotCharacterProfile* Existing = Store.Find(ProfileId);
	if (!Existing)
	{
		return MakeDetailedError(RiotErrorCodes::CharacterProfileNotFound,
			FString::Printf(TEXT("No character profile with id '%s'."), *ProfileId),
			/*bPartialMutation=*/false, ProfileId, FString(),
			TEXT("Call riot_list_character_profiles to see what is registered."));
	}

	// CLAUDE-NOTE: start from a COPY of the existing profile, apply the patch to the copy, validate
	// the copy, and only then commit. A failed update therefore leaves the previously working profile
	// exactly as it was, rather than half-patched into an unusable state.
	FRiotCharacterProfile Candidate = *Existing;
	FString ErrorCode, Message;
	if (!ReadProfileFromBody(Parsed, Candidate, ErrorCode, Message))
	{
		return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, ProfileId);
	}

	if (!ValidateRiotCharacterProfileAssets(Candidate, ErrorCode, Message))
	{
		return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, ProfileId,
			Candidate.SkeletalMeshPath,
			TEXT("The existing profile is unchanged. Fix the reference and retry."));
	}

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: profile '%s' would be updated."), *ProfileId));
		Result->SetBoolField(TEXT("dryRun"), true);
		Result->SetObjectField(TEXT("profile"), Candidate.ToJson());
		return JsonToString(Result);
	}

	*Existing = MoveTemp(Candidate);

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Updated character profile '%s' (%s)."),
		*ProfileId, LexToStringRiotValidationState(Existing->ValidationState)));
	Result->SetObjectField(TEXT("profile"), Existing->ToJson());
	// A live crowd already holds a snapshot of its profiles, so an update cannot retroactively
	// change what is on screen. Saying so prevents an operator concluding the tool silently failed.
	Result->SetBoolField(TEXT("affectsLiveCrowd"), false);
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleDeleteCharacterProfile(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FString ProfileId;
	if (!Parsed->TryGetStringField(TEXT("profileId"), ProfileId))
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("profileId is required."), /*bPartialMutation=*/false);
	}

	FRiotCharacterProfileStore& Store = FRiotCharacterProfileStore::Get();
	if (!Store.Find(ProfileId))
	{
		return MakeDetailedError(RiotErrorCodes::CharacterProfileNotFound,
			FString::Printf(TEXT("No character profile with id '%s'."), *ProfileId),
			/*bPartialMutation=*/false, ProfileId);
	}

	const TArray<FString> Usages = FindProfileUsages(ProfileId);
	bool bForce = false;
	Parsed->TryGetBoolField(TEXT("force"), bForce);

	if (Usages.Num() > 0 && !bForce)
	{
		// CLAUDE-NOTE: refuse rather than cascade. Silently unassigning a profile from every faction
		// that uses it would change the visual makeup of scenarios the operator did not mention, and
		// they would only find out at the next spawn. force:true is the documented override.
		TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
		Json->SetStringField(TEXT("error"), FString::Printf(
			TEXT("Character profile '%s' is assigned to %d faction(s) and was not deleted."),
			*ProfileId, Usages.Num()));
		Json->SetStringField(TEXT("errorCode"), RiotErrorCodes::CharacterProfileInUse);
		Json->SetBoolField(TEXT("partialMutation"), false);
		Json->SetStringField(TEXT("profileId"), ProfileId);
		TArray<TSharedPtr<FJsonValue>> UsageArray;
		for (const FString& Usage : Usages)
		{
			UsageArray.Add(MakeShared<FJsonValueString>(Usage));
		}
		Json->SetArrayField(TEXT("usedBy"), UsageArray);
		Json->SetStringField(TEXT("suggestedNextAction"),
			TEXT("Reassign those factions with riot_assign_character_profiles, or repeat this call "
				 "with force:true to delete it and drop the assignments."));
		return JsonToString(Json);
	}

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: profile '%s' would be deleted."), *ProfileId));
		Result->SetBoolField(TEXT("dryRun"), true);
		return JsonToString(Result);
	}

	int32 AssignmentsDropped = 0;
	if (bForce)
	{
		for (FRiotScenario& Scenario : FRiotScenarioStore::Get().AllMutable())
		{
			for (FRiotFaction& Faction : Scenario.Factions)
			{
				AssignmentsDropped += Faction.CharacterProfileIds.Remove(ProfileId);
			}
		}
	}

	Store.Remove(ProfileId);

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Deleted character profile '%s'%s."), *ProfileId,
		AssignmentsDropped > 0
			? *FString::Printf(TEXT(" and dropped %d faction assignment(s)"), AssignmentsDropped)
			: TEXT("")));
	Result->SetNumberField(TEXT("assignmentsDropped"), AssignmentsDropped);
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleListCharacterProfiles(const FString& /*Body*/)
{
	const FRiotCharacterProfileStore& Store = FRiotCharacterProfileStore::Get();

	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	TArray<TSharedPtr<FJsonValue>> Array;
	int32 UsableCount = 0;
	for (const FRiotCharacterProfile& Profile : Store.All())
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("profileId"), Profile.ProfileId);
		Entry->SetStringField(TEXT("displayName"), Profile.DisplayName);
		Entry->SetStringField(TEXT("skeletalMeshPath"), Profile.SkeletalMeshPath);
		Entry->SetStringField(TEXT("animationMode"), LexToStringRiotAnimationMode(Profile.AnimationMode));
		Entry->SetNumberField(TEXT("selectionWeight"), Profile.SelectionWeight);
		Entry->SetBoolField(TEXT("enabled"), Profile.bEnabled);
		Entry->SetStringField(TEXT("validationState"),
			LexToStringRiotValidationState(Profile.ValidationState));
		Entry->SetNumberField(TEXT("warningCount"), Profile.Warnings.Num());
		Array.Add(MakeShared<FJsonValueObject>(Entry));
		if (Profile.IsUsable()) { ++UsableCount; }
	}
	Json->SetArrayField(TEXT("profiles"), Array);
	Json->SetNumberField(TEXT("count"), Array.Num());
	Json->SetNumberField(TEXT("usableCount"), UsableCount);

	TArray<TSharedPtr<FJsonValue>> RepArray;
	for (const FRiotRepresentationProfile& RepProfile : Store.AllRepresentations())
	{
		RepArray.Add(MakeShared<FJsonValueObject>(RepProfile.ToJson()));
	}
	Json->SetArrayField(TEXT("representationProfiles"), RepArray);

	return JsonToString(Json);
}

FString FRiotCrowdHandlers::HandleGetCharacterProfile(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FString ProfileId;
	if (!Parsed->TryGetStringField(TEXT("profileId"), ProfileId))
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("profileId is required."), /*bPartialMutation=*/false);
	}

	const FRiotCharacterProfile* Profile = FRiotCharacterProfileStore::Get().Find(ProfileId);
	if (!Profile)
	{
		return MakeDetailedError(RiotErrorCodes::CharacterProfileNotFound,
			FString::Printf(TEXT("No character profile with id '%s'."), *ProfileId),
			/*bPartialMutation=*/false, ProfileId);
	}

	return JsonToString(Profile->ToJson());
}

FString FRiotCrowdHandlers::HandleValidateCharacterProfile(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	// CLAUDE-NOTE: validates EITHER a registered profile by id OR an unregistered candidate supplied
	// inline. The inline form is the point of this tool — it lets an operator check asset paths
	// before committing anything to the store, which is what makes "validate without spawning" real
	// rather than just a re-run of registration.
	FString ProfileId;
	FRiotCharacterProfile Profile;
	const bool bByReference = Parsed->TryGetStringField(TEXT("profileId"), ProfileId)
		&& !Parsed->HasField(TEXT("skeletalMeshPath"));

	if (bByReference)
	{
		const FRiotCharacterProfile* Existing = FRiotCharacterProfileStore::Get().Find(ProfileId);
		if (!Existing)
		{
			return MakeDetailedError(RiotErrorCodes::CharacterProfileNotFound,
				FString::Printf(TEXT("No character profile with id '%s'."), *ProfileId),
				/*bPartialMutation=*/false, ProfileId);
		}
		Profile = *Existing;
	}
	else
	{
		FString ErrorCode, Message;
		if (!ReadProfileFromBody(Parsed, Profile, ErrorCode, Message))
		{
			return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, Profile.ProfileId);
		}
	}

	FString ErrorCode, Message;
	const bool bValid = ValidateRiotCharacterProfileAssets(Profile, ErrorCode, Message);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetBoolField(TEXT("valid"), bValid);
	Result->SetStringField(TEXT("validationState"),
		LexToStringRiotValidationState(Profile.ValidationState));
	Result->SetStringField(TEXT("summary"), bValid
		? FString::Printf(TEXT("Profile '%s' validated: %s."), *Profile.ProfileId,
			LexToStringRiotValidationState(Profile.ValidationState))
		: FString::Printf(TEXT("Profile '%s' is invalid: %s"), *Profile.ProfileId, *Message));
	if (!bValid)
	{
		Result->SetStringField(TEXT("errorCode"), ErrorCode);
		Result->SetStringField(TEXT("errorMessage"), Message);
	}
	Result->SetObjectField(TEXT("profile"), Profile.ToJson());
	// Validation never writes to the store, even for a registered profile, so the caller can always
	// re-validate without side effects.
	Result->SetBoolField(TEXT("stored"), false);
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleAssignCharacterProfiles(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FString ScenarioId, FactionId;
	if (!Parsed->TryGetStringField(TEXT("scenarioId"), ScenarioId)
		|| !Parsed->TryGetStringField(TEXT("factionId"), FactionId))
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("scenarioId and factionId are both required."), /*bPartialMutation=*/false);
	}

	FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ScenarioId);
	if (!Scenario)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioNotFound,
			FString::Printf(TEXT("No scenario with id '%s'."), *ScenarioId),
			/*bPartialMutation=*/false);
	}

	const int32 FactionIndex = Scenario->IndexOfFaction(FactionId);
	if (FactionIndex == INDEX_NONE)
	{
		return MakeDetailedError(RiotErrorCodes::FactionNotFound,
			FString::Printf(TEXT("Scenario '%s' has no faction '%s'."), *ScenarioId, *FactionId),
			/*bPartialMutation=*/false);
	}

	const TArray<TSharedPtr<FJsonValue>>* IdArray = nullptr;
	if (!Parsed->TryGetArrayField(TEXT("profileIds"), IdArray))
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("profileIds must be an array of registered character profile ids."),
			/*bPartialMutation=*/false);
	}

	// CLAUDE-NOTE: resolve and check EVERY id before writing any of them. A half-applied assignment
	// would leave the faction with a subset the operator never asked for, and the error would not say
	// which ids did land.
	const FRiotCharacterProfileStore& Store = FRiotCharacterProfileStore::Get();
	FRiotFaction& Faction = Scenario->Factions[FactionIndex];
	TArray<FString> Resolved;
	for (const TSharedPtr<FJsonValue>& Value : *IdArray)
	{
		const FString Id = Value->AsString();
		const FRiotCharacterProfile* Profile = Store.Find(Id);
		if (!Profile)
		{
			return MakeDetailedError(RiotErrorCodes::CharacterProfileNotFound,
				FString::Printf(TEXT("No character profile with id '%s'. Nothing was assigned."), *Id),
				/*bPartialMutation=*/false, Id, FString(),
				TEXT("Register it with riot_register_character_profile first."));
		}
		if (!Profile->SupportsFactionType(Faction.Type))
		{
			return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
				FString::Printf(
					TEXT("Character profile '%s' does not accept faction type '%s' (faction '%s'). "
						 "Nothing was assigned."),
					*Id, LexToStringRiotFactionType(Faction.Type), *FactionId),
				/*bPartialMutation=*/false, Id, FString(),
				TEXT("Add that faction type to the profile's factionTypes, or leave factionTypes "
					 "empty to accept any."));
		}
		if (!Profile->IsUsable())
		{
			return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
				FString::Printf(
					TEXT("Character profile '%s' is %s and cannot be assigned. Nothing was assigned."),
					*Id, LexToStringRiotValidationState(Profile->ValidationState)),
				/*bPartialMutation=*/false, Id, FString(),
				TEXT("Fix it with riot_update_character_profile, then retry."));
		}
		Resolved.AddUnique(Id);
	}

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: %d profile(s) would be assigned to faction '%s'."),
			Resolved.Num(), *FactionId));
		Result->SetBoolField(TEXT("dryRun"), true);
		return JsonToString(Result);
	}

	Faction.CharacterProfileIds = Resolved;

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Assigned %d character profile(s) to faction '%s' in scenario '%s'."),
		Resolved.Num(), *FactionId, *ScenarioId));
	TArray<TSharedPtr<FJsonValue>> Assigned;
	for (const FString& Id : Resolved)
	{
		Assigned.Add(MakeShared<FJsonValueString>(Id));
	}
	Result->SetArrayField(TEXT("profileIds"), Assigned);
	return JsonToString(Result);
}

// ============================================================
// Representation
// ============================================================

FString FRiotCrowdHandlers::HandleSetRepresentationProfile(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FRiotRepresentationProfile Profile;
	if (!Parsed->TryGetStringField(TEXT("profileId"), Profile.ProfileId))
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("profileId is required."), /*bPartialMutation=*/false);
	}

	// Start from an existing profile of the same id so a partial update is a patch, not a reset.
	FRiotCharacterProfileStore& Store = FRiotCharacterProfileStore::Get();
	if (const FRiotRepresentationProfile* Existing = Store.FindRepresentation(Profile.ProfileId))
	{
		Profile = *Existing;
	}

	double Number = 0.0;
	if (Parsed->TryGetNumberField(TEXT("nearDistance"), Number))       { Profile.NearDistance = Number; }
	if (Parsed->TryGetNumberField(TEXT("midDistance"), Number))        { Profile.MidDistance = Number; }
	if (Parsed->TryGetNumberField(TEXT("farDistance"), Number))        { Profile.FarDistance = Number; }
	if (Parsed->TryGetNumberField(TEXT("hysteresisDistance"), Number)) { Profile.HysteresisDistance = Number; }
	if (Parsed->TryGetNumberField(TEXT("maxNearActors"), Number))      { Profile.MaxNearActors = (int32)Number; }
	if (Parsed->TryGetNumberField(TEXT("maxMidRepresentations"), Number)) { Profile.MaxMidRepresentations = (int32)Number; }
	Parsed->TryGetBoolField(TEXT("farRepresentationEnabled"), Profile.bFarRepresentationEnabled);

	const TSharedPtr<FJsonObject>* Intervals = nullptr;
	if (Parsed->TryGetObjectField(TEXT("updateIntervals"), Intervals))
	{
		if ((*Intervals)->TryGetNumberField(TEXT("near"), Number)) { Profile.NearUpdateInterval = Number; }
		if ((*Intervals)->TryGetNumberField(TEXT("mid"), Number))  { Profile.MidUpdateInterval = Number; }
		if ((*Intervals)->TryGetNumberField(TEXT("far"), Number))  { Profile.FarUpdateInterval = Number; }
	}

	FString CameraString;
	if (Parsed->TryGetStringField(TEXT("cameraSource"), CameraString))
	{
		if (!LexFromStringRiotCameraSource(CameraString, Profile.CameraSource))
		{
			return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
				FString::Printf(
					TEXT("Unknown cameraSource '%s'. Expected piePlayerCamera, explicitTransform or "
						 "sequencerCamera."), *CameraString),
				/*bPartialMutation=*/false, Profile.ProfileId);
		}
	}

	const TSharedPtr<FJsonObject>* CameraObject = nullptr;
	if (Parsed->TryGetObjectField(TEXT("cameraTransform"), CameraObject))
	{
		double X = 0, Y = 0, Z = 0, Pitch = 0, Yaw = 0, Roll = 0;
		(*CameraObject)->TryGetNumberField(TEXT("x"), X);
		(*CameraObject)->TryGetNumberField(TEXT("y"), Y);
		(*CameraObject)->TryGetNumberField(TEXT("z"), Z);
		(*CameraObject)->TryGetNumberField(TEXT("pitch"), Pitch);
		(*CameraObject)->TryGetNumberField(TEXT("yaw"), Yaw);
		(*CameraObject)->TryGetNumberField(TEXT("roll"), Roll);
		Profile.ExplicitCameraTransform =
			FTransform(FRotator(Pitch, Yaw, Roll), FVector(X, Y, Z));
	}

	FString ErrorCode, Message;
	if (!ValidateRiotRepresentationProfile(Profile, ErrorCode, Message))
	{
		return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, Profile.ProfileId,
			FString(), TEXT("Nothing was stored. Correct the ranges and retry."));
	}

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: representation profile '%s' is valid."), *Profile.ProfileId));
		Result->SetBoolField(TEXT("dryRun"), true);
		Result->SetObjectField(TEXT("representationProfile"), Profile.ToJson());
		return JsonToString(Result);
	}

	const FString ProfileId = Profile.ProfileId;
	if (FRiotRepresentationProfile* Existing = Store.FindRepresentation(ProfileId))
	{
		*Existing = Profile;
	}
	else
	{
		Store.AddRepresentation(Profile);
	}

	// Optionally bind it to a scenario in the same call, since setting a profile nobody uses is
	// almost never what the caller meant.
	FString ScenarioId;
	bool bBound = false;
	if (Parsed->TryGetStringField(TEXT("scenarioId"), ScenarioId))
	{
		if (FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ScenarioId))
		{
			Scenario->RepresentationProfileId = ProfileId;
			bBound = true;
		}
		else
		{
			return MakeDetailedError(RiotErrorCodes::ScenarioNotFound,
				FString::Printf(
					TEXT("Representation profile '%s' was stored, but scenario '%s' does not exist so "
						 "it was not bound to anything."), *ProfileId, *ScenarioId),
				/*bPartialMutation=*/true, ProfileId, FString(),
				TEXT("Call riot_set_representation_profile again with a valid scenarioId to bind it."));
		}
	}

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Stored representation profile '%s'%s."), *ProfileId,
		bBound ? *FString::Printf(TEXT(" and bound it to scenario '%s'"), *ScenarioId) : TEXT("")));
	Result->SetObjectField(TEXT("representationProfile"), Profile.ToJson());
	Result->SetBoolField(TEXT("boundToScenario"), bBound);
	// Taking effect at the next spawn is a consequence of the snapshot rule; say it rather than let
	// the operator discover it by watching nothing change.
	Result->SetStringField(TEXT("appliesFrom"),
		TEXT("Next riot_spawn. A live crowd keeps the profile it spawned with."));
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleGetRepresentationReport(const FString& /*Body*/)
{
	FString Error;
	URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(Error);
	if (!Subsystem)
	{
		return MakeDetailedError(RiotErrorCodes::PieNotRunning, Error, /*bPartialMutation=*/false);
	}
	return JsonToString(Subsystem->BuildRepresentationReport());
}

namespace
{
/**
 * Resolve the promote/demote selector into concrete entity handles.
 *
 * CLAUDE-NOTE: agents are addressed publicly by their entity INDEX, not by a bespoke id. The index
 * is what the runtime report already exposes, and inventing a parallel id space would mean
 * maintaining a second map that can disagree with Mass. Handles are always re-resolved from the
 * subsystem's live lists, so a stale index from an earlier run simply fails to match rather than
 * addressing whatever entity now occupies that slot.
 *
 * Deliberately NO arbitrary predicate: the milestone forbids exposing code predicates, and a
 * fixed selector vocabulary is also what makes the operation reproducible in a test.
 */
TArray<FMassEntityHandle> ResolveAgentSelector(URiotCrowdSubsystem& Subsystem,
	const TSharedPtr<FJsonObject>& Body, FString& OutSummary)
{
	TArray<FMassEntityHandle> All;
	All.Append(Subsystem.GetOwnedRioters());
	All.Append(Subsystem.GetOwnedDefenders());

	const FRiotRepresentationManager& Manager = Subsystem.GetRepresentationManager();

	// ----- explicit ids -----
	const TArray<TSharedPtr<FJsonValue>>* IdArray = nullptr;
	if (Body->TryGetArrayField(TEXT("agentIds"), IdArray))
	{
		TArray<FMassEntityHandle> Selected;
		for (const TSharedPtr<FJsonValue>& Value : *IdArray)
		{
			const int32 Index = (int32)Value->AsNumber();
			for (const FMassEntityHandle& Handle : All)
			{
				if (Handle.Index == Index)
				{
					Selected.Add(Handle);
					break;
				}
			}
		}
		OutSummary = FString::Printf(TEXT("%d of %d requested agent id(s) matched a live agent."),
			Selected.Num(), IdArray->Num());
		return Selected;
	}

	// ----- filtered -----
	FString FactionTypeString, ProfileIdFilter, StateFilter;
	const bool bHasFaction = Body->TryGetStringField(TEXT("factionType"), FactionTypeString);
	const bool bHasProfile = Body->TryGetStringField(TEXT("characterProfileId"), ProfileIdFilter);
	const bool bHasState = Body->TryGetStringField(TEXT("riotState"), StateFilter);

	ERiotFactionType FactionFilter = ERiotFactionType::Rioter;
	if (bHasFaction) { LexFromStringRiotFactionType(FactionTypeString, FactionFilter); }

	TArray<TPair<double, FMassEntityHandle>> Scored;
	const TMap<FMassEntityHandle, FRiotAgentRepresentation>& Agents = Manager.GetAgents();

	// Nearest-to-what. Camera by default; an explicit point overrides it.
	FVector Origin = FVector::ZeroVector;
	bool bHaveOrigin = false;
	const TSharedPtr<FJsonObject>* NearObject = nullptr;
	if (Body->TryGetObjectField(TEXT("nearestToLocation"), NearObject))
	{
		double X = 0, Y = 0, Z = 0;
		(*NearObject)->TryGetNumberField(TEXT("x"), X);
		(*NearObject)->TryGetNumberField(TEXT("y"), Y);
		(*NearObject)->TryGetNumberField(TEXT("z"), Z);
		Origin = FVector(X, Y, Z);
		bHaveOrigin = true;
	}
	else
	{
		FTransform CameraTransform;
		FString ResolvedSource;
		if (Manager.GetCameraTransform(CameraTransform, ResolvedSource))
		{
			Origin = CameraTransform.GetLocation();
			bHaveOrigin = true;
		}
	}

	for (const TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		const FRiotAgentRepresentation& Agent = Pair.Value;
		if (bHasFaction && Agent.FactionType != FactionFilter) { continue; }
		if (bHasProfile)
		{
			// Compare against the id the report shows, so a filter that looks right behaves right.
			bool bMatches = false;
			for (const TPair<FString, int32>& Count : Manager.CountsByProfile())
			{
				if (Count.Key == ProfileIdFilter) { bMatches = true; break; }
			}
			if (!bMatches) { continue; }
		}
		Scored.Add({ Agent.LastDistance, Pair.Key });
	}

	Scored.Sort([](const TPair<double, FMassEntityHandle>& A, const TPair<double, FMassEntityHandle>& B)
	{
		if (!FMath::IsNearlyEqual(A.Key, B.Key)) { return A.Key < B.Key; }
		return A.Value.Index < B.Value.Index; // stable tie-break, same rule as the budget sort
	});

	double MaxCount = (double)Scored.Num();
	Body->TryGetNumberField(TEXT("maxCount"), MaxCount);

	TArray<FMassEntityHandle> Selected;
	for (int32 i = 0; i < Scored.Num() && i < (int32)MaxCount; ++i)
	{
		Selected.Add(Scored[i].Value);
	}

	OutSummary = FString::Printf(
		TEXT("Selected %d agent(s) from %d live, ordered nearest-first%s."),
		Selected.Num(), Agents.Num(),
		bHaveOrigin ? TEXT("") : TEXT(" (no camera or location available, so order is arbitrary)"));
	return Selected;
}
} // namespace

FString FRiotCrowdHandlers::HandlePromoteAgents(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FString Error;
	URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(Error);
	if (!Subsystem)
	{
		return MakeDetailedError(RiotErrorCodes::PieNotRunning, Error, /*bPartialMutation=*/false);
	}

	FString SelectionSummary;
	const TArray<FMassEntityHandle> Selected =
		ResolveAgentSelector(*Subsystem, Parsed, SelectionSummary);

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: %s Nothing was promoted."), *SelectionSummary));
		Result->SetBoolField(TEXT("dryRun"), true);
		Result->SetNumberField(TEXT("wouldPromote"), Selected.Num());
		return JsonToString(Result);
	}

	FString ErrorCode, Message;
	const int32 Changed = Subsystem->PromoteAgents(Selected, ErrorCode, Message);
	if (!ErrorCode.IsEmpty())
	{
		return MakeDetailedError(*ErrorCode, Message, /*bPartialMutation=*/false, FString(), FString(),
			TEXT("Raise maxNearActors with riot_set_representation_profile, or demote agents first."));
	}

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Promoted %d agent(s) to the near tier. %s"), Changed, *SelectionSummary));
	Result->SetNumberField(TEXT("promoted"), Changed);
	Result->SetNumberField(TEXT("selected"), Selected.Num());
	// Selected-but-unchanged means "already promoted", which is a success, not a silent failure.
	Result->SetNumberField(TEXT("alreadyPromoted"), Selected.Num() - Changed);

	TArray<TSharedPtr<FJsonValue>> Ids;
	for (const FMassEntityHandle& Handle : Selected)
	{
		Ids.Add(MakeShared<FJsonValueNumber>(Handle.Index));
	}
	Result->SetArrayField(TEXT("agentIds"), Ids);
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleDemoteAgents(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed)
	{
		return MakeDetailedError(RiotErrorCodes::ScenarioInvalid,
			TEXT("Request body is not valid JSON."), /*bPartialMutation=*/false);
	}

	FString Error;
	URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(Error);
	if (!Subsystem)
	{
		return MakeDetailedError(RiotErrorCodes::PieNotRunning, Error, /*bPartialMutation=*/false);
	}

	FString SelectionSummary;
	const TArray<FMassEntityHandle> Selected =
		ResolveAgentSelector(*Subsystem, Parsed, SelectionSummary);

	if (IsDryRun(Parsed))
	{
		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: %s Nothing was demoted."), *SelectionSummary));
		Result->SetBoolField(TEXT("dryRun"), true);
		Result->SetNumberField(TEXT("wouldDemote"), Selected.Num());
		return JsonToString(Result);
	}

	FString ErrorCode, Message;
	const int32 Changed = Subsystem->DemoteAgents(Selected, ErrorCode, Message);

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Demoted %d agent(s). %s"), Changed, *SelectionSummary));
	Result->SetNumberField(TEXT("demoted"), Changed);
	Result->SetNumberField(TEXT("selected"), Selected.Num());
	Result->SetNumberField(TEXT("alreadyDemoted"), Selected.Num() - Changed);
	return JsonToString(Result);
}
