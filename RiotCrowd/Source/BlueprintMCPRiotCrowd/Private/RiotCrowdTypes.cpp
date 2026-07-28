#include "RiotCrowdTypes.h"

const TCHAR* LexToStringRiotAgentState(ERiotAgentState State)
{
	switch (State)
	{
	case ERiotAgentState::Queued:         return TEXT("queued");
	case ERiotAgentState::Advancing:      return TEXT("advancing");
	case ERiotAgentState::Blocked:        return TEXT("blocked");
	case ERiotAgentState::Pressuring:     return TEXT("pressuring");
	case ERiotAgentState::Breaching:      return TEXT("breaching");
	case ERiotAgentState::PassedBlockade: return TEXT("passed_blockade");
	case ERiotAgentState::Panicked:       return TEXT("panicked");
	case ERiotAgentState::Retreating:     return TEXT("retreating");
	case ERiotAgentState::Inactive:       return TEXT("inactive");
	}
	return TEXT("unknown");
}

const TCHAR* LexToStringRiotLifecycle(ERiotLifecycle State)
{
	switch (State)
	{
	case ERiotLifecycle::Unconfigured: return TEXT("unconfigured");
	case ERiotLifecycle::Configured:   return TEXT("configured");
	case ERiotLifecycle::Spawned:      return TEXT("spawned");
	case ERiotLifecycle::Running:      return TEXT("running");
	case ERiotLifecycle::Paused:       return TEXT("paused");
	case ERiotLifecycle::Completed:    return TEXT("completed");
	case ERiotLifecycle::Reset:        return TEXT("reset");
	case ERiotLifecycle::Failed:       return TEXT("failed");
	}
	return TEXT("unknown");
}

const TCHAR* LexToStringRiotFactionType(ERiotFactionType Type)
{
	switch (Type)
	{
	case ERiotFactionType::Rioter:   return TEXT("rioter");
	case ERiotFactionType::Police:   return TEXT("police");
	case ERiotFactionType::Military: return TEXT("military");
	case ERiotFactionType::Neutral:  return TEXT("neutral");
	}
	return TEXT("unknown");
}
