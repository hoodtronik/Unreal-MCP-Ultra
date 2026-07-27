#include "BlueprintMCPServer.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"

// ============================================================
// Helper — get the first active viewport client
// ============================================================

static FLevelEditorViewportClient* GetFirstViewportClient(const FBlueprintMCPServer& Server, FString& OutError)
{
	if (!GEditor)
	{
		OutError = TEXT("Editor not available.");
		return nullptr;
	}

	// CLAUDE-NOTE: was GetLevelViewportClients()[0], which is not reliably a realized, sized
	// viewport — see the long note on ResolveSizedLevelViewportClient in
	// BlueprintMCPHandlers_Screenshot.cpp. This helper backs set_view_mode, set_show_flags,
	// set_realtime_rendering, set_game_view and set_viewport_type, so index 0 meant all five could
	// report success while acting on a viewport nobody was looking at — and, worse, on a DIFFERENT
	// viewport from the one viewport_capture reads, so setting a view mode then capturing could
	// legitimately show no change.
	FString Diagnostic;
	if (FLevelEditorViewportClient* Client = Server.ResolveSizedLevelViewportClient(Diagnostic))
	{
		return Client;
	}

	OutError = FString::Printf(TEXT("No level editor viewport with a usable size (%s)."), *Diagnostic);
	return nullptr;
}

// ============================================================
// HandleSetViewMode — change the viewport rendering mode
// ============================================================

FString FBlueprintMCPServer::HandleSetViewMode(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	FString ModeName;
	if (!Json->TryGetStringField(TEXT("mode"), ModeName) || ModeName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'mode'. Options: Lit, Unlit, Wireframe, DetailLighting, LightingOnly, LightComplexity, ShaderComplexity, PathTracing."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_view_mode('%s')"), *ModeName);

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("set_view_mode requires editor mode."));
	}

	FString Error;
	FLevelEditorViewportClient* VC = GetFirstViewportClient(*this, Error);
	if (!VC) return MakeErrorJson(Error);

	EViewModeIndex NewMode;
	if (ModeName.Equals(TEXT("Lit"), ESearchCase::IgnoreCase))
		NewMode = VMI_Lit;
	else if (ModeName.Equals(TEXT("Unlit"), ESearchCase::IgnoreCase))
		NewMode = VMI_Unlit;
	else if (ModeName.Equals(TEXT("Wireframe"), ESearchCase::IgnoreCase))
		NewMode = VMI_BrushWireframe;
	else if (ModeName.Equals(TEXT("DetailLighting"), ESearchCase::IgnoreCase))
		NewMode = VMI_Lit_DetailLighting;
	else if (ModeName.Equals(TEXT("LightingOnly"), ESearchCase::IgnoreCase))
		NewMode = VMI_LightingOnly;
	else if (ModeName.Equals(TEXT("LightComplexity"), ESearchCase::IgnoreCase))
		NewMode = VMI_LightComplexity;
	else if (ModeName.Equals(TEXT("ShaderComplexity"), ESearchCase::IgnoreCase))
		NewMode = VMI_ShaderComplexity;
	else if (ModeName.Equals(TEXT("PathTracing"), ESearchCase::IgnoreCase))
		NewMode = VMI_PathTracing;
	else
	{
		return MakeErrorJson(FString::Printf(TEXT("Unknown view mode: '%s'. Options: Lit, Unlit, Wireframe, DetailLighting, LightingOnly, LightComplexity, ShaderComplexity, PathTracing."), *ModeName));
	}

	VC->SetViewMode(NewMode);
	VC->Invalidate();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("mode"), ModeName);

	return JsonToString(Result);
}

// ============================================================
// HandleSetShowFlags — toggle viewport show flags
// ============================================================

FString FBlueprintMCPServer::HandleSetShowFlags(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	FString FlagName;
	if (!Json->TryGetStringField(TEXT("flag"), FlagName) || FlagName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'flag'. Examples: Grid, Fog, Volumes, BSP, Collision, Navigation, Bounds."));
	}

	bool bEnabled = true;
	Json->TryGetBoolField(TEXT("enabled"), bEnabled);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_show_flags('%s', %s)"), *FlagName, bEnabled ? TEXT("true") : TEXT("false"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("set_show_flags requires editor mode."));
	}

	FString Error;
	FLevelEditorViewportClient* VC = GetFirstViewportClient(*this, Error);
	if (!VC) return MakeErrorJson(Error);

	// Use the engine show flag index lookup
	int32 FlagIndex = FEngineShowFlags::FindIndexByName(*FlagName);
	if (FlagIndex == INDEX_NONE)
	{
		return MakeErrorJson(FString::Printf(TEXT("Unknown show flag: '%s'. Common flags: Grid, Fog, Volumes, BSP, Collision, Navigation, Bounds, StaticMeshes, SkeletalMeshes, Lighting, PostProcessing."), *FlagName));
	}

	FEngineShowFlags& ShowFlags = VC->EngineShowFlags;
	ShowFlags.SetSingleFlag(FlagIndex, bEnabled);
	VC->Invalidate();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("flag"), FlagName);
	Result->SetBoolField(TEXT("enabled"), bEnabled);

	return JsonToString(Result);
}

// ============================================================
// HandleSetViewportType — switch between perspective/orthographic
// ============================================================

FString FBlueprintMCPServer::HandleSetViewportType(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	FString TypeName;
	if (!Json->TryGetStringField(TEXT("type"), TypeName) || TypeName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: 'type'. Options: Perspective, Top, Bottom, Left, Right, Front, Back."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_viewport_type('%s')"), *TypeName);

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("set_viewport_type requires editor mode."));
	}

	FString Error;
	FLevelEditorViewportClient* VC = GetFirstViewportClient(*this, Error);
	if (!VC) return MakeErrorJson(Error);

	if (TypeName.Equals(TEXT("Perspective"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_Perspective);
	}
	else if (TypeName.Equals(TEXT("Top"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_OrthoXY);
	}
	else if (TypeName.Equals(TEXT("Bottom"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_OrthoNegativeXY);
	}
	else if (TypeName.Equals(TEXT("Left"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_OrthoYZ);
	}
	else if (TypeName.Equals(TEXT("Right"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_OrthoNegativeYZ);
	}
	else if (TypeName.Equals(TEXT("Front"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_OrthoXZ);
	}
	else if (TypeName.Equals(TEXT("Back"), ESearchCase::IgnoreCase))
	{
		VC->SetViewportType(LVT_OrthoNegativeXZ);
	}
	else
	{
		return MakeErrorJson(FString::Printf(TEXT("Unknown viewport type: '%s'. Options: Perspective, Top, Bottom, Left, Right, Front, Back."), *TypeName));
	}

	VC->Invalidate();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("type"), TypeName);

	return JsonToString(Result);
}

// ============================================================
// HandleSetRealtimeRendering — toggle realtime rendering
// ============================================================

FString FBlueprintMCPServer::HandleSetRealtimeRendering(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	bool bEnabled = true;
	if (!Json->TryGetBoolField(TEXT("enabled"), bEnabled))
	{
		return MakeErrorJson(TEXT("Missing required field: 'enabled' (boolean)."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_realtime_rendering(%s)"), bEnabled ? TEXT("true") : TEXT("false"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("set_realtime_rendering requires editor mode."));
	}

	FString Error;
	FLevelEditorViewportClient* VC = GetFirstViewportClient(*this, Error);
	if (!VC) return MakeErrorJson(Error);

	VC->SetRealtime(bEnabled);
	VC->Invalidate();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetBoolField(TEXT("realtime"), VC->IsRealtime());

	return JsonToString(Result);
}

// ============================================================
// HandleSetGameView — toggle game view mode (hides editor UI)
// ============================================================

FString FBlueprintMCPServer::HandleSetGameView(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	bool bEnabled = true;
	if (!Json->TryGetBoolField(TEXT("enabled"), bEnabled))
	{
		return MakeErrorJson(TEXT("Missing required field: 'enabled' (boolean)."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_game_view(%s)"), bEnabled ? TEXT("true") : TEXT("false"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("set_game_view requires editor mode."));
	}

	FString Error;
	FLevelEditorViewportClient* VC = GetFirstViewportClient(*this, Error);
	if (!VC) return MakeErrorJson(Error);

	VC->SetGameView(bEnabled);
	VC->Invalidate();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetBoolField(TEXT("gameView"), VC->IsInGameView());

	return JsonToString(Result);
}
