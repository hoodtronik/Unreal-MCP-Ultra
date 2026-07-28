#include "RiotRepresentation.h"

#include "RiotCrowdFragments.h"
#include "RiotErrorCodes.h"

#include "Camera/PlayerCameraManager.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "MassCommonFragments.h"
#include "MassEntityManager.h"
#include "MassLODSubsystem.h"

namespace
{
	/** Placeholder mesh used only when no valid character profile applies. Diagnostic, never a result. */
	const TCHAR* PlaceholderMeshPath = TEXT("/Engine/BasicShapes/Cylinder.Cylinder");

	/** Parking transform for a released instance slot: zero scale renders nothing. */
	const FTransform ParkedInstanceTransform(
		FQuat::Identity, FVector(0.0, 0.0, -100000.0), FVector::ZeroVector);
}

void FRiotRepresentationManager::Initialize(UWorld* InWorld, const FRiotRepresentationProfile& InProfile,
	const TArray<FRiotCharacterProfile>& InProfiles)
{
	World = InWorld;
	Profile = InProfile;

	// Copy only usable profiles. An invalid profile stays in the store so the operator can read why
	// it failed, but it must never be selectable for an agent.
	ResolvedProfiles.Reset();
	for (const FRiotCharacterProfile& Candidate : InProfiles)
	{
		if (Candidate.IsUsable())
		{
			ResolvedProfiles.Add(Candidate);
		}
	}
}

void FRiotRepresentationManager::RegisterAgent(FMassEntityHandle Entity, ERiotFactionType FactionType,
	uint32 SeedSalt)
{
	FRiotAgentRepresentation Agent;
	Agent.Entity = Entity;
	Agent.FactionType = FactionType;

	TArray<const FRiotCharacterProfile*> Eligible;
	for (const FRiotCharacterProfile& Candidate : ResolvedProfiles)
	{
		if (Candidate.SupportsFactionType(FactionType))
		{
			Eligible.Add(&Candidate);
		}
	}

	const int32 Selected = SelectRiotProfileForAgent(Eligible, SeedSalt);
	if (Selected != INDEX_NONE)
	{
		// Map back from the eligible sublist to the resolved array.
		Agent.ProfileIndex = ResolvedProfiles.IndexOfByPredicate(
			[Chosen = Eligible[Selected]](const FRiotCharacterProfile& P)
			{
				return P.ProfileId == Chosen->ProfileId;
			});
	}

	// CLAUDE-NOTE: two DIFFERENT hashes of the same salt. Reusing one value for both phase and play
	// rate would correlate them - every agent that started late in its animation would also play
	// fast - which reads as a pattern rather than as variation.
	const uint32 PhaseHash = HashCombine(SeedSalt, 0x85EBCA6Bu);
	const uint32 RateHash = HashCombine(SeedSalt, 0xC2B2AE35u);
	Agent.PhaseOffset = static_cast<float>(PhaseHash % 1000u) / 1000.f;
	Agent.PlayRateScale = 0.9f + (static_cast<float>(RateHash % 200u) / 1000.f); // 0.90 .. 1.09

	Agents.Add(Entity, MoveTemp(Agent));
}

void FRiotRepresentationManager::UnregisterAgent(FMassEntityHandle Entity)
{
	if (FRiotAgentRepresentation* Agent = Agents.Find(Entity))
	{
		ReleaseActor(*Agent);
		ReleaseInstanceSlot(*Agent);
		Agents.Remove(Entity);
	}
}

bool FRiotRepresentationManager::GetCameraTransform(FTransform& OutTransform,
	FString& OutResolvedSource) const
{
	OutResolvedSource = ResolvedCameraSource;
	OutTransform = LastCameraTransform;
	return bCameraResolved;
}

ERiotRepresentationTier FRiotRepresentationManager::DesiredTierForDistance(double Distance,
	ERiotRepresentationTier Current) const
{
	const double H = Profile.HysteresisDistance;

	// CLAUDE-NOTE: hysteresis is applied as a one-sided extension of the band the agent is ALREADY
	// in, not as a symmetric dead zone around each threshold. An agent keeps its current tier until
	// it leaves that tier's range by more than H, which is what stops an agent hovering exactly on a
	// threshold from flipping every frame. Applying it symmetrically to both the entry and exit of
	// every band would create ranges where two tiers are simultaneously valid and the result depends
	// on evaluation order.
	switch (Current)
	{
	case ERiotRepresentationTier::Near:
		if (Distance < Profile.NearDistance + H) { return ERiotRepresentationTier::Near; }
		break;
	case ERiotRepresentationTier::Mid:
		if (Distance >= Profile.NearDistance - H && Distance < Profile.MidDistance + H)
		{
			return ERiotRepresentationTier::Mid;
		}
		break;
	case ERiotRepresentationTier::Far:
	case ERiotRepresentationTier::Placeholder:
		if (Distance >= Profile.MidDistance - H && Distance < Profile.FarDistance + H)
		{
			return ERiotRepresentationTier::Far;
		}
		break;
	default:
		break;
	}

	if (Distance < Profile.NearDistance) { return ERiotRepresentationTier::Near; }
	if (Distance < Profile.MidDistance)  { return ERiotRepresentationTier::Mid; }
	if (Distance < Profile.FarDistance)  { return ERiotRepresentationTier::Far; }
	return ERiotRepresentationTier::None;
}

bool FRiotRepresentationManager::EnsureFarISM()
{
	if (FarISM.IsValid())
	{
		return true;
	}

	UWorld* WorldPtr = World.Get();
	if (!WorldPtr)
	{
		return false;
	}

	FActorSpawnParameters Params;
	// CLAUDE-NOTE: never pin Params.Name. The foundation hit a fatal
	// "Cannot generate unique name ... in level" on the second spawn of a session, because a
	// Destroy()ed actor keeps its name reserved until GC. See RiotCrowdSubsystem.cpp EnsureVisualizer.
	Params.ObjectFlags |= RF_Transient;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	AActor* Visualizer = WorldPtr->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, Params);
	if (!Visualizer)
	{
		return false;
	}
	Visualizer->SetActorLabel(TEXT("RiotFarRepresentation"));

	USceneComponent* Root = NewObject<USceneComponent>(Visualizer, TEXT("Root"));
	Root->RegisterComponent();
	Visualizer->SetRootComponent(Root);

	UInstancedStaticMeshComponent* ISM =
		NewObject<UInstancedStaticMeshComponent>(Visualizer, TEXT("FarISM"));
	if (UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, PlaceholderMeshPath))
	{
		ISM->SetStaticMesh(Mesh);
	}
	ISM->SetupAttachment(Root);
	ISM->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	ISM->SetCastShadow(false);
	ISM->RegisterComponent();

	FarVisualizerActor = Visualizer;
	FarISM = ISM;
	return true;
}

int32 FRiotRepresentationManager::AcquireInstanceSlot()
{
	UInstancedStaticMeshComponent* ISM = FarISM.Get();
	if (!ISM)
	{
		return INDEX_NONE;
	}

	if (FreeInstanceSlots.Num() > 0)
	{
		return FreeInstanceSlots.Pop(EAllowShrinking::No);
	}

	const int32 NewSlot = ISM->AddInstance(ParkedInstanceTransform, /*bWorldSpace=*/true);
	InstanceSlots.SetNum(FMath::Max(InstanceSlots.Num(), NewSlot + 1));
	return NewSlot;
}

void FRiotRepresentationManager::ReleaseInstanceSlot(FRiotAgentRepresentation& Agent)
{
	if (Agent.InstanceSlot == INDEX_NONE)
	{
		return;
	}

	if (UInstancedStaticMeshComponent* ISM = FarISM.Get())
	{
		// Park rather than remove: RemoveInstance re-indexes every later instance, which is exactly
		// the churn the stable-slot scheme exists to avoid.
		ISM->UpdateInstanceTransform(Agent.InstanceSlot, ParkedInstanceTransform,
			/*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/false, /*bTeleport=*/true);
	}

	if (InstanceSlots.IsValidIndex(Agent.InstanceSlot))
	{
		InstanceSlots[Agent.InstanceSlot] = FMassEntityHandle();
	}
	FreeInstanceSlots.Push(Agent.InstanceSlot);
	Agent.InstanceSlot = INDEX_NONE;
}

ARiotCharacterActor* FRiotRepresentationManager::AcquireActor(const FRiotCharacterProfile& CharacterProfile)
{
	UWorld* WorldPtr = World.Get();
	if (!WorldPtr)
	{
		return nullptr;
	}

	ARiotCharacterActor* Actor = nullptr;
	while (FreeActors.Num() > 0 && !Actor)
	{
		Actor = FreeActors.Pop(EAllowShrinking::No).Get();
	}

	if (!Actor)
	{
		FActorSpawnParameters Params;
		Params.ObjectFlags |= RF_Transient;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		Actor = WorldPtr->SpawnActor<ARiotCharacterActor>(
			ARiotCharacterActor::StaticClass(), FTransform::Identity, Params);
		if (!Actor)
		{
			return nullptr;
		}
		SpawnedActors.Add(Actor);
	}

	Actor->PrepareForGame_Implementation();
	if (!Actor->ApplyProfile(CharacterProfile))
	{
		// The mesh vanished between validation and use. Return it to the pool rather than leaving a
		// blank actor standing in the scene looking like a representation failure.
		Actor->PrepareForPooling_Implementation();
		FreeActors.Push(Actor);
		return nullptr;
	}
	return Actor;
}

void FRiotRepresentationManager::ReleaseActor(FRiotAgentRepresentation& Agent)
{
	if (ARiotCharacterActor* Actor = Agent.Actor.Get())
	{
		Actor->PrepareForPooling_Implementation();
		FreeActors.Push(Actor);
	}
	Agent.Actor = nullptr;
}

void FRiotRepresentationManager::ApplyTierTransition(FRiotAgentRepresentation& Agent,
	ERiotRepresentationTier NewTier, const FTransform& Transform)
{
	if (Agent.Tier == NewTier)
	{
		return;
	}

	const bool bWasActorTier = Agent.Tier == ERiotRepresentationTier::Near
		|| Agent.Tier == ERiotRepresentationTier::Mid;
	const bool bIsActorTier = NewTier == ERiotRepresentationTier::Near
		|| NewTier == ERiotRepresentationTier::Mid;

	// CLAUDE-NOTE: release the OLD representation before acquiring the new one. Doing it the other
	// way round leaves both alive for the duration of the call, which is precisely the "duplicate
	// body during transition" the acceptance test looks for.
	if (bWasActorTier && !bIsActorTier)
	{
		ReleaseActor(Agent);
	}
	if (Agent.Tier == ERiotRepresentationTier::Far || Agent.Tier == ERiotRepresentationTier::Placeholder)
	{
		if (NewTier != ERiotRepresentationTier::Far && NewTier != ERiotRepresentationTier::Placeholder)
		{
			ReleaseInstanceSlot(Agent);
		}
	}

	if (bIsActorTier)
	{
		if (!Agent.Actor.IsValid())
		{
			if (ResolvedProfiles.IsValidIndex(Agent.ProfileIndex))
			{
				if (ARiotCharacterActor* Actor = AcquireActor(ResolvedProfiles[Agent.ProfileIndex]))
				{
					Actor->SetVariation(Agent.PhaseOffset, Agent.PlayRateScale);
					Actor->SetActorTransform(Transform);
					Agent.Actor = Actor;
				}
			}
		}
		if (ARiotCharacterActor* Actor = Agent.Actor.Get())
		{
			Actor->ApplyTier(NewTier);
			Actor->bIsPromoted = Agent.bManualPromote;
		}
	}
	else if (NewTier == ERiotRepresentationTier::Far || NewTier == ERiotRepresentationTier::Placeholder)
	{
		if (Agent.InstanceSlot == INDEX_NONE && EnsureFarISM())
		{
			Agent.InstanceSlot = AcquireInstanceSlot();
			if (InstanceSlots.IsValidIndex(Agent.InstanceSlot))
			{
				InstanceSlots[Agent.InstanceSlot] = Agent.Entity;
			}
		}
	}

	Agent.PrevTier = Agent.Tier;
	Agent.Tier = NewTier;
}

void FRiotRepresentationManager::Update(FMassEntityManager& EntityManager, double WorldTime,
	double DeltaTime)
{
	Counts.Reset();

	UWorld* WorldPtr = World.Get();
	if (!WorldPtr)
	{
		return;
	}

	// ----- camera -----
	bCameraResolved = false;
	ResolvedCameraSource = LexToStringRiotCameraSource(Profile.CameraSource);
	if (Profile.CameraSource == ERiotCameraSource::ExplicitTransform)
	{
		LastCameraTransform = Profile.ExplicitCameraTransform;
		bCameraResolved = true;
	}
	else
	{
		// CLAUDE-NOTE: read the PlayerController's camera directly rather than going through
		// UMassLODSubsystem::GetSynchronizedViewers(). The subsystem gathers exactly this same
		// PlayerController list (MassLODSubsystem.cpp SynchronizeViewers, gated by
		// bGatherPlayerControllers which defaults true), but its viewer array is synchronised on the
		// Mass PrePhysics phase. Reading it from our own tick would sample whatever the previous
		// frame left, and a one-frame-stale camera during a fast pan is visible as late LOD
		// transitions. The direct read is the same data, one frame fresher.
		if (APlayerController* PC = WorldPtr->GetFirstPlayerController())
		{
			if (PC->PlayerCameraManager)
			{
				LastCameraTransform = FTransform(
					PC->PlayerCameraManager->GetCameraRotation(),
					PC->PlayerCameraManager->GetCameraLocation());
				bCameraResolved = true;
				ResolvedCameraSource = TEXT("piePlayerCamera");
			}
		}
	}

	if (!bCameraResolved)
	{
		// Documented fallback: without a camera every agent falls to the cheapest representation
		// rather than all qualifying for the near tier and blowing the actor budget.
		ResolvedCameraSource = FString::Printf(
			TEXT("%s (unresolved; using far-tier fallback)"),
			LexToStringRiotCameraSource(Profile.CameraSource));
		LastCameraTransform = FTransform::Identity;
	}

	const FVector CameraLocation = LastCameraTransform.GetLocation();

	// ----- pass 1: distance and desired tier -----
	struct FCandidate
	{
		FMassEntityHandle Entity;
		double Distance;
		bool bManual;
	};
	TArray<FCandidate> NearCandidates;
	TArray<FCandidate> MidCandidates;

	for (TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		FRiotAgentRepresentation& Agent = Pair.Value;
		if (!EntityManager.IsEntityValid(Agent.Entity))
		{
			continue;
		}

		const FRiotAgentFragment& Fragment =
			EntityManager.GetFragmentDataChecked<FRiotAgentFragment>(Agent.Entity);
		const FTransform Transform =
			EntityManager.GetFragmentDataChecked<FTransformFragment>(Agent.Entity).GetTransform();

		++Counts.Total;

		// An inactive or not-yet-released agent is not drawn at all.
		if (Fragment.State == ERiotAgentState::Queued || Fragment.State == ERiotAgentState::Inactive)
		{
			ApplyTierTransition(Agent, ERiotRepresentationTier::None, Transform);
			++Counts.NoneTier;
			continue;
		}

		const double Distance = bCameraResolved
			? FVector::Dist(CameraLocation, Transform.GetLocation())
			: Profile.FarDistance; // fallback: everything is "far"
		Agent.LastDistance = Distance;

		ERiotRepresentationTier Desired = Agent.bManualPromote
			? ERiotRepresentationTier::Near
			: DesiredTierForDistance(Distance, Agent.Tier);

		if (Desired == ERiotRepresentationTier::Near)
		{
			++Counts.QualifiedNear;
			NearCandidates.Add({ Agent.Entity, Distance, Agent.bManualPromote });
		}
		else if (Desired == ERiotRepresentationTier::Mid)
		{
			++Counts.QualifiedMid;
			MidCandidates.Add({ Agent.Entity, Distance, false });
		}
	}

	// ----- pass 2: budgets -----
	// CLAUDE-NOTE: stable ordering. Manual promotions first (they are an explicit operator decision
	// and must not be evicted by a closer agent), then nearest-first, then entity index as the final
	// tie-break. Without that last key, two agents at identical distance could swap tiers between
	// frames purely from TMap iteration order, which looks exactly like LOD thrash.
	auto SortCandidates = [](TArray<FCandidate>& Candidates)
	{
		Candidates.Sort([](const FCandidate& A, const FCandidate& B)
		{
			if (A.bManual != B.bManual) { return A.bManual; }
			if (!FMath::IsNearlyEqual(A.Distance, B.Distance)) { return A.Distance < B.Distance; }
			return A.Entity.Index < B.Entity.Index;
		});
	};
	SortCandidates(NearCandidates);

	TSet<FMassEntityHandle> AssignedNear;
	const int32 NearBudget = Profile.MaxNearActors;
	for (int32 i = 0; i < NearCandidates.Num(); ++i)
	{
		if (i < NearBudget)
		{
			AssignedNear.Add(NearCandidates[i].Entity);
		}
		else
		{
			// Overflow drops to the next cheaper tier; it is never dropped from the simulation.
			MidCandidates.Add(NearCandidates[i]);
			++Counts.NearOverflow;
		}
	}

	SortCandidates(MidCandidates);
	TSet<FMassEntityHandle> AssignedMid;
	const int32 MidBudget = Profile.MaxMidRepresentations;
	for (int32 i = 0; i < MidCandidates.Num(); ++i)
	{
		if (i < MidBudget)
		{
			AssignedMid.Add(MidCandidates[i].Entity);
		}
		else
		{
			++Counts.MidOverflow;
		}
	}

	// ----- pass 3: transitions and per-frame updates -----
	bool bAnyInstanceDirty = false;
	for (TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		FRiotAgentRepresentation& Agent = Pair.Value;

		// CLAUDE-NOTE: skip only on an invalid ENTITY. An earlier version of this guard also
		// short-circuited when Agent.Tier was None, which meant that on the very first frame — when
		// every agent still holds the default tier of None — the loop skipped all of them and no
		// agent was ever transitioned into a tier at all. Found live: the budget pass correctly
		// assigned 24 near and 200 mid, and then every tier count reported zero. The tier an agent is
		// LEAVING must never gate whether it is allowed to arrive somewhere.
		if (!EntityManager.IsEntityValid(Agent.Entity))
		{
			continue;
		}

		const FRiotAgentFragment& Fragment =
			EntityManager.GetFragmentDataChecked<FRiotAgentFragment>(Agent.Entity);
		if (Fragment.State == ERiotAgentState::Queued || Fragment.State == ERiotAgentState::Inactive)
		{
			continue;
		}

		const FTransform Transform =
			EntityManager.GetFragmentDataChecked<FTransformFragment>(Agent.Entity).GetTransform();

		ERiotRepresentationTier Target;
		if (AssignedNear.Contains(Agent.Entity))
		{
			Target = ERiotRepresentationTier::Near;
		}
		else if (AssignedMid.Contains(Agent.Entity))
		{
			Target = ERiotRepresentationTier::Mid;
		}
		else if (Agent.LastDistance < Profile.FarDistance && Profile.bFarRepresentationEnabled)
		{
			Target = ERiotRepresentationTier::Far;
		}
		else
		{
			Target = ERiotRepresentationTier::None;
		}

		// An agent with no usable character profile can only ever be a diagnostic placeholder, and
		// it is counted separately so a run can never quietly pass on placeholders.
		const bool bHasProfile = ResolvedProfiles.IsValidIndex(Agent.ProfileIndex);
		if (!bHasProfile && (Target == ERiotRepresentationTier::Near || Target == ERiotRepresentationTier::Mid))
		{
			Target = ERiotRepresentationTier::Placeholder;
		}

		ApplyTierTransition(Agent, Target, Transform);

		switch (Agent.Tier)
		{
		case ERiotRepresentationTier::Near:
		case ERiotRepresentationTier::Mid:
			if (ARiotCharacterActor* Actor = Agent.Actor.Get())
			{
				Actor->SetActorTransform(Transform, /*bSweep=*/false, nullptr, ETeleportType::TeleportPhysics);
				Actor->SetAgentState(Fragment.State, Agent.FactionType, Fragment.Speed, Fragment.Speed);
				Actor->bIsPromoted = Agent.bManualPromote;
				++Counts.ActiveSkeletalMeshes;
			}
			(Agent.Tier == ERiotRepresentationTier::Near ? Counts.Near : Counts.Mid)++;
			break;

		case ERiotRepresentationTier::Far:
		case ERiotRepresentationTier::Placeholder:
			if (UInstancedStaticMeshComponent* ISM = FarISM.Get())
			{
				if (Agent.InstanceSlot != INDEX_NONE)
				{
					FTransform InstanceTransform = Transform;
					InstanceTransform.SetScale3D(FVector(0.5, 0.5, 1.0));
					// Deferred dirty: one render-state update for the whole pass instead of one per
					// agent. This plus stable slots is what replaces the per-tick rebuild.
					ISM->UpdateInstanceTransform(Agent.InstanceSlot, InstanceTransform,
						/*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/false, /*bTeleport=*/true);
					bAnyInstanceDirty = true;
				}
			}
			if (Agent.Tier == ERiotRepresentationTier::Far) { ++Counts.Far; }
			else { ++Counts.Placeholder; }
			break;

		default:
			++Counts.NoneTier;
			break;
		}

		Agent.LastUpdateTime = WorldTime;

		if (Agent.Actor.IsValid() && Agent.InstanceSlot != INDEX_NONE)
		{
			// Both representations live at once: the exact defect the acceptance test hunts for.
			++Counts.DuplicateRepresentations;
		}
	}

	if (bAnyInstanceDirty)
	{
		if (UInstancedStaticMeshComponent* ISM = FarISM.Get())
		{
			ISM->MarkRenderStateDirty();
		}
	}

	Counts.PromotedActors = 0;
	for (const TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		if (Pair.Value.bManualPromote) { ++Counts.PromotedActors; }
	}
	Counts.PooledActorsAvailable = FreeActors.Num();
	Counts.AnimatedInstances = 0; // Tier 3 animation is not implemented; see the milestone docs.
}

int32 FRiotRepresentationManager::PromoteAgents(const TArray<FMassEntityHandle>& Entities,
	FString& OutErrorCode, FString& OutMessage)
{
	int32 AlreadyPromoted = 0;
	for (const TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		if (Pair.Value.bManualPromote) { ++AlreadyPromoted; }
	}

	int32 WouldAdd = 0;
	for (const FMassEntityHandle& Entity : Entities)
	{
		const FRiotAgentRepresentation* Agent = Agents.Find(Entity);
		if (Agent && !Agent->bManualPromote) { ++WouldAdd; }
	}

	if (AlreadyPromoted + WouldAdd > Profile.MaxNearActors)
	{
		OutErrorCode = RiotErrorCodes::RepresentationBudgetExceeded;
		OutMessage = FString::Printf(
			TEXT("Promoting %d more agent(s) would bring the pinned near-tier count to %d, above the "
				 "representation profile's maxNearActors of %d. No agents were promoted. Raise the "
				 "budget with riot_set_representation_profile or demote some agents first."),
			WouldAdd, AlreadyPromoted + WouldAdd, Profile.MaxNearActors);
		return 0;
	}

	int32 Changed = 0;
	for (const FMassEntityHandle& Entity : Entities)
	{
		FRiotAgentRepresentation* Agent = Agents.Find(Entity);
		if (!Agent)
		{
			continue;
		}
		// Idempotent: promoting an already-promoted agent must not create a second actor.
		if (!Agent->bManualPromote)
		{
			Agent->bManualPromote = true;
			++Changed;
		}
	}
	return Changed;
}

int32 FRiotRepresentationManager::DemoteAgents(const TArray<FMassEntityHandle>& Entities,
	FString& OutErrorCode, FString& OutMessage)
{
	int32 Changed = 0;
	for (const FMassEntityHandle& Entity : Entities)
	{
		FRiotAgentRepresentation* Agent = Agents.Find(Entity);
		if (!Agent)
		{
			continue;
		}
		// Idempotent: demoting an already-demoted agent is a no-op, never a crash.
		if (Agent->bManualPromote)
		{
			Agent->bManualPromote = false;
			++Changed;
		}
	}
	return Changed;
}

void FRiotRepresentationManager::Reset()
{
	for (TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		ReleaseActor(Pair.Value);
		Pair.Value.InstanceSlot = INDEX_NONE;
	}
	Agents.Reset();

	for (const TWeakObjectPtr<ARiotCharacterActor>& Weak : SpawnedActors)
	{
		if (ARiotCharacterActor* Actor = Weak.Get())
		{
			Actor->Destroy();
		}
	}
	SpawnedActors.Reset();
	FreeActors.Reset();

	if (AActor* Visualizer = FarVisualizerActor.Get())
	{
		Visualizer->Destroy();
	}
	FarVisualizerActor = nullptr;
	FarISM = nullptr;

	InstanceSlots.Reset();
	FreeInstanceSlots.Reset();
	Counts.Reset();
	ResolvedProfiles.Reset();
	bCameraResolved = false;
	ResolvedCameraSource.Reset();
}

TMap<FString, int32> FRiotRepresentationManager::CountsByProfile() const
{
	TMap<FString, int32> Result;
	for (const TPair<FMassEntityHandle, FRiotAgentRepresentation>& Pair : Agents)
	{
		const FString Key = ResolvedProfiles.IsValidIndex(Pair.Value.ProfileIndex)
			? ResolvedProfiles[Pair.Value.ProfileIndex].ProfileId
			: FString(TEXT("<none>"));
		Result.FindOrAdd(Key)++;
	}
	return Result;
}

TSharedRef<FJsonObject> FRiotRepresentationManager::BuildReport(FMassEntityManager& EntityManager) const
{
	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();

	Json->SetStringField(TEXT("cameraSource"), ResolvedCameraSource);
	if (bCameraResolved)
	{
		TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
		const FVector Location = LastCameraTransform.GetLocation();
		const FRotator Rotation = LastCameraTransform.Rotator();
		Camera->SetNumberField(TEXT("x"), Location.X);
		Camera->SetNumberField(TEXT("y"), Location.Y);
		Camera->SetNumberField(TEXT("z"), Location.Z);
		Camera->SetNumberField(TEXT("pitch"), Rotation.Pitch);
		Camera->SetNumberField(TEXT("yaw"), Rotation.Yaw);
		Camera->SetNumberField(TEXT("roll"), Rotation.Roll);
		Json->SetObjectField(TEXT("cameraTransform"), Camera);
	}
	else
	{
		// Never report an unavailable measurement as zero.
		Json->SetStringField(TEXT("cameraTransform"), TEXT("unavailable"));
	}

	Json->SetNumberField(TEXT("totalAgents"), Counts.Total);
	Json->SetNumberField(TEXT("nearTierCount"), Counts.Near);
	Json->SetNumberField(TEXT("midTierCount"), Counts.Mid);
	Json->SetNumberField(TEXT("farTierCount"), Counts.Far);
	Json->SetNumberField(TEXT("fallbackPlaceholderCount"), Counts.Placeholder);
	Json->SetNumberField(TEXT("unrepresentedCount"), Counts.NoneTier);
	Json->SetNumberField(TEXT("promotedActorCount"), Counts.PromotedActors);
	Json->SetNumberField(TEXT("pooledActorCount"), Counts.PooledActorsAvailable);
	Json->SetNumberField(TEXT("activeSkeletalMeshCount"), Counts.ActiveSkeletalMeshes);
	Json->SetNumberField(TEXT("animatedInstanceCount"), Counts.AnimatedInstances);
	Json->SetNumberField(TEXT("duplicateRepresentationCount"), Counts.DuplicateRepresentations);

	TSharedRef<FJsonObject> Qualified = MakeShared<FJsonObject>();
	Qualified->SetNumberField(TEXT("near"), Counts.QualifiedNear);
	Qualified->SetNumberField(TEXT("mid"), Counts.QualifiedMid);
	Json->SetObjectField(TEXT("qualifiedCounts"), Qualified);

	TSharedRef<FJsonObject> Overflow = MakeShared<FJsonObject>();
	Overflow->SetNumberField(TEXT("near"), Counts.NearOverflow);
	Overflow->SetNumberField(TEXT("mid"), Counts.MidOverflow);
	Json->SetObjectField(TEXT("budgetOverflowCounts"), Overflow);

	Json->SetObjectField(TEXT("representationBudget"), Profile.ToJson());

	TSharedRef<FJsonObject> ByProfile = MakeShared<FJsonObject>();
	for (const TPair<FString, int32>& Pair : CountsByProfile())
	{
		ByProfile->SetNumberField(Pair.Key, Pair.Value);
	}
	Json->SetObjectField(TEXT("agentsByCharacterProfile"), ByProfile);

	// Honest capability reporting: the far tier renders instanced geometry but does not animate it.
	TArray<TSharedPtr<FJsonValue>> Warnings;
	Warnings.Add(MakeShared<FJsonValueString>(
		TEXT("Tier 3 (background) renders instanced static geometry and does NOT animate. "
			 "AnimToTexture-backed animated instancing is not implemented in this milestone; see "
			 "docs/riot-crowd/UE56-RIGGED-REPRESENTATION-API-FINDINGS.md section 11.")));
	if (!bCameraResolved)
	{
		Warnings.Add(MakeShared<FJsonValueString>(
			TEXT("No camera could be resolved; every agent fell back to the far tier.")));
	}
	Json->SetArrayField(TEXT("warnings"), Warnings);

	return Json;
}
