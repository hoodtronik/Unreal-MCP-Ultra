#include "RiotCharacterProfile.h"

#include "RiotErrorCodes.h"
#include "RiotScenario.h"

#include "Animation/AnimSequenceBase.h"
#include "Animation/AnimInstance.h"
#include "Animation/Skeleton.h"
#include "Dom/JsonObject.h"
#include "Engine/SkeletalMesh.h"
#include "Materials/MaterialInterface.h"
#include "UObject/SoftObjectPath.h"

// ============================================================
// Store
// ============================================================

FRiotCharacterProfileStore& FRiotCharacterProfileStore::Get()
{
	static FRiotCharacterProfileStore Instance;
	return Instance;
}

FRiotCharacterProfile* FRiotCharacterProfileStore::Find(const FString& ProfileId)
{
	return Profiles.FindByPredicate(
		[&ProfileId](const FRiotCharacterProfile& P) { return P.ProfileId == ProfileId; });
}

const FRiotCharacterProfile* FRiotCharacterProfileStore::Find(const FString& ProfileId) const
{
	return Profiles.FindByPredicate(
		[&ProfileId](const FRiotCharacterProfile& P) { return P.ProfileId == ProfileId; });
}

FRiotCharacterProfile& FRiotCharacterProfileStore::Add(FRiotCharacterProfile Profile)
{
	return Profiles.Add_GetRef(MoveTemp(Profile));
}

bool FRiotCharacterProfileStore::Remove(const FString& ProfileId)
{
	return Profiles.RemoveAll(
		[&ProfileId](const FRiotCharacterProfile& P) { return P.ProfileId == ProfileId; }) > 0;
}

FRiotRepresentationProfile* FRiotCharacterProfileStore::FindRepresentation(const FString& ProfileId)
{
	return RepresentationProfiles.FindByPredicate(
		[&ProfileId](const FRiotRepresentationProfile& P) { return P.ProfileId == ProfileId; });
}

const FRiotRepresentationProfile* FRiotCharacterProfileStore::FindRepresentation(const FString& ProfileId) const
{
	return RepresentationProfiles.FindByPredicate(
		[&ProfileId](const FRiotRepresentationProfile& P) { return P.ProfileId == ProfileId; });
}

FRiotRepresentationProfile& FRiotCharacterProfileStore::AddRepresentation(FRiotRepresentationProfile Profile)
{
	return RepresentationProfiles.Add_GetRef(MoveTemp(Profile));
}

bool FRiotCharacterProfileStore::RemoveRepresentation(const FString& ProfileId)
{
	return RepresentationProfiles.RemoveAll(
		[&ProfileId](const FRiotRepresentationProfile& P) { return P.ProfileId == ProfileId; }) > 0;
}

void FRiotCharacterProfileStore::ResetForTests()
{
	Profiles.Reset();
	RepresentationProfiles.Reset();
}

// ============================================================
// Lex
// ============================================================

const TCHAR* LexToStringRiotAnimationSlot(ERiotAnimationSlot Slot)
{
	switch (Slot)
	{
	case ERiotAnimationSlot::Idle:       return TEXT("idle");
	case ERiotAnimationSlot::Gathering:  return TEXT("gathering");
	case ERiotAnimationSlot::Advancing:  return TEXT("advancing");
	case ERiotAnimationSlot::Pressuring: return TEXT("pressuring");
	case ERiotAnimationSlot::Breaching:  return TEXT("breaching");
	case ERiotAnimationSlot::Panicked:   return TEXT("panicked");
	case ERiotAnimationSlot::Retreating: return TEXT("retreating");
	case ERiotAnimationSlot::Holding:    return TEXT("holding");
	case ERiotAnimationSlot::Bracing:    return TEXT("bracing");
	case ERiotAnimationSlot::Fallback:   return TEXT("fallback");
	case ERiotAnimationSlot::Broken:     return TEXT("broken");
	case ERiotAnimationSlot::Inactive:   return TEXT("inactive");
	default:                             return TEXT("unknown");
	}
}

bool LexFromStringRiotAnimationSlot(const FString& In, ERiotAnimationSlot& Out)
{
	for (int32 i = 0; i < static_cast<int32>(ERiotAnimationSlot::Max); ++i)
	{
		const ERiotAnimationSlot Slot = static_cast<ERiotAnimationSlot>(i);
		if (In.Equals(LexToStringRiotAnimationSlot(Slot), ESearchCase::IgnoreCase))
		{
			Out = Slot;
			return true;
		}
	}
	return false;
}

const TCHAR* LexToStringRiotAnimationMode(ERiotAnimationMode Mode)
{
	return Mode == ERiotAnimationMode::AnimationBlueprint
		? TEXT("animationBlueprint")
		: TEXT("sequenceSet");
}

bool LexFromStringRiotAnimationMode(const FString& In, ERiotAnimationMode& Out)
{
	if (In.Equals(TEXT("animationBlueprint"), ESearchCase::IgnoreCase))
	{
		Out = ERiotAnimationMode::AnimationBlueprint;
		return true;
	}
	if (In.Equals(TEXT("sequenceSet"), ESearchCase::IgnoreCase))
	{
		Out = ERiotAnimationMode::SequenceSet;
		return true;
	}
	return false;
}

const TCHAR* LexToStringRiotValidationState(ERiotValidationState State)
{
	switch (State)
	{
	case ERiotValidationState::Valid:   return TEXT("valid");
	case ERiotValidationState::Warning: return TEXT("warning");
	case ERiotValidationState::Invalid: return TEXT("invalid");
	default:                            return TEXT("notValidated");
	}
}

const TCHAR* LexToStringRiotCameraSource(ERiotCameraSource Source)
{
	switch (Source)
	{
	case ERiotCameraSource::ExplicitTransform: return TEXT("explicitTransform");
	case ERiotCameraSource::SequencerCamera:   return TEXT("sequencerCamera");
	default:                                   return TEXT("piePlayerCamera");
	}
}

bool LexFromStringRiotCameraSource(const FString& In, ERiotCameraSource& Out)
{
	if (In.Equals(TEXT("piePlayerCamera"), ESearchCase::IgnoreCase))   { Out = ERiotCameraSource::PiePlayerCamera;   return true; }
	if (In.Equals(TEXT("explicitTransform"), ESearchCase::IgnoreCase)) { Out = ERiotCameraSource::ExplicitTransform; return true; }
	if (In.Equals(TEXT("sequencerCamera"), ESearchCase::IgnoreCase))   { Out = ERiotCameraSource::SequencerCamera;   return true; }
	return false;
}

bool LexFromStringRiotFactionType(const FString& In, ERiotFactionType& Out)
{
	if (In.Equals(TEXT("rioter"), ESearchCase::IgnoreCase))   { Out = ERiotFactionType::Rioter;   return true; }
	if (In.Equals(TEXT("police"), ESearchCase::IgnoreCase))   { Out = ERiotFactionType::Police;   return true; }
	if (In.Equals(TEXT("military"), ESearchCase::IgnoreCase)) { Out = ERiotFactionType::Military; return true; }
	if (In.Equals(TEXT("neutral"), ESearchCase::IgnoreCase))  { Out = ERiotFactionType::Neutral;  return true; }
	return false;
}

// ============================================================
// State -> slot mapping
// ============================================================

ERiotAnimationSlot RiotAnimationSlotForState(ERiotAgentState State, ERiotFactionType FactionType)
{
	// CLAUDE-NOTE: Rioter and Neutral read the crowd states literally. Police/Military read the SAME
	// states from the other side of the line: an agent state of Pressuring means the rioters are
	// pushing, which for a defender is Bracing, and Breaching means the line has gone, which for a
	// defender is Broken. Collapsing these into one table would animate one faction wrongly at every
	// contact stage, which is the exact moment the crowd is most readable.
	const bool bDefender =
		FactionType == ERiotFactionType::Police || FactionType == ERiotFactionType::Military;

	if (bDefender)
	{
		switch (State)
		{
		case ERiotAgentState::Queued:
		case ERiotAgentState::Advancing:      return ERiotAnimationSlot::Holding;
		case ERiotAgentState::Blocked:
		case ERiotAgentState::Pressuring:     return ERiotAnimationSlot::Bracing;
		case ERiotAgentState::Breaching:
		case ERiotAgentState::PassedBlockade:
		case ERiotAgentState::Panicked:       return ERiotAnimationSlot::Broken;
		case ERiotAgentState::Retreating:     return ERiotAnimationSlot::Fallback;
		case ERiotAgentState::Inactive:       return ERiotAnimationSlot::Inactive;
		default:                              return ERiotAnimationSlot::Holding;
		}
	}

	switch (State)
	{
	case ERiotAgentState::Queued:         return ERiotAnimationSlot::Idle;
	case ERiotAgentState::Advancing:      return ERiotAnimationSlot::Advancing;
	case ERiotAgentState::Blocked:        return ERiotAnimationSlot::Gathering;
	case ERiotAgentState::Pressuring:     return ERiotAnimationSlot::Pressuring;
	case ERiotAgentState::Breaching:      return ERiotAnimationSlot::Breaching;
	case ERiotAgentState::PassedBlockade: return ERiotAnimationSlot::Advancing;
	case ERiotAgentState::Panicked:       return ERiotAnimationSlot::Panicked;
	case ERiotAgentState::Retreating:     return ERiotAnimationSlot::Retreating;
	case ERiotAgentState::Inactive:       return ERiotAnimationSlot::Inactive;
	default:                              return ERiotAnimationSlot::Idle;
	}
}

ERiotAnimationSlot RiotAnimationSlotFallback(ERiotAnimationSlot Slot)
{
	// CLAUDE-NOTE: every chain terminates at Idle, and locomotion-flavoured slots route through
	// Advancing first so a profile that supplies only walk+idle still reads correctly: a panicking
	// rioter with no panic animation runs rather than standing still, which is far less wrong than
	// the reverse. Idle returns Max to mark the chain root.
	switch (Slot)
	{
	case ERiotAnimationSlot::Gathering:  return ERiotAnimationSlot::Idle;
	case ERiotAnimationSlot::Advancing:  return ERiotAnimationSlot::Idle;
	case ERiotAnimationSlot::Pressuring: return ERiotAnimationSlot::Advancing;
	case ERiotAnimationSlot::Breaching:  return ERiotAnimationSlot::Advancing;
	case ERiotAnimationSlot::Panicked:   return ERiotAnimationSlot::Advancing;
	case ERiotAnimationSlot::Retreating: return ERiotAnimationSlot::Advancing;
	case ERiotAnimationSlot::Holding:    return ERiotAnimationSlot::Idle;
	case ERiotAnimationSlot::Bracing:    return ERiotAnimationSlot::Holding;
	case ERiotAnimationSlot::Fallback:   return ERiotAnimationSlot::Advancing;
	case ERiotAnimationSlot::Broken:     return ERiotAnimationSlot::Idle;
	case ERiotAnimationSlot::Inactive:   return ERiotAnimationSlot::Idle;
	case ERiotAnimationSlot::Idle:
	default:                             return ERiotAnimationSlot::Max;
	}
}

const FRiotAnimationBinding* FRiotCharacterProfile::FindBinding(ERiotAnimationSlot Slot) const
{
	const FRiotAnimationBinding* Found = AnimationSet.FindByPredicate(
		[Slot](const FRiotAnimationBinding& B) { return B.Slot == Slot; });
	return (Found && !Found->AnimationPath.IsEmpty()) ? Found : nullptr;
}

bool FRiotCharacterProfile::SupportsFactionType(ERiotFactionType Type) const
{
	return FactionTypes.Num() == 0 || FactionTypes.Contains(Type);
}

bool ResolveRiotAnimationSlot(const FRiotCharacterProfile& Profile, ERiotAnimationSlot Requested,
	ERiotAnimationSlot& OutResolved, bool& bOutUsedFallback)
{
	bOutUsedFallback = false;

	// CLAUDE-NOTE: bounded walk. The chain is acyclic by construction (every edge moves toward Idle)
	// but the loop is still capped, because a future edit to RiotAnimationSlotFallback that
	// accidentally introduces a cycle would otherwise hang the game thread rather than fail a test.
	ERiotAnimationSlot Current = Requested;
	for (int32 Step = 0; Step <= static_cast<int32>(ERiotAnimationSlot::Max); ++Step)
	{
		if (Profile.FindBinding(Current))
		{
			OutResolved = Current;
			bOutUsedFallback = (Current != Requested);
			return true;
		}

		const ERiotAnimationSlot Next = RiotAnimationSlotFallback(Current);
		if (Next == ERiotAnimationSlot::Max)
		{
			return false;
		}
		Current = Next;
	}
	return false;
}

TArray<ERiotAnimationSlot> RequiredRiotAnimationSlots(const FRiotCharacterProfile& Profile)
{
	// CLAUDE-NOTE: deliberately small. Requiring all twelve slots would reject every realistic
	// starter asset set (the Third Person template ships idle + a locomotion set and nothing else),
	// which would make the validator useless in exactly the case it is meant to serve. Everything
	// else resolves through the fallback chain and is reported as a warning, so an operator can see
	// how much of the crowd is reusing animation without being blocked from running at all.
	TArray<ERiotAnimationSlot> Required;
	Required.Add(ERiotAnimationSlot::Idle);
	Required.Add(ERiotAnimationSlot::Advancing);

	const bool bDefenderOnly =
		Profile.FactionTypes.Num() > 0
		&& !Profile.FactionTypes.Contains(ERiotFactionType::Rioter)
		&& !Profile.FactionTypes.Contains(ERiotFactionType::Neutral);
	if (bDefenderOnly)
	{
		Required.Add(ERiotAnimationSlot::Holding);
	}
	return Required;
}

// ============================================================
// Validation
// ============================================================

bool ValidateRiotCharacterProfileSchema(const FRiotCharacterProfile& Profile,
	FString& OutErrorCode, FString& OutMessage)
{
	if (!IsValidRiotId(Profile.ProfileId))
	{
		OutErrorCode = RiotErrorCodes::ScenarioInvalid;
		OutMessage = TEXT("profileId must be non-empty, at most 64 characters, and contain only "
			"[A-Za-z0-9_-].");
		return false;
	}

	if (!(Profile.SelectionWeight > 0.0) || !FMath::IsFinite(Profile.SelectionWeight))
	{
		OutErrorCode = RiotErrorCodes::InvalidSelectionWeight;
		OutMessage = FString::Printf(
			TEXT("Profile '%s' has selectionWeight %.4f. It must be a finite value greater than 0 — "
				 "a zero or negative weight can never be selected, which is a silent no-op rather "
				 "than a configuration."),
			*Profile.ProfileId, Profile.SelectionWeight);
		return false;
	}

	if (Profile.SkeletalMeshPath.IsEmpty())
	{
		OutErrorCode = RiotErrorCodes::InvalidSkeletalMesh;
		OutMessage = FString::Printf(
			TEXT("Profile '%s' has no skeletalMeshPath. A rigged character profile without a mesh "
				 "has nothing to represent."), *Profile.ProfileId);
		return false;
	}

	if (Profile.AnimationMode == ERiotAnimationMode::AnimationBlueprint
		&& Profile.AnimationBlueprintPath.IsEmpty())
	{
		OutErrorCode = RiotErrorCodes::AnimBlueprintInvalid;
		OutMessage = FString::Printf(
			TEXT("Profile '%s' uses animationMode 'animationBlueprint' but supplies no "
				 "animationBlueprintPath."), *Profile.ProfileId);
		return false;
	}

	if (Profile.AnimationMode == ERiotAnimationMode::SequenceSet && Profile.AnimationSet.Num() == 0)
	{
		OutErrorCode = RiotErrorCodes::AnimationMappingIncomplete;
		OutMessage = FString::Printf(
			TEXT("Profile '%s' uses animationMode 'sequenceSet' but binds no animations."),
			*Profile.ProfileId);
		return false;
	}

	// Duplicate slot bindings are a configuration mistake that silently drops one of the two.
	TSet<ERiotAnimationSlot> Seen;
	for (const FRiotAnimationBinding& Binding : Profile.AnimationSet)
	{
		bool bAlready = false;
		Seen.Add(Binding.Slot, &bAlready);
		if (bAlready)
		{
			OutErrorCode = RiotErrorCodes::AnimationMappingIncomplete;
			OutMessage = FString::Printf(
				TEXT("Profile '%s' binds animation slot '%s' more than once. One of the bindings "
					 "would be silently ignored."),
				*Profile.ProfileId, LexToStringRiotAnimationSlot(Binding.Slot));
			return false;
		}

		if (!(Binding.PlayRate > 0.0) || !FMath::IsFinite(Binding.PlayRate))
		{
			OutErrorCode = RiotErrorCodes::InvalidAnimationAsset;
			OutMessage = FString::Printf(
				TEXT("Profile '%s' slot '%s' has playRate %.4f; it must be finite and greater than 0."),
				*Profile.ProfileId, LexToStringRiotAnimationSlot(Binding.Slot), Binding.PlayRate);
			return false;
		}
	}

	return true;
}

namespace
{
	/**
	 * CLAUDE-NOTE: TryLoad() rather than LoadObject<T>() so that a path pointing at the WRONG asset
	 * type produces "loaded, but it is a UStaticMesh" rather than a bare null. That distinction is
	 * the difference between RIOT_INVALID_SKELETAL_MESH ("this is not a skeletal mesh") and
	 * RIOT_ASSET_LOAD_FAILED ("nothing is there"), and the operator needs to know which.
	 */
	UObject* TryLoadRiotAsset(const FString& Path)
	{
		if (Path.IsEmpty())
		{
			return nullptr;
		}
		const FSoftObjectPath SoftPath(Path);
		return SoftPath.IsValid() ? SoftPath.TryLoad() : nullptr;
	}

	FString DescribeLoadedType(const UObject* Object)
	{
		return Object ? Object->GetClass()->GetName() : FString(TEXT("<nothing>"));
	}
}

bool ValidateRiotCharacterProfileAssets(FRiotCharacterProfile& Profile,
	FString& OutErrorCode, FString& OutMessage)
{
	Profile.Warnings.Reset();
	Profile.FailureCode.Reset();
	Profile.FailureMessage.Reset();

	auto Fail = [&Profile, &OutErrorCode, &OutMessage](const TCHAR* Code, const FString& Message)
	{
		Profile.ValidationState = ERiotValidationState::Invalid;
		Profile.FailureCode = Code;
		Profile.FailureMessage = Message;
		OutErrorCode = Code;
		OutMessage = Message;
		return false;
	};

	if (!ValidateRiotCharacterProfileSchema(Profile, OutErrorCode, OutMessage))
	{
		return Fail(*OutErrorCode, OutMessage);
	}

	// ----- skeletal mesh -----
	UObject* MeshObject = TryLoadRiotAsset(Profile.SkeletalMeshPath);
	if (!MeshObject)
	{
		return Fail(RiotErrorCodes::AssetLoadFailed, FString::Printf(
			TEXT("Profile '%s': nothing could be loaded from skeletalMeshPath '%s'. The path may be "
				 "misspelled, or the asset may not exist in this project."),
			*Profile.ProfileId, *Profile.SkeletalMeshPath));
	}

	USkeletalMesh* SkeletalMesh = Cast<USkeletalMesh>(MeshObject);
	if (!SkeletalMesh)
	{
		return Fail(RiotErrorCodes::InvalidSkeletalMesh, FString::Printf(
			TEXT("Profile '%s': skeletalMeshPath '%s' loaded a %s, not a SkeletalMesh."),
			*Profile.ProfileId, *Profile.SkeletalMeshPath, *DescribeLoadedType(MeshObject)));
	}

	// ----- skeleton -----
	USkeleton* MeshSkeleton = SkeletalMesh->GetSkeleton();
	if (!MeshSkeleton)
	{
		return Fail(RiotErrorCodes::InvalidSkeleton, FString::Printf(
			TEXT("Profile '%s': skeletal mesh '%s' has no skeleton assigned."),
			*Profile.ProfileId, *Profile.SkeletalMeshPath));
	}

	USkeleton* Skeleton = MeshSkeleton;
	if (!Profile.SkeletonPath.IsEmpty())
	{
		UObject* SkeletonObject = TryLoadRiotAsset(Profile.SkeletonPath);
		if (!SkeletonObject)
		{
			return Fail(RiotErrorCodes::AssetLoadFailed, FString::Printf(
				TEXT("Profile '%s': nothing could be loaded from skeletonPath '%s'."),
				*Profile.ProfileId, *Profile.SkeletonPath));
		}

		Skeleton = Cast<USkeleton>(SkeletonObject);
		if (!Skeleton)
		{
			return Fail(RiotErrorCodes::InvalidSkeleton, FString::Printf(
				TEXT("Profile '%s': skeletonPath '%s' loaded a %s, not a Skeleton."),
				*Profile.ProfileId, *Profile.SkeletonPath, *DescribeLoadedType(SkeletonObject)));
		}

		// CLAUDE-NOTE: IsCompatibleMesh rather than pointer equality. UE supports compatible-skeleton
		// chains, so a mesh whose own skeleton differs from the declared one can still be legitimate.
		// Requiring identity here would reject valid setups; skipping the check entirely would let a
		// genuinely mismatched pair through, which loads fine and then animates as garbage.
		if (Skeleton != MeshSkeleton && !Skeleton->IsCompatibleMesh(SkeletalMesh))
		{
			return Fail(RiotErrorCodes::SkeletonMismatch, FString::Printf(
				TEXT("Profile '%s': skeleton '%s' is not compatible with skeletal mesh '%s' (the "
					 "mesh's own skeleton is '%s')."),
				*Profile.ProfileId, *Profile.SkeletonPath, *Profile.SkeletalMeshPath,
				*MeshSkeleton->GetPathName()));
		}
	}
	else
	{
		Profile.SkeletonPath = MeshSkeleton->GetPathName();
		Profile.Warnings.Add(FString::Printf(
			TEXT("No skeletonPath supplied; derived '%s' from the skeletal mesh."),
			*Profile.SkeletonPath));
	}

	// ----- animation blueprint -----
	if (Profile.AnimationMode == ERiotAnimationMode::AnimationBlueprint)
	{
		// CLAUDE-NOTE: operators reference the ABP asset, but what a SkeletalMeshComponent needs is
		// the GENERATED CLASS. Accept either spelling and normalise, because "/Game/ABP_Rioter" and
		// "/Game/ABP_Rioter.ABP_Rioter_C" both mean the same thing to a human and only one of them
		// resolves with LoadClass.
		FString ClassPath = Profile.AnimationBlueprintPath;
		if (!ClassPath.EndsWith(TEXT("_C")))
		{
			FString ObjectName;
			if (ClassPath.Split(TEXT("."), nullptr, &ObjectName))
			{
				ClassPath = ClassPath + TEXT("_C");
			}
			else
			{
				int32 SlashIndex = INDEX_NONE;
				ClassPath.FindLastChar(TEXT('/'), SlashIndex);
				const FString AssetName = (SlashIndex == INDEX_NONE)
					? ClassPath
					: ClassPath.RightChop(SlashIndex + 1);
				ClassPath = ClassPath + TEXT(".") + AssetName + TEXT("_C");
			}
		}

		UClass* AnimClass = LoadClass<UAnimInstance>(nullptr, *ClassPath);
		if (!AnimClass)
		{
			return Fail(RiotErrorCodes::AnimBlueprintInvalid, FString::Printf(
				TEXT("Profile '%s': animationBlueprintPath '%s' did not resolve to an AnimInstance "
					 "class (tried '%s'). Supply the Animation Blueprint asset path."),
				*Profile.ProfileId, *Profile.AnimationBlueprintPath, *ClassPath));
		}
	}

	// ----- animation sequences -----
	int32 BoundCount = 0;
	for (const FRiotAnimationBinding& Binding : Profile.AnimationSet)
	{
		if (Binding.AnimationPath.IsEmpty())
		{
			continue;
		}

		UObject* AnimObject = TryLoadRiotAsset(Binding.AnimationPath);
		if (!AnimObject)
		{
			return Fail(RiotErrorCodes::AssetLoadFailed, FString::Printf(
				TEXT("Profile '%s' slot '%s': nothing could be loaded from '%s'."),
				*Profile.ProfileId, LexToStringRiotAnimationSlot(Binding.Slot),
				*Binding.AnimationPath));
		}

		UAnimSequenceBase* AnimSequence = Cast<UAnimSequenceBase>(AnimObject);
		if (!AnimSequence)
		{
			return Fail(RiotErrorCodes::InvalidAnimationAsset, FString::Printf(
				TEXT("Profile '%s' slot '%s': '%s' loaded a %s, not an animation asset."),
				*Profile.ProfileId, LexToStringRiotAnimationSlot(Binding.Slot),
				*Binding.AnimationPath, *DescribeLoadedType(AnimObject)));
		}

		USkeleton* AnimSkeleton = AnimSequence->GetSkeleton();
		if (!AnimSkeleton)
		{
			return Fail(RiotErrorCodes::InvalidAnimationAsset, FString::Printf(
				TEXT("Profile '%s' slot '%s': animation '%s' has no skeleton."),
				*Profile.ProfileId, LexToStringRiotAnimationSlot(Binding.Slot),
				*Binding.AnimationPath));
		}

		// The failure this exists to catch: an animation authored for a different rig. It loads
		// perfectly and then plays as garbage, so silence here would be worse than a hard error.
		//
		// CLAUDE-NOTE: IsCompatibleForEditor, not IsCompatible. 5.6 deprecates the latter with
		// "Compatibility is now an editor-only concern... otherwise your project will no longer
		// compile" on the next release. This module already depends on UnrealEd, so it is only ever
		// built with WITH_EDITOR; the guard is there so the file stays honest about the requirement
		// rather than relying on that staying true.
#if WITH_EDITOR
		const bool bSkeletonCompatible = Skeleton->IsCompatibleForEditor(AnimSkeleton);
#else
		const bool bSkeletonCompatible = false;
#endif
		if (AnimSkeleton != Skeleton && !bSkeletonCompatible)
		{
			return Fail(RiotErrorCodes::SkeletonMismatch, FString::Printf(
				TEXT("Profile '%s' slot '%s': animation '%s' targets skeleton '%s', which is not "
					 "compatible with the profile's skeleton '%s'. Retargeting is out of scope for "
					 "this milestone — supply an animation authored for this skeleton."),
				*Profile.ProfileId, LexToStringRiotAnimationSlot(Binding.Slot),
				*Binding.AnimationPath, *AnimSkeleton->GetPathName(), *Skeleton->GetPathName()));
		}

		++BoundCount;
	}

	// ----- material overrides (non-fatal) -----
	for (int32 SlotIndex = 0; SlotIndex < Profile.MaterialOverrides.Num(); ++SlotIndex)
	{
		const FString& MaterialPath = Profile.MaterialOverrides[SlotIndex];
		if (MaterialPath.IsEmpty())
		{
			continue;
		}

		UObject* MaterialObject = TryLoadRiotAsset(MaterialPath);
		if (!Cast<UMaterialInterface>(MaterialObject))
		{
			// CLAUDE-NOTE: a warning rather than an error on purpose. A bad material override
			// produces a visibly wrong-coloured but fully functional character, whereas a bad
			// animation produces a broken one. Failing the whole profile over a tint would block a
			// run for a cosmetic problem.
			Profile.Warnings.Add(FString::Printf(
				TEXT("Material override for slot %d ('%s') did not load as a material (%s); the "
					 "mesh's own material will be used for that slot."),
				SlotIndex, *MaterialPath, *DescribeLoadedType(MaterialObject)));
		}
	}

	// ----- required slot resolution -----
	if (Profile.AnimationMode == ERiotAnimationMode::SequenceSet)
	{
		if (BoundCount == 0)
		{
			return Fail(RiotErrorCodes::AnimationMappingIncomplete, FString::Printf(
				TEXT("Profile '%s' resolved no usable animation bindings."), *Profile.ProfileId));
		}

		for (const ERiotAnimationSlot Slot : RequiredRiotAnimationSlots(Profile))
		{
			ERiotAnimationSlot Resolved = ERiotAnimationSlot::Idle;
			bool bUsedFallback = false;
			if (!ResolveRiotAnimationSlot(Profile, Slot, Resolved, bUsedFallback))
			{
				return Fail(RiotErrorCodes::AnimationMappingIncomplete, FString::Printf(
					TEXT("Profile '%s': required animation slot '%s' does not resolve, and neither "
						 "does anything in its fallback chain."),
					*Profile.ProfileId, LexToStringRiotAnimationSlot(Slot)));
			}
		}

		// Report every slot that will be reusing another slot's animation, so the acceptance record
		// can state honestly how much distinct animation is actually on screen.
		for (int32 i = 0; i < static_cast<int32>(ERiotAnimationSlot::Max); ++i)
		{
			const ERiotAnimationSlot Slot = static_cast<ERiotAnimationSlot>(i);
			ERiotAnimationSlot Resolved = ERiotAnimationSlot::Idle;
			bool bUsedFallback = false;
			if (ResolveRiotAnimationSlot(Profile, Slot, Resolved, bUsedFallback) && bUsedFallback)
			{
				Profile.Warnings.Add(FString::Printf(
					TEXT("Slot '%s' is unbound and falls back to '%s'."),
					LexToStringRiotAnimationSlot(Slot), LexToStringRiotAnimationSlot(Resolved)));
			}
		}
	}

	Profile.ValidationState = Profile.Warnings.Num() > 0
		? ERiotValidationState::Warning
		: ERiotValidationState::Valid;
	return true;
}

bool ValidateRiotRepresentationProfile(const FRiotRepresentationProfile& Profile,
	FString& OutErrorCode, FString& OutMessage)
{
	if (!IsValidRiotId(Profile.ProfileId))
	{
		OutErrorCode = RiotErrorCodes::ScenarioInvalid;
		OutMessage = TEXT("profileId must be non-empty, at most 64 characters, and contain only "
			"[A-Za-z0-9_-].");
		return false;
	}

	if (!(Profile.NearDistance > 0.0) || !(Profile.MidDistance > Profile.NearDistance)
		|| !(Profile.FarDistance > Profile.MidDistance))
	{
		OutErrorCode = RiotErrorCodes::InvalidRepresentationRange;
		OutMessage = FString::Printf(
			TEXT("Representation profile '%s' has distances near=%.1f mid=%.1f far=%.1f. They must "
				 "be strictly increasing and positive; an out-of-order band can never be entered."),
			*Profile.ProfileId, Profile.NearDistance, Profile.MidDistance, Profile.FarDistance);
		return false;
	}

	if (Profile.HysteresisDistance < 0.0)
	{
		OutErrorCode = RiotErrorCodes::InvalidRepresentationRange;
		OutMessage = FString::Printf(
			TEXT("Representation profile '%s' has negative hysteresisDistance %.1f."),
			*Profile.ProfileId, Profile.HysteresisDistance);
		return false;
	}

	// CLAUDE-NOTE: hysteresis wider than half the narrowest band would make the two band edges
	// overlap, so an agent could satisfy "enter" and "leave" simultaneously and oscillate — the exact
	// failure hysteresis exists to prevent.
	const double NarrowestBand = FMath::Min(
		Profile.MidDistance - Profile.NearDistance,
		Profile.FarDistance - Profile.MidDistance);
	if (Profile.HysteresisDistance > NarrowestBand * 0.5)
	{
		OutErrorCode = RiotErrorCodes::InvalidRepresentationRange;
		OutMessage = FString::Printf(
			TEXT("Representation profile '%s' has hysteresisDistance %.1f, which exceeds half the "
				 "narrowest band (%.1f). Overlapping band edges would oscillate rather than damp."),
			*Profile.ProfileId, Profile.HysteresisDistance, NarrowestBand * 0.5);
		return false;
	}

	if (Profile.MaxNearActors < 0 || Profile.MaxMidRepresentations < 0)
	{
		OutErrorCode = RiotErrorCodes::InvalidRepresentationRange;
		OutMessage = FString::Printf(
			TEXT("Representation profile '%s' has a negative budget (maxNearActors=%d, "
				 "maxMidRepresentations=%d)."),
			*Profile.ProfileId, Profile.MaxNearActors, Profile.MaxMidRepresentations);
		return false;
	}

	if (Profile.NearUpdateInterval < 0.0 || Profile.MidUpdateInterval < 0.0
		|| Profile.FarUpdateInterval < 0.0)
	{
		OutErrorCode = RiotErrorCodes::InvalidRepresentationRange;
		OutMessage = FString::Printf(
			TEXT("Representation profile '%s' has a negative update interval."), *Profile.ProfileId);
		return false;
	}

	return true;
}

// ============================================================
// Deterministic selection
// ============================================================

int32 SelectRiotProfileForAgent(const TArray<const FRiotCharacterProfile*>& Eligible, uint32 SeedSalt)
{
	if (Eligible.Num() == 0)
	{
		return INDEX_NONE;
	}

	double TotalWeight = 0.0;
	for (const FRiotCharacterProfile* Profile : Eligible)
	{
		if (Profile && Profile->IsUsable())
		{
			TotalWeight += Profile->SelectionWeight;
		}
	}

	if (!(TotalWeight > 0.0))
	{
		return INDEX_NONE;
	}

	// CLAUDE-NOTE: hash the salt again rather than using it raw. SeedSalt is derived from
	// (scenario seed, origin index, spawn ordinal), so consecutive agents from one origin carry
	// consecutive-ish salts. Feeding those straight into a modulo would band the crowd into visible
	// stripes of identical characters by spawn order. A hash decorrelates them while staying
	// perfectly reproducible for a given seed.
	const uint32 Hashed = HashCombine(SeedSalt, 0x9E3779B9u);
	const double Roll = (static_cast<double>(Hashed) / static_cast<double>(MAX_uint32)) * TotalWeight;

	double Accumulated = 0.0;
	int32 LastUsable = INDEX_NONE;
	for (int32 Index = 0; Index < Eligible.Num(); ++Index)
	{
		const FRiotCharacterProfile* Profile = Eligible[Index];
		if (!Profile || !Profile->IsUsable())
		{
			continue;
		}
		LastUsable = Index;
		Accumulated += Profile->SelectionWeight;
		if (Roll < Accumulated)
		{
			return Index;
		}
	}

	// Floating-point accumulation can leave Roll a hair above the final boundary.
	return LastUsable;
}

// ============================================================
// JSON
// ============================================================

TSharedRef<FJsonObject> FRiotCharacterProfile::ToJson() const
{
	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("profileId"), ProfileId);
	Json->SetStringField(TEXT("displayName"), DisplayName);
	Json->SetNumberField(TEXT("schemaVersion"), SchemaVersion);

	TArray<TSharedPtr<FJsonValue>> FactionArray;
	for (const ERiotFactionType Type : FactionTypes)
	{
		FactionArray.Add(MakeShared<FJsonValueString>(LexToStringRiotFactionType(Type)));
	}
	Json->SetArrayField(TEXT("factionTypes"), FactionArray);

	Json->SetNumberField(TEXT("selectionWeight"), SelectionWeight);
	Json->SetStringField(TEXT("skeletalMeshPath"), SkeletalMeshPath);
	Json->SetStringField(TEXT("skeletonPath"), SkeletonPath);
	Json->SetStringField(TEXT("animationMode"), LexToStringRiotAnimationMode(AnimationMode));
	Json->SetStringField(TEXT("animationBlueprintPath"), AnimationBlueprintPath);

	TArray<TSharedPtr<FJsonValue>> BindingArray;
	for (const FRiotAnimationBinding& Binding : AnimationSet)
	{
		TSharedRef<FJsonObject> BindingJson = MakeShared<FJsonObject>();
		BindingJson->SetStringField(TEXT("slot"), LexToStringRiotAnimationSlot(Binding.Slot));
		BindingJson->SetStringField(TEXT("animationPath"), Binding.AnimationPath);
		BindingJson->SetNumberField(TEXT("playRate"), Binding.PlayRate);
		BindingJson->SetBoolField(TEXT("looping"), Binding.bLooping);
		BindingArray.Add(MakeShared<FJsonValueObject>(BindingJson));
	}
	Json->SetArrayField(TEXT("animationSet"), BindingArray);

	TArray<TSharedPtr<FJsonValue>> MaterialArray;
	for (const FString& Path : MaterialOverrides)
	{
		MaterialArray.Add(MakeShared<FJsonValueString>(Path));
	}
	Json->SetArrayField(TEXT("materialOverrides"), MaterialArray);

	Json->SetStringField(TEXT("representationProfileId"), RepresentationProfileId);
	Json->SetBoolField(TEXT("enabled"), bEnabled);
	Json->SetStringField(TEXT("validationState"), LexToStringRiotValidationState(ValidationState));

	// Resolved slot map, so an operator can see exactly which animation each state will play and
	// which of those are reused rather than distinct.
	TArray<TSharedPtr<FJsonValue>> ResolvedArray;
	for (int32 i = 0; i < static_cast<int32>(ERiotAnimationSlot::Max); ++i)
	{
		const ERiotAnimationSlot Slot = static_cast<ERiotAnimationSlot>(i);
		ERiotAnimationSlot Resolved = ERiotAnimationSlot::Idle;
		bool bUsedFallback = false;
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("slot"), LexToStringRiotAnimationSlot(Slot));
		if (ResolveRiotAnimationSlot(*this, Slot, Resolved, bUsedFallback))
		{
			Entry->SetStringField(TEXT("resolvedSlot"), LexToStringRiotAnimationSlot(Resolved));
			Entry->SetBoolField(TEXT("usedFallback"), bUsedFallback);
			if (const FRiotAnimationBinding* Binding = FindBinding(Resolved))
			{
				Entry->SetStringField(TEXT("animationPath"), Binding->AnimationPath);
			}
		}
		else
		{
			Entry->SetStringField(TEXT("resolvedSlot"), TEXT("unresolved"));
			Entry->SetBoolField(TEXT("usedFallback"), false);
		}
		ResolvedArray.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Json->SetArrayField(TEXT("resolvedAnimationSlots"), ResolvedArray);

	TArray<TSharedPtr<FJsonValue>> WarningArray;
	for (const FString& Warning : Warnings)
	{
		WarningArray.Add(MakeShared<FJsonValueString>(Warning));
	}
	Json->SetArrayField(TEXT("warnings"), WarningArray);

	if (!FailureCode.IsEmpty())
	{
		Json->SetStringField(TEXT("failureCode"), FailureCode);
		Json->SetStringField(TEXT("failureMessage"), FailureMessage);
	}

	return Json;
}

TSharedRef<FJsonObject> FRiotRepresentationProfile::ToJson() const
{
	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("profileId"), ProfileId);
	Json->SetNumberField(TEXT("schemaVersion"), SchemaVersion);
	Json->SetNumberField(TEXT("nearDistance"), NearDistance);
	Json->SetNumberField(TEXT("midDistance"), MidDistance);
	Json->SetNumberField(TEXT("farDistance"), FarDistance);
	Json->SetNumberField(TEXT("hysteresisDistance"), HysteresisDistance);
	Json->SetNumberField(TEXT("maxNearActors"), MaxNearActors);
	Json->SetNumberField(TEXT("maxMidRepresentations"), MaxMidRepresentations);
	Json->SetBoolField(TEXT("farRepresentationEnabled"), bFarRepresentationEnabled);

	TSharedRef<FJsonObject> Intervals = MakeShared<FJsonObject>();
	Intervals->SetNumberField(TEXT("near"), NearUpdateInterval);
	Intervals->SetNumberField(TEXT("mid"), MidUpdateInterval);
	Intervals->SetNumberField(TEXT("far"), FarUpdateInterval);
	Json->SetObjectField(TEXT("updateIntervals"), Intervals);

	Json->SetStringField(TEXT("cameraSource"), LexToStringRiotCameraSource(CameraSource));
	Json->SetStringField(TEXT("fallbackBehavior"),
		FallbackBehavior == ERiotRepresentationFallback::Hidden ? TEXT("hidden") : TEXT("placeholderMesh"));

	return Json;
}
