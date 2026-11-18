#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "BlueprintMCPLandscapeLibrary.generated.h"

class ALandscape;

/**
 * Landscape heightmap I/O that works with Edit Layers, callable from Python and Blueprints.
 *
 * CLAUDE-NOTE (2026-11-18): exists so editor-side Python (Content/Python/blueprintmcp_carve.py) can
 * write terrain synchronously on the game thread. Python cannot call this plugin's own HTTP routes
 * from inside the editor: a request queued for the game thread while Python is already running on it
 * deadlocks. The HTTP handlers (/api/landscape-*-heightmap) are thin wrappers over these functions.
 *
 * Data format: raw little-endian uint16 (.r16), one value per landscape vertex, row-major, rows +Y.
 * All functions return a JSON object string with "success" or "error".
 */
UCLASS()
class BLUEPRINTMCP_API UBlueprintMCPLandscapeLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Write an edit layer's heights to a .r16 file. Empty Layer = layer 0 (base). */
	UFUNCTION(BlueprintCallable, Category = "BlueprintMCP|Landscape")
	static FString ExportLandscapeHeightmap(ALandscape* Landscape, const FString& File, const FString& Layer);

	/** Overwrite an edit layer's heights from a .r16 file (optionally backing the old heights up first). */
	UFUNCTION(BlueprintCallable, Category = "BlueprintMCP|Landscape")
	static FString ImportLandscapeHeightmap(ALandscape* Landscape, const FString& File, const FString& Layer, const FString& BackupFile, bool bDryRun = false);

	/** The single landscape in the editor world, or the one whose label matches. Null if none/ambiguous. */
	UFUNCTION(BlueprintCallable, Category = "BlueprintMCP|Landscape")
	static ALandscape* FindEditorLandscape(const FString& Label);
};
