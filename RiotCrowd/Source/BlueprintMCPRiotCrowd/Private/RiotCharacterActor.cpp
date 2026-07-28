#include "RiotCharacterActor.h"

#include "Animation/AnimInstance.h"
#include "Animation/AnimSequenceBase.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Materials/MaterialInterface.h"
#include "UObject/SoftObjectPath.h"

const TCHAR* LexToStringRiotRepresentationTier(ERiotRepresentationTier Tier)
{
	switch (Tier)
	{
	case ERiotRepresentationTier::Near:        return TEXT("near");
	case ERiotRepresentationTier::Mid:         return TEXT("mid");
	case ERiotRepresentationTier::Far:         return TEXT("far");
	case ERiotRepresentationTier::Placeholder: return TEXT("placeholder");
	default:                                   return TEXT("none");
	}
}

ARiotCharacterActor::ARiotCharacterActor()
{
	PrimaryActorTick.bCanEverTick = false;

	// CLAUDE-NOTE: a scene root with the mesh ATTACHED, not the mesh as root. The actor's rotation is
	// the agent's travel facing; the mesh needs an additional per-profile yaw on top of that because
	// skeletal meshes carry their own authoring convention (Epic's face +Y, so -90 aligns them with
	// the actor's +X). A relative rotation can only exist on a non-root component.
	USceneComponent* SceneRoot = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(SceneRoot);

	MeshComponent = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("Mesh"));
	MeshComponent->SetupAttachment(SceneRoot);

	// CLAUDE-NOTE: no collision, ever. These actors are a view of Mass entities, and hundreds of
	// colliding capsules would both cost more than the animation does and let physics fight Mass for
	// authority over position. Melee and shield contact are explicit non-goals of this milestone; if
	// they arrive, collision belongs on a deliberately promoted subset, not on the whole pool.
	MeshComponent->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	MeshComponent->SetGenerateOverlapEvents(false);
	MeshComponent->bReceivesDecals = false;

	// The pool hands the same actor back repeatedly; nothing about it should persist in a save or
	// be considered part of the level.
	SetActorEnableCollision(false);
}

void ARiotCharacterActor::PrepareForPooling_Implementation()
{
	// CLAUDE-NOTE: this is the hook that prevents the classic pooled-skeletal bug — a recycled actor
	// showing the PREVIOUS agent's pose for a frame before the new state is applied. Stopping the
	// anim instance and clearing the mesh means a reused actor has nothing stale to display, and the
	// next ApplyProfile always starts from empty.
	if (MeshComponent)
	{
		MeshComponent->Stop();
		MeshComponent->SetAnimationMode(EAnimationMode::AnimationSingleNode);
		MeshComponent->SetAnimation(nullptr);
		MeshComponent->SetSkeletalMesh(nullptr);
		MeshComponent->SetVisibility(false, true);
		MeshComponent->SetComponentTickEnabled(false);
	}

	SetActorHiddenInGame(true);
	SetActorTickEnabled(false);

	bHasProfile = false;
	ActiveProfile = FRiotCharacterProfile();
	CurrentSlot = ERiotAnimationSlot::Max;
	CurrentTier = ERiotRepresentationTier::None;
	CharacterProfileId.Reset();
	bIsPromoted = false;
	bIsMoving = false;
	Speed = 0.f;
	NormalizedSpeed = 0.f;
	PhaseOffset = 0.f;
	PlayRateScale = 1.f;
}

void ARiotCharacterActor::PrepareForGame_Implementation()
{
	SetActorHiddenInGame(false);
	if (MeshComponent)
	{
		MeshComponent->SetVisibility(true, true);
		MeshComponent->SetComponentTickEnabled(true);
	}
}

void ARiotCharacterActor::SetVariation(float InPhaseOffset, float InPlayRateScale)
{
	PhaseOffset = InPhaseOffset;
	PlayRateScale = FMath::Clamp(InPlayRateScale, 0.5f, 1.5f);
	SeedPhase = FMath::Frac(FMath::Abs(InPhaseOffset));
}

bool ARiotCharacterActor::ApplyProfile(const FRiotCharacterProfile& Profile)
{
	if (!MeshComponent)
	{
		return false;
	}

	ActiveProfile = Profile;
	CharacterProfileId = Profile.ProfileId;
	bHasProfile = false;
	CurrentSlot = ERiotAnimationSlot::Max;

	// Apply the profile's mesh-forward correction. See MeshYawOffsetDegrees in RiotCharacterProfile.h.
	MeshComponent->SetRelativeRotation(FRotator(0.0, Profile.MeshYawOffsetDegrees, 0.0));

	USkeletalMesh* Mesh = Cast<USkeletalMesh>(FSoftObjectPath(Profile.SkeletalMeshPath).TryLoad());
	if (!Mesh)
	{
		// Validation should have caught this long before a spawn. Reaching here means the asset was
		// removed between registration and use, so fail rather than render an empty actor that looks
		// like a representation bug.
		return false;
	}
	MeshComponent->SetSkeletalMesh(Mesh);

	for (int32 SlotIndex = 0; SlotIndex < Profile.MaterialOverrides.Num(); ++SlotIndex)
	{
		const FString& Path = Profile.MaterialOverrides[SlotIndex];
		if (Path.IsEmpty())
		{
			continue;
		}
		if (UMaterialInterface* Material = Cast<UMaterialInterface>(FSoftObjectPath(Path).TryLoad()))
		{
			MeshComponent->SetMaterial(SlotIndex, Material);
		}
	}

	if (Profile.AnimationMode == ERiotAnimationMode::AnimationBlueprint)
	{
		// CLAUDE-NOTE: accept either the asset path or the generated-class path, matching what
		// ValidateRiotCharacterProfileAssets accepts. Doing the normalisation in both places rather
		// than storing a normalised value keeps the profile round-tripping exactly what the operator
		// supplied, which is what they see in riot_get_character_profile.
		FString ClassPath = Profile.AnimationBlueprintPath;
		if (!ClassPath.EndsWith(TEXT("_C")))
		{
			FString ObjectName;
			if (ClassPath.Split(TEXT("."), nullptr, &ObjectName))
			{
				ClassPath += TEXT("_C");
			}
			else
			{
				int32 SlashIndex = INDEX_NONE;
				ClassPath.FindLastChar(TEXT('/'), SlashIndex);
				const FString AssetName = (SlashIndex == INDEX_NONE)
					? ClassPath : ClassPath.RightChop(SlashIndex + 1);
				ClassPath += TEXT(".") + AssetName + TEXT("_C");
			}
		}

		if (UClass* AnimClass = LoadClass<UAnimInstance>(nullptr, *ClassPath))
		{
			MeshComponent->SetAnimationMode(EAnimationMode::AnimationBlueprint);
			MeshComponent->SetAnimInstanceClass(AnimClass);
		}
		else
		{
			return false;
		}
	}
	else
	{
		MeshComponent->SetAnimationMode(EAnimationMode::AnimationSingleNode);
	}

	bHasProfile = true;
	return true;
}

void ARiotCharacterActor::ApplyTier(ERiotRepresentationTier Tier)
{
	if (!MeshComponent || Tier == CurrentTier)
	{
		return;
	}
	CurrentTier = Tier;

	switch (Tier)
	{
	case ERiotRepresentationTier::Near:
		// CLAUDE-NOTE: Tier 1 pays for everything. URO off so the pose is evaluated every frame,
		// and AlwaysTickPoseAndRefreshBones so an agent that walks behind something and back out
		// does not pop to a stale pose. This is the tier a camera is actually looking at.
		MeshComponent->bEnableUpdateRateOptimizations = false;
		MeshComponent->VisibilityBasedAnimTickOption =
			EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
		MeshComponent->SetCastShadow(true);
		break;

	case ERiotRepresentationTier::Mid:
		// CLAUDE-NOTE: Tier 2 is the SAME actor with the cost turned down — URO evaluates the pose
		// every few frames and interpolates, and OnlyTickPoseWhenRendered skips offscreen agents
		// entirely. Shadows off: at this distance a crowd's shadows cost more than they read.
		// This is why one actor class serves both tiers; see the class comment.
		MeshComponent->bEnableUpdateRateOptimizations = true;
		MeshComponent->VisibilityBasedAnimTickOption =
			EVisibilityBasedAnimTickOption::OnlyTickPoseWhenRendered;
		MeshComponent->SetCastShadow(false);
		break;

	default:
		break;
	}
}

void ARiotCharacterActor::SetAgentState(ERiotAgentState State, ERiotFactionType InFactionType,
	double InSpeed, double InMaxSpeed, bool bForceRestart)
{
	RiotState = FName(LexToStringRiotAgentState(State));
	FactionType = FName(LexToStringRiotFactionType(InFactionType));
	Speed = static_cast<float>(InSpeed);
	NormalizedSpeed = (InMaxSpeed > KINDA_SMALL_NUMBER)
		? static_cast<float>(FMath::Clamp(InSpeed / InMaxSpeed, 0.0, 1.0))
		: 0.f;
	bIsMoving = InSpeed > 1.0;

	const ERiotAnimationSlot Slot = RiotAnimationSlotForState(State, InFactionType);
	RiotAnimationSlot = FName(LexToStringRiotAnimationSlot(Slot));

	// In Animation Blueprint mode the parameters above ARE the contract; the ABP decides what to
	// play. Only direct-sequence mode drives playback from here.
	if (bHasProfile && ActiveProfile.AnimationMode == ERiotAnimationMode::SequenceSet)
	{
		PlaySlotAnimation(Slot, bForceRestart);
	}
	CurrentSlot = Slot;
}

void ARiotCharacterActor::PlaySlotAnimation(ERiotAnimationSlot Slot, bool bForceRestart)
{
	if (!MeshComponent || (Slot == CurrentSlot && !bForceRestart))
	{
		return;
	}

	ERiotAnimationSlot Resolved = ERiotAnimationSlot::Idle;
	bool bUsedFallback = false;
	if (!ResolveRiotAnimationSlot(ActiveProfile, Slot, Resolved, bUsedFallback))
	{
		return;
	}

	const FRiotAnimationBinding* Binding = ActiveProfile.FindBinding(Resolved);
	if (!Binding)
	{
		return;
	}

	UAnimSequenceBase* Sequence =
		Cast<UAnimSequenceBase>(FSoftObjectPath(Binding->AnimationPath).TryLoad());
	if (!Sequence)
	{
		return;
	}

	MeshComponent->SetAnimationMode(EAnimationMode::AnimationSingleNode);
	MeshComponent->SetAnimation(Sequence);
	MeshComponent->SetPlayRate(static_cast<float>(Binding->PlayRate) * PlayRateScale);
	MeshComponent->Play(Binding->bLooping);

	// CLAUDE-NOTE: seek to a deterministic per-agent offset rather than starting every agent at
	// frame 0. Without this a crowd switching state together snaps into lockstep and reads as a
	// single animated object rather than a hundred people. The offset comes from the agent's seed
	// salt, so it is stable across re-runs of the same scenario seed.
	const float Length = Sequence->GetPlayLength();
	if (Length > KINDA_SMALL_NUMBER && PhaseOffset != 0.f)
	{
		MeshComponent->SetPosition(FMath::Fmod(FMath::Abs(PhaseOffset), 1.f) * Length, false);
	}
}
