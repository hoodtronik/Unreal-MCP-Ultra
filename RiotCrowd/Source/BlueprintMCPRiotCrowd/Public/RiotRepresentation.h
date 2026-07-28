#pragma once

#include "CoreMinimal.h"
#include "MassEntityHandle.h"
#include "RiotCharacterActor.h"
#include "RiotCharacterProfile.h"
#include "RiotCrowdTypes.h"

class AActor;
class ARiotCharacterActor;
class FJsonObject;
class UInstancedStaticMeshComponent;
class UWorld;
struct FMassEntityManager;

/** Per-agent representation bookkeeping. */
struct FRiotAgentRepresentation
{
	FMassEntityHandle Entity;
	ERiotFactionType FactionType = ERiotFactionType::Rioter;

	/** Index into FRiotRepresentationManager::ResolvedProfiles. INDEX_NONE = no valid profile. */
	int32 ProfileIndex = INDEX_NONE;

	ERiotRepresentationTier Tier = ERiotRepresentationTier::None;
	ERiotRepresentationTier PrevTier = ERiotRepresentationTier::None;

	/** Stable ISM instance slot for the far tier. INDEX_NONE when not far-represented. */
	int32 InstanceSlot = INDEX_NONE;

	/** Weak: actors are kept alive by the world, and weak avoids dangling after a PIE teardown. */
	TWeakObjectPtr<ARiotCharacterActor> Actor;

	/** Pinned to the near tier by riot_promote_agents rather than chosen by distance. */
	bool bManualPromote = false;

	/** Deterministic variation, derived once from the agent's seed salt. */
	float PhaseOffset = 0.f;
	float PlayRateScale = 1.f;

	double LastDistance = 0.0;
	double LastUpdateTime = -1.0;
};

/** Counts produced by one representation update, reported verbatim. */
struct FRiotRepresentationCounts
{
	int32 Total = 0;
	int32 Near = 0;
	int32 Mid = 0;
	int32 Far = 0;
	int32 Placeholder = 0;
	int32 NoneTier = 0;

	/** How many agents QUALIFIED for a tier by distance, before budgets were applied. */
	int32 QualifiedNear = 0;
	int32 QualifiedMid = 0;

	/** Qualified minus represented, per tier. Non-zero means a budget bound. */
	int32 NearOverflow = 0;
	int32 MidOverflow = 0;

	int32 PromotedActors = 0;
	int32 PooledActorsAvailable = 0;
	int32 ActiveSkeletalMeshes = 0;
	int32 AnimatedInstances = 0;
	int32 DuplicateRepresentations = 0;
	int32 InvalidAssets = 0;

	void Reset() { *this = FRiotRepresentationCounts(); }
};

/**
 * Owns everything about how riot agents are DRAWN. Nothing here decides how they behave.
 *
 * CLAUDE-NOTE: this is a bespoke manager built on engine primitives, NOT the engine's
 * UMassRepresentationProcessor chain, and that is a deliberate reversal of the initial lean recorded
 * in UE56-RIGGED-REPRESENTATION-API-FINDINGS.md §3. The engine chain was surveyed and would work,
 * but it fights three of this milestone's explicit requirements:
 *
 *   1. Budgets. FMassVisualizationLODParameters::LODMaxCount is enforced by SHRINKING the distance
 *      band (FMassVisualizationLODSharedFragment::bHasAdjustedDistancesFromCount), so the effective
 *      thresholds drift away from the requested ones. The brief requires reporting qualified-vs-
 *      represented against the thresholds the operator SET.
 *   2. Hysteresis. The engine expresses it as a percentage of band distance; the brief requires an
 *      absolute distance. See findings §8.
 *   3. Manual promotion. riot_promote_agents must pin specific agents to the near tier regardless of
 *      distance, and must be idempotent. There is no seam for that in the engine's distance-driven
 *      representation processor.
 *
 * What IS reused from the engine, rather than reimplemented: UMassLODSubsystem for the viewer/camera
 * (findings §7), UMassActorSpawnerSubsystem for actor pooling including its time-sliced spawning
 * (findings §6), and IMassActorPoolableInterface for safe recycling.
 *
 * The engine chain remains the right answer for a pure distance-LOD crowd with no operator control.
 * If this system ever loses its manual-promotion and exact-budget requirements, switching back is a
 * simplification worth making.
 */
class FRiotRepresentationManager
{
public:
	/**
	 * Bind to a world and a representation profile. Resolves eligible character profiles per faction
	 * up front so the per-frame path never touches the profile store.
	 */
	void Initialize(UWorld* InWorld, const FRiotRepresentationProfile& InProfile,
		const TArray<FRiotCharacterProfile>& InProfiles);

	/** Register an agent. Selects its character profile deterministically from its seed salt. */
	void RegisterAgent(FMassEntityHandle Entity, ERiotFactionType FactionType, uint32 SeedSalt);

	/** Drop an agent and release whatever represented it. Idempotent. */
	void UnregisterAgent(FMassEntityHandle Entity);

	/** Recompute tiers, apply budgets, drive actors and instances. Call once per frame. */
	void Update(FMassEntityManager& EntityManager, double WorldTime, double DeltaTime);

	/**
	 * Pin agents to the near tier. Returns how many actually changed.
	 * Promoting an already-promoted agent is a no-op, not a second actor.
	 */
	int32 PromoteAgents(const TArray<FMassEntityHandle>& Entities, FString& OutErrorCode,
		FString& OutMessage);

	/** Unpin agents. Demoting an already-demoted agent is a no-op, not an error. */
	int32 DemoteAgents(const TArray<FMassEntityHandle>& Entities, FString& OutErrorCode,
		FString& OutMessage);

	/** Destroy every actor and instance this manager created. Idempotent. */
	void Reset();

	const FRiotRepresentationCounts& GetCounts() const { return Counts; }
	const FRiotRepresentationProfile& GetProfile() const { return Profile; }
	const TMap<FMassEntityHandle, FRiotAgentRepresentation>& GetAgents() const { return Agents; }

	/** Where LOD is being measured from, and whether that source was actually found. */
	bool GetCameraTransform(FTransform& OutTransform, FString& OutResolvedSource) const;

	TSharedRef<FJsonObject> BuildReport(FMassEntityManager& EntityManager) const;

	/** Counts by character profile id, for the runtime report. */
	TMap<FString, int32> CountsByProfile() const;

private:
	ERiotRepresentationTier DesiredTierForDistance(double Distance, ERiotRepresentationTier Current) const;
	bool EnsureFarISM();
	void ApplyTierTransition(FRiotAgentRepresentation& Agent, ERiotRepresentationTier NewTier,
		const FTransform& Transform);
	ARiotCharacterActor* AcquireActor(const FRiotCharacterProfile& CharacterProfile);
	void ReleaseActor(FRiotAgentRepresentation& Agent);
	int32 AcquireInstanceSlot();
	void ReleaseInstanceSlot(FRiotAgentRepresentation& Agent);

	TWeakObjectPtr<UWorld> World;
	FRiotRepresentationProfile Profile;

	/** Copies, not pointers: the store is a TArray and reallocates on registration. */
	TArray<FRiotCharacterProfile> ResolvedProfiles;

	TMap<FMassEntityHandle, FRiotAgentRepresentation> Agents;

	/** Every actor this manager has spawned, so Reset destroys exactly its own. */
	TArray<TWeakObjectPtr<ARiotCharacterActor>> SpawnedActors;
	TArray<TWeakObjectPtr<ARiotCharacterActor>> FreeActors;

	TWeakObjectPtr<AActor> FarVisualizerActor;
	TWeakObjectPtr<UInstancedStaticMeshComponent> FarISM;

	/**
	 * CLAUDE-NOTE: instance slots are allocated and NEVER removed while a run is live — a released
	 * slot is parked at zero scale and pushed onto FreeInstanceSlots for reuse.
	 *
	 * This is the whole fix for the foundation's per-tick ClearInstances + AddInstance rebuild
	 * (RiotCrowdSubsystem.cpp:916-924). That code was correct about its constraint: instance counts
	 * change every frame, and UInstancedStaticMeshComponent::RemoveInstance re-indexes everything
	 * after the removed element, so any index the caller cached goes stale. The fix is not to remove
	 * at all. Slot indices then stay valid for the lifetime of the run, the instance count only ever
	 * grows to the high-water mark, and the steady state is a transform write per visible agent with
	 * a single render-state dirty at the end of the pass.
	 */
	TArray<FMassEntityHandle> InstanceSlots;
	TArray<int32> FreeInstanceSlots;

	FRiotRepresentationCounts Counts;
	FString ResolvedCameraSource;
	bool bCameraResolved = false;
	FTransform LastCameraTransform = FTransform::Identity;
};
