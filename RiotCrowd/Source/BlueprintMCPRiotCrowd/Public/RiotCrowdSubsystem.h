#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
// CLAUDE-NOTE: FMassEntityHandle lives in its OWN header in 5.6, not in MassEntityTypes.h.
// Including only MassEntityTypes.h compiles the fragments fine but leaves FMassEntityHandle
// undeclared, which cascades into ~30 confusing TArray/template errors that all point at the
// TArray<FMassEntityHandle> members rather than at the missing include.
#include "MassEntityHandle.h"
#include "MassEntityTypes.h"
#include "RiotCrowdTypes.h"
#include "RiotScenario.h"

#include "RiotCrowdSubsystem.generated.h"

class AActor;
class UInstancedStaticMeshComponent;
class FJsonObject;
struct FMassEntityManager;

/**
 * Owns the live riot simulation for one world.
 *
 * CLAUDE-NOTE: UTickableWorldSubsystem, gated to game worlds only. Mass processors execute during
 * game-world simulation, so in practice this means PIE (see UE56-MASS-API-FINDINGS.md §5). The
 * scenario DEFINITION deliberately does not live here — it lives in the editor-side
 * FRiotScenarioStore, because this subsystem dies with the PIE world and would take every authored
 * scenario with it.
 *
 * Simulation orchestration (spawn waves, pressure accumulation, trigger evaluation, state
 * transitions) runs here in Tick rather than in Mass processors, while the per-agent motion hot loop
 * runs in URiotCrowdSteeringProcessor. That split is deliberate: orchestration needs to be pausable,
 * inspectable and ordered deterministically, all of which are awkward to guarantee across
 * independently-scheduled processors, whereas motion is a pure per-entity transform that belongs in
 * a processor.
 */
UCLASS()
class URiotCrowdSubsystem : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	// ----- UWorldSubsystem -----
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Deinitialize() override;

	// ----- FTickableGameObject -----
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual bool IsTickable() const override { return bSpawned; }

	/** Instantiate entities for ScenarioId. Returns false and fills OutError on failure. */
	bool SpawnScenario(const FString& ScenarioId, FString& OutErrorCode, FString& OutError);

	/** Begin advancing the simulation. */
	bool StartSimulation(FString& OutErrorCode, FString& OutError);
	bool PauseSimulation(FString& OutErrorCode, FString& OutError);
	bool ResumeSimulation(FString& OutErrorCode, FString& OutError);

	/**
	 * Destroy every entity and actor this subsystem created and zero the runtime counters.
	 * Idempotent: calling it twice is a no-op, not an error and not a crash.
	 */
	bool ResetScenario(FString& OutErrorCode, FString& OutError);

	/** True once SpawnScenario succeeded and before ResetScenario. */
	bool IsSpawned() const { return bSpawned; }
	bool IsRunning() const { return bRunning; }
	const FString& GetActiveScenarioId() const { return ActiveScenarioId; }

	/** Live per-state counts, read straight off the entity fragments. */
	FRiotRuntimeCounts CollectCounts() const;

	/** Full structured runtime report. */
	TSharedRef<FJsonObject> BuildRuntimeReport() const;

private:
	FMassEntityManager* GetEntityManager() const;

	void TickSpawning(FRiotScenario& Scenario, double DeltaTime);
	void TickAgentStates(FRiotScenario& Scenario, double DeltaTime);
	void TickPressure(FRiotScenario& Scenario, double DeltaTime);
	void TickTriggers(FRiotScenario& Scenario);
	void TickRepresentation();

	void FirePanicTrigger(FRiotScenario& Scenario, FRiotTrigger& Trigger);
	void FireBreachTrigger(FRiotScenario& Scenario, FRiotTrigger& Trigger);

	bool EnsureVisualizer();
	void DestroyVisualizer();

	/** Every entity this subsystem created, so reset can destroy exactly its own and nothing else. */
	TArray<FMassEntityHandle> OwnedRioters;
	TArray<FMassEntityHandle> OwnedDefenders;

	/** Rioters not yet released by their origin's delay/interval schedule. */
	struct FPendingSpawn
	{
		FMassEntityHandle Entity;
		double ReleaseTime = 0.0;
	};
	TArray<FPendingSpawn> PendingReleases;

	UPROPERTY(Transient)
	TObjectPtr<AActor> VisualizerActor = nullptr;

	UPROPERTY(Transient)
	TObjectPtr<UInstancedStaticMeshComponent> RioterISM = nullptr;

	UPROPERTY(Transient)
	TObjectPtr<UInstancedStaticMeshComponent> DefenderISM = nullptr;

	FString ActiveScenarioId;
	bool bSpawned = false;
	bool bRunning = false;
};
