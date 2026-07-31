#include "RiotCrowdHandlers.h"

#include "RiotCrowdSubsystem.h"
#include "RiotErrorCodes.h"
#include "RiotScenario.h"

#include "Editor.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/World.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/EngineVersion.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// ============================================================
// Local helpers
// ============================================================

namespace
{

FString JsonToString(const TSharedRef<FJsonObject>& Object)
{
	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Object, Writer);
	return Out;
}

TSharedPtr<FJsonObject> ParseBody(const FString& Body)
{
	TSharedPtr<FJsonObject> Parsed;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
	return FJsonSerializer::Deserialize(Reader, Parsed) && Parsed.IsValid() ? Parsed : nullptr;
}

bool ReadVector(const TSharedPtr<FJsonObject>& Parent, const TCHAR* Field, FVector& OutVector)
{
	const TSharedPtr<FJsonObject>* Object = nullptr;
	if (!Parent->TryGetObjectField(Field, Object))
	{
		return false;
	}
	double X = 0, Y = 0, Z = 0;
	(*Object)->TryGetNumberField(TEXT("x"), X);
	(*Object)->TryGetNumberField(TEXT("y"), Y);
	(*Object)->TryGetNumberField(TEXT("z"), Z);
	OutVector = FVector(X, Y, Z);
	return true;
}

double ReadNumber(const TSharedPtr<FJsonObject>& Parent, const TCHAR* Field, double Fallback)
{
	double Value = Fallback;
	Parent->TryGetNumberField(Field, Value);
	return Value;
}

bool IsDryRun(const TSharedPtr<FJsonObject>& Parent)
{
	bool bDryRun = false;
	Parent->TryGetBoolField(TEXT("dryRun"), bDryRun);
	return bDryRun;
}

/**
 * CLAUDE-NOTE: the riot simulation lives in the PIE world, so every runtime endpoint needs
 * GEditor->PlayWorld. This mirrors GetPIEWorld() in the core's BlueprintMCPHandlers_PIERuntime.cpp
 * deliberately, including the wording of the error, so an agent sees one consistent "PIE is not
 * running" message across core and riot tools rather than two different phrasings for one cause.
 */
URiotCrowdSubsystem* GetRiotSubsystem(FString& OutError)
{
	if (!GEditor || !GEditor->PlayWorld)
	{
		OutError = TEXT("PIE is not running. Use start_pie first — the riot simulation runs in the play world.");
		return nullptr;
	}

	URiotCrowdSubsystem* Subsystem = GEditor->PlayWorld->GetSubsystem<URiotCrowdSubsystem>();
	if (!Subsystem)
	{
		OutError = TEXT("RiotCrowdSubsystem is not available in the play world.");
		return nullptr;
	}
	return Subsystem;
}

/** Uniform success envelope with the bits every mutation tool is required to return. */
TSharedRef<FJsonObject> MakeSuccess(const FString& Summary)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("summary"), Summary);
	return Result;
}

void AddNextSteps(const TSharedRef<FJsonObject>& Result, std::initializer_list<const TCHAR*> Steps)
{
	TArray<TSharedPtr<FJsonValue>> Array;
	for (const TCHAR* Step : Steps)
	{
		Array.Add(MakeShared<FJsonValueString>(Step));
	}
	Result->SetArrayField(TEXT("nextSteps"), Array);
}

bool IsPluginEnabled(const TCHAR* PluginName)
{
	const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(PluginName);
	return Plugin.IsValid() && Plugin->IsEnabled();
}

/**
 * CLAUDE-NOTE: probe the MODULE, never a plugin, for anything that ships as engine Runtime code.
 *
 * `IsPluginEnabled(TEXT("MassEntity"))` was the wrong question. The MassEntity *plugin* is a
 * content-only shell (no Source/ at all, see UE56-MASS-API-FINDINGS.md §1) that this project
 * deliberately leaves disabled, while the ECS itself is an engine Runtime module this translation
 * unit links against. So the old probe answered `massEntity: false` on a perfectly healthy editor.
 *
 * On 5.6 that false was at least literally true *of the plugin* — but nobody consumes the field to
 * ask about the shell, and it misled in practice: three docs cited `massEntity: false` as
 * PROVEN-LIVE evidence that only MassGameplay is required. On 5.8, where the shell plugin no longer
 * exists at all, the same code became a flat contradiction of a running system. One fix for both.
 *
 * `ModuleExists` is the fallback for a module that is present but not yet demand-loaded;
 * `IsModuleLoaded` covers the ones already up, which is the normal case for engine Runtime modules.
 */
bool IsModuleAvailable(const TCHAR* ModuleName)
{
	return FModuleManager::Get().IsModuleLoaded(ModuleName)
		|| FModuleManager::Get().ModuleExists(ModuleName);
}

/** Look up a scenario, or produce the standard not-found error. */
FRiotScenario* RequireScenario(const TSharedPtr<FJsonObject>& Body, FString& OutErrorJson)
{
	FString ScenarioId;
	if (!Body->TryGetStringField(TEXT("scenarioId"), ScenarioId) || ScenarioId.IsEmpty())
	{
		OutErrorJson = MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'scenarioId'."));
		return nullptr;
	}

	FRiotScenario* Scenario = FRiotScenarioStore::Get().Find(ScenarioId);
	if (!Scenario)
	{
		OutErrorJson = MakeRiotErrorJson(RiotErrorCodes::ScenarioNotFound,
			FString::Printf(TEXT("No scenario with id '%s'. Use riot_list_scenarios to see what exists."), *ScenarioId));
		return nullptr;
	}
	return Scenario;
}

/**
 * Validate a candidate scenario and, unless dryRun, commit it.
 *
 * CLAUDE-NOTE: every authoring endpoint mutates a COPY, validates the copy, and only then writes it
 * back. That is what makes dryRun honest and what guarantees a rejected call leaves absolutely no
 * partial state — appending a faction and then discovering the scenario is invalid would otherwise
 * leave the faction behind.
 */
FString CommitScenario(FRiotScenario& Live, FRiotScenario Candidate, bool bDryRun,
	const FString& Summary, std::initializer_list<const TCHAR*> NextSteps)
{
	FString ErrorCode, Message;
	if (!ValidateRiotScenario(Candidate, ErrorCode, Message))
	{
		return MakeRiotErrorJson(*ErrorCode, Message);
	}

	TSharedRef<FJsonObject> Result = MakeSuccess(Summary);
	Result->SetBoolField(TEXT("dryRun"), bDryRun);

	if (!bDryRun)
	{
		Candidate.Lifecycle = ERiotLifecycle::Configured;
		Live = MoveTemp(Candidate);
		Result->SetObjectField(TEXT("scenario"), Live.ToJson());
	}
	else
	{
		Result->SetObjectField(TEXT("scenario"), Candidate.ToJson());
	}

	AddNextSteps(Result, NextSteps);
	return JsonToString(Result);
}

} // namespace

// ============================================================
// Capability + inspection
// ============================================================

FString FRiotCrowdHandlers::HandleGetCapabilities(const FString& /*Body*/)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	// CLAUDE-NOTE: this handler only runs at all if the riot plugin is installed and its module
	// loaded, so featureInstalled is necessarily true here. When the plugin is absent the route is
	// never bound and the TS layer reports RIOT_FEATURE_NOT_INSTALLED on the 404 — that is where
	// "not installed" is detected, not here.
	Result->SetBoolField(TEXT("featureInstalled"), true);

	const FEngineVersion& Version = FEngineVersion::Current();
	const FString VersionString = FString::Printf(TEXT("%d.%d.%d"),
		Version.GetMajor(), Version.GetMinor(), Version.GetPatch());
	Result->SetStringField(TEXT("engineVersion"), VersionString);

	// CLAUDE-NOTE: MassEntity is a MODULE question, not a plugin question — see IsModuleAvailable.
	// MassCore is checked because UE 5.8 split Runtime/MassEntity into Runtime/Mass/{MassCore,...}
	// and moved the base element types there. It does not exist on 5.6, so the check costs a false
	// here and nothing else — kept deliberately so this file stays identical across both engine
	// branches. Only TargetEngineMinor below is allowed to differ.
	const bool bMassEntityModule = IsModuleAvailable(TEXT("MassEntity"));
	const bool bMassCoreModule = IsModuleAvailable(TEXT("MassCore"));
	const bool bMassEntity = bMassEntityModule || bMassCoreModule;

	const bool bMassGameplay = IsPluginEnabled(TEXT("MassGameplay"));
	const bool bMassCrowd = IsPluginEnabled(TEXT("MassCrowd"));
	const bool bZoneGraph = IsPluginEnabled(TEXT("ZoneGraph"));
	const bool bStateTree = IsPluginEnabled(TEXT("StateTree"));

	// MassGameplay is the only hard requirement — see UE56-MASS-API-FINDINGS.md §1 and §9.
	const bool bSupported = bMassGameplay;

	Result->SetBoolField(TEXT("supported"), bSupported);
	Result->SetBoolField(TEXT("massEntity"), bMassEntity);
	Result->SetBoolField(TEXT("massGameplay"), bMassGameplay);
	Result->SetBoolField(TEXT("massCrowd"), bMassCrowd);
	Result->SetBoolField(TEXT("zoneGraph"), bZoneGraph);
	Result->SetBoolField(TEXT("stateTree"), bStateTree);

	TSharedRef<FJsonObject> Required = MakeShared<FJsonObject>();
	Required->SetBoolField(TEXT("MassGameplay"), bMassGameplay);
	Result->SetObjectField(TEXT("requiredPlugins"), Required);

	// CLAUDE-NOTE: MassEntity deliberately does NOT appear here any more. Listing an engine Runtime
	// module inside an object named "availablePlugins" is the exact category error that produced the
	// false negative — a reader (human or agent) sees a plugin name and reaches for the plugin
	// browser to turn it on, which is impossible and unnecessary. Modules are reported separately.
	TSharedRef<FJsonObject> Available = MakeShared<FJsonObject>();
	Available->SetBoolField(TEXT("MassGameplay"), bMassGameplay);
	Available->SetBoolField(TEXT("MassCrowd"), bMassCrowd);
	Available->SetBoolField(TEXT("ZoneGraph"), bZoneGraph);
	Available->SetBoolField(TEXT("StateTree"), bStateTree);
	Result->SetObjectField(TEXT("availablePlugins"), Available);

	TSharedRef<FJsonObject> Modules = MakeShared<FJsonObject>();
	Modules->SetBoolField(TEXT("MassEntity"), bMassEntityModule);
	Modules->SetBoolField(TEXT("MassCore"), bMassCoreModule);
	Result->SetObjectField(TEXT("availableModules"), Modules);

	Result->SetBoolField(TEXT("deterministicSeed"), true);
	Result->SetBoolField(TEXT("supportsFlowOrigins"), true);
	Result->SetBoolField(TEXT("supportsBlockades"), true);
	Result->SetBoolField(TEXT("supportsPressure"), true);
	Result->SetBoolField(TEXT("supportsBreachTrigger"), true);
	Result->SetBoolField(TEXT("supportsPanicTrigger"), true);

	// Explicitly unsupported, per the milestone's non-goals. Reported as false rather than omitted
	// so an agent can branch on them instead of guessing from their absence.
	//
	// CLAUDE-NOTE: these four are UNCONDITIONAL literals, not derived from any plugin/module probe —
	// checked deliberately while fixing the massEntity false negative, because they were suspected of
	// being collateral damage from it. They are not. Enabling MassCrowd, ZoneGraph or StateTree will
	// NOT flip them, and it should not: the foundation navigates by direct steering and has no
	// ZoneGraph or StateTree code path to report on. They flip when the features are built, and the
	// only honest way to change them is to change them here alongside that work.
	Result->SetBoolField(TEXT("supportsHeroPromotion"), false);
	Result->SetBoolField(TEXT("supportsMelee"), false);
	Result->SetBoolField(TEXT("supportsZoneGraphNavigation"), false);
	Result->SetBoolField(TEXT("supportsStateTreeBehaviour"), false);
	Result->SetBoolField(TEXT("supportsSequencerCapture"), false);

	TArray<TSharedPtr<FJsonValue>> Warnings;
	if (!bMassGameplay)
	{
		Warnings.Add(MakeShared<FJsonValueString>(
			TEXT("MassGameplay is not enabled. Riot tools will reject spawn with RIOT_REQUIRED_PLUGIN_DISABLED.")));
	}
	// CLAUDE-NOTE: this is the ONE line that legitimately differs between the 5.6 and 5.8 branches —
	// 6 here, 8 there. Named rather than inlined so the divergence is greppable instead of being a
	// bare literal someone "helpfully" syncs. It was a bare 6 on the 5.8 fork too, which meant a
	// correctly-installed 5.8 editor was warned on every call that it ran an untested engine.
	// Left hard-coded rather than derived because the claim is "the engine this source was ported
	// and tested against", which no runtime query can answer.
	constexpr int32 TargetEngineMinor = 6;
	if (Version.GetMajor() != 5 || Version.GetMinor() != TargetEngineMinor)
	{
		Warnings.Add(MakeShared<FJsonValueString>(FString::Printf(
			TEXT("This build targets UE 5.%d; running on %s. Mass APIs have changed between engine ")
			TEXT("releases and are untested here."),
			TargetEngineMinor, *VersionString)));
	}
	if (bMassCrowd || bZoneGraph)
	{
		Warnings.Add(MakeShared<FJsonValueString>(
			TEXT("MassCrowd/ZoneGraph are enabled but this foundation does not use them; navigation is direct steering.")));
	}
	if (!GEditor || !GEditor->PlayWorld)
	{
		Warnings.Add(MakeShared<FJsonValueString>(
			TEXT("PIE is not running. Mass processors execute in the play world only; start_pie before riot_spawn.")));
	}
	Result->SetArrayField(TEXT("warnings"), Warnings);

	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleListScenarios(const FString& /*Body*/)
{
	TArray<TSharedPtr<FJsonValue>> Array;
	for (const FRiotScenario& Scenario : FRiotScenarioStore::Get().All())
	{
		TSharedRef<FJsonObject> Summary = MakeShared<FJsonObject>();
		Summary->SetStringField(TEXT("scenarioId"), Scenario.Id);
		Summary->SetStringField(TEXT("displayName"), Scenario.DisplayName);
		Summary->SetStringField(TEXT("lifecycle"), LexToStringRiotLifecycle(Scenario.Lifecycle));
		Summary->SetNumberField(TEXT("seed"), Scenario.Seed);
		Summary->SetNumberField(TEXT("factionCount"), Scenario.Factions.Num());
		Summary->SetNumberField(TEXT("flowOriginCount"), Scenario.Origins.Num());
		Summary->SetNumberField(TEXT("blockadeCount"), Scenario.Blockades.Num());
		Summary->SetNumberField(TEXT("triggerCount"), Scenario.Triggers.Num());
		Array.Add(MakeShared<FJsonValueObject>(Summary));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("scenarios"), Array);
	Result->SetNumberField(TEXT("count"), Array.Num());
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleGetScenario(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("scenario"), Scenario->ToJson());
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleGetRuntimeReport(const FString& /*Body*/)
{
	FString Error;
	URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(Error);
	if (!Subsystem)
	{
		return MakeRiotErrorJson(RiotErrorCodes::PieNotRunning, Error);
	}

	TSharedRef<FJsonObject> Result = Subsystem->BuildRuntimeReport();
	return JsonToString(Result);
}

// ============================================================
// Scenario authoring
// ============================================================

FString FRiotCrowdHandlers::HandleCreateScenario(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ScenarioId;
	if (!Parsed->TryGetStringField(TEXT("scenarioId"), ScenarioId) || ScenarioId.IsEmpty())
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'scenarioId'."));
	}

	if (FRiotScenarioStore::Get().Find(ScenarioId))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioAlreadyExists,
			FString::Printf(TEXT("Scenario '%s' already exists. Delete it first or use a different id."), *ScenarioId));
	}

	FRiotScenario Scenario;
	Scenario.Id = ScenarioId;
	Scenario.SchemaVersion = RiotScenarioSchemaVersion;
	Parsed->TryGetStringField(TEXT("displayName"), Scenario.DisplayName);
	if (Scenario.DisplayName.IsEmpty())
	{
		Scenario.DisplayName = ScenarioId;
	}
	Scenario.Seed = (int32)ReadNumber(Parsed, TEXT("seed"), 1337);
	Parsed->TryGetStringField(TEXT("world"), Scenario.WorldName);
	Scenario.Lifecycle = ERiotLifecycle::Configured;

	// Optional pressure-model overrides.
	const TSharedPtr<FJsonObject>* ModelJson = nullptr;
	if (Parsed->TryGetObjectField(TEXT("pressureModel"), ModelJson))
	{
		FRiotPressureModel& Model = Scenario.PressureModel;
		Model.PressureGain = ReadNumber(*ModelJson, TEXT("pressureGain"), Model.PressureGain);
		Model.SustainBonusPerSecond = ReadNumber(*ModelJson, TEXT("sustainBonusPerSecond"), Model.SustainBonusPerSecond);
		Model.DecayRatePerSecond = ReadNumber(*ModelJson, TEXT("decayRatePerSecond"), Model.DecayRatePerSecond);
		Model.RiseRatePerSecond = ReadNumber(*ModelJson, TEXT("riseRatePerSecond"), Model.RiseRatePerSecond);
		Model.ContactBand = ReadNumber(*ModelJson, TEXT("contactBand"), Model.ContactBand);
		Model.MaxPressure = ReadNumber(*ModelJson, TEXT("maxPressure"), Model.MaxPressure);
	}

	FString ErrorCode, Message;
	if (!ValidateRiotScenario(Scenario, ErrorCode, Message))
	{
		return MakeRiotErrorJson(*ErrorCode, Message);
	}

	const bool bDryRun = IsDryRun(Parsed);
	TSharedRef<FJsonObject> Result = MakeSuccess(
		FString::Printf(TEXT("Created scenario '%s' with seed %d."), *ScenarioId, Scenario.Seed));
	Result->SetBoolField(TEXT("dryRun"), bDryRun);

	if (!bDryRun)
	{
		FRiotScenario& Stored = FRiotScenarioStore::Get().Add(MoveTemp(Scenario));
		Result->SetObjectField(TEXT("scenario"), Stored.ToJson());
	}
	else
	{
		Result->SetObjectField(TEXT("scenario"), Scenario.ToJson());
	}

	AddNextSteps(Result, {
		TEXT("riot_add_faction — define at least one rioter faction and one defending faction"),
		TEXT("riot_add_flow_origin — add three or more entry points"),
		TEXT("riot_add_blockade — place the defending line"),
	});
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleDeleteScenario(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	const FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	const FString ScenarioId = Scenario->Id;
	const bool bDryRun = IsDryRun(Parsed);

	TSharedRef<FJsonObject> Result = MakeSuccess(
		FString::Printf(TEXT("Deleted scenario '%s'."), *ScenarioId));
	Result->SetBoolField(TEXT("dryRun"), bDryRun);
	Result->SetStringField(TEXT("scenarioId"), ScenarioId);

	if (!bDryRun)
	{
		// CLAUDE-NOTE: reset any live simulation for this scenario BEFORE dropping the definition.
		// Deleting the definition first would strand spawned entities with no scenario to reset
		// them against, which is exactly the "partial mutation" the milestone forbids.
		FString SubsystemError;
		if (URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(SubsystemError))
		{
			if (Subsystem->GetActiveScenarioId() == ScenarioId)
			{
				FString Code, Error;
				Subsystem->ResetScenario(Code, Error);
			}
		}
		FRiotScenarioStore::Get().Remove(ScenarioId);
	}

	AddNextSteps(Result, { TEXT("riot_list_scenarios — confirm it is gone") });
	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleAddFaction(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	FRiotFaction Faction;
	if (!Parsed->TryGetStringField(TEXT("factionId"), Faction.Id))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'factionId'."));
	}
	Parsed->TryGetStringField(TEXT("displayName"), Faction.DisplayName);
	if (Faction.DisplayName.IsEmpty()) Faction.DisplayName = Faction.Id;

	FString TypeString;
	Parsed->TryGetStringField(TEXT("type"), TypeString);
	if (TypeString.Equals(TEXT("police"), ESearchCase::IgnoreCase))        Faction.Type = ERiotFactionType::Police;
	else if (TypeString.Equals(TEXT("military"), ESearchCase::IgnoreCase)) Faction.Type = ERiotFactionType::Military;
	else if (TypeString.Equals(TEXT("neutral"), ESearchCase::IgnoreCase))  Faction.Type = ERiotFactionType::Neutral;
	else                                                                   Faction.Type = ERiotFactionType::Rioter;

	Faction.MaxSpawnCount = (int32)ReadNumber(Parsed, TEXT("maxSpawnCount"), 0);

	FRiotScenario Candidate = *Scenario;
	Candidate.Factions.Add(Faction);

	return CommitScenario(*Scenario, MoveTemp(Candidate), IsDryRun(Parsed),
		FString::Printf(TEXT("Added faction '%s' (%s) to scenario '%s'."),
			*Faction.Id, LexToStringRiotFactionType(Faction.Type), *Scenario->Id),
		{ TEXT("riot_add_flow_origin — give this faction somewhere to enter from") });
}

FString FRiotCrowdHandlers::HandleAddFlowOrigin(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	FRiotFlowOrigin Origin;
	if (!Parsed->TryGetStringField(TEXT("originId"), Origin.Id))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'originId'."));
	}
	if (!Parsed->TryGetStringField(TEXT("factionId"), Origin.FactionId))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'factionId'."));
	}
	if (!ReadVector(Parsed, TEXT("location"), Origin.Location))
	{
		return MakeRiotErrorJson(RiotErrorCodes::InvalidTransform,
			TEXT("Missing required field: 'location' with x, y, z."));
	}
	if (!ReadVector(Parsed, TEXT("initialTarget"), Origin.InitialTarget))
	{
		Origin.InitialTarget = Origin.Location;
	}

	Origin.SpawnRadius = ReadNumber(Parsed, TEXT("spawnRadius"), 0.0);
	Origin.SpawnCount = (int32)ReadNumber(Parsed, TEXT("spawnCount"), 0);
	Origin.SpawnDelay = ReadNumber(Parsed, TEXT("spawnDelay"), 0.0);
	Origin.SpawnInterval = ReadNumber(Parsed, TEXT("spawnInterval"), 0.0);
	Origin.SpeedMin = ReadNumber(Parsed, TEXT("speedMin"), 200.0);
	Origin.SpeedMax = ReadNumber(Parsed, TEXT("speedMax"), 400.0);

	FRiotScenario Candidate = *Scenario;
	Candidate.Origins.Add(Origin);

	return CommitScenario(*Scenario, MoveTemp(Candidate), IsDryRun(Parsed),
		FString::Printf(TEXT("Added flow origin '%s' releasing %d agents of faction '%s'."),
			*Origin.Id, Origin.SpawnCount, *Origin.FactionId),
		{ TEXT("riot_add_blockade — give the crowd something to press against") });
}

FString FRiotCrowdHandlers::HandleAddBlockade(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	FRiotBlockade Blockade;
	if (!Parsed->TryGetStringField(TEXT("blockadeId"), Blockade.Id))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'blockadeId'."));
	}
	if (!Parsed->TryGetStringField(TEXT("defendingFactionId"), Blockade.DefendingFactionId))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'defendingFactionId'."));
	}
	if (!ReadVector(Parsed, TEXT("location"), Blockade.Location))
	{
		return MakeRiotErrorJson(RiotErrorCodes::InvalidTransform,
			TEXT("Missing required field: 'location' with x, y, z."));
	}

	Blockade.YawDegrees = ReadNumber(Parsed, TEXT("yawDegrees"), 0.0);
	Blockade.Width = ReadNumber(Parsed, TEXT("width"), 800.0);
	Blockade.Depth = ReadNumber(Parsed, TEXT("depth"), 200.0);
	Blockade.DefenderCount = (int32)ReadNumber(Parsed, TEXT("defenderCount"), 0);
	Blockade.HoldThreshold = ReadNumber(Parsed, TEXT("holdThreshold"), 40.0);
	Blockade.BreakThreshold = ReadNumber(Parsed, TEXT("breakThreshold"), 100.0);
	ReadVector(Parsed, TEXT("fallbackLocation"), Blockade.FallbackLocation);

	FRiotScenario Candidate = *Scenario;
	Candidate.Blockades.Add(Blockade);

	return CommitScenario(*Scenario, MoveTemp(Candidate), IsDryRun(Parsed),
		FString::Printf(TEXT("Added blockade '%s' with %d defenders (breaks at pressure %.1f)."),
			*Blockade.Id, Blockade.DefenderCount, Blockade.BreakThreshold),
		{ TEXT("riot_set_trigger — add a breach and a panic trigger") });
}

FString FRiotCrowdHandlers::HandleAddHotspot(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	FRiotHotspot Hotspot;
	if (!Parsed->TryGetStringField(TEXT("hotspotId"), Hotspot.Id))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'hotspotId'."));
	}
	if (!ReadVector(Parsed, TEXT("location"), Hotspot.Location))
	{
		return MakeRiotErrorJson(RiotErrorCodes::InvalidTransform,
			TEXT("Missing required field: 'location' with x, y, z."));
	}

	FString TypeString;
	Parsed->TryGetStringField(TEXT("type"), TypeString);
	if (TypeString.Equals(TEXT("breach"), ESearchCase::IgnoreCase))     Hotspot.Type = ERiotHotspotType::Breach;
	else if (TypeString.Equals(TEXT("panic"), ESearchCase::IgnoreCase)) Hotspot.Type = ERiotHotspotType::Panic;
	else                                                                Hotspot.Type = ERiotHotspotType::Pressure;

	Hotspot.InfluenceRadius = ReadNumber(Parsed, TEXT("influenceRadius"), 500.0);
	Hotspot.Intensity = ReadNumber(Parsed, TEXT("intensity"), 1.0);

	FRiotScenario Candidate = *Scenario;
	Candidate.Hotspots.Add(Hotspot);

	return CommitScenario(*Scenario, MoveTemp(Candidate), IsDryRun(Parsed),
		FString::Printf(TEXT("Added hotspot '%s'."), *Hotspot.Id),
		{ TEXT("riot_spawn — instantiate the scenario in PIE") });
}

FString FRiotCrowdHandlers::HandleSetTrigger(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	FRiotTrigger Trigger;
	if (!Parsed->TryGetStringField(TEXT("triggerId"), Trigger.Id))
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Missing required field: 'triggerId'."));
	}

	FString TypeString;
	Parsed->TryGetStringField(TEXT("type"), TypeString);
	if (TypeString.Equals(TEXT("panic"), ESearchCase::IgnoreCase))
	{
		Trigger.Type = ERiotHotspotType::Panic;
	}
	else if (TypeString.Equals(TEXT("breach"), ESearchCase::IgnoreCase))
	{
		Trigger.Type = ERiotHotspotType::Breach;
	}
	else
	{
		return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid,
			TEXT("Field 'type' must be 'breach' or 'panic'."));
	}

	FString ConditionString;
	Parsed->TryGetStringField(TEXT("condition"), ConditionString);
	if (ConditionString.Equals(TEXT("elapsed_time"), ESearchCase::IgnoreCase))
	{
		Trigger.Condition = ERiotTriggerCondition::ElapsedTime;
	}
	else if (ConditionString.Equals(TEXT("agents_passed"), ESearchCase::IgnoreCase))
	{
		Trigger.Condition = ERiotTriggerCondition::AgentsPassed;
	}
	else
	{
		Trigger.Condition = ERiotTriggerCondition::PressureThreshold;
	}

	Parsed->TryGetStringField(TEXT("targetBlockadeId"), Trigger.TargetBlockadeId);
	Trigger.ThresholdValue = ReadNumber(Parsed, TEXT("thresholdValue"), 0.0);
	Trigger.AffectedFraction = ReadNumber(Parsed, TEXT("affectedFraction"), 0.5);

	FRiotScenario Candidate = *Scenario;
	// CLAUDE-NOTE: "set" semantics — replace a trigger with the same id rather than appending a
	// duplicate, otherwise calling riot_set_trigger twice with one id would fail validation on
	// RIOT_DUPLICATE_ID and the tool name would be a lie.
	const int32 Existing = Candidate.Triggers.IndexOfByPredicate(
		[&](const FRiotTrigger& T) { return T.Id == Trigger.Id; });
	if (Existing != INDEX_NONE)
	{
		Candidate.Triggers[Existing] = Trigger;
	}
	else
	{
		Candidate.Triggers.Add(Trigger);
	}

	return CommitScenario(*Scenario, MoveTemp(Candidate), IsDryRun(Parsed),
		FString::Printf(TEXT("Set %s trigger '%s' (threshold %.1f)."),
			Trigger.Type == ERiotHotspotType::Breach ? TEXT("breach") : TEXT("panic"),
			*Trigger.Id, Trigger.ThresholdValue),
		{ TEXT("riot_spawn — instantiate the scenario in PIE") });
}

// ============================================================
// Runtime control
// ============================================================

FString FRiotCrowdHandlers::HandleSpawn(const FString& Body)
{
	const TSharedPtr<FJsonObject> Parsed = ParseBody(Body);
	if (!Parsed) return MakeRiotErrorJson(RiotErrorCodes::ScenarioInvalid, TEXT("Invalid JSON body."));

	FString ErrorJson;
	FRiotScenario* Scenario = RequireScenario(Parsed, ErrorJson);
	if (!Scenario) return ErrorJson;

	const bool bDryRun = IsDryRun(Parsed);

	// Count what a real spawn would produce, without creating anything.
	int32 PlannedRioters = 0;
	for (const FRiotFlowOrigin& Origin : Scenario->Origins)
	{
		PlannedRioters += Origin.SpawnCount;
	}
	int32 PlannedDefenders = 0;
	for (const FRiotBlockade& Blockade : Scenario->Blockades)
	{
		PlannedDefenders += Blockade.DefenderCount;
	}

	if (bDryRun)
	{
		FString ValidationCode, ValidationMessage;
		if (!ValidateRiotScenario(*Scenario, ValidationCode, ValidationMessage))
		{
			return MakeRiotErrorJson(*ValidationCode, ValidationMessage);
		}

		TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
			TEXT("Dry run: would spawn %d rioters and %d defenders. Nothing was created."),
			PlannedRioters, PlannedDefenders));
		Result->SetBoolField(TEXT("dryRun"), true);
		Result->SetNumberField(TEXT("plannedRioters"), PlannedRioters);
		Result->SetNumberField(TEXT("plannedDefenders"), PlannedDefenders);
		Result->SetNumberField(TEXT("spawnedRioters"), 0);
		Result->SetNumberField(TEXT("spawnedDefenders"), 0);
		AddNextSteps(Result, { TEXT("riot_spawn with dryRun=false — actually create the agents") });
		return JsonToString(Result);
	}

	FString SubsystemError;
	URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(SubsystemError);
	if (!Subsystem)
	{
		return MakeRiotErrorJson(RiotErrorCodes::PieNotRunning, SubsystemError);
	}

	FString Code, Error;
	if (!Subsystem->SpawnScenario(Scenario->Id, Code, Error))
	{
		return MakeRiotErrorJson(*Code, Error);
	}

	// CLAUDE-NOTE: read the counts back off the live entities rather than echoing what we asked
	// for. "Never claim success solely because a function returned" — if entity creation silently
	// produced fewer agents than planned, the mismatch surfaces here instead of in a screenshot.
	const FRiotRuntimeCounts Counts = Subsystem->CollectCounts();

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(
		TEXT("Spawned %d rioters and %d defenders for scenario '%s'."),
		Counts.Total, Counts.Defenders, *Scenario->Id));
	Result->SetBoolField(TEXT("dryRun"), false);
	Result->SetNumberField(TEXT("plannedRioters"), PlannedRioters);
	Result->SetNumberField(TEXT("plannedDefenders"), PlannedDefenders);
	Result->SetNumberField(TEXT("spawnedRioters"), Counts.Total);
	Result->SetNumberField(TEXT("spawnedDefenders"), Counts.Defenders);

	TArray<TSharedPtr<FJsonValue>> Warnings;
	if (Counts.Total != PlannedRioters)
	{
		Warnings.Add(MakeShared<FJsonValueString>(FString::Printf(
			TEXT("Rioter count mismatch: planned %d, live %d."), PlannedRioters, Counts.Total)));
	}
	if (Counts.Defenders != PlannedDefenders)
	{
		Warnings.Add(MakeShared<FJsonValueString>(FString::Printf(
			TEXT("Defender count mismatch: planned %d, live %d."), PlannedDefenders, Counts.Defenders)));
	}
	Result->SetArrayField(TEXT("warnings"), Warnings);

	AddNextSteps(Result, {
		TEXT("riot_start — begin advancing the simulation"),
		TEXT("viewport_capture — record the pre-start frame"),
	});
	return JsonToString(Result);
}

/** Shared shape for start/pause/resume/reset, which differ only in the verb they call. */
FString FRiotCrowdHandlers::HandleLifecycleVerb(const FString& /*Body*/, ERiotLifecycleVerb Verb)
{
	FString SubsystemError;
	URiotCrowdSubsystem* Subsystem = GetRiotSubsystem(SubsystemError);
	if (!Subsystem)
	{
		return MakeRiotErrorJson(RiotErrorCodes::PieNotRunning, SubsystemError);
	}

	FString Code, Error;
	bool bOk = false;
	const TCHAR* VerbName = TEXT("");

	switch (Verb)
	{
	case ERiotLifecycleVerb::Start:  bOk = Subsystem->StartSimulation(Code, Error);  VerbName = TEXT("started"); break;
	case ERiotLifecycleVerb::Pause:  bOk = Subsystem->PauseSimulation(Code, Error);  VerbName = TEXT("paused"); break;
	case ERiotLifecycleVerb::Resume: bOk = Subsystem->ResumeSimulation(Code, Error); VerbName = TEXT("resumed"); break;
	case ERiotLifecycleVerb::Reset:  bOk = Subsystem->ResetScenario(Code, Error);    VerbName = TEXT("reset"); break;
	}

	if (!bOk)
	{
		return MakeRiotErrorJson(*Code, Error);
	}

	// Read state back rather than asserting the verb worked.
	const FRiotRuntimeCounts Counts = Subsystem->CollectCounts();

	TSharedRef<FJsonObject> Result = MakeSuccess(FString::Printf(TEXT("Simulation %s."), VerbName));
	Result->SetBoolField(TEXT("running"), Subsystem->IsRunning());
	Result->SetBoolField(TEXT("spawned"), Subsystem->IsSpawned());
	Result->SetNumberField(TEXT("liveAgents"), Counts.Total);
	Result->SetNumberField(TEXT("liveDefenders"), Counts.Defenders);

	if (Verb == ERiotLifecycleVerb::Reset)
	{
		// CLAUDE-NOTE: reset is only allowed to report success once the counts are actually zero.
		// Reporting "reset" while entities survive is the precise failure the milestone calls out.
		TArray<TSharedPtr<FJsonValue>> Warnings;
		if (Counts.Total != 0 || Counts.Defenders != 0)
		{
			Warnings.Add(MakeShared<FJsonValueString>(FString::Printf(
				TEXT("Reset reported success but %d agents and %d defenders remain."),
				Counts.Total, Counts.Defenders)));
			Result->SetBoolField(TEXT("success"), false);
			Result->SetStringField(TEXT("errorCode"), RiotErrorCodes::ResetFailed);
		}
		Result->SetArrayField(TEXT("warnings"), Warnings);
	}

	return JsonToString(Result);
}

FString FRiotCrowdHandlers::HandleStart(const FString& Body)  { return HandleLifecycleVerb(Body, ERiotLifecycleVerb::Start); }
FString FRiotCrowdHandlers::HandlePause(const FString& Body)  { return HandleLifecycleVerb(Body, ERiotLifecycleVerb::Pause); }
FString FRiotCrowdHandlers::HandleResume(const FString& Body) { return HandleLifecycleVerb(Body, ERiotLifecycleVerb::Resume); }
FString FRiotCrowdHandlers::HandleReset(const FString& Body)  { return HandleLifecycleVerb(Body, ERiotLifecycleVerb::Reset); }
