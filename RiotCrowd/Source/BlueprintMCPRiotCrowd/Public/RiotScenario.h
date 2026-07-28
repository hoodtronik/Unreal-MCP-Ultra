#pragma once

#include "CoreMinimal.h"
#include "RiotCrowdTypes.h"

class FJsonObject;

/**
 * Versioned, serializable riot scenario definition.
 *
 * CLAUDE-NOTE: plain structs, not UObjects. Scenario definitions are authored over MCP *before* PIE
 * starts and must survive PIE start/stop cycles, so they cannot live in a world-scoped UObject.
 * Keeping them as plain C++ in an editor-side store (FRiotScenarioStore) means a scenario is
 * unaffected by world teardown, GC, or the reset path — which is exactly what "reset must return
 * runtime counts to zero without destroying the scenario" requires.
 */

/** Current schema version. Bump when a field's meaning changes, not when one is added. */
inline constexpr int32 RiotScenarioSchemaVersion = 1;

struct FRiotFaction
{
	FString Id;
	FString DisplayName;
	ERiotFactionType Type = ERiotFactionType::Rioter;
	int32 MaxSpawnCount = 0;
	FLinearColor DebugColor = FLinearColor::White;
};

struct FRiotFlowOrigin
{
	FString Id;
	FString FactionId;
	FVector Location = FVector::ZeroVector;
	/** Agents are scattered within this radius of Location at spawn. 0 = exact point. */
	double SpawnRadius = 0.0;
	FVector InitialTarget = FVector::ZeroVector;
	int32 SpawnCount = 0;
	/** Seconds before this origin releases its first agent. */
	double SpawnDelay = 0.0;
	/** Seconds between agents. 0 = all at once. */
	double SpawnInterval = 0.0;
	double SpeedMin = 200.0;
	double SpeedMax = 400.0;
};

struct FRiotBlockade
{
	FString Id;
	FString DefendingFactionId;
	FVector Location = FVector::ZeroVector;
	/** Yaw only. The blockade is a line segment centred on Location, facing YawDegrees. */
	double YawDegrees = 0.0;
	double Width = 800.0;
	double Depth = 200.0;
	/** How many defenders to place along the segment. */
	int32 DefenderCount = 0;
	/**
	 * Pressure at or above which the segment is considered under serious strain but still holding.
	 * Purely reported; it exists so an operator can see "about to go" before it goes.
	 */
	double HoldThreshold = 40.0;
	/** Pressure at or above which the segment breaks. Must exceed HoldThreshold. */
	double BreakThreshold = 100.0;
	/** Where defenders go once broken. Zero vector = fall straight back along the facing normal. */
	FVector FallbackLocation = FVector::ZeroVector;

	// ----- runtime -----
	bool bBroken = false;
	double CurrentPressure = 0.0;
	double PeakPressure = 0.0;
	double BrokenAtTime = -1.0;
};

/** Trigger condition kinds. */
enum class ERiotTriggerCondition : uint8
{
	/** Fires when the named blockade's pressure reaches ThresholdValue. */
	PressureThreshold,
	/** Fires ThresholdValue seconds after the simulation starts. */
	ElapsedTime,
	/** Fires once ThresholdValue agents have passed any breached blockade. */
	AgentsPassed,
};

struct FRiotTrigger
{
	FString Id;
	ERiotHotspotType Type = ERiotHotspotType::Breach;
	ERiotTriggerCondition Condition = ERiotTriggerCondition::PressureThreshold;
	/** For Breach triggers: which blockade breaks. Empty = the most-pressured one. */
	FString TargetBlockadeId;
	double ThresholdValue = 0.0;
	/**
	 * For Panic triggers: fraction (0..1) of the live crowd that panics when this fires.
	 * Ignored by Breach triggers.
	 */
	double AffectedFraction = 0.5;

	// ----- runtime -----
	bool bFired = false;
	double FiredAtTime = -1.0;
};

struct FRiotHotspot
{
	FString Id;
	ERiotHotspotType Type = ERiotHotspotType::Pressure;
	FVector Location = FVector::ZeroVector;
	double InfluenceRadius = 500.0;
	double Intensity = 1.0;
	bool bActive = false;
};

/**
 * The pressure model's tunables, in one place and reported verbatim by riot_get_runtime_report.
 *
 * CLAUDE-NOTE: these live on the scenario rather than as constants in the simulation specifically so
 * that nothing about how pressure builds is hidden. An operator reading a report can see every
 * number that produced the pressure figure and reproduce the arithmetic by hand:
 *
 *   attackersPerDefender = pressingAgents / max(1, defenderCount)
 *   target = attackersPerDefender * PressureGain * (1 + SustainBonusPerSecond * avgPressingTime)
 *   pressure moves toward target, and decays at DecayRatePerSecond when nobody is pressing
 *
 * Defaults are tuned so a ~200-rioter crowd against ~30 defenders crosses a 100.0 break threshold
 * a few seconds after contact, rather than instantly or never.
 */
struct FRiotPressureModel
{
	/** Pressure units contributed per attacker-per-defender. */
	double PressureGain = 25.0;
	/** Extra fraction of pressure per second an agent has been pressing continuously. */
	double SustainBonusPerSecond = 0.15;
	/** Pressure units shed per second when no agent is pressing the segment. */
	double DecayRatePerSecond = 20.0;
	/** How fast current pressure chases its target, in units per second. */
	double RiseRatePerSecond = 60.0;
	/** Distance in front of a blockade within which an agent counts as pressing. */
	double ContactBand = 250.0;
	/** Hard ceiling so a runaway crowd cannot produce an unbounded number. */
	double MaxPressure = 500.0;
};

/** Live counters, recomputed each report. Never persisted. */
struct FRiotRuntimeCounts
{
	int32 Total = 0;
	int32 Queued = 0;
	int32 Advancing = 0;
	int32 Blocked = 0;
	int32 Pressuring = 0;
	int32 Breaching = 0;
	int32 PassedBlockade = 0;
	int32 Panicked = 0;
	int32 Retreating = 0;
	int32 Inactive = 0;
	int32 Defenders = 0;

	void Reset() { *this = FRiotRuntimeCounts(); }
};

struct FRiotScenario
{
	FString Id;
	FString DisplayName;
	int32 SchemaVersion = RiotScenarioSchemaVersion;
	int32 Seed = 0;
	/** Level the scenario was authored against, for operator sanity-checking. */
	FString WorldName;

	ERiotLifecycle Lifecycle = ERiotLifecycle::Unconfigured;
	FRiotPressureModel PressureModel;

	TArray<FRiotFaction> Factions;
	TArray<FRiotFlowOrigin> Origins;
	TArray<FRiotBlockade> Blockades;
	TArray<FRiotTrigger> Triggers;
	TArray<FRiotHotspot> Hotspots;

	// ----- runtime -----
	double SimulationTime = 0.0;
	int32 SpawnedRioters = 0;
	int32 SpawnedDefenders = 0;
	int32 AgentsPassedBlockade = 0;
	FString FailureReason;

	// ----- lookups -----
	const FRiotFaction* FindFaction(const FString& FactionId) const;
	int32 IndexOfFaction(const FString& FactionId) const;
	FRiotBlockade* FindBlockade(const FString& BlockadeId);
	int32 IndexOfBlockade(const FString& BlockadeId) const;

	/** Clears every runtime field but leaves the authored definition intact. */
	void ResetRuntimeState();

	TSharedRef<FJsonObject> ToJson() const;
};

/**
 * Editor-side scenario store.
 *
 * CLAUDE-NOTE: a process-wide singleton rather than a subsystem, because it must outlive PIE worlds.
 * A UWorldSubsystem would be destroyed on PIE end and take every authored scenario with it, which
 * would make the "reset, then re-run the same seed" requirement impossible to satisfy.
 */
class FRiotScenarioStore
{
public:
	static FRiotScenarioStore& Get();

	FRiotScenario* Find(const FString& ScenarioId);
	const FRiotScenario* Find(const FString& ScenarioId) const;
	FRiotScenario& Add(FRiotScenario Scenario);
	bool Remove(const FString& ScenarioId);
	const TArray<FRiotScenario>& All() const { return Scenarios; }
	TArray<FRiotScenario>& AllMutable() { return Scenarios; }

private:
	TArray<FRiotScenario> Scenarios;
};

// ----- validation -----

/**
 * Structural validation. Returns true when valid; otherwise fills OutErrorCode with a RIOT_* code
 * and OutMessage with something a human can act on.
 *
 * CLAUDE-NOTE: separated from mutation so every authoring endpoint can validate BEFORE writing and
 * so dryRun can report exactly what a real call would reject, with no partial state written.
 */
bool ValidateRiotScenario(const FRiotScenario& Scenario, FString& OutErrorCode, FString& OutMessage);

/** True when Id is a usable stable identifier: non-empty, <=64 chars, [A-Za-z0-9_-] only. */
bool IsValidRiotId(const FString& Id);
