using UnrealBuildTool;

// CLAUDE-NOTE (2026-10-22): Pose Search ships as a SEPARATE opt-in sibling plugin, like RiotCrowd (see
// RiotCrowd/Source/BlueprintMCPRiotCrowd/BlueprintMCPRiotCrowd.Build.cs for why a nested plugin is not discovered and
// why one module cannot link PoseSearch optionally). Projects that do not enable PoseSearch keep the core plugin only.
public class BlueprintMCPPoseSearch : ModuleRules
{
	public BlueprintMCPPoseSearch(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "Json", "JsonUtilities" });
		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"UnrealEd",
			"AssetRegistry",
			"EditorScriptingUtilities",
			"BlueprintMCP",
			"PoseSearch",
		});
	}
}
