#include "BlueprintMCPServer.h"
#include "Editor.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Blueprint.h"
#include "LevelEditorViewport.h"
#include "UnrealClient.h"
#include "HighResScreenshot.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ImageUtils.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "GraphEditor.h"
#include "SGraphPanel.h"
#include "Widgets/SVirtualWindow.h"
#include "Slate/WidgetRenderer.h"
#include "Layout/WidgetPath.h"
#include "Engine/TextureRenderTarget2D.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "Misc/Base64.h"
#include "Misc/Crc.h"
#include "Misc/App.h"
#include "Engine/World.h"
#include "Engine/Level.h"
#include "GameFramework/Actor.h"
#include "Selection.h"
#include "FileHelpers.h"
#include "UObject/Package.h"

// ============================================================
// HandleTakeScreenshot — capture a viewport screenshot
// ============================================================

FString FBlueprintMCPServer::HandleTakeScreenshot(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: take_screenshot()"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("take_screenshot requires editor mode."));
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("Editor not available."));
	}

	FString Filename;
	if (!Json->TryGetStringField(TEXT("filename"), Filename) || Filename.IsEmpty())
	{
		Filename = FString::Printf(TEXT("Screenshot_%s"), *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")));
	}

	// Ensure .png extension
	if (!Filename.EndsWith(TEXT(".png")))
	{
		Filename += TEXT(".png");
	}

	// Output directory
	FString OutputDir = FPaths::ProjectSavedDir() / TEXT("Screenshots");
	FString FullPath = OutputDir / Filename;

	// Prefer the PIE game viewport when playing — that's where gameplay (and the
	// framing component) actually renders. Falls back to the editor level viewport.
	FViewport* Viewport = nullptr;
	if (GEditor->PlayWorld && GEngine && GEngine->GameViewport && GEngine->GameViewport->Viewport)
	{
		Viewport = GEngine->GameViewport->Viewport;
	}
	else if (GEditor->GetLevelViewportClients().Num() > 0 && GEditor->GetLevelViewportClients()[0])
	{
		Viewport = GEditor->GetLevelViewportClients()[0]->Viewport;
	}

	if (!Viewport)
	{
		return MakeErrorJson(TEXT("No active viewport found."));
	}

	// Read pixels from viewport
	TArray<FColor> Bitmap;
	int32 Width = Viewport->GetSizeXY().X;
	int32 Height = Viewport->GetSizeXY().Y;

	if (Width <= 0 || Height <= 0)
	{
		return MakeErrorJson(TEXT("Viewport has invalid dimensions."));
	}

	bool bReadSuccess = Viewport->ReadPixels(Bitmap);
	if (!bReadSuccess || Bitmap.Num() == 0)
	{
		return MakeErrorJson(TEXT("Failed to read pixels from viewport."));
	}

	// Save as PNG (PNGCompressImageArray requires TArray64 in UE 5.7)
	TArray64<uint8> PngData;
	FImageUtils::PNGCompressImageArray(Width, Height, Bitmap, PngData);

	IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
	PlatformFile.CreateDirectoryTree(*OutputDir);

	bool bSaved = FFileHelper::SaveArrayToFile(PngData, *FullPath);
	if (!bSaved)
	{
		return MakeErrorJson(FString::Printf(TEXT("Failed to save screenshot to '%s'."), *FullPath));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("filename"), Filename);
	Result->SetStringField(TEXT("fullPath"), FullPath);
	Result->SetNumberField(TEXT("width"), Width);
	Result->SetNumberField(TEXT("height"), Height);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Screenshot saved to '%s' (%dx%d)"), *FullPath, Width, Height);

	return JsonToString(Result);
}

// ============================================================
// HandleTakeHighResScreenshot — capture a high-resolution screenshot
// ============================================================

FString FBlueprintMCPServer::HandleTakeHighResScreenshot(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: take_high_res_screenshot()"));

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("take_high_res_screenshot requires editor mode."));
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("Editor not available."));
	}

	double ResMultiplier = 2.0;
	Json->TryGetNumberField(TEXT("resolutionMultiplier"), ResMultiplier);
	if (ResMultiplier < 1.0) ResMultiplier = 1.0;
	if (ResMultiplier > 8.0) ResMultiplier = 8.0;

	FString Filename;
	if (!Json->TryGetStringField(TEXT("filename"), Filename) || Filename.IsEmpty())
	{
		Filename = FString::Printf(TEXT("HighRes_%s"), *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")));
	}

	if (!Filename.EndsWith(TEXT(".png")))
	{
		Filename += TEXT(".png");
	}

	FString OutputDir = FPaths::ProjectSavedDir() / TEXT("Screenshots");
	FString FullPath = OutputDir / Filename;

	FLevelEditorViewportClient* ViewportClient = nullptr;
	if (GEditor->GetLevelViewportClients().Num() > 0)
	{
		ViewportClient = GEditor->GetLevelViewportClients()[0];
	}

	if (!ViewportClient || !ViewportClient->Viewport)
	{
		return MakeErrorJson(TEXT("No active viewport found."));
	}

	// Configure high-res screenshot settings
	FHighResScreenshotConfig& Config = GetHighResScreenshotConfig();
	Config.SetResolution(
		ViewportClient->Viewport->GetSizeXY().X,
		ViewportClient->Viewport->GetSizeXY().Y,
		ResMultiplier
	);
	Config.SetFilename(FullPath);
	Config.bMaskEnabled = false;

	// Request the screenshot
	ViewportClient->Viewport->TakeHighResScreenShot();

	int32 FinalWidth = FMath::CeilToInt(ViewportClient->Viewport->GetSizeXY().X * ResMultiplier);
	int32 FinalHeight = FMath::CeilToInt(ViewportClient->Viewport->GetSizeXY().Y * ResMultiplier);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("filename"), Filename);
	Result->SetStringField(TEXT("fullPath"), FullPath);
	Result->SetNumberField(TEXT("resolutionMultiplier"), ResMultiplier);
	Result->SetNumberField(TEXT("estimatedWidth"), FinalWidth);
	Result->SetNumberField(TEXT("estimatedHeight"), FinalHeight);
	Result->SetStringField(TEXT("note"), TEXT("High-res screenshot is captured asynchronously. The file may take a moment to appear on disk."));

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: High-res screenshot requested at %dx multiplier -> '%s'"), (int32)ResMultiplier, *FullPath);

	return JsonToString(Result);
}

// ============================================================
// HandleScreenshotGraph — render a Blueprint graph (not the 3D viewport) to PNG
// ============================================================
// CLAUDE-NOTE: github.com/mirno-ehf/ue5-mcp#65. Renders an SGraphEditor off-screen via
// FWidgetRenderer/SVirtualWindow — the same headless-safe mechanism UE's own Content Browser
// thumbnail renderers use (WidgetBlueprintThumbnailRenderer.cpp), not FWidgetSnapshotService
// (which only captures already-visible native OS windows and can't target a widget built on the
// fly). No live Blueprint Editor tab is required — AssetEditorToolkit is left unset. SEH-wrapped
// since this is genuinely novel Slate/rendering code in this codebase with no prior art to lean on.

namespace
{
	// CLAUDE-NOTE: returns the raw FColor bitmap rather than compressed PNG bytes so callers can
	// downscale BEFORE compressing. viewport_capture asks for small (384-512px) frames, and
	// PNG-compressing 1600x1200 only to throw the pixels away costs ~10x what compressing the
	// already-downscaled image does. HandleScreenshotGraph compresses at full size as before.
	bool RenderGraphToBitmapInner(UEdGraph* EdGraph, int32 Width, int32 Height, TArray<FColor>& OutBitmap)
	{
		TSharedRef<SGraphEditor> GraphEditorWidget = SNew(SGraphEditor)
			.GraphToEdit(EdGraph)
			.IsEditable(false)
			.DisplayAsReadOnly(true);

		// CLAUDE-NOTE: SGraphPanel only builds its child SGraphNode widgets reactively, in
		// SGraphPanel::Update() — fired off the OnGraphChanged delegate or a Tick's deferred-update
		// flag, never from Construct() itself. With no running Slate app tick loop driving this
		// off-screen SVirtualWindow, Update() would never run on its own and the panel stays
		// permanently empty (verified live: zoom/pan changed correctly but the canvas stayed blank
		// with 0 node widgets). Force it explicitly before layout/paint.
		if (SGraphPanel* GraphPanel = GraphEditorWidget->GetGraphPanel())
		{
			GraphPanel->Update();
		}

		GraphEditorWidget->SlatePrepass(1.0f);

		// CLAUDE-NOTE: SGraphPanel's ZoomToFit() only *schedules* the fit — it registers a Slate
		// ActiveTimer that interpolates view offset/zoom across several real application ticks
		// (SNodePanel::HandleZoomToFit). There's no window and no running Slate app tick loop here
		// (FWidgetRenderer draws this SVirtualWindow exactly once with DeltaTime=0), so the timer
		// never advances and the capture came out at the default 1:1 view showing nothing (verified
		// live against a 6-node test graph). Compute the fit ourselves from node positions and set
		// the view synchronously with SetViewLocation instead.
		float MinX = TNumericLimits<float>::Max();
		float MinY = TNumericLimits<float>::Max();
		float MaxX = TNumericLimits<float>::Lowest();
		float MaxY = TNumericLimits<float>::Lowest();
		bool bHasNodes = false;
		for (UEdGraphNode* Node : EdGraph->Nodes)
		{
			if (!Node)
			{
				continue;
			}
			bHasNodes = true;
			MinX = FMath::Min(MinX, Node->GetNodePosX());
			MinY = FMath::Min(MinY, Node->GetNodePosY());
			// Real node widths aren't known until laid out; a generous minimum keeps single-node
			// graphs from zooming in absurdly tight.
			MaxX = FMath::Max(MaxX, Node->GetNodePosX() + FMath::Max(Node->GetWidth(), 250.0f));
			MaxY = FMath::Max(MaxY, Node->GetNodePosY() + FMath::Max(Node->GetHeight(), 150.0f));
		}

		if (bHasNodes)
		{
			constexpr float Padding = 100.0f;
			MinX -= Padding; MinY -= Padding; MaxX += Padding; MaxY += Padding;
			const float BoundsWidth = FMath::Max(MaxX - MinX, 1.0f);
			const float BoundsHeight = FMath::Max(MaxY - MinY, 1.0f);
			const float FitZoom = FMath::Min((float)Width / BoundsWidth, (float)Height / BoundsHeight);
			const float ZoomAmount = FMath::Clamp(FitZoom, 0.1f, 1.0f);
			// CLAUDE-NOTE: SGraphEditor::GetViewLocation() returns GraphPanel->GetViewOffset()
			// verbatim, and SGraphPanel::GraphCoordToPanelCoord() is (GraphCoord - ViewOffset) *
			// Zoom — so "Location" is the graph-space coordinate that lands at the viewport's
			// TOP-LEFT corner, not the center. Passing the bounds' center here (an earlier attempt)
			// left the actual nodes off-screen to the bottom-right; verified live before landing on
			// this fix. Pass the padded bounds' top-left instead.
			GraphEditorWidget->SetViewLocation(FVector2D(MinX, MinY), ZoomAmount);
		}

		FWidgetRenderer Renderer(/*bUseGammaCorrection=*/true);
		UTextureRenderTarget2D* RenderTarget = Renderer.DrawWidget(GraphEditorWidget, FVector2D(Width, Height));
		if (!RenderTarget)
		{
			return false;
		}

		FRenderTarget* RTResource = RenderTarget->GameThread_GetRenderTargetResource();
		if (!RTResource)
		{
			return false;
		}

		if (!RTResource->ReadPixels(OutBitmap) || OutBitmap.Num() == 0)
		{
			return false;
		}

		return true;
	}
}

int32 TryRenderGraphToBitmapSEH(UEdGraph* EdGraph, int32 Width, int32 Height, TArray<FColor>* OutBitmap, bool* bOutSuccess)
{
	__try
	{
		*bOutSuccess = RenderGraphToBitmapInner(EdGraph, Width, Height, *OutBitmap);
		return 0;
	}
	__except (1)
	{
		*bOutSuccess = false;
		return -1;
	}
}

FString FBlueprintMCPServer::HandleScreenshotGraph(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	if (BlueprintName.IsEmpty() || GraphName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph"), MCPErrorCodes::InvalidInput);
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: screenshot_graph('%s', '%s')"), *BlueprintName, *GraphName);

	if (!bIsEditor)
	{
		return MakeErrorJson(TEXT("screenshot_graph requires editor mode."));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP)
	{
		return MakeErrorJson(LoadError);
	}

	TArray<UEdGraph*> AllGraphs;
	BP->GetAllGraphs(AllGraphs);
	UEdGraph* TargetGraph = nullptr;
	for (UEdGraph* Graph : AllGraphs)
	{
		if (Graph && Graph->GetName().Equals(GraphName, ESearchCase::IgnoreCase))
		{
			TargetGraph = Graph;
			break;
		}
	}
	if (!TargetGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("Graph '%s' not found in Blueprint '%s'"), *GraphName, *BlueprintName), MCPErrorCodes::NotFound);
	}

	int32 Width = 1600;
	int32 Height = 1200;
	Json->TryGetNumberField(TEXT("width"), Width);
	Json->TryGetNumberField(TEXT("height"), Height);
	Width = FMath::Clamp(Width, 256, 8192);
	Height = FMath::Clamp(Height, 256, 8192);

	FString Filename;
	if (!Json->TryGetStringField(TEXT("filename"), Filename) || Filename.IsEmpty())
	{
		Filename = FString::Printf(TEXT("Graph_%s_%s_%s"), *BlueprintName, *GraphName, *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")));
	}
	if (!Filename.EndsWith(TEXT(".png")))
	{
		Filename += TEXT(".png");
	}

	FString OutputDir = FPaths::ProjectSavedDir() / TEXT("Screenshots");
	FString FullPath = OutputDir / Filename;

	TArray<FColor> Bitmap;
	bool bRenderSuccess = false;
	int32 SEHCode = TryRenderGraphToBitmapSEH(TargetGraph, Width, Height, &Bitmap, &bRenderSuccess);
	if (SEHCode != 0)
	{
		return MakeErrorJson(TEXT("screenshot_graph crashed while rendering the graph (SEH exception caught)."), MCPErrorCodes::OperationFailed);
	}
	if (!bRenderSuccess)
	{
		return MakeErrorJson(TEXT("Failed to render the graph to an image."), MCPErrorCodes::OperationFailed);
	}

	TArray64<uint8> PngData;
	FImageUtils::PNGCompressImageArray(Width, Height, Bitmap, PngData);
	if (PngData.Num() == 0)
	{
		return MakeErrorJson(TEXT("Failed to compress the graph image to PNG."), MCPErrorCodes::OperationFailed);
	}

	IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
	PlatformFile.CreateDirectoryTree(*OutputDir);

	bool bSaved = FFileHelper::SaveArrayToFile(PngData, *FullPath);
	if (!bSaved)
	{
		return MakeErrorJson(FString::Printf(TEXT("Failed to save graph screenshot to '%s'."), *FullPath));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("blueprint"), BlueprintName);
	Result->SetStringField(TEXT("graph"), GraphName);
	Result->SetStringField(TEXT("filename"), Filename);
	Result->SetStringField(TEXT("fullPath"), FullPath);
	Result->SetNumberField(TEXT("width"), Width);
	Result->SetNumberField(TEXT("height"), Height);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Graph screenshot saved to '%s' (%dx%d)"), *FullPath, Width, Height);

	return JsonToString(Result);
}

// ============================================================
// Vision: inline-image capture + change digest
// ============================================================
// CLAUDE-NOTE: viewport_capture returns PNG bytes as base64 INSIDE the tool result rather than
// writing a file and handing back a path. The round trip (capture -> write -> separate read-file
// tool call -> look) costs two extra agent turns per glance, which in practice means the agent
// stops looking at all and works blind off state queries. Both capture backends here were already
// synchronous and already had the compressed bytes in memory one line before writing them to disk
// (see HandleTakeScreenshot / HandleScreenshotGraph), so this is a strictly smaller code path, not
// a new one. take_high_res_screenshot is deliberately NOT part of this: it is the only genuinely
// deferred capture (TakeHighResScreenShot lands on disk a frame or more later) and ReadPixels
// supersedes it for every purpose vision mode has.

namespace
{
	constexpr int32 MinCaptureSize = 64;
	constexpr int32 MaxCaptureSize = 2048;

	/**
	 * Downscale (never upscale) to fit MaxSize on the longest edge, force opaque, PNG-compress,
	 * base64-encode, and fingerprint the resulting pixels.
	 *
	 * CLAUDE-NOTE: order matters. Resizing BEFORE PNG compression is the difference between
	 * compressing 1920x1080 and compressing 384x216 — roughly 80ms vs 2ms of game-thread stall.
	 * This runs synchronously inside ProcessOneRequest, so every millisecond here is a millisecond
	 * the editor is frozen.
	 */
	bool EncodeFrame(
		TArray<FColor>& Bitmap, int32 SrcWidth, int32 SrcHeight, int32 MaxSize,
		FString& OutBase64, FString& OutDigest, int32& OutWidth, int32& OutHeight, int64& OutBytes)
	{
		if (SrcWidth <= 0 || SrcHeight <= 0 || Bitmap.Num() < SrcWidth * SrcHeight)
		{
			return false;
		}

		// CLAUDE-NOTE: viewport backbuffer readback frequently comes back with alpha 0, which
		// encodes to a fully transparent PNG — invisible when rendered inline, so the failure looks
		// like "capture succeeded but the image is blank". UE's own screenshot path forces opacity
		// for the same reason. Do it before any resize so the filter cannot blend it back.
		for (FColor& Pixel : Bitmap)
		{
			Pixel.A = 255;
		}

		const int32 LongestEdge = FMath::Max(SrcWidth, SrcHeight);
		TArray<FColor> Resized;
		const FColor* FinalPixels = Bitmap.GetData();
		OutWidth = SrcWidth;
		OutHeight = SrcHeight;

		if (LongestEdge > MaxSize)
		{
			const float Scale = (float)MaxSize / (float)LongestEdge;
			OutWidth = FMath::Max(1, FMath::RoundToInt(SrcWidth * Scale));
			OutHeight = FMath::Max(1, FMath::RoundToInt(SrcHeight * Scale));
			Resized.SetNumUninitialized(OutWidth * OutHeight);
			FImageUtils::ImageResize(
				SrcWidth, SrcHeight, Bitmap,
				OutWidth, OutHeight, Resized,
				/*bResizeSRGBinLinearSpace=*/false, /*bForceOpaqueOutput=*/true);
			FinalPixels = Resized.GetData();
		}

		const int32 PixelCount = OutWidth * OutHeight;
		const TArrayView64<const FColor> View(FinalPixels, PixelCount);

		// Fingerprint the pixels actually about to be sent. This catches "the mutation ran but
		// changed nothing visible", which no amount of scene-state hashing can tell you.
		const uint32 PixelCrc = FCrc::MemCrc32(FinalPixels, PixelCount * sizeof(FColor));
		OutDigest = FString::Printf(TEXT("%dx%d-%08x"), OutWidth, OutHeight, PixelCrc);

		TArray64<uint8> PngData;
		FImageUtils::PNGCompressImageArray(OutWidth, OutHeight, View, PngData);
		if (PngData.Num() == 0)
		{
			return false;
		}

		OutBytes = PngData.Num();

		// FBase64::Encode takes a uint32 length. A 2048px frame is ~2 MB at worst so this cannot
		// realistically trip, but a silent truncation here is exactly the class of bug that stays
		// invisible until it isn't.
		if (PngData.Num() > (int64)MAX_uint32)
		{
			return false;
		}

		OutBase64 = FBase64::Encode(PngData.GetData(), (uint32)PngData.Num());
		return !OutBase64.IsEmpty();
	}
}

FString FBlueprintMCPServer::HandleViewportCapture(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	const double StartTime = FPlatformTime::Seconds();

	FString Target = TEXT("level");
	Json->TryGetStringField(TEXT("target"), Target);
	Target = Target.ToLower();

	int32 MaxSize = 512;
	Json->TryGetNumberField(TEXT("maxSize"), MaxSize);
	MaxSize = FMath::Clamp(MaxSize, MinCaptureSize, MaxCaptureSize);

	FString SinceDigest;
	Json->TryGetStringField(TEXT("sinceDigest"), SinceDigest);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: viewport_capture(target='%s', maxSize=%d)"), *Target, MaxSize);

	// CLAUDE-NOTE: the commandlet is spawned with -nullrhi (see Tools/src/ue-bridge.ts), meaning no
	// render device at all: no viewport, no render target, no Slate renderer. This is the direct
	// analogue of Blender's background mode. Name the reason and the fix — a bare "no viewport
	// found" sends people hunting for a viewport that structurally cannot exist in that process.
	if (!bIsEditor || !FApp::CanEverRender())
	{
		return MakeErrorJson(
			TEXT("No render device: the BlueprintMCP backend is running as a headless commandlet ")
			TEXT("(-nullrhi), which has no viewport, render target, or Slate renderer. Open the ")
			TEXT("project in the UE5 editor — the editor subsystem takes over port 9847 ")
			TEXT("automatically — and retry."),
			MCPErrorCodes::OperationFailed);
	}

	if (!GEditor)
	{
		return MakeErrorJson(TEXT("Editor not available."), MCPErrorCodes::OperationFailed);
	}

	TArray<FColor> Bitmap;
	int32 SrcWidth = 0;
	int32 SrcHeight = 0;
	FString Method;

	if (Target == TEXT("graph"))
	{
		FString BlueprintName;
		FString GraphName;
		Json->TryGetStringField(TEXT("blueprint"), BlueprintName);
		Json->TryGetStringField(TEXT("graph"), GraphName);
		if (BlueprintName.IsEmpty() || GraphName.IsEmpty())
		{
			return MakeErrorJson(
				TEXT("target='graph' requires both 'blueprint' and 'graph'."),
				MCPErrorCodes::InvalidInput);
		}

		FString LoadError;
		UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
		if (!BP)
		{
			return MakeErrorJson(LoadError, MCPErrorCodes::NotFound);
		}

		TArray<UEdGraph*> AllGraphs;
		BP->GetAllGraphs(AllGraphs);
		UEdGraph* TargetGraph = nullptr;
		for (UEdGraph* Graph : AllGraphs)
		{
			if (Graph && Graph->GetName().Equals(GraphName, ESearchCase::IgnoreCase))
			{
				TargetGraph = Graph;
				break;
			}
		}
		if (!TargetGraph)
		{
			return MakeErrorJson(
				FString::Printf(TEXT("Graph '%s' not found in Blueprint '%s'"), *GraphName, *BlueprintName),
				MCPErrorCodes::NotFound);
		}

		// CLAUDE-NOTE: render the graph directly at the requested size instead of rendering large
		// and downscaling. Node text stops being legible below ~1024px wide, so a graph frame is
		// inherently more expensive than a level frame (~1000 tokens vs ~150) — rendering at target
		// size at least avoids paying for pixels that get thrown away. 4:3 matches the existing
		// screenshot_graph default aspect.
		SrcWidth = MaxSize;
		SrcHeight = FMath::Max(MinCaptureSize, (MaxSize * 3) / 4);
		Json->TryGetNumberField(TEXT("width"), SrcWidth);
		Json->TryGetNumberField(TEXT("height"), SrcHeight);
		SrcWidth = FMath::Clamp(SrcWidth, MinCaptureSize, MaxCaptureSize);
		SrcHeight = FMath::Clamp(SrcHeight, MinCaptureSize, MaxCaptureSize);

		bool bRenderSuccess = false;
		const int32 SEHCode = TryRenderGraphToBitmapSEH(TargetGraph, SrcWidth, SrcHeight, &Bitmap, &bRenderSuccess);
		if (SEHCode != 0)
		{
			return MakeErrorJson(
				TEXT("viewport_capture crashed while rendering the graph (SEH exception caught)."),
				MCPErrorCodes::OperationFailed);
		}
		if (!bRenderSuccess)
		{
			return MakeErrorJson(TEXT("Failed to render the graph to an image."), MCPErrorCodes::OperationFailed);
		}
		Method = TEXT("SGraphEditor/FWidgetRenderer");
	}
	else if (Target == TEXT("level") || Target == TEXT("pie"))
	{
		FViewport* Viewport = nullptr;

		if (Target == TEXT("pie"))
		{
			if (!GEditor->PlayWorld || !GEngine || !GEngine->GameViewport || !GEngine->GameViewport->Viewport)
			{
				return MakeErrorJson(
					TEXT("target='pie' requires a running PIE session. Start one with start_pie, or ")
					TEXT("use target='level' to capture the editor viewport instead."),
					MCPErrorCodes::OperationFailed);
			}
			Viewport = GEngine->GameViewport->Viewport;
			Method = TEXT("FViewport::ReadPixels (PIE)");
		}
		else
		{
			FLevelEditorViewportClient* ViewportClient =
				GEditor->GetLevelViewportClients().Num() > 0 ? GEditor->GetLevelViewportClients()[0] : nullptr;
			if (!ViewportClient || !ViewportClient->Viewport)
			{
				return MakeErrorJson(
					TEXT("No level editor viewport is open. Open a Level Editor viewport tab, or use ")
					TEXT("target='graph' to capture a Blueprint graph without one."),
					MCPErrorCodes::OperationFailed);
			}
			Viewport = ViewportClient->Viewport;

			// CLAUDE-NOTE: the editor viewport only redraws when something invalidates it. With
			// realtime rendering off (the default for an idle editor) ReadPixels hands back
			// whatever was last drawn — so a capture taken right after spawn_actor can show the
			// pre-spawn frame, and the agent concludes its edit silently failed. Force a redraw
			// first. This is the most confusing failure mode in the feature and it is invisible in
			// a realtime-enabled editor, which is exactly how it survives testing.
			ViewportClient->Invalidate();
			Viewport->Draw();

			Method = TEXT("FViewport::ReadPixels (level)");
		}

		SrcWidth = Viewport->GetSizeXY().X;
		SrcHeight = Viewport->GetSizeXY().Y;
		if (SrcWidth <= 0 || SrcHeight <= 0)
		{
			return MakeErrorJson(TEXT("Viewport has invalid dimensions."), MCPErrorCodes::OperationFailed);
		}

		if (!Viewport->ReadPixels(Bitmap) || Bitmap.Num() == 0)
		{
			return MakeErrorJson(TEXT("Failed to read pixels from viewport."), MCPErrorCodes::OperationFailed);
		}
	}
	else
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Unknown target '%s'. Expected 'level', 'pie', or 'graph'."), *Target),
			MCPErrorCodes::InvalidInput);
	}

	FString ImageBase64;
	FString Digest;
	int32 OutWidth = 0;
	int32 OutHeight = 0;
	int64 PngBytes = 0;
	if (!EncodeFrame(Bitmap, SrcWidth, SrcHeight, MaxSize, ImageBase64, Digest, OutWidth, OutHeight, PngBytes))
	{
		return MakeErrorJson(TEXT("Failed to encode the captured frame to PNG."), MCPErrorCodes::OperationFailed);
	}

	const double ElapsedMs = (FPlatformTime::Seconds() - StartTime) * 1000.0;

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("target"), Target);
	Result->SetStringField(TEXT("method"), Method);
	Result->SetStringField(TEXT("digest"), Digest);
	Result->SetNumberField(TEXT("width"), OutWidth);
	Result->SetNumberField(TEXT("height"), OutHeight);
	Result->SetNumberField(TEXT("nativeWidth"), SrcWidth);
	Result->SetNumberField(TEXT("nativeHeight"), SrcHeight);
	Result->SetNumberField(TEXT("elapsedMs"), FMath::RoundToInt(ElapsedMs));

	// Pixel-identical to what the caller already has: skip the payload, keep the metadata. Saves
	// the tokens, not the game-thread stall — the frame had to be rendered to know this.
	if (!SinceDigest.IsEmpty() && SinceDigest == Digest)
	{
		Result->SetBoolField(TEXT("unchanged"), true);
		Result->SetNumberField(TEXT("bytes"), 0);
		UE_LOG(LogTemp, Verbose, TEXT("BlueprintMCP: viewport_capture unchanged (digest %s), payload suppressed."), *Digest);
		return JsonToString(Result);
	}

	Result->SetBoolField(TEXT("unchanged"), false);
	Result->SetNumberField(TEXT("bytes"), (double)PngBytes);
	Result->SetStringField(TEXT("mimeType"), TEXT("image/png"));
	Result->SetStringField(TEXT("imageBase64"), ImageBase64);

	bool bSaveToDisk = false;
	Json->TryGetBoolField(TEXT("saveToDisk"), bSaveToDisk);
	if (bSaveToDisk)
	{
		FString Filename;
		if (!Json->TryGetStringField(TEXT("filename"), Filename) || Filename.IsEmpty())
		{
			Filename = FString::Printf(TEXT("Capture_%s_%s"), *Target, *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")));
		}
		if (!Filename.EndsWith(TEXT(".png")))
		{
			Filename += TEXT(".png");
		}

		const FString OutputDir = FPaths::ProjectSavedDir() / TEXT("Screenshots");
		const FString FullPath = OutputDir / Filename;

		TArray<uint8> DecodedPng;
		if (FBase64::Decode(ImageBase64, DecodedPng))
		{
			FPlatformFileManager::Get().GetPlatformFile().CreateDirectoryTree(*OutputDir);
			if (FFileHelper::SaveArrayToFile(DecodedPng, *FullPath))
			{
				Result->SetStringField(TEXT("filename"), Filename);
				Result->SetStringField(TEXT("fullPath"), FullPath);
			}
		}
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: viewport_capture target='%s' %dx%d (%lld B PNG) in %.0f ms"),
		*Target, OutWidth, OutHeight, PngBytes, ElapsedMs);

	return JsonToString(Result);
}

// ============================================================
// HandleSceneDigest — cheap "did anything change" fingerprint
// ============================================================
// CLAUDE-NOTE: deliberately coarse, and deliberately NOT a transform hash. Hashing every actor's
// transform is O(actors) per call and gets genuinely expensive on a large level — which defeats
// the point, since the digest exists to cost less than the capture it avoids. Level counts come
// from ULevel::Actors.Num() (O(levels), not O(actors)); the exact "did the picture change"
// question is answered instead by the pixel CRC in viewport_capture's response, which is precise
// and costs nothing extra because the frame was rendered anyway.

FString FBlueprintMCPServer::HandleSceneDigest(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body."), MCPErrorCodes::InvalidInput);
	}

	FString Scope = TEXT("level");
	Json->TryGetStringField(TEXT("scope"), Scope);
	Scope = Scope.ToLower();

	if (!bIsEditor || !GEditor)
	{
		return MakeErrorJson(TEXT("scene_digest requires editor mode."), MCPErrorCodes::OperationFailed);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("scope"), Scope);

	if (Scope == TEXT("graph"))
	{
		FString BlueprintName;
		FString GraphName;
		Json->TryGetStringField(TEXT("blueprint"), BlueprintName);
		Json->TryGetStringField(TEXT("graph"), GraphName);
		if (BlueprintName.IsEmpty() || GraphName.IsEmpty())
		{
			return MakeErrorJson(
				TEXT("scope='graph' requires both 'blueprint' and 'graph'."),
				MCPErrorCodes::InvalidInput);
		}

		FString LoadError;
		UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
		if (!BP)
		{
			return MakeErrorJson(LoadError, MCPErrorCodes::NotFound);
		}

		TArray<UEdGraph*> AllGraphs;
		BP->GetAllGraphs(AllGraphs);
		UEdGraph* TargetGraph = nullptr;
		for (UEdGraph* Graph : AllGraphs)
		{
			if (Graph && Graph->GetName().Equals(GraphName, ESearchCase::IgnoreCase))
			{
				TargetGraph = Graph;
				break;
			}
		}
		if (!TargetGraph)
		{
			return MakeErrorJson(
				FString::Printf(TEXT("Graph '%s' not found in Blueprint '%s'"), *GraphName, *BlueprintName),
				MCPErrorCodes::NotFound);
		}

		// Graphs are tens of nodes, not thousands of actors — a full structural hash is genuinely
		// cheap here, unlike the level case.
		FString Material;
		int32 LinkCount = 0;
		for (UEdGraphNode* Node : TargetGraph->Nodes)
		{
			if (!Node) continue;
			Material += Node->NodeGuid.ToString();
			Material += FString::Printf(TEXT(":%d,%d;"), Node->NodePosX, Node->NodePosY);
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin) continue;
				for (UEdGraphPin* Linked : Pin->LinkedTo)
				{
					if (!Linked || !Linked->GetOwningNodeUnchecked()) continue;
					Material += Pin->PinName.ToString();
					Material += TEXT(">");
					Material += Linked->GetOwningNodeUnchecked()->NodeGuid.ToString();
					Material += TEXT("|");
					++LinkCount;
				}
			}
		}

		const uint32 GraphCrc = FCrc::StrCrc32(*Material);
		Result->SetStringField(TEXT("digest"),
			FString::Printf(TEXT("g-%d-%d-%08x"), TargetGraph->Nodes.Num(), LinkCount, GraphCrc));
		Result->SetStringField(TEXT("blueprint"), BlueprintName);
		Result->SetStringField(TEXT("graph"), GraphName);
		Result->SetNumberField(TEXT("nodeCount"), TargetGraph->Nodes.Num());
		Result->SetNumberField(TEXT("linkCount"), LinkCount);
		return JsonToString(Result);
	}

	if (Scope != TEXT("level"))
	{
		return MakeErrorJson(
			FString::Printf(TEXT("Unknown scope '%s'. Expected 'level' or 'graph'."), *Scope),
			MCPErrorCodes::InvalidInput);
	}

	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (!World)
	{
		return MakeErrorJson(TEXT("No editor world available."), MCPErrorCodes::OperationFailed);
	}

	const FString LevelName = World->GetMapName();

	int32 ActorCount = 0;
	for (ULevel* Level : World->GetLevels())
	{
		if (Level)
		{
			ActorCount += Level->Actors.Num();
		}
	}

	TArray<FString> SelectedNames;
	if (USelection* Selection = GEditor->GetSelectedActors())
	{
		for (FSelectionIterator It(*Selection); It; ++It)
		{
			if (AActor* Actor = Cast<AActor>(*It))
			{
				SelectedNames.Add(Actor->GetActorNameOrLabel());
			}
		}
	}
	SelectedNames.Sort();

	TArray<UPackage*> DirtyPackages;
	FEditorFileUtils::GetDirtyPackages(DirtyPackages);
	TArray<FString> DirtyNames;
	for (UPackage* Package : DirtyPackages)
	{
		if (Package)
		{
			DirtyNames.Add(Package->GetName());
		}
	}
	DirtyNames.Sort();

	const bool bPieRunning = GEditor->PlayWorld != nullptr;

	const FString Material = FString::Printf(
		TEXT("%s|%d|%s|%s|%d"),
		*LevelName, ActorCount,
		*FString::Join(SelectedNames, TEXT(",")),
		*FString::Join(DirtyNames, TEXT(",")),
		bPieRunning ? 1 : 0);

	const uint32 LevelCrc = FCrc::StrCrc32(*Material);

	Result->SetStringField(TEXT("digest"), FString::Printf(TEXT("l-%d-%08x"), ActorCount, LevelCrc));
	Result->SetStringField(TEXT("level"), LevelName);
	Result->SetNumberField(TEXT("actorCount"), ActorCount);
	Result->SetNumberField(TEXT("selectedCount"), SelectedNames.Num());
	Result->SetNumberField(TEXT("dirtyPackageCount"), DirtyNames.Num());
	Result->SetBoolField(TEXT("pieRunning"), bPieRunning);

	return JsonToString(Result);
}
