#pragma once

#include "CoreMinimal.h"

enum class ERiotLifecycleVerb : uint8
{
	Start,
	Pause,
	Resume,
	Reset,
};

/**
 * HTTP handlers for the riot endpoints.
 *
 * CLAUDE-NOTE: a plain static class, not a UObject. These are invoked through the core server's
 * external-endpoint seam and always run on the GAME THREAD (the core queues requests off the HTTP
 * thread and dispatches them from ProcessOneRequest), which is what makes it safe for them to touch
 * GEditor->PlayWorld and the Mass entity manager directly.
 */
class FRiotCrowdHandlers
{
public:
	// Capability and inspection
	static FString HandleGetCapabilities(const FString& Body);
	static FString HandleListScenarios(const FString& Body);
	static FString HandleGetScenario(const FString& Body);
	static FString HandleGetRuntimeReport(const FString& Body);

	// Scenario authoring
	static FString HandleCreateScenario(const FString& Body);
	static FString HandleDeleteScenario(const FString& Body);
	static FString HandleAddFaction(const FString& Body);
	static FString HandleAddFlowOrigin(const FString& Body);
	static FString HandleAddBlockade(const FString& Body);
	static FString HandleAddHotspot(const FString& Body);
	static FString HandleSetTrigger(const FString& Body);

	// Runtime control
	static FString HandleSpawn(const FString& Body);
	static FString HandleStart(const FString& Body);
	static FString HandlePause(const FString& Body);
	static FString HandleResume(const FString& Body);
	static FString HandleReset(const FString& Body);

	// Rigged character profiles (rigged-animation-LOD milestone)
	static FString HandleRegisterCharacterProfile(const FString& Body);
	static FString HandleUpdateCharacterProfile(const FString& Body);
	static FString HandleDeleteCharacterProfile(const FString& Body);
	static FString HandleListCharacterProfiles(const FString& Body);
	static FString HandleGetCharacterProfile(const FString& Body);
	static FString HandleValidateCharacterProfile(const FString& Body);
	static FString HandleAssignCharacterProfiles(const FString& Body);

	// Representation
	static FString HandleSetRepresentationProfile(const FString& Body);
	static FString HandleGetRepresentationReport(const FString& Body);
	static FString HandlePromoteAgents(const FString& Body);
	static FString HandleDemoteAgents(const FString& Body);

	/** Register every riot endpoint with the core server. Call from StartupModule(). */
	static void RegisterEndpoints();

private:
	static FString HandleLifecycleVerb(const FString& Body, ERiotLifecycleVerb Verb);
};
