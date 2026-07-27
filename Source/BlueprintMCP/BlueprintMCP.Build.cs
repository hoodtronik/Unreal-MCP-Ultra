using UnrealBuildTool;

public class BlueprintMCP : ModuleRules
{
	public BlueprintMCP(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"UnrealEd",
			"BlueprintGraph",
			"Json",
			"JsonUtilities",
			"HTTPServer",
			"Sockets",
			"Networking",
			// CLAUDE-NOTE: Niagara runtime modules — needed for UNiagaraSystem/UNiagaraEmitter
			// references in handler code. NiagaraEditor is editor-only (see Private list).
			"Niagara",
			"NiagaraCore"
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"AssetRegistry",
			"AssetTools",
			"Kismet",
			"KismetCompiler",
			"EditorSubsystem",
			"MaterialEditor",
			"AnimGraph",
			"AnimGraphRuntime",
			"RHI",
			"Slate",
			"UMG",
			"UMGEditor",
			"SlateCore",
			"HairStrandsCore",
			// CLAUDE-NOTE: added for the Voxel Sandbox -> StaticMesh baker (BlueprintMCPVoxelBaker.cpp).
			"ProceduralMeshComponent",
			"MeshDescription",
			"StaticMeshDescription",
			// CLAUDE-NOTE: added for the run_python bridge (BlueprintMCPHandlers_Python.cpp).
			"PythonScriptPlugin",
			// CLAUDE-NOTE: added for PCG graph authoring endpoints (BlueprintMCPHandlers_PCG.cpp) —
			// graph user-parameters + override-pin binding via the PCG editor C++ API.
			"PCG",
			// CLAUDE-NOTE: NiagaraEditor exposes factories, the stack ViewModel, and module
			// library helpers — all editor-only. Wrap usage with WITH_EDITOR.
			"NiagaraEditor",
			// CLAUDE-NOTE: added for USourceControlHelpers::CheckOutFile (github.com/mirno-ehf/ue5-mcp#88,
			// #66) — MCP saves now check out via the active source control provider before writing,
			// instead of only stripping the read-only bit. Safe no-op when SC isn't configured.
			"SourceControl",
			// CLAUDE-NOTE: added for GGameThreadTime/GRenderThreadTime/GRHIThreadTime
			// (get_frame_timing — the scoped-down "profiling service" backlog item). Engine
			// already pulls RenderCore in transitively; explicit for clarity.
			"RenderCore",
			// CLAUDE-NOTE: SGraphEditor came for free via UnrealEd (it's declared in
			// UnrealEd/Public/GraphEditor.h), but SGraphPanel::Update() lives in the separate
			// GraphEditor module and wasn't linkable without this — screenshot_graph (#65) needs it
			// to force the panel to build its node widgets before an off-screen render.
			"GraphEditor",
			// CLAUDE-NOTE: ULevelEditorSubsystem (open_level / new_level). Its LoadLevel/NewLevel
			// wrap themselves in GIsRunningUnattendedScript, which is what makes them safe to call
			// from an MCP request — the raw FEditorFileUtils path can raise a modal save dialog and
			// deadlock the game thread the handler runs on.
			"LevelEditor"
		});
	}
}
