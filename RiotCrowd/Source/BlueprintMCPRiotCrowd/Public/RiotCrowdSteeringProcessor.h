#pragma once

#include "CoreMinimal.h"

#include "MassProcessor.h"
#include "MassEntityQuery.h"

#include "RiotCrowdSteeringProcessor.generated.h"

/**
 * Moves riot agents toward their current destination.
 *
 * CLAUDE-NOTE: this is the compile-contract processor for the milestone. Every signature it
 * overrides changed in UE 5.6 and the pre-5.6 forms are `final`, so if this class builds, the rest
 * of the Mass integration is on solid ground. See docs/riot-crowd/UE56-MASS-API-FINDINGS.md §4.
 */
UCLASS()
class URiotCrowdSteeringProcessor : public UMassProcessor
{
	GENERATED_BODY()

public:
	URiotCrowdSteeringProcessor();

protected:
	// CLAUDE-NOTE: 5.6 signature. The no-arg ConfigureQueries() is declared `final` in
	// MassProcessor.h:310 — overriding it is a hard compile error, not a deprecation warning.
	virtual void ConfigureQueries(const TSharedRef<FMassEntityManager>& EntityManager) override;

	virtual void Execute(FMassEntityManager& EntityManager, FMassExecutionContext& Context) override;

private:
	// CLAUDE-NOTE: 5.6 requires a query to know its owning processor at construction
	// (FMassEntityQuery(UMassProcessor&), MassEntityQuery.h:85). The default-constructed +
	// later-registered form still exists but the owner ctor is the one Epic's own processors use.
	FMassEntityQuery EntityQuery;
};
