#include "BlueprintMCPEditorSubsystem.h"
#include "BlueprintMCPServer.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "HAL/IConsoleManager.h"

void UBlueprintMCPEditorSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	// Don't start in commandlet mode — the commandlet has its own server instance.
	if (IsRunningCommandlet())
	{
		return;
	}

	RestartConsoleCommand = IConsoleManager::Get().RegisterConsoleCommand(
		TEXT("BlueprintMCP.Restart"),
		TEXT("Stop the BlueprintMCP HTTP server (if running) and attempt a fresh bind on port 9847."),
		FConsoleCommandDelegate::CreateUObject(this, &UBlueprintMCPEditorSubsystem::RestartServer),
		ECVF_Default);

	StartServer();
}

void UBlueprintMCPEditorSubsystem::StartServer()
{
	Server = MakeUnique<FBlueprintMCPServer>();
	if (Server->Start(9847, /*bEditorMode=*/true))
	{
		bBindFailed = false;
		RetryAttempts = 0;
		UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Editor subsystem started — MCP server on port %d"), Server->GetPort());

		// Asset Registry loads asynchronously during editor startup.
		// The initial scan in Start() only sees engine assets.
		// Defer a full rescan until the registry finishes gathering.
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		IAssetRegistry& AR = ARM.Get();

		if (AR.IsGathering())
		{
			OnFilesLoadedHandle = AR.OnFilesLoaded().AddUObject(
				this, &UBlueprintMCPEditorSubsystem::HandleAssetRegistryReady);
		}
	}
	else
	{
		Server.Reset();
		bBindFailed = true;
		RetrySecondsRemaining = RetryIntervalSeconds;
		// First failure is a Warning; retry chatter drops to Verbose so a long-squatted port
		// doesn't spam the log.
		if (RetryAttempts == 0)
		{
			UE_LOG(LogTemp, Warning, TEXT("BlueprintMCP: port bind failed (port in use?) — will retry every %.0fs. Run 'BlueprintMCP.Restart' to retry now."), RetryIntervalSeconds);
		}
		else
		{
			UE_LOG(LogTemp, Verbose, TEXT("BlueprintMCP: bind retry %d failed — next attempt in %.0fs."), RetryAttempts, RetryIntervalSeconds);
		}
		++RetryAttempts;
	}
}

void UBlueprintMCPEditorSubsystem::RestartServer()
{
	if (IsRunningCommandlet())
	{
		return;
	}
	if (Server)
	{
		Server->Stop();
		Server.Reset();
		UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: server stopped for restart."));
	}
	StartServer();
}

void UBlueprintMCPEditorSubsystem::HandleAssetRegistryReady()
{
	if (OnFilesLoadedHandle.IsValid())
	{
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		ARM.Get().OnFilesLoaded().Remove(OnFilesLoadedHandle);
		OnFilesLoadedHandle.Reset();
	}

	if (Server && Server->IsRunning())
	{
		Server->HandleRescan();
		UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Deferred rescan complete after Asset Registry finished gathering."));
	}
}

void UBlueprintMCPEditorSubsystem::Deinitialize()
{
	if (RestartConsoleCommand)
	{
		IConsoleManager::Get().UnregisterConsoleObject(RestartConsoleCommand);
		RestartConsoleCommand = nullptr;
	}

	if (OnFilesLoadedHandle.IsValid() && FModuleManager::Get().IsModuleLoaded("AssetRegistry"))
	{
		FAssetRegistryModule& ARM = FModuleManager::GetModuleChecked<FAssetRegistryModule>("AssetRegistry");
		ARM.Get().OnFilesLoaded().Remove(OnFilesLoadedHandle);
		OnFilesLoadedHandle.Reset();
	}

	if (Server)
	{
		Server->Stop();
		Server.Reset();
		UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Editor subsystem stopped."));
	}

	Super::Deinitialize();
}

void UBlueprintMCPEditorSubsystem::Tick(float DeltaTime)
{
	if (Server)
	{
		Server->ProcessOneRequest();
	}
	else if (bBindFailed)
	{
		RetrySecondsRemaining -= DeltaTime;
		if (RetrySecondsRemaining <= 0.0f)
		{
			StartServer();
		}
	}
}

bool UBlueprintMCPEditorSubsystem::IsTickable() const
{
	// Must stay tickable while the bind is failed so the retry timer can run.
	return (Server.IsValid() && Server->IsRunning()) || bBindFailed;
}

TStatId UBlueprintMCPEditorSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UBlueprintMCPEditorSubsystem, STATGROUP_Tickables);
}
