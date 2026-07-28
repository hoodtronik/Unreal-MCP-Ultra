#include "RiotCrowdHandlers.h"

#include "BlueprintMCPServer.h"

void FRiotCrowdHandlers::RegisterEndpoints()
{
	// CLAUDE-NOTE: bIsMutation is FALSE on every riot endpoint, including the authoring ones, and
	// that is deliberate rather than an oversight.
	//
	// The core wraps mutation endpoints in an undo transaction (GEditor->BeginTransaction). That is
	// correct for Blueprint/asset edits, which mutate UObjects the transaction buffer can capture
	// and roll back. Riot authoring mutates FRiotScenarioStore — plain C++ structs the transaction
	// buffer cannot see — and riot_spawn creates Mass entities in the PIE world, which are not
	// UObjects at all. Marking these as mutations would open and close empty transactions, adding
	// meaningless "Riot" entries to the editor's undo stack that do nothing when undone. An undo
	// entry that silently does nothing is worse than no undo entry.
	//
	// riot_reset is the real undo path for riot state, and it is explicit.
	auto Add = [](const TCHAR* Route, const TCHAR* Key,
		TFunction<FString(const FString&)> Handler, bool bIsPost = true)
	{
		FBlueprintMCPServer::FExternalEndpoint Endpoint;
		Endpoint.Route = Route;
		Endpoint.EndpointKey = Key;
		Endpoint.Handler = MoveTemp(Handler);
		Endpoint.bIsMutation = false;
		Endpoint.bIsPost = bIsPost;
		FBlueprintMCPServer::RegisterExternalEndpoint(MoveTemp(Endpoint));
	};

	// ----- capability + inspection -----
	Add(TEXT("/api/riot-capabilities"), TEXT("riot-capabilities"),
		&FRiotCrowdHandlers::HandleGetCapabilities, /*bIsPost=*/false);
	Add(TEXT("/api/riot-list-scenarios"), TEXT("riot-list-scenarios"),
		&FRiotCrowdHandlers::HandleListScenarios, /*bIsPost=*/false);
	Add(TEXT("/api/riot-get-scenario"), TEXT("riot-get-scenario"),
		&FRiotCrowdHandlers::HandleGetScenario);
	Add(TEXT("/api/riot-runtime-report"), TEXT("riot-runtime-report"),
		&FRiotCrowdHandlers::HandleGetRuntimeReport);

	// ----- scenario authoring -----
	Add(TEXT("/api/riot-create-scenario"), TEXT("riot-create-scenario"),
		&FRiotCrowdHandlers::HandleCreateScenario);
	Add(TEXT("/api/riot-delete-scenario"), TEXT("riot-delete-scenario"),
		&FRiotCrowdHandlers::HandleDeleteScenario);
	Add(TEXT("/api/riot-add-faction"), TEXT("riot-add-faction"),
		&FRiotCrowdHandlers::HandleAddFaction);
	Add(TEXT("/api/riot-add-flow-origin"), TEXT("riot-add-flow-origin"),
		&FRiotCrowdHandlers::HandleAddFlowOrigin);
	Add(TEXT("/api/riot-add-blockade"), TEXT("riot-add-blockade"),
		&FRiotCrowdHandlers::HandleAddBlockade);
	Add(TEXT("/api/riot-add-hotspot"), TEXT("riot-add-hotspot"),
		&FRiotCrowdHandlers::HandleAddHotspot);
	Add(TEXT("/api/riot-set-trigger"), TEXT("riot-set-trigger"),
		&FRiotCrowdHandlers::HandleSetTrigger);

	// ----- runtime control -----
	Add(TEXT("/api/riot-spawn"),  TEXT("riot-spawn"),  &FRiotCrowdHandlers::HandleSpawn);
	Add(TEXT("/api/riot-start"),  TEXT("riot-start"),  &FRiotCrowdHandlers::HandleStart);
	Add(TEXT("/api/riot-pause"),  TEXT("riot-pause"),  &FRiotCrowdHandlers::HandlePause);
	Add(TEXT("/api/riot-resume"), TEXT("riot-resume"), &FRiotCrowdHandlers::HandleResume);
	Add(TEXT("/api/riot-reset"),  TEXT("riot-reset"),  &FRiotCrowdHandlers::HandleReset);
}
