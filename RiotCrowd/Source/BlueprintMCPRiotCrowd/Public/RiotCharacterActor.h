#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MassActorPoolableInterface.h"
#include "RiotCharacterProfile.h"
#include "RiotCrowdTypes.h"

#include "RiotCharacterActor.generated.h"

class USkeletalMeshComponent;
class UAnimSequenceBase;

/** Which representation a riot agent is currently drawn with. */
UENUM()
enum class ERiotRepresentationTier : uint8
{
	/** Not represented at all (beyond far distance, or inactive). */
	None,
	/** Tier 1: full skeletal actor, full animation response. */
	Near,
	/** Tier 2: pooled skeletal actor with reduced animation cost. */
	Mid,
	/** Tier 3: animated instance, no per-agent component. */
	Far,
	/** Diagnostic fallback: the foundation's placeholder mesh. Never a successful result. */
	Placeholder,
};

BLUEPRINTMCPRIOTCROWD_API const TCHAR* LexToStringRiotRepresentationTier(ERiotRepresentationTier Tier);

/**
 * A pooled skeletal representation of one riot agent.
 *
 * CLAUDE-NOTE: ONE actor class serves both Tier 1 and Tier 2, differing only by runtime
 * configuration (see ApplyTier). Two classes would mean two pools, and the engine pools per actor
 * class (UMassActorSpawnerSubsystem::PooledActors is keyed by TSubclassOf<AActor>), so a tier change
 * would become a destroy-and-respawn instead of a reconfigure — the opposite of what tiering is for.
 *
 * Deliberately AActor, not ACharacter. A character brings a movement component and a capsule, and
 * Mass is authoritative over position here: the actor is a VIEW of an entity, never a simulator of
 * one. Adding CharacterMovement would put two systems in charge of the same transform.
 *
 * The animation parameters below are BlueprintReadOnly so a project-supplied Animation Blueprint can
 * read them off its owning actor. That is the entire contract for animation mode A — no interface to
 * implement, no base class to inherit, which matters because the operator supplies the ABP and the
 * plugin ships none.
 */
UCLASS(NotBlueprintable)
class BLUEPRINTMCPRIOTCROWD_API ARiotCharacterActor : public AActor, public IMassActorPoolableInterface
{
	GENERATED_BODY()

public:
	ARiotCharacterActor();

	// ----- IMassActorPoolableInterface -----
	virtual bool CanBePooled_Implementation() override { return true; }
	virtual void PrepareForPooling_Implementation() override;
	virtual void PrepareForGame_Implementation() override;

	/**
	 * Configure this actor to represent the given profile. Returns false if the mesh cannot load.
	 * Safe to call on a recycled actor: it fully replaces mesh, materials and animation.
	 */
	bool ApplyProfile(const FRiotCharacterProfile& Profile);

	/** Apply tier-specific cost settings. Cheap and idempotent; called on every tier change. */
	void ApplyTier(ERiotRepresentationTier Tier);

	/**
	 * Push the current simulation state. Drives animation in both modes.
	 * bForceRestart replays the slot animation even if the slot did not change.
	 */
	void SetAgentState(ERiotAgentState State, ERiotFactionType FactionType, double Speed,
		double MaxSpeed, bool bForceRestart = false);

	ERiotAnimationSlot GetCurrentSlot() const { return CurrentSlot; }
	const FString& GetProfileId() const { return CharacterProfileId; }
	USkeletalMeshComponent* GetMeshComponent() const { return MeshComponent; }

	/**
	 * Deterministic per-agent variation. Set once at promotion from the agent's seed salt.
	 * PhaseOffset shifts animation start time; PlayRateScale multiplies the binding's play rate.
	 */
	void SetVariation(float InPhaseOffset, float InPlayRateScale);

	// ----- animation parameters, read by a project-supplied Animation Blueprint -----

	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	FName RiotState;

	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	FName RiotAnimationSlot;

	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	float Speed = 0.f;

	/** Speed as a 0..1 fraction of the agent's configured maximum. */
	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	float NormalizedSpeed = 0.f;

	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	FName FactionType;

	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	FString CharacterProfileId;

	/** Deterministic 0..1 phase, so a crowd does not move as one clone. */
	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	float SeedPhase = 0.f;

	/** True while pinned by riot_promote_agents rather than chosen by distance. */
	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	bool bIsPromoted = false;

	UPROPERTY(BlueprintReadOnly, Category = "Riot")
	bool bIsMoving = false;

private:
	/** Plays the sequence bound to Slot, walking the profile's fallback chain. */
	void PlaySlotAnimation(ERiotAnimationSlot Slot, bool bForceRestart);

	UPROPERTY(Transient)
	TObjectPtr<USkeletalMeshComponent> MeshComponent = nullptr;

	/**
	 * CLAUDE-NOTE: a COPY of the profile, not a pointer into the store. The store is a TArray and
	 * reallocates when a profile is registered mid-run, which would dangle every held pointer. The
	 * copy is small (strings and a short binding array) and is refreshed on every ApplyProfile.
	 */
	FRiotCharacterProfile ActiveProfile;
	bool bHasProfile = false;

	ERiotAnimationSlot CurrentSlot = ERiotAnimationSlot::Max;
	ERiotRepresentationTier CurrentTier = ERiotRepresentationTier::None;

	float PhaseOffset = 0.f;
	float PlayRateScale = 1.f;
};
