#include "RiotCrowdSubsystem.h"

#include "RiotCrowdFragments.h"
#include "RiotErrorCodes.h"

#include "MassEntitySubsystem.h"
#include "MassEntityManager.h"
#include "MassCommonFragments.h"
#include "MassMovementFragments.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Math/RandomStream.h"
#include "UObject/ConstructorHelpers.h"

// ============================================================
// Placeholder representation
// ============================================================

// CLAUDE-NOTE: engine BasicShapes only — no third-party downloads, no production art touched, and
// nothing that has to be authored into the test level beforehand. Cylinders read as upright bodies
// at a glance and cubes read as a solid line, which is all the visual proof needs to distinguish a
// crowd from a blockade in a screenshot.
static const TCHAR* RioterMeshPath   = TEXT("/Engine/BasicShapes/Cylinder.Cylinder");
static const TCHAR* DefenderMeshPath = TEXT("/Engine/BasicShapes/Cube.Cube");

// ============================================================
// Subsystem lifetime
// ============================================================

bool URiotCrowdSubsystem::ShouldCreateSubsystem(UObject* Outer) const
{
	// CLAUDE-NOTE: game worlds only. Mass processors do not execute in the editor world, so creating
	// this in an editor world would produce a subsystem that accepts spawn requests and then never
	// advances — the worst possible failure shape, because it looks like it worked.
	const UWorld* World = Cast<UWorld>(Outer);
	return World && World->IsGameWorld();
}

void URiotCrowdSubsystem::Deinitialize()
{
	FString Code, Error;
	ResetScenario(Code, Error);
	Super::Deinitialize();
}

TStatId URiotCrowdSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(URiotCrowdSubsystem, STATGROUP_Tickables);
}

FMassEntityManager* URiotCrowdSubsystem::GetEntityManager() const
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return nullptr;
	}

	UMassEntitySubsystem* EntitySubsystem = World->GetSubsystem<UMassEntitySubsystem>();
	return EntitySubsystem ? &EntitySubsystem->GetMutableEntityManager() : nullptr;
}

// ============================================================
// Spawn
// ============================================================

bool URiotCrowdSubsystem::SpawnScenario(const FString& ScenarioId, FString& OutErrorCode, FString& OutError)
{
	if (bSpawned)
	{
		OutErrorCode = RiotErrorCodes::SimulationAlreadyRunning;
		OutError = FString::Printf(
			TEXT("Scenario '%s' is already spawned. Call riot_reset before spawning again."), *ActiveScenarioId);
		return false;
	}

	FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ScenarioId);
	if (!Scenario)
	{
		OutErrorCode = RiotErrorCodes::ScenarioNotFound;
		OutError = FString::Printf(TEXT("No scenario with id '%s'."), *ScenarioId);
		return false;
	}

	FString ValidationCode, ValidationMessage;
	if (!ValidateRiotScenario(*Scenario, ValidationCode, ValidationMessage))
	{
		OutErrorCode = ValidationCode;
		OutError = ValidationMessage;
		return false;
	}

	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager)
	{
		OutErrorCode = RiotErrorCodes::RequiredPluginDisabled;
		OutError = TEXT("MassEntitySubsystem is unavailable in this world. Is the MassGameplay plugin enabled?");
		return false;
	}

	if (!EnsureVisualizer())
	{
		OutErrorCode = RiotErrorCodes::OperationFailed;
		OutError = TEXT("Failed to create the riot visualizer actor.");
		return false;
	}

	// CLAUDE-NOTE: one archetype shared by rioters and defenders. Both need the same fragment set,
	// and keeping them in a single archetype means the steering processor sees one chunk stream and
	// no migration ever occurs when an agent changes role or state (state is a field, not a tag).
	const FMassArchetypeHandle Archetype = EntityManager->CreateArchetype(
		TArray<const UScriptStruct*>{
			FTransformFragment::StaticStruct(),
			FMassVelocityFragment::StaticStruct(),
			FRiotAgentFragment::StaticStruct(),
			FRiotTargetFragment::StaticStruct(),
		});

	Scenario->ResetRuntimeState();

	// CLAUDE-NOTE: ALL randomness derives from this one stream, and it is consumed in a fixed
	// order (origins in array order, then agents in index order, then blockades). That fixed
	// consumption order is what makes the same seed reproduce the same run — not the seed alone.
	FRandomStream Rng(Scenario->Seed);

	int32 RioterTotal = 0;
	int32 DefenderTotal = 0;

	// ----- rioters -----
	for (int32 OriginIndex = 0; OriginIndex < Scenario->Origins.Num(); ++OriginIndex)
	{
		const FRiotFlowOrigin& Origin = Scenario->Origins[OriginIndex];
		const int32 FactionIndex = Scenario->IndexOfFaction(Origin.FactionId);
		if (FactionIndex == INDEX_NONE)
		{
			continue; // validation already guaranteed this, belt and braces
		}

		for (int32 i = 0; i < Origin.SpawnCount; ++i)
		{
			const FMassEntityHandle Entity = EntityManager->CreateEntity(Archetype);

			const double Angle = Rng.FRandRange(0.0, 2.0 * PI);
			const double Radius = Origin.SpawnRadius > 0.0 ? Rng.FRandRange(0.0, Origin.SpawnRadius) : 0.0;
			const FVector Offset(Radius * FMath::Cos(Angle), Radius * FMath::Sin(Angle), 0.0);

			FTransformFragment& TransformFrag = EntityManager->GetFragmentDataChecked<FTransformFragment>(Entity);
			TransformFrag.GetMutableTransform().SetLocation(Origin.Location + Offset);

			FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
			Agent.FactionIndex = (uint8)FMath::Clamp(FactionIndex, 0, 255);
			Agent.Speed = (float)Rng.FRandRange(Origin.SpeedMin, Origin.SpeedMax);
			Agent.SeedSalt = (uint32)Rng.GetUnsignedInt();
			Agent.State = ERiotAgentState::Queued;
			Agent.TargetBlockadeIndex = INDEX_NONE;

			FRiotTargetFragment& Target = EntityManager->GetFragmentDataChecked<FRiotTargetFragment>(Entity);
			Target.Destination = Origin.InitialTarget;

			OwnedRioters.Add(Entity);
			++RioterTotal;

			FPendingSpawn Pending;
			Pending.Entity = Entity;
			Pending.ReleaseTime = Origin.SpawnDelay + (Origin.SpawnInterval * i);
			PendingReleases.Add(Pending);
		}
	}

	// ----- defenders -----
	for (FRiotBlockade& Blockade : Scenario->Blockades)
	{
		const int32 FactionIndex = Scenario->IndexOfFaction(Blockade.DefendingFactionId);
		if (FactionIndex == INDEX_NONE || Blockade.DefenderCount <= 0)
		{
			continue;
		}

		const FRotator BlockadeRotation(0.0, Blockade.YawDegrees, 0.0);
		const FVector Right = BlockadeRotation.RotateVector(FVector::RightVector);

		for (int32 i = 0; i < Blockade.DefenderCount; ++i)
		{
			const FMassEntityHandle Entity = EntityManager->CreateEntity(Archetype);

			// Spread defenders evenly along the segment, centred on the blockade location.
			const double T = Blockade.DefenderCount > 1
				? ((double)i / (double)(Blockade.DefenderCount - 1)) - 0.5
				: 0.0;
			const FVector Position = Blockade.Location + Right * (T * Blockade.Width);

			FTransformFragment& TransformFrag = EntityManager->GetFragmentDataChecked<FTransformFragment>(Entity);
			TransformFrag.GetMutableTransform().SetLocation(Position);
			TransformFrag.GetMutableTransform().SetRotation(BlockadeRotation.Quaternion());

			FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
			Agent.FactionIndex = (uint8)FMath::Clamp(FactionIndex, 0, 255);
			Agent.Speed = 0.f; // defenders hold position until their segment breaks
			Agent.SeedSalt = (uint32)Rng.GetUnsignedInt();
			Agent.State = ERiotAgentState::Blocked;
			Agent.TargetBlockadeIndex = Scenario->IndexOfBlockade(Blockade.Id);

			FRiotTargetFragment& Target = EntityManager->GetFragmentDataChecked<FRiotTargetFragment>(Entity);
			Target.Destination = Position;

			OwnedDefenders.Add(Entity);
			++DefenderTotal;
		}
	}

	Scenario->SpawnedRioters = RioterTotal;
	Scenario->SpawnedDefenders = DefenderTotal;
	Scenario->Lifecycle = ERiotLifecycle::Spawned;

	ActiveScenarioId = ScenarioId;
	bSpawned = true;
	bRunning = false;

	UE_LOG(LogTemp, Display,
		TEXT("RiotCrowd: spawned scenario '%s' — %d rioters, %d defenders."),
		*ScenarioId, RioterTotal, DefenderTotal);

	TickRepresentation();
	return true;
}

// ============================================================
// Lifecycle transitions
// ============================================================

bool URiotCrowdSubsystem::StartSimulation(FString& OutErrorCode, FString& OutError)
{
	if (!bSpawned)
	{
		OutErrorCode = RiotErrorCodes::SimulationNotRunning;
		OutError = TEXT("Nothing is spawned. Call riot_spawn first.");
		return false;
	}
	if (bRunning)
	{
		OutErrorCode = RiotErrorCodes::SimulationAlreadyRunning;
		OutError = TEXT("Simulation is already running.");
		return false;
	}

	bRunning = true;
	if (FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ActiveScenarioId))
	{
		Scenario->Lifecycle = ERiotLifecycle::Running;
	}
	return true;
}

bool URiotCrowdSubsystem::PauseSimulation(FString& OutErrorCode, FString& OutError)
{
	if (!bRunning)
	{
		OutErrorCode = RiotErrorCodes::SimulationNotRunning;
		OutError = TEXT("Simulation is not running.");
		return false;
	}

	bRunning = false;
	if (FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ActiveScenarioId))
	{
		Scenario->Lifecycle = ERiotLifecycle::Paused;
	}
	return true;
}

bool URiotCrowdSubsystem::ResumeSimulation(FString& OutErrorCode, FString& OutError)
{
	if (!bSpawned)
	{
		OutErrorCode = RiotErrorCodes::SimulationNotRunning;
		OutError = TEXT("Nothing is spawned. Call riot_spawn first.");
		return false;
	}
	if (bRunning)
	{
		OutErrorCode = RiotErrorCodes::SimulationAlreadyRunning;
		OutError = TEXT("Simulation is already running.");
		return false;
	}

	bRunning = true;
	if (FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ActiveScenarioId))
	{
		Scenario->Lifecycle = ERiotLifecycle::Running;
	}
	return true;
}

bool URiotCrowdSubsystem::ResetScenario(FString& OutErrorCode, FString& OutError)
{
	// CLAUDE-NOTE: idempotent by construction — an unspawned reset is a success, not an error.
	// The milestone requires calling reset twice to be safe, and returning an error the second time
	// would make a correct cleanup script look like it failed.
	if (!bSpawned && OwnedRioters.Num() == 0 && OwnedDefenders.Num() == 0 && !VisualizerActor)
	{
		return true;
	}

	if (FMassEntityManager* EntityManager = GetEntityManager())
	{
		auto DestroyAll = [EntityManager](TArray<FMassEntityHandle>& Handles)
		{
			for (const FMassEntityHandle& Handle : Handles)
			{
				if (EntityManager->IsEntityValid(Handle))
				{
					EntityManager->DestroyEntity(Handle);
				}
			}
			Handles.Reset();
		};

		DestroyAll(OwnedRioters);
		DestroyAll(OwnedDefenders);
	}
	else
	{
		// World already torn down — the entities went with it. Drop our handles so a later reset
		// does not try to touch a dead manager.
		OwnedRioters.Reset();
		OwnedDefenders.Reset();
	}

	PendingReleases.Reset();
	DestroyVisualizer();

	if (FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ActiveScenarioId))
	{
		Scenario->ResetRuntimeState();
		Scenario->Lifecycle = ERiotLifecycle::Reset;
	}

	bSpawned = false;
	bRunning = false;
	// CLAUDE-NOTE: ActiveScenarioId is deliberately NOT cleared. Clearing it made
	// riot_get_runtime_report answer "unconfigured" immediately after a successful reset, because
	// it could no longer find the scenario to read its lifecycle — so a correct reset looked like
	// the scenario had never been configured. Keeping the id lets the report say "reset", which is
	// the truth. SpawnScenario overwrites it, so nothing goes stale.
	return true;
}

// ============================================================
// Tick
// ============================================================

void URiotCrowdSubsystem::Tick(float DeltaTime)
{
	if (!bSpawned)
	{
		return;
	}

	FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ActiveScenarioId);
	if (!Scenario)
	{
		return;
	}

	if (bRunning)
	{
		Scenario->SimulationTime += DeltaTime;
		TickSpawning(*Scenario, DeltaTime);
		TickAgentStates(*Scenario, DeltaTime);
		TickPressure(*Scenario, DeltaTime);
		TickTriggers(*Scenario);
	}

	// CLAUDE-NOTE: representation updates even while paused, so a paused frame still renders the
	// crowd where it actually is. Skipping it would make pause look like the crowd vanished.
	TickRepresentation();
}

void URiotCrowdSubsystem::TickSpawning(FRiotScenario& Scenario, double /*DeltaTime*/)
{
	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager)
	{
		return;
	}

	for (int32 i = PendingReleases.Num() - 1; i >= 0; --i)
	{
		const FPendingSpawn& Pending = PendingReleases[i];
		if (Scenario.SimulationTime < Pending.ReleaseTime)
		{
			continue;
		}

		if (EntityManager->IsEntityValid(Pending.Entity))
		{
			FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Pending.Entity);
			if (Agent.State == ERiotAgentState::Queued)
			{
				Agent.State = ERiotAgentState::Advancing;
			}
		}
		PendingReleases.RemoveAtSwap(i);
	}
}

void URiotCrowdSubsystem::TickAgentStates(FRiotScenario& Scenario, double DeltaTime)
{
	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager)
	{
		return;
	}

	const FRiotPressureModel& Model = Scenario.PressureModel;

	for (const FMassEntityHandle& Entity : OwnedRioters)
	{
		if (!EntityManager->IsEntityValid(Entity))
		{
			continue;
		}

		FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
		FRiotTargetFragment& Target = EntityManager->GetFragmentDataChecked<FRiotTargetFragment>(Entity);
		const FTransformFragment& TransformFrag = EntityManager->GetFragmentDataChecked<FTransformFragment>(Entity);
		const FVector Location = TransformFrag.GetTransform().GetLocation();

		switch (Agent.State)
		{
		case ERiotAgentState::Queued:
		case ERiotAgentState::Inactive:
			break;

		case ERiotAgentState::Retreating:
		{
			// Retreat until far enough away, then stop participating.
			if (FVector::Dist2D(Location, Target.Destination) < 200.0)
			{
				Agent.State = ERiotAgentState::Inactive;
			}
			break;
		}

		case ERiotAgentState::Panicked:
		{
			Agent.State = ERiotAgentState::Retreating;
			break;
		}

		case ERiotAgentState::PassedBlockade:
			break;

		case ERiotAgentState::Breaching:
		{
			// Once past the blockade plane, the agent has made it through.
			const int32 BlockadeIndex = Agent.TargetBlockadeIndex;
			if (Scenario.Blockades.IsValidIndex(BlockadeIndex))
			{
				const FRiotBlockade& Blockade = Scenario.Blockades[BlockadeIndex];
				const FVector Forward = FRotator(0.0, Blockade.YawDegrees, 0.0).RotateVector(FVector::ForwardVector);
				const double Along = FVector::DotProduct(Location - Blockade.Location, Forward);
				if (Along > Blockade.Depth)
				{
					Agent.State = ERiotAgentState::PassedBlockade;
					Agent.TargetBlockadeIndex = INDEX_NONE;
					++Scenario.AgentsPassedBlockade;
				}
			}
			else
			{
				Agent.State = ERiotAgentState::PassedBlockade;
			}
			break;
		}

		case ERiotAgentState::Advancing:
		case ERiotAgentState::Blocked:
		case ERiotAgentState::Pressuring:
		default:
		{
			// Find the nearest blockade in front of this agent.
			int32 NearestIndex = INDEX_NONE;
			double NearestDistance = TNumericLimits<double>::Max();
			for (int32 b = 0; b < Scenario.Blockades.Num(); ++b)
			{
				const double Distance = FVector::Dist2D(Location, Scenario.Blockades[b].Location);
				if (Distance < NearestDistance)
				{
					NearestDistance = Distance;
					NearestIndex = b;
				}
			}

			if (NearestIndex == INDEX_NONE)
			{
				Agent.State = ERiotAgentState::Advancing;
				break;
			}

			const FRiotBlockade& Blockade = Scenario.Blockades[NearestIndex];

			if (Blockade.bBroken)
			{
				// The way is open — push through.
				Agent.State = ERiotAgentState::Breaching;
				Agent.TargetBlockadeIndex = NearestIndex;
				Agent.PressingTime = 0.f;

				const FVector Forward = FRotator(0.0, Blockade.YawDegrees, 0.0).RotateVector(FVector::ForwardVector);
				Target.Destination = Blockade.Location + Forward * (Blockade.Depth * 4.0);
				break;
			}

			if (NearestDistance <= Model.ContactBand)
			{
				Agent.State = ERiotAgentState::Pressuring;
				Agent.TargetBlockadeIndex = NearestIndex;
				Agent.PressingTime += (float)DeltaTime;
				// Keep leaning on the line rather than walking through it.
				Target.Destination = Blockade.Location;
			}
			else
			{
				Agent.State = ERiotAgentState::Advancing;
				Agent.PressingTime = 0.f;
				Target.Destination = Blockade.Location;
			}
			break;
		}
		}
	}
}

void URiotCrowdSubsystem::TickPressure(FRiotScenario& Scenario, double DeltaTime)
{
	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager)
	{
		return;
	}

	const FRiotPressureModel& Model = Scenario.PressureModel;

	// Gather per-blockade pressing counts and sustained-press time in one pass.
	TArray<int32> PressingCount;
	TArray<double> SustainedTime;
	PressingCount.SetNumZeroed(Scenario.Blockades.Num());
	SustainedTime.SetNumZeroed(Scenario.Blockades.Num());

	for (const FMassEntityHandle& Entity : OwnedRioters)
	{
		if (!EntityManager->IsEntityValid(Entity))
		{
			continue;
		}

		const FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
		if (Agent.State != ERiotAgentState::Pressuring || !PressingCount.IsValidIndex(Agent.TargetBlockadeIndex))
		{
			continue;
		}

		++PressingCount[Agent.TargetBlockadeIndex];
		SustainedTime[Agent.TargetBlockadeIndex] += Agent.PressingTime;
	}

	for (int32 b = 0; b < Scenario.Blockades.Num(); ++b)
	{
		FRiotBlockade& Blockade = Scenario.Blockades[b];

		// CLAUDE-NOTE: a broken segment decays to zero rather than freezing at its breaking value.
		// The first live run left b_main reading 90.3 forever after it broke, which made the report
		// look like the line was still under load long after the crowd had walked through it.
		// PeakPressure retains the historical maximum, so nothing is lost by letting current fall.
		if (Blockade.bBroken)
		{
			Blockade.CurrentPressure = FMath::Max(
				0.0, Blockade.CurrentPressure - Model.DecayRatePerSecond * DeltaTime);
			continue;
		}

		const int32 Pressing = PressingCount[b];

		if (Pressing == 0)
		{
			Blockade.CurrentPressure = FMath::Max(
				0.0, Blockade.CurrentPressure - Model.DecayRatePerSecond * DeltaTime);
			continue;
		}

		const double AveragePressTime = SustainedTime[b] / (double)Pressing;
		const double AttackersPerDefender = (double)Pressing / (double)FMath::Max(1, Blockade.DefenderCount);
		const double TargetPressure = FMath::Min(
			Model.MaxPressure,
			AttackersPerDefender * Model.PressureGain * (1.0 + Model.SustainBonusPerSecond * AveragePressTime));

		// Chase the target rather than snapping, so pressure has visible build-up.
		Blockade.CurrentPressure = FMath::FInterpConstantTo(
			Blockade.CurrentPressure, TargetPressure, DeltaTime, Model.RiseRatePerSecond);
		Blockade.PeakPressure = FMath::Max(Blockade.PeakPressure, Blockade.CurrentPressure);
	}
}

void URiotCrowdSubsystem::TickTriggers(FRiotScenario& Scenario)
{
	for (FRiotTrigger& Trigger : Scenario.Triggers)
	{
		if (Trigger.bFired)
		{
			continue;
		}

		bool bShouldFire = false;
		switch (Trigger.Condition)
		{
		case ERiotTriggerCondition::ElapsedTime:
			bShouldFire = Scenario.SimulationTime >= Trigger.ThresholdValue;
			break;

		case ERiotTriggerCondition::AgentsPassed:
			bShouldFire = (double)Scenario.AgentsPassedBlockade >= Trigger.ThresholdValue;
			break;

		case ERiotTriggerCondition::PressureThreshold:
		default:
		{
			if (!Trigger.TargetBlockadeId.IsEmpty())
			{
				if (const FRiotBlockade* Blockade = Scenario.FindBlockade(Trigger.TargetBlockadeId))
				{
					bShouldFire = Blockade->CurrentPressure >= Trigger.ThresholdValue;
				}
			}
			else
			{
				for (const FRiotBlockade& Blockade : Scenario.Blockades)
				{
					if (!Blockade.bBroken && Blockade.CurrentPressure >= Trigger.ThresholdValue)
					{
						bShouldFire = true;
						break;
					}
				}
			}
			break;
		}
		}

		if (!bShouldFire)
		{
			continue;
		}

		Trigger.bFired = true;
		Trigger.FiredAtTime = Scenario.SimulationTime;

		if (Trigger.Type == ERiotHotspotType::Breach)
		{
			FireBreachTrigger(Scenario, Trigger);
		}
		else if (Trigger.Type == ERiotHotspotType::Panic)
		{
			FirePanicTrigger(Scenario, Trigger);
		}

		for (FRiotHotspot& Hotspot : Scenario.Hotspots)
		{
			if (Hotspot.Type == Trigger.Type)
			{
				Hotspot.bActive = true;
			}
		}
	}

	// Blockades also break on their own configured threshold, independent of any trigger.
	for (FRiotBlockade& Blockade : Scenario.Blockades)
	{
		if (!Blockade.bBroken && Blockade.CurrentPressure >= Blockade.BreakThreshold)
		{
			Blockade.bBroken = true;
			Blockade.BrokenAtTime = Scenario.SimulationTime;
			UE_LOG(LogTemp, Display,
				TEXT("RiotCrowd: blockade '%s' broke at t=%.2fs (pressure %.1f >= %.1f)."),
				*Blockade.Id, Scenario.SimulationTime, Blockade.CurrentPressure, Blockade.BreakThreshold);
		}
	}
}

void URiotCrowdSubsystem::FireBreachTrigger(FRiotScenario& Scenario, FRiotTrigger& Trigger)
{
	FRiotBlockade* Target = nullptr;

	if (!Trigger.TargetBlockadeId.IsEmpty())
	{
		Target = Scenario.FindBlockade(Trigger.TargetBlockadeId);
	}
	else
	{
		// CLAUDE-NOTE: deterministic tie-break. Picking "most pressured" alone would be ambiguous
		// when two segments sit at identical pressure, and array order is stable across runs of the
		// same seed, so ties resolve to the earliest-declared blockade every time.
		double BestPressure = -1.0;
		for (FRiotBlockade& Blockade : Scenario.Blockades)
		{
			if (!Blockade.bBroken && Blockade.CurrentPressure > BestPressure)
			{
				BestPressure = Blockade.CurrentPressure;
				Target = &Blockade;
			}
		}
	}

	if (Target && !Target->bBroken)
	{
		Target->bBroken = true;
		Target->BrokenAtTime = Scenario.SimulationTime;
		UE_LOG(LogTemp, Display,
			TEXT("RiotCrowd: trigger '%s' breached blockade '%s' at t=%.2fs."),
			*Trigger.Id, *Target->Id, Scenario.SimulationTime);
	}
}

void URiotCrowdSubsystem::FirePanicTrigger(FRiotScenario& Scenario, FRiotTrigger& Trigger)
{
	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager)
	{
		return;
	}

	// CLAUDE-NOTE: selection is by stable index stride, not by random draw, so the same seed panics
	// the same agents. A random draw here would break run-to-run comparability even with a fixed
	// seed, because the number of RNG consumers by this point depends on frame timing.
	TArray<FMassEntityHandle> Candidates;
	for (const FMassEntityHandle& Entity : OwnedRioters)
	{
		if (!EntityManager->IsEntityValid(Entity))
		{
			continue;
		}
		const FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
		// CLAUDE-NOTE: Breaching agents ARE eligible, and that is a bug fix rather than a widening.
		// The first live acceptance run fired the panic trigger at t=17.9s and panicked exactly zero
		// agents: the trigger's condition was "35 agents have passed", which by definition can only
		// be true AFTER the blockade opens, and once it opens every remaining agent flips to
		// Breaching within a frame. So the eligible set was empty every time, and panic silently did
		// nothing while still reporting itself as fired.
		// A crowd surging through a broken line turning into a rout is also the more realistic
		// reading. Agents that already got through, or are already panicking/retreating/inactive,
		// stay ineligible.
		const bool bEligible =
			Agent.State == ERiotAgentState::Advancing ||
			Agent.State == ERiotAgentState::Blocked ||
			Agent.State == ERiotAgentState::Pressuring ||
			Agent.State == ERiotAgentState::Breaching;
		if (bEligible)
		{
			Candidates.Add(Entity);
		}
	}

	const int32 AffectedCount = FMath::Clamp(
		FMath::RoundToInt(Candidates.Num() * Trigger.AffectedFraction), 0, Candidates.Num());
	if (AffectedCount == 0)
	{
		return;
	}

	const double Stride = (double)Candidates.Num() / (double)AffectedCount;
	for (int32 i = 0; i < AffectedCount; ++i)
	{
		const int32 Index = FMath::Min((int32)(i * Stride), Candidates.Num() - 1);
		const FMassEntityHandle Entity = Candidates[Index];

		FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
		FRiotTargetFragment& Target = EntityManager->GetFragmentDataChecked<FRiotTargetFragment>(Entity);
		const FTransformFragment& TransformFrag = EntityManager->GetFragmentDataChecked<FTransformFragment>(Entity);

		Agent.State = ERiotAgentState::Panicked;
		Agent.PressingTime = 0.f;

		// Run away from the blockade they were facing.
		FVector Away = FVector(-1.0, 0.0, 0.0);
		if (Scenario.Blockades.IsValidIndex(Agent.TargetBlockadeIndex))
		{
			const FVector BlockadeLocation = Scenario.Blockades[Agent.TargetBlockadeIndex].Location;
			Away = (TransformFrag.GetTransform().GetLocation() - BlockadeLocation).GetSafeNormal2D();
		}
		Target.Destination = TransformFrag.GetTransform().GetLocation() + Away * 4000.0;
		Agent.TargetBlockadeIndex = INDEX_NONE;
	}

	UE_LOG(LogTemp, Display,
		TEXT("RiotCrowd: trigger '%s' panicked %d of %d eligible agents at t=%.2fs."),
		*Trigger.Id, AffectedCount, Candidates.Num(), Scenario.SimulationTime);
}

// ============================================================
// Representation
// ============================================================

bool URiotCrowdSubsystem::EnsureVisualizer()
{
	if (VisualizerActor)
	{
		return true;
	}

	UWorld* World = GetWorld();
	if (!World)
	{
		return false;
	}

	FActorSpawnParameters Params;
	// CLAUDE-NOTE: do NOT pin Params.Name to a fixed string. Doing so crashed the editor outright
	// on the second spawn of a session:
	//
	//   Fatal error: LevelActor.cpp:585
	//   Cannot generate unique name for 'RiotCrowdVisualizer' in level '.../UEDPIE_0_...'
	//
	// After riot_reset the previous visualizer has been Destroy()ed but not yet garbage collected,
	// so its name is still reserved. Requesting that exact name again is a fatal error, not a
	// fallback — UE only auto-uniquifies when you leave the name unset. This survived the first
	// live run because that run only ever spawned once; it took the spawn/reset/respawn cycle the
	// acceptance test requires to expose it.
	//
	// The actor is tracked by the VisualizerActor pointer, so it never needed a fixed name. The
	// label is cosmetic and carries no uniqueness requirement.
	Params.ObjectFlags |= RF_Transient;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	VisualizerActor = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, Params);
	if (!VisualizerActor)
	{
		return false;
	}
	VisualizerActor->SetActorLabel(TEXT("RiotCrowdVisualizer"));

	USceneComponent* Root = NewObject<USceneComponent>(VisualizerActor, TEXT("Root"));
	Root->RegisterComponent();
	VisualizerActor->SetRootComponent(Root);

	auto MakeISM = [&](const TCHAR* MeshPath, const TCHAR* ComponentName, const FLinearColor& /*Tint*/)
		-> UInstancedStaticMeshComponent*
	{
		UInstancedStaticMeshComponent* ISM =
			NewObject<UInstancedStaticMeshComponent>(VisualizerActor, ComponentName);
		if (UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, MeshPath))
		{
			ISM->SetStaticMesh(Mesh);
		}
		ISM->SetupAttachment(Root);
		ISM->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		ISM->SetCastShadow(false);
		ISM->RegisterComponent();
		return ISM;
	};

	RioterISM = MakeISM(RioterMeshPath, TEXT("RioterISM"), FLinearColor::Red);
	DefenderISM = MakeISM(DefenderMeshPath, TEXT("DefenderISM"), FLinearColor::Blue);

	return RioterISM != nullptr && DefenderISM != nullptr;
}

void URiotCrowdSubsystem::DestroyVisualizer()
{
	if (VisualizerActor)
	{
		VisualizerActor->Destroy();
	}
	VisualizerActor = nullptr;
	RioterISM = nullptr;
	DefenderISM = nullptr;
}

void URiotCrowdSubsystem::TickRepresentation()
{
	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager || !RioterISM || !DefenderISM)
	{
		return;
	}

	auto SyncInstances = [EntityManager](UInstancedStaticMeshComponent* ISM,
		const TArray<FMassEntityHandle>& Entities, bool bHideInactive)
	{
		TArray<FTransform> Transforms;
		Transforms.Reserve(Entities.Num());

		for (const FMassEntityHandle& Entity : Entities)
		{
			if (!EntityManager->IsEntityValid(Entity))
			{
				continue;
			}

			const FRiotAgentFragment& Agent = EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity);
			if (bHideInactive &&
				(Agent.State == ERiotAgentState::Queued || Agent.State == ERiotAgentState::Inactive))
			{
				continue;
			}

			FTransform Transform = EntityManager->GetFragmentDataChecked<FTransformFragment>(Entity).GetTransform();
			// BasicShapes are 100uu; scale down to something person-sized so a crowd reads as a crowd.
			Transform.SetScale3D(FVector(0.5, 0.5, 1.0));
			Transforms.Add(Transform);
		}

		// CLAUDE-NOTE: rebuild wholesale rather than diffing. Instance counts change every frame as
		// agents are released and deactivated, and AddInstance/RemoveInstance shuffles indices, so
		// index-based updates drift out of sync with the entity list within a few frames.
		// BatchUpdateInstancesTransforms cannot change the count, hence Clear + Add.
		ISM->ClearInstances();
		for (const FTransform& Transform : Transforms)
		{
			ISM->AddInstance(Transform, /*bWorldSpace=*/true);
		}
	};

	SyncInstances(RioterISM, OwnedRioters, /*bHideInactive=*/true);
	SyncInstances(DefenderISM, OwnedDefenders, /*bHideInactive=*/false);
}

// ============================================================
// Reporting
// ============================================================

FRiotRuntimeCounts URiotCrowdSubsystem::CollectCounts() const
{
	FRiotRuntimeCounts Counts;

	FMassEntityManager* EntityManager = GetEntityManager();
	if (!EntityManager)
	{
		return Counts;
	}

	for (const FMassEntityHandle& Entity : OwnedRioters)
	{
		if (!EntityManager->IsEntityValid(Entity))
		{
			continue;
		}

		++Counts.Total;
		switch (EntityManager->GetFragmentDataChecked<FRiotAgentFragment>(Entity).State)
		{
		case ERiotAgentState::Queued:         ++Counts.Queued; break;
		case ERiotAgentState::Advancing:      ++Counts.Advancing; break;
		case ERiotAgentState::Blocked:        ++Counts.Blocked; break;
		case ERiotAgentState::Pressuring:     ++Counts.Pressuring; break;
		case ERiotAgentState::Breaching:      ++Counts.Breaching; break;
		case ERiotAgentState::PassedBlockade: ++Counts.PassedBlockade; break;
		case ERiotAgentState::Panicked:       ++Counts.Panicked; break;
		case ERiotAgentState::Retreating:     ++Counts.Retreating; break;
		case ERiotAgentState::Inactive:       ++Counts.Inactive; break;
		}
	}

	for (const FMassEntityHandle& Entity : OwnedDefenders)
	{
		if (EntityManager->IsEntityValid(Entity))
		{
			++Counts.Defenders;
		}
	}

	return Counts;
}

TSharedRef<FJsonObject> URiotCrowdSubsystem::BuildRuntimeReport() const
{
	TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();

	Report->SetBoolField(TEXT("spawned"), bSpawned);
	Report->SetBoolField(TEXT("running"), bRunning);
	Report->SetStringField(TEXT("scenarioId"), ActiveScenarioId);

	const FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ActiveScenarioId);
	if (!Scenario)
	{
		Report->SetStringField(TEXT("lifecycle"), LexToStringRiotLifecycle(ERiotLifecycle::Unconfigured));
		return Report;
	}

	Report->SetStringField(TEXT("lifecycle"), LexToStringRiotLifecycle(Scenario->Lifecycle));
	Report->SetNumberField(TEXT("simulationTime"), Scenario->SimulationTime);
	Report->SetNumberField(TEXT("seed"), Scenario->Seed);
	Report->SetNumberField(TEXT("spawnedRioters"), Scenario->SpawnedRioters);
	Report->SetNumberField(TEXT("spawnedDefenders"), Scenario->SpawnedDefenders);
	Report->SetNumberField(TEXT("agentsPassedBlockade"), Scenario->AgentsPassedBlockade);

	// CLAUDE-NOTE: representation telemetry. Added after the first live run could not prove the
	// crowd was rendering: PIE opens in a floating window, so both viewport_capture and HighResShot
	// photograph the EDITOR level viewport, where riot entities do not exist. That left "the ISM is
	// empty" and "the screenshot is of the wrong world" indistinguishable from the outside.
	// Reporting the live instance counts separates them without needing a picture.
	TSharedRef<FJsonObject> RepJson = MakeShared<FJsonObject>();
	RepJson->SetBoolField(TEXT("visualizerActorValid"), VisualizerActor != nullptr);
	RepJson->SetNumberField(TEXT("rioterInstances"), RioterISM ? RioterISM->GetInstanceCount() : -1);
	RepJson->SetNumberField(TEXT("defenderInstances"), DefenderISM ? DefenderISM->GetInstanceCount() : -1);
	RepJson->SetBoolField(TEXT("rioterMeshSet"), RioterISM && RioterISM->GetStaticMesh() != nullptr);
	RepJson->SetBoolField(TEXT("defenderMeshSet"), DefenderISM && DefenderISM->GetStaticMesh() != nullptr);
	Report->SetObjectField(TEXT("representation"), RepJson);

	const FRiotRuntimeCounts Counts = CollectCounts();
	TSharedRef<FJsonObject> CountsJson = MakeShared<FJsonObject>();
	CountsJson->SetNumberField(TEXT("total"), Counts.Total);
	CountsJson->SetNumberField(TEXT("queued"), Counts.Queued);
	CountsJson->SetNumberField(TEXT("advancing"), Counts.Advancing);
	CountsJson->SetNumberField(TEXT("blocked"), Counts.Blocked);
	CountsJson->SetNumberField(TEXT("pressuring"), Counts.Pressuring);
	CountsJson->SetNumberField(TEXT("breaching"), Counts.Breaching);
	CountsJson->SetNumberField(TEXT("passedBlockade"), Counts.PassedBlockade);
	CountsJson->SetNumberField(TEXT("panicked"), Counts.Panicked);
	CountsJson->SetNumberField(TEXT("retreating"), Counts.Retreating);
	CountsJson->SetNumberField(TEXT("inactive"), Counts.Inactive);
	CountsJson->SetNumberField(TEXT("defenders"), Counts.Defenders);
	Report->SetObjectField(TEXT("agentCounts"), CountsJson);

	// CLAUDE-NOTE: the pressure model's tunables ship inside the report on purpose. The milestone
	// forbids hiding the model behind magic constants, and a reader can recompute every pressure
	// figure below from these numbers plus the pressing counts.
	const FRiotPressureModel& Model = Scenario->PressureModel;
	TSharedRef<FJsonObject> ModelJson = MakeShared<FJsonObject>();
	ModelJson->SetNumberField(TEXT("pressureGain"), Model.PressureGain);
	ModelJson->SetNumberField(TEXT("sustainBonusPerSecond"), Model.SustainBonusPerSecond);
	ModelJson->SetNumberField(TEXT("decayRatePerSecond"), Model.DecayRatePerSecond);
	ModelJson->SetNumberField(TEXT("riseRatePerSecond"), Model.RiseRatePerSecond);
	ModelJson->SetNumberField(TEXT("contactBand"), Model.ContactBand);
	ModelJson->SetNumberField(TEXT("maxPressure"), Model.MaxPressure);
	ModelJson->SetStringField(TEXT("formula"),
		TEXT("target = (pressing / max(1, defenders)) * pressureGain * (1 + sustainBonusPerSecond * avgPressingTime)"));
	Report->SetObjectField(TEXT("pressureModel"), ModelJson);

	TArray<TSharedPtr<FJsonValue>> BlockadeArr;
	for (const FRiotBlockade& Blockade : Scenario->Blockades)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("blockadeId"), Blockade.Id);
		J->SetBoolField(TEXT("broken"), Blockade.bBroken);
		J->SetNumberField(TEXT("currentPressure"), Blockade.CurrentPressure);
		J->SetNumberField(TEXT("peakPressure"), Blockade.PeakPressure);
		J->SetNumberField(TEXT("holdThreshold"), Blockade.HoldThreshold);
		J->SetNumberField(TEXT("breakThreshold"), Blockade.BreakThreshold);
		J->SetNumberField(TEXT("brokenAtTime"), Blockade.BrokenAtTime);
		J->SetNumberField(TEXT("defenderCount"), Blockade.DefenderCount);
		BlockadeArr.Add(MakeShared<FJsonValueObject>(J));
	}
	Report->SetArrayField(TEXT("blockades"), BlockadeArr);

	TArray<TSharedPtr<FJsonValue>> TriggerArr;
	for (const FRiotTrigger& Trigger : Scenario->Triggers)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("triggerId"), Trigger.Id);
		J->SetBoolField(TEXT("fired"), Trigger.bFired);
		J->SetNumberField(TEXT("firedAtTime"), Trigger.FiredAtTime);
		TriggerArr.Add(MakeShared<FJsonValueObject>(J));
	}
	Report->SetArrayField(TEXT("triggers"), TriggerArr);

	return Report;
}
