#include "RiotCrowdSteeringProcessor.h"

#include "RiotCrowdFragments.h"
#include "MassCommonFragments.h"
#include "MassExecutionContext.h"
#include "MassMovementFragments.h"

URiotCrowdSteeringProcessor::URiotCrowdSteeringProcessor()
	: EntityQuery(*this)
{
	ExecutionFlags = (int32)EProcessorExecutionFlags::Standalone | (int32)EProcessorExecutionFlags::Server;
	ProcessingPhase = EMassProcessingPhase::PrePhysics;
}

void URiotCrowdSteeringProcessor::ConfigureQueries(const TSharedRef<FMassEntityManager>& EntityManager)
{
	EntityQuery.AddRequirement<FTransformFragment>(EMassFragmentAccess::ReadWrite);
	EntityQuery.AddRequirement<FRiotAgentFragment>(EMassFragmentAccess::ReadWrite);
	EntityQuery.AddRequirement<FRiotTargetFragment>(EMassFragmentAccess::ReadOnly);
	EntityQuery.AddRequirement<FMassVelocityFragment>(EMassFragmentAccess::ReadWrite);
}

void URiotCrowdSteeringProcessor::Execute(FMassEntityManager& EntityManager, FMassExecutionContext& Context)
{
	// CLAUDE-NOTE: 5.6 dropped the FMassEntityManager parameter from ForEachEntityChunk
	// (MassEntityQuery.h:93; the 3-arg form at :315 is deprecated). The manager is still passed to
	// Execute, it is just no longer threaded through the iteration call.
	EntityQuery.ForEachEntityChunk(Context, [](FMassExecutionContext& ChunkContext)
	{
		const float DeltaTime = ChunkContext.GetDeltaTimeSeconds();
		const int32 NumEntities = ChunkContext.GetNumEntities();

		const TArrayView<FTransformFragment> Transforms = ChunkContext.GetMutableFragmentView<FTransformFragment>();
		const TArrayView<FRiotAgentFragment> Agents = ChunkContext.GetMutableFragmentView<FRiotAgentFragment>();
		const TConstArrayView<FRiotTargetFragment> Targets = ChunkContext.GetFragmentView<FRiotTargetFragment>();
		const TArrayView<FMassVelocityFragment> Velocities = ChunkContext.GetMutableFragmentView<FMassVelocityFragment>();

		for (int32 i = 0; i < NumEntities; ++i)
		{
			FRiotAgentFragment& Agent = Agents[i];

			// Agents that are done contribute nothing and must not drift.
			if (Agent.State == ERiotAgentState::Inactive || Agent.State == ERiotAgentState::Queued)
			{
				Velocities[i].Value = FVector::ZeroVector;
				continue;
			}

			FTransform& Transform = Transforms[i].GetMutableTransform();
			const FVector Location = Transform.GetLocation();
			const FVector ToTarget = Targets[i].Destination - Location;
			const FVector Flat(ToTarget.X, ToTarget.Y, 0.0);

			if (Flat.IsNearlyZero())
			{
				Velocities[i].Value = FVector::ZeroVector;
				continue;
			}

			// CLAUDE-NOTE: arrival handling. The original stop condition was Flat.IsNearlyZero() -
			// sub-millimetre - which a 3-5uu per-frame step essentially never lands inside, so every
			// agent OVERSHOT its destination and flipped direction each frame, oscillating there
			// forever. Since breachers all shared one onward point, every agent that ever passed the
			// blockade ended up fused into a single jittering blob at that point. It shipped in the
			// foundation milestone unseen, because a stack of oscillating cylinders reads as nothing;
			// it took a user free-flying a camera over a crowd of real characters to spot it.
			const double Remaining = Flat.Size();
			const double Step = Agent.Speed * DeltaTime;
			if (Remaining <= FMath::Max(Step, 50.0))
			{
				Transform.SetLocation(FVector(
					Targets[i].Destination.X, Targets[i].Destination.Y, Location.Z));
				Velocities[i].Value = FVector::ZeroVector;
				continue;
			}

			const FVector Direction = Flat.GetSafeNormal();
			Velocities[i].Value = Direction * Agent.Speed;

			Transform.SetLocation(Location + Velocities[i].Value * DeltaTime);
			Transform.SetRotation(Direction.ToOrientationQuat());
		}
	});
}
