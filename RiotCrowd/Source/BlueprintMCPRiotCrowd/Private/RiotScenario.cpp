#include "RiotScenario.h"
#include "RiotErrorCodes.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// ============================================================
// Helpers
// ============================================================

static TSharedRef<FJsonObject> VectorToJson(const FVector& V)
{
	TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
	O->SetNumberField(TEXT("x"), V.X);
	O->SetNumberField(TEXT("y"), V.Y);
	O->SetNumberField(TEXT("z"), V.Z);
	return O;
}

FString MakeRiotErrorJson(const TCHAR* ErrorCode, const FString& Message)
{
	TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
	O->SetStringField(TEXT("error"), Message);
	O->SetStringField(TEXT("errorCode"), ErrorCode);

	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(O, Writer);
	return Out;
}

bool IsValidRiotId(const FString& Id)
{
	if (Id.IsEmpty() || Id.Len() > 64)
	{
		return false;
	}

	for (const TCHAR C : Id)
	{
		const bool bOk = FChar::IsAlnum(C) || C == TEXT('_') || C == TEXT('-');
		if (!bOk)
		{
			return false;
		}
	}
	return true;
}

// ============================================================
// FRiotScenario
// ============================================================

const FRiotFaction* FRiotScenario::FindFaction(const FString& FactionId) const
{
	return Factions.FindByPredicate([&](const FRiotFaction& F) { return F.Id == FactionId; });
}

int32 FRiotScenario::IndexOfFaction(const FString& FactionId) const
{
	return Factions.IndexOfByPredicate([&](const FRiotFaction& F) { return F.Id == FactionId; });
}

FRiotBlockade* FRiotScenario::FindBlockade(const FString& BlockadeId)
{
	return Blockades.FindByPredicate([&](const FRiotBlockade& B) { return B.Id == BlockadeId; });
}

int32 FRiotScenario::IndexOfBlockade(const FString& BlockadeId) const
{
	return Blockades.IndexOfByPredicate([&](const FRiotBlockade& B) { return B.Id == BlockadeId; });
}

void FRiotScenario::ResetRuntimeState()
{
	// CLAUDE-NOTE: resets runtime ONLY. The authored definition (factions, origins, blockade
	// geometry, thresholds, seed) is deliberately preserved so the same scenario can be re-run with
	// the same seed and compared — that comparison is the determinism check, and it would be
	// impossible if reset wiped the definition.
	SimulationTime = 0.0;
	SpawnedRioters = 0;
	SpawnedDefenders = 0;
	AgentsPassedBlockade = 0;
	FailureReason.Reset();

	for (FRiotBlockade& B : Blockades)
	{
		B.bBroken = false;
		B.CurrentPressure = 0.0;
		B.PeakPressure = 0.0;
		B.BrokenAtTime = -1.0;
	}

	for (FRiotTrigger& T : Triggers)
	{
		T.bFired = false;
		T.FiredAtTime = -1.0;
	}

	for (FRiotHotspot& H : Hotspots)
	{
		H.bActive = false;
	}
}

TSharedRef<FJsonObject> FRiotScenario::ToJson() const
{
	TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
	O->SetStringField(TEXT("scenarioId"), Id);
	O->SetStringField(TEXT("displayName"), DisplayName);
	O->SetNumberField(TEXT("schemaVersion"), SchemaVersion);
	O->SetNumberField(TEXT("seed"), Seed);
	O->SetStringField(TEXT("world"), WorldName);
	O->SetStringField(TEXT("lifecycle"), LexToStringRiotLifecycle(Lifecycle));
	O->SetNumberField(TEXT("simulationTime"), SimulationTime);

	TArray<TSharedPtr<FJsonValue>> FactionArr;
	for (const FRiotFaction& F : Factions)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("factionId"), F.Id);
		J->SetStringField(TEXT("displayName"), F.DisplayName);
		J->SetStringField(TEXT("type"), LexToStringRiotFactionType(F.Type));
		J->SetNumberField(TEXT("maxSpawnCount"), F.MaxSpawnCount);
		FactionArr.Add(MakeShared<FJsonValueObject>(J));
	}
	O->SetArrayField(TEXT("factions"), FactionArr);

	TArray<TSharedPtr<FJsonValue>> OriginArr;
	for (const FRiotFlowOrigin& Origin : Origins)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("originId"), Origin.Id);
		J->SetStringField(TEXT("factionId"), Origin.FactionId);
		J->SetObjectField(TEXT("location"), VectorToJson(Origin.Location));
		J->SetNumberField(TEXT("spawnRadius"), Origin.SpawnRadius);
		J->SetObjectField(TEXT("initialTarget"), VectorToJson(Origin.InitialTarget));
		J->SetNumberField(TEXT("spawnCount"), Origin.SpawnCount);
		J->SetNumberField(TEXT("spawnDelay"), Origin.SpawnDelay);
		J->SetNumberField(TEXT("spawnInterval"), Origin.SpawnInterval);
		J->SetNumberField(TEXT("speedMin"), Origin.SpeedMin);
		J->SetNumberField(TEXT("speedMax"), Origin.SpeedMax);
		OriginArr.Add(MakeShared<FJsonValueObject>(J));
	}
	O->SetArrayField(TEXT("flowOrigins"), OriginArr);

	TArray<TSharedPtr<FJsonValue>> BlockadeArr;
	for (const FRiotBlockade& B : Blockades)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("blockadeId"), B.Id);
		J->SetStringField(TEXT("defendingFactionId"), B.DefendingFactionId);
		J->SetObjectField(TEXT("location"), VectorToJson(B.Location));
		J->SetNumberField(TEXT("yawDegrees"), B.YawDegrees);
		J->SetNumberField(TEXT("width"), B.Width);
		J->SetNumberField(TEXT("depth"), B.Depth);
		J->SetNumberField(TEXT("defenderCount"), B.DefenderCount);
		J->SetNumberField(TEXT("holdThreshold"), B.HoldThreshold);
		J->SetNumberField(TEXT("breakThreshold"), B.BreakThreshold);
		J->SetBoolField(TEXT("broken"), B.bBroken);
		J->SetNumberField(TEXT("currentPressure"), B.CurrentPressure);
		J->SetNumberField(TEXT("peakPressure"), B.PeakPressure);
		J->SetNumberField(TEXT("brokenAtTime"), B.BrokenAtTime);
		BlockadeArr.Add(MakeShared<FJsonValueObject>(J));
	}
	O->SetArrayField(TEXT("blockades"), BlockadeArr);

	TArray<TSharedPtr<FJsonValue>> TriggerArr;
	for (const FRiotTrigger& T : Triggers)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("triggerId"), T.Id);
		J->SetStringField(TEXT("type"),
			T.Type == ERiotHotspotType::Breach ? TEXT("breach")
			: T.Type == ERiotHotspotType::Panic ? TEXT("panic") : TEXT("pressure"));
		const TCHAR* CondName =
			T.Condition == ERiotTriggerCondition::PressureThreshold ? TEXT("pressure_threshold")
			: T.Condition == ERiotTriggerCondition::ElapsedTime ? TEXT("elapsed_time")
			: TEXT("agents_passed");
		J->SetStringField(TEXT("condition"), CondName);
		J->SetStringField(TEXT("targetBlockadeId"), T.TargetBlockadeId);
		J->SetNumberField(TEXT("thresholdValue"), T.ThresholdValue);
		J->SetNumberField(TEXT("affectedFraction"), T.AffectedFraction);
		J->SetBoolField(TEXT("fired"), T.bFired);
		J->SetNumberField(TEXT("firedAtTime"), T.FiredAtTime);
		TriggerArr.Add(MakeShared<FJsonValueObject>(J));
	}
	O->SetArrayField(TEXT("triggers"), TriggerArr);

	TArray<TSharedPtr<FJsonValue>> HotspotArr;
	for (const FRiotHotspot& H : Hotspots)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("hotspotId"), H.Id);
		J->SetStringField(TEXT("type"),
			H.Type == ERiotHotspotType::Breach ? TEXT("breach")
			: H.Type == ERiotHotspotType::Panic ? TEXT("panic") : TEXT("pressure"));
		J->SetObjectField(TEXT("location"), VectorToJson(H.Location));
		J->SetNumberField(TEXT("influenceRadius"), H.InfluenceRadius);
		J->SetNumberField(TEXT("intensity"), H.Intensity);
		J->SetBoolField(TEXT("active"), H.bActive);
		HotspotArr.Add(MakeShared<FJsonValueObject>(J));
	}
	O->SetArrayField(TEXT("hotspots"), HotspotArr);

	if (!FailureReason.IsEmpty())
	{
		O->SetStringField(TEXT("failureReason"), FailureReason);
	}

	return O;
}

// ============================================================
// FRiotScenarioStore
// ============================================================

FRiotScenarioStore& FRiotScenarioStore::Get()
{
	static FRiotScenarioStore Instance;
	return Instance;
}

FRiotScenario* FRiotScenarioStore::Find(const FString& ScenarioId)
{
	return Scenarios.FindByPredicate([&](const FRiotScenario& S) { return S.Id == ScenarioId; });
}

const FRiotScenario* FRiotScenarioStore::Find(const FString& ScenarioId) const
{
	return Scenarios.FindByPredicate([&](const FRiotScenario& S) { return S.Id == ScenarioId; });
}

FRiotScenario& FRiotScenarioStore::Add(FRiotScenario Scenario)
{
	const int32 Index = Scenarios.Add(MoveTemp(Scenario));
	return Scenarios[Index];
}

bool FRiotScenarioStore::Remove(const FString& ScenarioId)
{
	return Scenarios.RemoveAll([&](const FRiotScenario& S) { return S.Id == ScenarioId; }) > 0;
}

// ============================================================
// Validation
// ============================================================

bool ValidateRiotScenario(const FRiotScenario& Scenario, FString& OutErrorCode, FString& OutMessage)
{
	if (!IsValidRiotId(Scenario.Id))
	{
		OutErrorCode = RiotErrorCodes::ScenarioInvalid;
		OutMessage = TEXT("Scenario id must be 1-64 characters of [A-Za-z0-9_-].");
		return false;
	}

	if (Scenario.SchemaVersion != RiotScenarioSchemaVersion)
	{
		OutErrorCode = RiotErrorCodes::ScenarioInvalid;
		OutMessage = FString::Printf(
			TEXT("Scenario schemaVersion %d is not supported by this build (expected %d)."),
			Scenario.SchemaVersion, RiotScenarioSchemaVersion);
		return false;
	}

	// ----- duplicate ids across every collection -----
	TSet<FString> SeenIds;
	auto CheckUnique = [&](const FString& Id, const TCHAR* Kind) -> bool
	{
		if (!IsValidRiotId(Id))
		{
			OutErrorCode = RiotErrorCodes::ScenarioInvalid;
			OutMessage = FString::Printf(TEXT("%s id '%s' must be 1-64 characters of [A-Za-z0-9_-]."), Kind, *Id);
			return false;
		}
		bool bAlready = false;
		SeenIds.Add(Id, &bAlready);
		if (bAlready)
		{
			OutErrorCode = RiotErrorCodes::DuplicateId;
			OutMessage = FString::Printf(TEXT("Duplicate id '%s' (%s). Ids must be unique across the whole scenario."), *Id, Kind);
			return false;
		}
		return true;
	};

	for (const FRiotFaction& F : Scenario.Factions)
	{
		if (!CheckUnique(F.Id, TEXT("faction"))) return false;
		if (F.MaxSpawnCount < 0)
		{
			OutErrorCode = RiotErrorCodes::InvalidCount;
			OutMessage = FString::Printf(TEXT("Faction '%s' has negative maxSpawnCount."), *F.Id);
			return false;
		}
	}

	for (const FRiotFlowOrigin& O : Scenario.Origins)
	{
		if (!CheckUnique(O.Id, TEXT("flow origin"))) return false;

		if (!Scenario.FindFaction(O.FactionId))
		{
			OutErrorCode = RiotErrorCodes::FactionNotFound;
			OutMessage = FString::Printf(TEXT("Flow origin '%s' references unknown faction '%s'."), *O.Id, *O.FactionId);
			return false;
		}
		if (O.SpawnCount < 0)
		{
			OutErrorCode = RiotErrorCodes::InvalidCount;
			OutMessage = FString::Printf(TEXT("Flow origin '%s' has negative spawnCount."), *O.Id);
			return false;
		}
		if (O.SpeedMin < 0.0 || O.SpeedMax < O.SpeedMin)
		{
			OutErrorCode = RiotErrorCodes::InvalidThreshold;
			OutMessage = FString::Printf(
				TEXT("Flow origin '%s' speed range is invalid (min %.1f, max %.1f)."), *O.Id, O.SpeedMin, O.SpeedMax);
			return false;
		}
		if (O.Location.ContainsNaN() || O.InitialTarget.ContainsNaN())
		{
			OutErrorCode = RiotErrorCodes::InvalidTransform;
			OutMessage = FString::Printf(TEXT("Flow origin '%s' has a non-finite location or target."), *O.Id);
			return false;
		}
	}

	for (const FRiotBlockade& B : Scenario.Blockades)
	{
		if (!CheckUnique(B.Id, TEXT("blockade"))) return false;

		if (!Scenario.FindFaction(B.DefendingFactionId))
		{
			OutErrorCode = RiotErrorCodes::FactionNotFound;
			OutMessage = FString::Printf(TEXT("Blockade '%s' references unknown faction '%s'."), *B.Id, *B.DefendingFactionId);
			return false;
		}
		if (B.Location.ContainsNaN())
		{
			OutErrorCode = RiotErrorCodes::InvalidTransform;
			OutMessage = FString::Printf(TEXT("Blockade '%s' has a non-finite location."), *B.Id);
			return false;
		}
		if (B.Width <= 0.0 || B.Depth <= 0.0)
		{
			OutErrorCode = RiotErrorCodes::InvalidTransform;
			OutMessage = FString::Printf(TEXT("Blockade '%s' must have positive width and depth."), *B.Id);
			return false;
		}
		if (B.DefenderCount < 0)
		{
			OutErrorCode = RiotErrorCodes::InvalidCount;
			OutMessage = FString::Printf(TEXT("Blockade '%s' has negative defenderCount."), *B.Id);
			return false;
		}
		// CLAUDE-NOTE: a break threshold at or below the hold threshold means the segment is
		// already broken the instant any pressure registers, which silently produces a scenario
		// that can never demonstrate holding. Reject rather than let it look like it works.
		if (B.BreakThreshold <= B.HoldThreshold)
		{
			OutErrorCode = RiotErrorCodes::InvalidThreshold;
			OutMessage = FString::Printf(
				TEXT("Blockade '%s': breakThreshold (%.1f) must be greater than holdThreshold (%.1f)."),
				*B.Id, B.BreakThreshold, B.HoldThreshold);
			return false;
		}
		if (B.HoldThreshold < 0.0)
		{
			OutErrorCode = RiotErrorCodes::InvalidThreshold;
			OutMessage = FString::Printf(TEXT("Blockade '%s' has a negative holdThreshold."), *B.Id);
			return false;
		}
	}

	for (const FRiotTrigger& T : Scenario.Triggers)
	{
		if (!CheckUnique(T.Id, TEXT("trigger"))) return false;

		if (!T.TargetBlockadeId.IsEmpty() && Scenario.IndexOfBlockade(T.TargetBlockadeId) == INDEX_NONE)
		{
			OutErrorCode = RiotErrorCodes::BlockadeNotFound;
			OutMessage = FString::Printf(TEXT("Trigger '%s' references unknown blockade '%s'."), *T.Id, *T.TargetBlockadeId);
			return false;
		}
		if (T.ThresholdValue < 0.0)
		{
			OutErrorCode = RiotErrorCodes::InvalidThreshold;
			OutMessage = FString::Printf(TEXT("Trigger '%s' has a negative thresholdValue."), *T.Id);
			return false;
		}
		if (T.Type == ERiotHotspotType::Panic && (T.AffectedFraction <= 0.0 || T.AffectedFraction > 1.0))
		{
			OutErrorCode = RiotErrorCodes::InvalidThreshold;
			OutMessage = FString::Printf(
				TEXT("Panic trigger '%s' affectedFraction must be in (0, 1]; got %.3f."), *T.Id, T.AffectedFraction);
			return false;
		}
	}

	for (const FRiotHotspot& H : Scenario.Hotspots)
	{
		if (!CheckUnique(H.Id, TEXT("hotspot"))) return false;

		if (H.InfluenceRadius <= 0.0)
		{
			OutErrorCode = RiotErrorCodes::InvalidTransform;
			OutMessage = FString::Printf(TEXT("Hotspot '%s' must have a positive influenceRadius."), *H.Id);
			return false;
		}
	}

	return true;
}
