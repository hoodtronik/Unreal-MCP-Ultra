#include "BlueprintMCPRiotCrowdModule.h"
#include "RiotCrowdHandlers.h"
#include "Modules/ModuleManager.h"

void FBlueprintMCPRiotCrowdModule::StartupModule()
{
	// CLAUDE-NOTE: registration must happen here, during module load, because the core binds its
	// HTTP routes once inside FBlueprintMCPServer::Start() — which is driven by an editor subsystem
	// that initializes AFTER all modules have loaded. Registering any later leaves the routes
	// unbound and every riot tool 404s. The core warns loudly if that ordering is ever violated.
	FRiotCrowdHandlers::RegisterEndpoints();
}

IMPLEMENT_MODULE(FBlueprintMCPRiotCrowdModule, BlueprintMCPRiotCrowd);
