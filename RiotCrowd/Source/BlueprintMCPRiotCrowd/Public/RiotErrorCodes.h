#pragma once

#include "CoreMinimal.h"

/**
 * Machine-checkable Riot Crowd error codes.
 *
 * CLAUDE-NOTE: follows the core's MCPErrorCodes convention exactly (BlueprintMCPServer.h) — plain
 * `inline const TCHAR*` rather than a UENUM, so codes serialize with no ToString() ceremony and
 * adding one does not require editing a central enum. The strings are SCREAMING_SNAKE here (rather
 * than the core's snake_case) because the milestone specifies these exact identifiers and the TS
 * layer branches on them verbatim.
 */
namespace RiotErrorCodes
{
	inline const TCHAR* FeatureNotInstalled   = TEXT("RIOT_FEATURE_NOT_INSTALLED");
	inline const TCHAR* RequiredPluginDisabled = TEXT("RIOT_REQUIRED_PLUGIN_DISABLED");
	inline const TCHAR* UnsupportedEngine     = TEXT("RIOT_UNSUPPORTED_ENGINE_VERSION");
	inline const TCHAR* ScenarioNotFound      = TEXT("RIOT_SCENARIO_NOT_FOUND");
	inline const TCHAR* ScenarioAlreadyExists = TEXT("RIOT_SCENARIO_ALREADY_EXISTS");
	inline const TCHAR* ScenarioInvalid       = TEXT("RIOT_SCENARIO_INVALID");
	inline const TCHAR* DuplicateId           = TEXT("RIOT_DUPLICATE_ID");
	inline const TCHAR* FactionNotFound       = TEXT("RIOT_FACTION_NOT_FOUND");
	inline const TCHAR* FlowOriginNotFound    = TEXT("RIOT_FLOW_ORIGIN_NOT_FOUND");
	inline const TCHAR* BlockadeNotFound      = TEXT("RIOT_BLOCKADE_NOT_FOUND");
	inline const TCHAR* InvalidCount          = TEXT("RIOT_INVALID_COUNT");
	inline const TCHAR* InvalidTransform      = TEXT("RIOT_INVALID_TRANSFORM");
	inline const TCHAR* InvalidThreshold      = TEXT("RIOT_INVALID_THRESHOLD");
	inline const TCHAR* SimulationNotRunning  = TEXT("RIOT_SIMULATION_NOT_RUNNING");
	inline const TCHAR* SimulationAlreadyRunning = TEXT("RIOT_SIMULATION_ALREADY_RUNNING");
	inline const TCHAR* ResetFailed           = TEXT("RIOT_RESET_FAILED");
	inline const TCHAR* RuntimeStateMismatch  = TEXT("RIOT_RUNTIME_STATE_MISMATCH");
	inline const TCHAR* LiveVerificationFailed = TEXT("RIOT_LIVE_VERIFICATION_FAILED");
	inline const TCHAR* PieNotRunning         = TEXT("RIOT_PIE_NOT_RUNNING");
	/** Generic fallback for a failure that is not one of the specific cases above. */
	inline const TCHAR* OperationFailed       = TEXT("RIOT_OPERATION_FAILED");
}

/** Uniform error envelope: {"error": "...", "errorCode": "RIOT_..."} */
FString MakeRiotErrorJson(const TCHAR* ErrorCode, const FString& Message);
