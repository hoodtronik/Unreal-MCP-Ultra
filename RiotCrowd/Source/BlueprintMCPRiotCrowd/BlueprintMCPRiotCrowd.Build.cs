using UnrealBuildTool;

// CLAUDE-NOTE: Riot Crowd ships as a SEPARATE, OPT-IN plugin that installs as a SIBLING of
// BlueprintMCP. Both the separation and the manual install step are forced by measured engine
// behaviour, not preference. Two constraints, both proven against UE 5.6.1:
//
// 1. A nested plugin is undiscoverable. FPluginManager::FindPluginsInDirectory
//    (PluginManager.cpp:1163-1167) discards a directory's sub-directories once it finds a .uplugin
//    there. This repo's root IS a plugin, so RiotCrowd/ is never scanned while it lives here — it
//    has to be copied/junctioned to <Project>/Plugins/BlueprintMCPRiotCrowd to load.
//
// 2. Optionality cannot be done with #if inside one module. UHT rejects reflected types inside any
//    preprocessor block: "'USTRUCT' must not be inside preprocessor blocks, except for
//    WITH_EDITORONLY_DATA". Mass fragments must be USTRUCTs and processors must be UCLASSes, so a
//    single module cannot conditionally reflect them — the Mass link is all-or-nothing per module.
//
// Together those mean the only way to keep MassGameplay off the machines of users who just want the
// core Blueprint tools is a genuinely separate plugin they choose to install. Opting in is the
// deliberate act of copying this folder.
//
// Full evidence: docs/riot-crowd/UE56-MASS-API-FINDINGS.md §3 and §9.
public class BlueprintMCPRiotCrowd : ModuleRules
{
	public BlueprintMCPRiotCrowd(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"Json",
			"JsonUtilities",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"UnrealEd",
			"EditorSubsystem",
			"Projects", // IPluginManager, for capability detection

			// CLAUDE-NOTE: depend on the core module rather than reimplementing it. Riot endpoints
			// are contributed through FBlueprintMCPServer::RegisterExternalEndpoint so they reuse
			// the core's router, request queue, game-thread marshalling and error conventions.
			"BlueprintMCP",

			// CLAUDE-NOTE: MassEntity is an ENGINE Runtime module in 5.6
			// (Engine/Source/Runtime/MassEntity), NOT a plugin module — the plugin at
			// Plugins/Runtime/MassEntity contains only Content/Resources and no Source at all.
			// Deliberately do NOT enable that plugin: UBT reports
			// "plugin 'MassEntity' which was deprecated in 5.5 and will soon be removed".
			// Naming the module here is correct and sufficient; enabling the shell plugin is not.
			"MassEntity",

			// From the MassGameplay plugin, which IS listed in the .uplugin.
			"MassCommon",
			"MassMovement",
			"MassRepresentation",
			"MassSpawner",
			"MassSimulation",

			// CLAUDE-NOTE: added for the rigged-representation milestone. Both are modules of the
			// SAME already-enabled MassGameplay plugin, so this adds no new plugin dependency for
			// consuming projects and leaves the optional-sibling boundary intact.
			//   MassLOD    - FMassViewerInfoFragment / FMassRepresentationLODFragment, and the
			//                viewer abstraction that makes the PIE player camera the default LOD
			//                source with no work on our side.
			//   MassActors - FMassActorFragment, UMassActorSubsystem, UMassActorSpawnerSubsystem and
			//                IMassActorPoolableInterface, i.e. engine-provided actor pooling.
			// See docs/riot-crowd/UE56-RIGGED-REPRESENTATION-API-FINDINGS.md §1 and §6.
			"MassLOD",
			"MassActors",
		});
	}
}
