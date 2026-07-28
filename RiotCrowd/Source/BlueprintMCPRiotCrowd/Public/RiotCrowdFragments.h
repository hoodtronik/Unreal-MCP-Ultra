#pragma once

#include "CoreMinimal.h"
#include "RiotCrowdTypes.h"

#include "MassEntityTypes.h"

#include "RiotCrowdFragments.generated.h"

/**
 * Everything mutable about a riot agent, in one fragment.
 *
 * CLAUDE-NOTE: packed into a single fragment on purpose. See the ERiotAgentState comment in
 * RiotCrowdTypes.h for why state is a field rather than a tag. Keeping the hot data together also
 * means the steering, pressure and panic processors all touch one fragment array per chunk instead
 * of three, which is the cache-friendly shape for a per-frame full-crowd sweep.
 */
USTRUCT()
struct FRiotAgentFragment : public FMassFragment
{
	GENERATED_BODY()

	/** Index into the scenario's faction array. uint8 caps factions at 255, which is far past need. */
	UPROPERTY()
	uint8 FactionIndex = 0;

	UPROPERTY()
	ERiotAgentState State = ERiotAgentState::Queued;

	/** Which blockade this agent is currently pressing. INDEX_NONE when none. */
	UPROPERTY()
	int32 TargetBlockadeIndex = INDEX_NONE;

	/** Per-agent movement speed, drawn from the origin's configured range at spawn. */
	UPROPERTY()
	float Speed = 0.f;

	/**
	 * Per-agent deterministic salt, derived from (scenario seed, origin index, spawn ordinal).
	 *
	 * CLAUDE-NOTE: stored rather than recomputed so that any per-agent jitter stays stable across
	 * frames and, critically, across re-runs of the same seed. Deriving jitter from entity index at
	 * use-time would break determinism the moment entity allocation order shifted.
	 */
	UPROPERTY()
	uint32 SeedSalt = 0;

	/** Seconds this agent has spent continuously in Pressuring state. Feeds the pressure model. */
	UPROPERTY()
	float PressingTime = 0.f;
};

/** Where this agent is trying to get to right now. Separate because it is written by different
 *  processors than the state block and is read by the debug/report path on its own. */
USTRUCT()
struct FRiotTargetFragment : public FMassFragment
{
	GENERATED_BODY()

	UPROPERTY()
	FVector Destination = FVector::ZeroVector;
};
