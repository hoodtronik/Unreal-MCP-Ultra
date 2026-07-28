#pragma once

#include "CoreMinimal.h"
#include "RiotCrowdTypes.generated.h"

// ============================================================
// Engine-agnostic domain vocabulary.
//
// CLAUDE-NOTE: these types are deliberately free of Mass includes so the scenario model, the HTTP
// handlers and the capability reporting all compile and behave identically whether or not Mass is
// present (WITH_RIOT_MASS). Only the simulation fragments below are Mass-gated.
// ============================================================

UENUM()
enum class ERiotFactionType : uint8
{
	Rioter,
	Police,
	Military,
	Neutral,
};

UENUM()
enum class ERiotHotspotType : uint8
{
	Pressure,
	Breach,
	Panic,
};

/**
 * Per-agent runtime state.
 *
 * CLAUDE-NOTE: this is a single enum FIELD inside one fragment, deliberately NOT a set of Mass tags.
 *
 * Tags are archetype-defining in Mass: flipping a tag moves the entity to a different archetype,
 * which is a structural change requiring an archetype migration. Riot agents change state
 * constantly and in bursts — a whole crowd transitions Advancing -> Blocked when it reaches a
 * blockade, then Blocked -> Breaching the instant a segment breaks. Modelling that with tags would
 * migrate hundreds of entities between archetypes within a frame or two, which is the classic Mass
 * archetype-churn pathology.
 *
 * An enum field is a plain fragment write: no migration, no command-buffer round trip, and state can
 * be flipped inside the same processor pass that computed it. The tradeoff is that queries cannot
 * filter on state at the archetype level, so processors read all riot agents and branch per entity.
 * At this milestone's scale (hundreds, not hundreds of thousands) the branch is far cheaper than the
 * migrations it avoids. If agent counts ever reach a scale where the branch dominates, the fix is a
 * small number of coarse, rarely-flipped tags (e.g. Active vs Inactive) layered ON TOP of this
 * field — not replacing it.
 *
 * UE 5.8's sparse fragments would change this calculus. We are on 5.6 and do not emulate them.
 */
UENUM()
enum class ERiotAgentState : uint8
{
	Queued,
	Advancing,
	Blocked,
	Pressuring,
	Breaching,
	PassedBlockade,
	Panicked,
	Retreating,
	Inactive,
};

/** Scenario lifecycle. Reported verbatim by riot_get_scenario. */
UENUM()
enum class ERiotLifecycle : uint8
{
	Unconfigured,
	Configured,
	Spawned,
	Running,
	Paused,
	Completed,
	Reset,
	Failed,
};

BLUEPRINTMCPRIOTCROWD_API const TCHAR* LexToStringRiotAgentState(ERiotAgentState State);
BLUEPRINTMCPRIOTCROWD_API const TCHAR* LexToStringRiotLifecycle(ERiotLifecycle State);
BLUEPRINTMCPRIOTCROWD_API const TCHAR* LexToStringRiotFactionType(ERiotFactionType Type);
