#include "BlueprintMCPServer.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"

// ============================================================
// HandleGetViewportCamera — get the viewport camera transform
// ============================================================

FString FBlueprintMCPServer::HandleGetViewportCamera(const FString& Body)
{
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: get_viewport_camera()"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("get_viewport_camera requires editor mode."));
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("Editor not available."));
	}

	// CLAUDE-NOTE: index 0 is not reliably a realized, sized viewport, and using it here while
	// viewport_capture resolves a different one means the camera could be moved on a viewport the
	// capture never shows. See ResolveSizedLevelViewportClient in BlueprintMCPHandlers_Screenshot.cpp.
	FString ViewportDiagnostic;
	FLevelEditorViewportClient* ViewportClient = ResolveSizedLevelViewportClient(ViewportDiagnostic);
	if (!ViewportClient)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("No level editor viewport with a usable size (%s)."), *ViewportDiagnostic));
	}

	FVector Location = ViewportClient->GetViewLocation();
	FRotator Rotation = ViewportClient->GetViewRotation();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	TSharedRef<FJsonObject> LocObj = MakeShared<FJsonObject>();
	LocObj->SetNumberField(TEXT("x"), Location.X);
	LocObj->SetNumberField(TEXT("y"), Location.Y);
	LocObj->SetNumberField(TEXT("z"), Location.Z);
	Result->SetObjectField(TEXT("location"), LocObj);

	TSharedRef<FJsonObject> RotObj = MakeShared<FJsonObject>();
	RotObj->SetNumberField(TEXT("pitch"), Rotation.Pitch);
	RotObj->SetNumberField(TEXT("yaw"), Rotation.Yaw);
	RotObj->SetNumberField(TEXT("roll"), Rotation.Roll);
	Result->SetObjectField(TEXT("rotation"), RotObj);

	Result->SetNumberField(TEXT("fov"), ViewportClient->ViewFOV);
	Result->SetNumberField(TEXT("cameraSpeed"), ViewportClient->GetCameraSpeedSetting());

	return JsonToString(Result);
}

// ============================================================
// HandleSetViewportCamera — set the viewport camera transform
// ============================================================

FString FBlueprintMCPServer::HandleSetViewportCamera(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: set_viewport_camera()"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("set_viewport_camera requires editor mode."));
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("Editor not available."));
	}

	// CLAUDE-NOTE: index 0 is not reliably a realized, sized viewport, and using it here while
	// viewport_capture resolves a different one means the camera could be moved on a viewport the
	// capture never shows. See ResolveSizedLevelViewportClient in BlueprintMCPHandlers_Screenshot.cpp.
	FString ViewportDiagnostic;
	FLevelEditorViewportClient* ViewportClient = ResolveSizedLevelViewportClient(ViewportDiagnostic);
	if (!ViewportClient)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("No level editor viewport with a usable size (%s)."), *ViewportDiagnostic));
	}

	// Parse optional location
	const TSharedPtr<FJsonObject>* LocObj = nullptr;
	if (Json->TryGetObjectField(TEXT("location"), LocObj))
	{
		double X = 0, Y = 0, Z = 0;
		(*LocObj)->TryGetNumberField(TEXT("x"), X);
		(*LocObj)->TryGetNumberField(TEXT("y"), Y);
		(*LocObj)->TryGetNumberField(TEXT("z"), Z);
		ViewportClient->SetViewLocation(FVector(X, Y, Z));
	}

	// Parse optional rotation
	const TSharedPtr<FJsonObject>* RotObj = nullptr;
	if (Json->TryGetObjectField(TEXT("rotation"), RotObj))
	{
		double Pitch = 0, Yaw = 0, Roll = 0;
		(*RotObj)->TryGetNumberField(TEXT("pitch"), Pitch);
		(*RotObj)->TryGetNumberField(TEXT("yaw"), Yaw);
		(*RotObj)->TryGetNumberField(TEXT("roll"), Roll);
		ViewportClient->SetViewRotation(FRotator(Pitch, Yaw, Roll));
	}

	// Parse optional FOV
	double FOV = 0;
	if (Json->TryGetNumberField(TEXT("fov"), FOV) && FOV > 0)
	{
		ViewportClient->ViewFOV = FOV;
	}

	ViewportClient->Invalidate();

	// Return current state
	FVector FinalLoc = ViewportClient->GetViewLocation();
	FRotator FinalRot = ViewportClient->GetViewRotation();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);

	TSharedRef<FJsonObject> FinalLocObj = MakeShared<FJsonObject>();
	FinalLocObj->SetNumberField(TEXT("x"), FinalLoc.X);
	FinalLocObj->SetNumberField(TEXT("y"), FinalLoc.Y);
	FinalLocObj->SetNumberField(TEXT("z"), FinalLoc.Z);
	Result->SetObjectField(TEXT("location"), FinalLocObj);

	TSharedRef<FJsonObject> FinalRotObj = MakeShared<FJsonObject>();
	FinalRotObj->SetNumberField(TEXT("pitch"), FinalRot.Pitch);
	FinalRotObj->SetNumberField(TEXT("yaw"), FinalRot.Yaw);
	FinalRotObj->SetNumberField(TEXT("roll"), FinalRot.Roll);
	Result->SetObjectField(TEXT("rotation"), FinalRotObj);

	Result->SetNumberField(TEXT("fov"), ViewportClient->ViewFOV);

	return JsonToString(Result);
}
