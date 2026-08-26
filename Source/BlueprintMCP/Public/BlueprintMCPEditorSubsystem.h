#pragma once

#include "CoreMinimal.h"
#include "EditorSubsystem.h"
#include "Tickable.h"
#include "BlueprintMCPServer.h"
#include "BlueprintMCPEditorSubsystem.generated.h"

/**
 * Editor subsystem that hosts the Blueprint MCP HTTP server inside the running
 * UE5 editor. When active, the MCP TypeScript wrapper connects instantly
 * (no commandlet spawn, no extra RAM).
 *
 * Requests are dequeued and processed on the editor's game thread via
 * FTickableEditorObject::Tick().
 */
UCLASS()
class UBlueprintMCPEditorSubsystem : public UEditorSubsystem, public FTickableEditorObject
{
	GENERATED_BODY()

public:
	// UEditorSubsystem
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	// FTickableEditorObject
	virtual void Tick(float DeltaTime) override;
	virtual bool IsTickable() const override;
	virtual TStatId GetStatId() const override;

private:
	void HandleAssetRegistryReady();

	/** Create the server and attempt the port bind (+ deferred asset-registry rescan hookup).
	 *  Safe to call repeatedly; on failure the server is torn down and retry state armed. */
	void StartServer();

	/** Console command target: stop the server if running, then attempt a fresh start. */
	void RestartServer();

	TUniquePtr<FBlueprintMCPServer> Server;
	FDelegateHandle OnFilesLoadedHandle;

	// CLAUDE-NOTE (2026-08-26): the bind used to be one-shot — a zombie editor squatting 9847 at
	// startup killed MCP for the whole session even after the port freed seconds later
	// (docs/KNOWN-ISSUE-port-bind-no-retry.md). Tick now retries a failed bind every
	// RetryIntervalSeconds, and BlueprintMCP.Restart recovers in-session on demand.
	bool bBindFailed = false;
	float RetrySecondsRemaining = 0.0f;
	int32 RetryAttempts = 0;
	static constexpr float RetryIntervalSeconds = 15.0f;

	IConsoleCommand* RestartConsoleCommand = nullptr;
};
