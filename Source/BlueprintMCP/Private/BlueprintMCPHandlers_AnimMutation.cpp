#include "BlueprintMCPServer.h"
#include "Engine/Blueprint.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "UObject/SavePackage.h"

// Animation Blueprint includes
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimBlueprintGeneratedClass.h"
#include "Animation/Skeleton.h"
#include "AnimGraphNode_StateMachine.h"
#include "AnimGraphNode_AssetPlayerBase.h"
#include "AnimGraphNode_SequencePlayer.h"
#include "AnimGraphNode_BlendSpacePlayer.h"
#include "AnimGraphNode_Base.h"
#include "AnimStateNode.h"
#include "AnimStateTransitionNode.h"
#include "AnimStateConduitNode.h"
#include "AnimStateEntryNode.h"
#include "AnimationStateMachineGraph.h"
#include "AnimationStateMachineSchema.h"
#include "AnimationGraph.h"
#include "AnimationGraphSchema.h"
#include "AnimationTransitionGraph.h"
#include "Animation/AnimSequence.h"
#include "Animation/BlendSpace.h"
#include "K2Node_VariableGet.h"
#include "AnimGraphNode_Slot.h"
#include "AnimGraphNode_PoseBlendNode.h"
#include "Animation/PoseAsset.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Misc/PackageName.h"

// CLAUDE-NOTE (2026-10-22): MCP audit item 8 (targets/unreal/work/mcp_audit.md in ReverseEngineerMCP). The handlers
// below used to (a) silently skip an animation asset that did not resolve and still report success, (b) never check
// that the asset's skeleton matched the ABP's, and (c) compile without looking at the result. ResolveAnimAsset fails
// loudly BEFORE anything is created (object path, package path or unique asset name), and every compile site goes
// through CompileAnimBPChecked so a compile error comes back as success:false with the compiler's messages.
namespace
{
	template <typename T>
	T* ResolveAnimAsset(const FString& Name, const USkeleton* TargetSkeleton, FString& OutError)
	{
		T* Asset = nullptr;
		if (Name.StartsWith(TEXT("/")))
		{
			FString Path = Name;
			if (!Path.Contains(TEXT(".")))
			{
				Path = Path + TEXT(".") + FPackageName::GetShortName(Path);
			}
			Asset = LoadObject<T>(nullptr, *Path);
		}
		if (!Asset)
		{
			FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
			TArray<FAssetData> Assets;
			ARM.Get().GetAssetsByClass(T::StaticClass()->GetClassPathName(), Assets, true);
			TArray<FAssetData> Hits;
			for (const FAssetData& A : Assets)
			{
				if (A.AssetName.ToString() == Name || A.PackageName.ToString() == Name)
				{
					Hits.Add(A);
				}
			}
			if (Hits.Num() > 1)
			{
				FString List;
				for (const FAssetData& H : Hits)
				{
					List += (List.IsEmpty() ? TEXT("") : TEXT(", ")) + H.PackageName.ToString();
				}
				OutError = FString::Printf(TEXT("%s name '%s' is ambiguous (%s) - pass the object path"),
					*T::StaticClass()->GetName(), *Name, *List);
				return nullptr;
			}
			if (Hits.Num() == 1)
			{
				Asset = Cast<T>(Hits[0].GetAsset());
			}
		}
		if (!Asset)
		{
			OutError = FString::Printf(TEXT("%s '%s' not found (nothing was changed; pass the object path, e.g. /Game/Anims/MM_Idle)"),
				*T::StaticClass()->GetName(), *Name);
			return nullptr;
		}
		const USkeleton* AssetSkeleton = Asset->GetSkeleton();
		if (TargetSkeleton && AssetSkeleton && AssetSkeleton != TargetSkeleton && !TargetSkeleton->IsCompatibleForEditor(AssetSkeleton))
		{
			OutError = FString::Printf(TEXT("'%s' uses skeleton '%s' but the Animation Blueprint targets '%s' (nothing was changed)"),
				*Asset->GetPathName(), *AssetSkeleton->GetPathName(), *TargetSkeleton->GetPathName());
			return nullptr;
		}
		return Asset;
	}

	// Walk a dotted property path from an object (descending into struct properties) and import a text value
	// (UE property text, e.g. hand_r, (X=1,Y=2,Z=3), True); returns the exported value read back.
	bool SetPropertyByPath(UObject* Obj, const FString& Path, const FString& Value, FString& OutReadback, FString& OutError)
	{
		TArray<FString> Parts;
		Path.ParseIntoArray(Parts, TEXT("."));
		UStruct* Struct = Obj->GetClass();
		void* Container = Obj;
		for (int32 i = 0; i < Parts.Num(); ++i)
		{
			FProperty* Prop = FindFProperty<FProperty>(Struct, FName(*Parts[i]));
			if (!Prop)
			{
				OutError = FString::Printf(TEXT("'%s': no property '%s' on %s"), *Path, *Parts[i], *Struct->GetName());
				return false;
			}
			void* Ptr = Prop->ContainerPtrToValuePtr<void>(Container);
			if (i + 1 < Parts.Num())
			{
				FStructProperty* SP = CastField<FStructProperty>(Prop);
				if (!SP)
				{
					OutError = FString::Printf(TEXT("'%s': '%s' is not a struct"), *Path, *Parts[i]);
					return false;
				}
				Struct = SP->Struct;
				Container = Ptr;
				continue;
			}
			if (!Prop->ImportText_Direct(*Value, Ptr, Obj, PPF_None))
			{
				OutError = FString::Printf(TEXT("'%s': could not import '%s' into a %s"), *Path, *Value, *Prop->GetCPPType());
				return false;
			}
			OutReadback.Reset();
			Prop->ExportTextItem_Direct(OutReadback, Ptr, nullptr, Obj, PPF_None);
		}
		return true;
	}

	bool ApplyNodeProperties(UObject* Node, const TSharedPtr<FJsonObject>& Props, const TSharedRef<FJsonObject>& OutReadbacks, FString& OutError)
	{
		Node->Modify();
		for (const auto& KV : Props->Values)
		{
			FString Value;
			if (!KV.Value->TryGetString(Value))
			{
				double D;
				bool B;
				if (KV.Value->TryGetNumber(D)) Value = FString::SanitizeFloat(D);
				else if (KV.Value->TryGetBool(B)) Value = B ? TEXT("True") : TEXT("False");
				else { OutError = KV.Key + TEXT(": value must be a string, number or bool"); return false; }
			}
			FString Back;
			if (!SetPropertyByPath(Node, KV.Key, Value, Back, OutError)) return false;
			OutReadbacks->SetStringField(KV.Key, Back);
		}
		return true;
	}

	TArray<TSharedPtr<FJsonValue>> PinsJson(UEdGraphNode* Node)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (!Pin || Pin->bHidden) continue;
			TSharedRef<FJsonObject> P = MakeShared<FJsonObject>();
			P->SetStringField(TEXT("name"), Pin->PinName.ToString());
			P->SetStringField(TEXT("dir"), Pin->Direction == EGPD_Input ? TEXT("in") : TEXT("out"));
			P->SetStringField(TEXT("type"), Pin->PinType.PinCategory.ToString());
			Out.Add(MakeShared<FJsonValueObject>(P));
		}
		return Out;
	}

	bool CompileAnimBPChecked(UBlueprint* BP, TArray<FString>& OutErrors)
	{
		FCompilerResultsLog Log;
		Log.bSilentMode = true;
		FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &Log);
		for (const TSharedRef<FTokenizedMessage>& Msg : Log.Messages)
		{
			if (Msg->GetSeverity() == EMessageSeverity::Error)
			{
				OutErrors.Add(Msg->ToText().ToString());
			}
		}
		return BP->Status != BS_Error && OutErrors.Num() == 0;
	}

	void SetCompileResult(const TSharedRef<FJsonObject>& Result, bool bOk, const TArray<FString>& Errors)
	{
		Result->SetBoolField(TEXT("success"), bOk);
		Result->SetBoolField(TEXT("compiled"), bOk);
		if (!bOk)
		{
			TArray<TSharedPtr<FJsonValue>> Arr;
			for (const FString& E : Errors)
			{
				Arr.Add(MakeShared<FJsonValueString>(E));
			}
			Result->SetArrayField(TEXT("compileErrors"), Arr);
			Result->SetStringField(TEXT("error"), FString::Printf(
				TEXT("Animation Blueprint compiled with errors (the change was saved): %s"),
				Errors.Num() ? *Errors[0] : TEXT("status BS_Error")));
		}
	}
}

// ============================================================
// HandleCreateAnimBlueprint — create a new Animation Blueprint
// ============================================================

FString FBlueprintMCPServer::HandleCreateAnimBlueprint(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString Name = Json->GetStringField(TEXT("name"));
	FString PackagePath = Json->GetStringField(TEXT("packagePath"));
	FString SkeletonName = Json->GetStringField(TEXT("skeleton"));
	FString ParentClassName = Json->GetStringField(TEXT("parentClass"));

	if (Name.IsEmpty() || PackagePath.IsEmpty() || SkeletonName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: name, packagePath, skeleton"));
	}

	if (!PackagePath.StartsWith(TEXT("/Game")))
	{
		return MakeErrorJson(TEXT("packagePath must start with '/Game'"));
	}

	// Check if asset already exists
	FString FullAssetPath = PackagePath / Name;
	if (FindBlueprintAsset(Name) || FindBlueprintAsset(FullAssetPath))
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Blueprint '%s' already exists. Use a different name or delete the existing asset first."),
			*Name));
	}

	// Resolve skeleton
	USkeleton* Skeleton = nullptr;

	if (SkeletonName == TEXT("__create_test_skeleton__"))
	{
		// Create a minimal in-memory skeleton for tests
		FString TestSkeletonPath = PackagePath / (Name + TEXT("_TestSkeleton"));
		UPackage* SkelPackage = CreatePackage(*TestSkeletonPath);
		Skeleton = NewObject<USkeleton>(SkelPackage, FName(*(Name + TEXT("_TestSkeleton"))), RF_Public | RF_Standalone);
		if (Skeleton)
		{
			Skeleton->MarkPackageDirty();
			UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created test skeleton '%s'"), *Skeleton->GetName());
		}
	}
	else
	{
		// Search asset registry for the skeleton
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		TArray<FAssetData> SkeletonAssets;
		ARM.Get().GetAssetsByClass(USkeleton::StaticClass()->GetClassPathName(), SkeletonAssets, false);

		for (const FAssetData& Asset : SkeletonAssets)
		{
			if (Asset.AssetName.ToString() == SkeletonName ||
				Asset.PackageName.ToString() == SkeletonName ||
				Asset.GetObjectPathString() == SkeletonName)
			{
				Skeleton = Cast<USkeleton>(Asset.GetAsset());
				break;
			}
		}

		// Case-insensitive fallback
		if (!Skeleton)
		{
			for (const FAssetData& Asset : SkeletonAssets)
			{
				if (Asset.AssetName.ToString().Equals(SkeletonName, ESearchCase::IgnoreCase) ||
					Asset.PackageName.ToString().Equals(SkeletonName, ESearchCase::IgnoreCase))
				{
					Skeleton = Cast<USkeleton>(Asset.GetAsset());
					break;
				}
			}
		}
	}

	if (!Skeleton)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Skeleton '%s' not found. Provide the skeleton asset name or path. Use '__create_test_skeleton__' for testing."),
			*SkeletonName));
	}

	// Resolve parent class (default: UAnimInstance)
	UClass* ParentClass = UAnimInstance::StaticClass();
	if (!ParentClassName.IsEmpty() && ParentClassName != TEXT("AnimInstance"))
	{
		for (TObjectIterator<UClass> It; It; ++It)
		{
			if (It->GetName() == ParentClassName && It->IsChildOf(UAnimInstance::StaticClass()))
			{
				ParentClass = *It;
				break;
			}
		}
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Creating AnimBlueprint '%s' in '%s' with skeleton '%s'"),
		*Name, *PackagePath, *Skeleton->GetName());

	// Create the package
	FString FullPackagePath = PackagePath / Name;
	UPackage* Package = CreatePackage(*FullPackagePath);
	if (!Package)
	{
		return MakeErrorJson(FString::Printf(TEXT("Failed to create package at '%s'"), *FullPackagePath));
	}

	// Create the Animation Blueprint
	UAnimBlueprint* NewAnimBP = CastChecked<UAnimBlueprint>(
		FKismetEditorUtilities::CreateBlueprint(
			ParentClass,
			Package,
			FName(*Name),
			BPTYPE_Normal,
			UAnimBlueprint::StaticClass(),
			UAnimBlueprintGeneratedClass::StaticClass()
		));

	if (!NewAnimBP)
	{
		return MakeErrorJson(TEXT("FKismetEditorUtilities::CreateBlueprint returned null for AnimBlueprint"));
	}

	// Set target skeleton
	NewAnimBP->TargetSkeleton = Skeleton;

	// Compile
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(NewAnimBP, CompileErrors);

	// Save
	bool bSaved = SaveBlueprintPackage(NewAnimBP);

	// Refresh asset cache
	FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	AllBlueprintAssets.Empty();
	ARM.Get().GetAssetsByClass(UBlueprint::StaticClass()->GetClassPathName(), AllBlueprintAssets, true);

	// Collect graph names
	TArray<TSharedPtr<FJsonValue>> GraphNames;
	TArray<UEdGraph*> AllGraphs;
	NewAnimBP->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		if (Graph)
		{
			GraphNames.Add(MakeShared<FJsonValueString>(Graph->GetName()));
		}
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created AnimBlueprint '%s' with %d graphs (saved: %s)"),
		*Name, GraphNames.Num(), bSaved ? TEXT("true") : TEXT("false"));

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("blueprintName"), Name);
	Result->SetStringField(TEXT("packagePath"), PackagePath);
	Result->SetStringField(TEXT("assetPath"), FullAssetPath);
	Result->SetStringField(TEXT("targetSkeleton"), Skeleton->GetName());
	Result->SetStringField(TEXT("parentClass"), ParentClass->GetName());
	Result->SetBoolField(TEXT("isAnimBlueprint"), true);
	Result->SetBoolField(TEXT("saved"), bSaved);
	Result->SetArrayField(TEXT("graphs"), GraphNames);
	return JsonToString(Result);
}

// ============================================================
// Tier 2: State Machine Mutation
// ============================================================

// Helper: find a state machine graph by name within an AnimBlueprint
static UAnimationStateMachineGraph* FindStateMachineGraph(UBlueprint* BP, const FString& GraphName)
{
	TArray<UEdGraph*> AllGraphs;
	BP->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		if (UAnimationStateMachineGraph* SMGraph = Cast<UAnimationStateMachineGraph>(Graph))
		{
			if (SMGraph->GetName() == GraphName)
			{
				return SMGraph;
			}
		}
	}
	return nullptr;
}

// Helper: find a state node by name within a state machine graph
static UAnimStateNode* FindStateByName(UAnimationStateMachineGraph* SMGraph, const FString& StateName)
{
	for (UEdGraphNode* Node : SMGraph->Nodes)
	{
		if (UAnimStateNode* StateNode = Cast<UAnimStateNode>(Node))
		{
			if (StateNode->GetStateName() == StateName)
			{
				return StateNode;
			}
		}
	}
	return nullptr;
}

// Helper: find a transition between two states
static UAnimStateTransitionNode* FindTransition(UAnimationStateMachineGraph* SMGraph,
	const FString& FromStateName, const FString& ToStateName)
{
	for (UEdGraphNode* Node : SMGraph->Nodes)
	{
		if (UAnimStateTransitionNode* TransNode = Cast<UAnimStateTransitionNode>(Node))
		{
			UAnimStateNode* FromState = Cast<UAnimStateNode>(TransNode->GetPreviousState());
			UAnimStateNode* ToState = Cast<UAnimStateNode>(TransNode->GetNextState());
			if (FromState && ToState &&
				FromState->GetStateName() == FromStateName &&
				ToState->GetStateName() == ToStateName)
			{
				return TransNode;
			}
		}
	}
	return nullptr;
}

FString FBlueprintMCPServer::HandleAddAnimState(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString StateName = Json->GetStringField(TEXT("stateName"));

	if (BlueprintName.IsEmpty() || GraphName.IsEmpty() || StateName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph, stateName"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	UAnimationStateMachineGraph* SMGraph = FindStateMachineGraph(BP, GraphName);
	if (!SMGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State machine graph '%s' not found"), *GraphName));
	}

	// Check for duplicate state name
	if (FindStateByName(SMGraph, StateName))
	{
		return MakeErrorJson(FString::Printf(TEXT("State '%s' already exists in graph '%s'"), *StateName, *GraphName));
	}

	// Resolve the optional animation asset BEFORE creating anything (audit item 8: it used to be skipped silently)
	UAnimSequence* AnimSeq = nullptr;
	FString AnimAssetName;
	Json->TryGetStringField(TEXT("animationAsset"), AnimAssetName);
	if (!AnimAssetName.IsEmpty())
	{
		FString AssetError;
		AnimSeq = ResolveAnimAsset<UAnimSequence>(AnimAssetName, AnimBP->TargetSkeleton, AssetError);
		if (!AnimSeq) return MakeErrorJson(AssetError);
	}

	// Get position
	int32 PosX = Json->HasField(TEXT("posX")) ? (int32)Json->GetNumberField(TEXT("posX")) : 200;
	int32 PosY = Json->HasField(TEXT("posY")) ? (int32)Json->GetNumberField(TEXT("posY")) : 0;

	// Create the state node
	UAnimStateNode* NewState = NewObject<UAnimStateNode>(SMGraph);
	NewState->CreateNewGuid();
	NewState->NodePosX = PosX;
	NewState->NodePosY = PosY;

	// Set the state name via the bound graph
	NewState->PostPlacedNewNode();
	NewState->AllocateDefaultPins();

	// Rename the bound graph to set the state name
	if (NewState->GetBoundGraph())
	{
		NewState->GetBoundGraph()->Rename(*StateName, nullptr);
	}

	SMGraph->AddNode(NewState, false, false);
	NewState->SetFlags(RF_Transactional);

	// Optionally set animation asset (resolved above)
	if (AnimSeq && NewState->GetBoundGraph())
	{
		{
			UAnimGraphNode_SequencePlayer* SeqNode = NewObject<UAnimGraphNode_SequencePlayer>(NewState->GetBoundGraph());
			SeqNode->CreateNewGuid();
			SeqNode->PostPlacedNewNode();
			SeqNode->AllocateDefaultPins();
			SeqNode->SetAnimationAsset(AnimSeq);
			SeqNode->NodePosX = 0;
			SeqNode->NodePosY = 0;
			NewState->GetBoundGraph()->AddNode(SeqNode, false, false);
		}
	}

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("stateName"), StateName);
	Result->SetStringField(TEXT("graph"), GraphName);
	Result->SetStringField(TEXT("nodeId"), NewState->NodeGuid.ToString());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

FString FBlueprintMCPServer::HandleRemoveAnimState(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString StateName = Json->GetStringField(TEXT("stateName"));

	if (BlueprintName.IsEmpty() || GraphName.IsEmpty() || StateName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph, stateName"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	UAnimationStateMachineGraph* SMGraph = FindStateMachineGraph(BP, GraphName);
	if (!SMGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State machine graph '%s' not found"), *GraphName));
	}

	UAnimStateNode* StateNode = FindStateByName(SMGraph, StateName);
	if (!StateNode)
	{
		return MakeErrorJson(FString::Printf(TEXT("State '%s' not found in graph '%s'"), *StateName, *GraphName));
	}

	// Collect and remove transitions connected to this state
	TArray<UAnimStateTransitionNode*> TransitionsToRemove;
	for (UEdGraphNode* Node : SMGraph->Nodes)
	{
		if (UAnimStateTransitionNode* TransNode = Cast<UAnimStateTransitionNode>(Node))
		{
			if (TransNode->GetPreviousState() == StateNode || TransNode->GetNextState() == StateNode)
			{
				TransitionsToRemove.Add(TransNode);
			}
		}
	}

	int32 RemovedTransitions = TransitionsToRemove.Num();
	for (UAnimStateTransitionNode* Trans : TransitionsToRemove)
	{
		Trans->BreakAllNodeLinks();
		SMGraph->RemoveNode(Trans);
	}

	// Remove the state
	StateNode->BreakAllNodeLinks();
	SMGraph->RemoveNode(StateNode);

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("removedState"), StateName);
	Result->SetNumberField(TEXT("removedTransitions"), RemovedTransitions);
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

FString FBlueprintMCPServer::HandleAddAnimTransition(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString FromStateName = Json->GetStringField(TEXT("fromState"));
	FString ToStateName = Json->GetStringField(TEXT("toState"));

	if (BlueprintName.IsEmpty() || GraphName.IsEmpty() || FromStateName.IsEmpty() || ToStateName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph, fromState, toState"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	UAnimationStateMachineGraph* SMGraph = FindStateMachineGraph(BP, GraphName);
	if (!SMGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State machine graph '%s' not found"), *GraphName));
	}

	UAnimStateNode* FromState = FindStateByName(SMGraph, FromStateName);
	if (!FromState)
	{
		return MakeErrorJson(FString::Printf(TEXT("From state '%s' not found"), *FromStateName));
	}

	UAnimStateNode* ToState = FindStateByName(SMGraph, ToStateName);
	if (!ToState)
	{
		return MakeErrorJson(FString::Printf(TEXT("To state '%s' not found"), *ToStateName));
	}

	// Create transition node
	UAnimStateTransitionNode* TransNode = NewObject<UAnimStateTransitionNode>(SMGraph);
	TransNode->CreateNewGuid();
	TransNode->PostPlacedNewNode();
	TransNode->AllocateDefaultPins();

	// Position between the two states
	TransNode->NodePosX = (FromState->NodePosX + ToState->NodePosX) / 2;
	TransNode->NodePosY = (FromState->NodePosY + ToState->NodePosY) / 2;

	SMGraph->AddNode(TransNode, false, false);
	TransNode->SetFlags(RF_Transactional);

	// Connect: FromState output -> Transition input, Transition output -> ToState input
	TransNode->CreateConnections(FromState, ToState);

	// Set optional properties
	if (Json->HasField(TEXT("crossfadeDuration")))
	{
		TransNode->CrossfadeDuration = (float)Json->GetNumberField(TEXT("crossfadeDuration"));
	}
	if (Json->HasField(TEXT("priority")))
	{
		TransNode->PriorityOrder = (int32)Json->GetNumberField(TEXT("priority"));
	}
	if (Json->HasField(TEXT("bBidirectional")))
	{
		TransNode->Bidirectional = Json->GetBoolField(TEXT("bBidirectional"));
	}

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("fromState"), FromStateName);
	Result->SetStringField(TEXT("toState"), ToStateName);
	Result->SetStringField(TEXT("nodeId"), TransNode->NodeGuid.ToString());
	Result->SetNumberField(TEXT("crossfadeDuration"), TransNode->CrossfadeDuration);
	Result->SetNumberField(TEXT("priorityOrder"), TransNode->PriorityOrder);
	Result->SetBoolField(TEXT("bBidirectional"), TransNode->Bidirectional);
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

FString FBlueprintMCPServer::HandleSetTransitionRule(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString FromStateName = Json->GetStringField(TEXT("fromState"));
	FString ToStateName = Json->GetStringField(TEXT("toState"));

	if (BlueprintName.IsEmpty() || GraphName.IsEmpty() || FromStateName.IsEmpty() || ToStateName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph, fromState, toState"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	UAnimationStateMachineGraph* SMGraph = FindStateMachineGraph(BP, GraphName);
	if (!SMGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State machine graph '%s' not found"), *GraphName));
	}

	UAnimStateTransitionNode* TransNode = FindTransition(SMGraph, FromStateName, ToStateName);
	if (!TransNode)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Transition from '%s' to '%s' not found in graph '%s'"),
			*FromStateName, *ToStateName, *GraphName));
	}

	// Update properties
	int32 ChangedCount = 0;

	if (Json->HasField(TEXT("crossfadeDuration")))
	{
		TransNode->CrossfadeDuration = (float)Json->GetNumberField(TEXT("crossfadeDuration"));
		ChangedCount++;
	}
	if (Json->HasField(TEXT("blendMode")))
	{
		TransNode->BlendMode = (EAlphaBlendOption)(int32)Json->GetNumberField(TEXT("blendMode"));
		ChangedCount++;
	}
	if (Json->HasField(TEXT("priorityOrder")))
	{
		TransNode->PriorityOrder = (int32)Json->GetNumberField(TEXT("priorityOrder"));
		ChangedCount++;
	}
	if (Json->HasField(TEXT("logicType")))
	{
		TransNode->LogicType = (ETransitionLogicType::Type)(int32)Json->GetNumberField(TEXT("logicType"));
		ChangedCount++;
	}
	if (Json->HasField(TEXT("bBidirectional")))
	{
		TransNode->Bidirectional = Json->GetBoolField(TEXT("bBidirectional"));
		ChangedCount++;
	}

	if (ChangedCount == 0)
	{
		return MakeErrorJson(TEXT("No properties to update. Provide at least one of: crossfadeDuration, blendMode, priorityOrder, logicType, bBidirectional"));
	}

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("fromState"), FromStateName);
	Result->SetStringField(TEXT("toState"), ToStateName);
	Result->SetNumberField(TEXT("propertiesChanged"), ChangedCount);
	Result->SetNumberField(TEXT("crossfadeDuration"), TransNode->CrossfadeDuration);
	Result->SetNumberField(TEXT("blendMode"), (int32)TransNode->BlendMode);
	Result->SetNumberField(TEXT("priorityOrder"), TransNode->PriorityOrder);
	Result->SetNumberField(TEXT("logicType"), (int32)TransNode->LogicType.GetValue());
	Result->SetBoolField(TEXT("bBidirectional"), TransNode->Bidirectional);
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

// ============================================================
// Tier 3: AnimGraph Blend Tree Mutation
// ============================================================

FString FBlueprintMCPServer::HandleAddAnimNode(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString NodeType = Json->GetStringField(TEXT("nodeType"));

	if (BlueprintName.IsEmpty() || NodeType.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, nodeType"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	// Find target graph (default to AnimGraph if not specified)
	UEdGraph* TargetGraph = nullptr;
	if (GraphName.IsEmpty())
	{
		GraphName = TEXT("AnimGraph");
	}

	TArray<UEdGraph*> AllGraphs;
	BP->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		if (Graph->GetName() == GraphName)
		{
			TargetGraph = Graph;
			break;
		}
	}

	if (!TargetGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("Graph '%s' not found"), *GraphName));
	}

	int32 PosX = Json->HasField(TEXT("posX")) ? (int32)Json->GetNumberField(TEXT("posX")) : 0;
	int32 PosY = Json->HasField(TEXT("posY")) ? (int32)Json->GetNumberField(TEXT("posY")) : 0;

	UAnimGraphNode_Base* NewNode = nullptr;

	// Resolve the asset first: a name that does not resolve (or a wrong skeleton) is an error and nothing is created.
	FString AssetName;
	Json->TryGetStringField(TEXT("animationAsset"), AssetName);
	UAnimSequence* AnimSeq = nullptr;
	UBlendSpace* BlendSpace = nullptr;
	UPoseAsset* PoseAsset = nullptr;
	if (!AssetName.IsEmpty())
	{
		FString AssetError;
		if (NodeType == TEXT("SequencePlayer"))
		{
			AnimSeq = ResolveAnimAsset<UAnimSequence>(AssetName, AnimBP->TargetSkeleton, AssetError);
		}
		else if (NodeType == TEXT("BlendSpacePlayer"))
		{
			BlendSpace = ResolveAnimAsset<UBlendSpace>(AssetName, AnimBP->TargetSkeleton, AssetError);
		}
		else if (NodeType == TEXT("PoseBlender"))
		{
			PoseAsset = ResolveAnimAsset<UPoseAsset>(AssetName, AnimBP->TargetSkeleton, AssetError);
		}
		if (!AssetError.IsEmpty()) return MakeErrorJson(AssetError);
	}

	if (NodeType == TEXT("SequencePlayer"))
	{
		UAnimGraphNode_SequencePlayer* SeqNode = NewObject<UAnimGraphNode_SequencePlayer>(TargetGraph);
		SeqNode->CreateNewGuid();
		SeqNode->PostPlacedNewNode();
		SeqNode->AllocateDefaultPins();
		if (AnimSeq)
		{
			SeqNode->SetAnimationAsset(AnimSeq);
		}
		NewNode = SeqNode;
	}
	else if (NodeType == TEXT("BlendSpacePlayer"))
	{
		UAnimGraphNode_BlendSpacePlayer* BSNode = NewObject<UAnimGraphNode_BlendSpacePlayer>(TargetGraph);
		BSNode->CreateNewGuid();
		BSNode->PostPlacedNewNode();
		BSNode->AllocateDefaultPins();
		if (BlendSpace)
		{
			BSNode->SetAnimationAsset(BlendSpace);
		}
		NewNode = BSNode;
	}
	else if (NodeType == TEXT("Slot"))
	{
		// CLAUDE-NOTE (2026-10-22): montages only play through a Slot node in the AnimGraph (restart batch item).
		// The slot name must exist on the target skeleton; a missing one is registered (default group).
		FString SlotName = TEXT("DefaultSlot");
		Json->TryGetStringField(TEXT("slotName"), SlotName);
		USkeleton* Skeleton = AnimBP->TargetSkeleton;
		bool bRegistered = false;
		if (Skeleton && !Skeleton->ContainsSlotName(FName(*SlotName)))
		{
			Skeleton->Modify();
			Skeleton->RegisterSlotNode(FName(*SlotName));
			Skeleton->MarkPackageDirty();
			bRegistered = true;
		}
		UAnimGraphNode_Slot* SlotNode = NewObject<UAnimGraphNode_Slot>(TargetGraph);
		SlotNode->CreateNewGuid();
		SlotNode->PostPlacedNewNode();
		SlotNode->Node.SlotName = FName(*SlotName);
		SlotNode->AllocateDefaultPins();
		NewNode = SlotNode;
		Json->SetBoolField(TEXT("_slotRegistered"), bRegistered);
	}
	else if (NodeType == TEXT("PoseBlender"))
	{
		// Pose Blender: outputs the PoseAsset's poses weighted by the curves of its source pose (audit item 12).
		UAnimGraphNode_PoseBlendNode* PoseNode = NewObject<UAnimGraphNode_PoseBlendNode>(TargetGraph);
		PoseNode->CreateNewGuid();
		PoseNode->PostPlacedNewNode();
		PoseNode->AllocateDefaultPins();
		if (PoseAsset)
		{
			PoseNode->SetAnimationAsset(PoseAsset);
		}
		NewNode = PoseNode;
	}
	else if (NodeType == TEXT("StateMachine"))
	{
		UAnimGraphNode_StateMachine* SMNode = NewObject<UAnimGraphNode_StateMachine>(TargetGraph);
		SMNode->CreateNewGuid();
		SMNode->PostPlacedNewNode();
		SMNode->AllocateDefaultPins();
		NewNode = SMNode;
	}
	else
	{
		// CLAUDE-NOTE (2026-10-22): any other AnimGraph node by class name (e.g. AnimGraphNode_TwoBoneIK,
		// AnimGraphNode_LayeredBoneBlend, AnimGraphNode_LookAt, AnimGraphNode_ModifyBone, AnimGraphNode_BlendListByBool,
		// AnimGraphNode_CopyPoseFromMesh). Configure it with `properties` (paths into the node, e.g. Node.IKBone.BoneName).
		FString ClassName = NodeType.StartsWith(TEXT("AnimGraphNode_")) ? NodeType : TEXT("AnimGraphNode_") + NodeType;
		UClass* NodeClass = FindFirstObject<UClass>(*ClassName, EFindFirstObjectOptions::NativeFirst);
		if (!NodeClass || !NodeClass->IsChildOf(UAnimGraphNode_Base::StaticClass()) || NodeClass->HasAnyClassFlags(CLASS_Abstract))
		{
			return MakeErrorJson(FString::Printf(
				TEXT("Unknown nodeType '%s' (named: SequencePlayer, BlendSpacePlayer, StateMachine, Slot, PoseBlender, or any AnimGraphNode_* class)"),
				*NodeType));
		}
		UAnimGraphNode_Base* Generic = NewObject<UAnimGraphNode_Base>(TargetGraph, NodeClass);
		Generic->CreateNewGuid();
		Generic->PostPlacedNewNode();
		Generic->AllocateDefaultPins();
		NewNode = Generic;
	}

	// Optional property writes (any node type), applied before the node is added and compiled.
	TSharedRef<FJsonObject> PropResult = MakeShared<FJsonObject>();
	const TSharedPtr<FJsonObject>* PropsObj = nullptr;
	if (Json->TryGetObjectField(TEXT("properties"), PropsObj) && PropsObj && (*PropsObj)->Values.Num() > 0)
	{
		FString PropError;
		if (!ApplyNodeProperties(NewNode, *PropsObj, PropResult, PropError))
		{
			return MakeErrorJson(PropError + TEXT(" (node not added)"));
		}
		NewNode->ReconstructNode();
	}

	if (!NewNode)
	{
		return MakeErrorJson(TEXT("Failed to create anim node"));
	}

	NewNode->NodePosX = PosX;
	NewNode->NodePosY = PosY;
	TargetGraph->AddNode(NewNode, false, false);
	NewNode->SetFlags(RF_Transactional);

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("nodeType"), NodeType);
	Result->SetStringField(TEXT("nodeId"), NewNode->NodeGuid.ToString());
	Result->SetStringField(TEXT("graph"), GraphName);
	Result->SetBoolField(TEXT("saved"), bSaved);
	if (PropResult->Values.Num() > 0) Result->SetObjectField(TEXT("properties"), PropResult);
	Result->SetArrayField(TEXT("pins"), PinsJson(NewNode));
	if (UAnimGraphNode_Slot* SlotNode = Cast<UAnimGraphNode_Slot>(NewNode))
	{
		Result->SetStringField(TEXT("slotName"), SlotNode->Node.SlotName.ToString());
		Result->SetBoolField(TEXT("slotRegistered"), Json->HasField(TEXT("_slotRegistered")) && Json->GetBoolField(TEXT("_slotRegistered")));
	}

	// For StateMachine, report the sub-graph name
	if (NodeType == TEXT("StateMachine"))
	{
		if (UAnimGraphNode_StateMachine* SMNode = Cast<UAnimGraphNode_StateMachine>(NewNode))
		{
			if (SMNode->EditorStateMachineGraph)
			{
				Result->SetStringField(TEXT("stateMachineGraph"), SMNode->EditorStateMachineGraph->GetName());
			}
		}
	}

	return JsonToString(Result);
}

// ============================================================
// Tier 4: Advanced Operations
// ============================================================

FString FBlueprintMCPServer::HandleAddStateMachine(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString MachineName = Json->GetStringField(TEXT("name"));

	if (BlueprintName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: blueprint"));
	}

	// Default name
	if (MachineName.IsEmpty())
	{
		MachineName = TEXT("NewStateMachine");
	}

	// Delegate to HandleAddAnimNode with StateMachine type and AnimGraph as target
	TSharedRef<FJsonObject> ForwardJson = MakeShared<FJsonObject>();
	ForwardJson->SetStringField(TEXT("blueprint"), BlueprintName);
	ForwardJson->SetStringField(TEXT("graph"), TEXT("AnimGraph"));
	ForwardJson->SetStringField(TEXT("nodeType"), TEXT("StateMachine"));
	if (Json->HasField(TEXT("posX")))
		ForwardJson->SetNumberField(TEXT("posX"), Json->GetNumberField(TEXT("posX")));
	if (Json->HasField(TEXT("posY")))
		ForwardJson->SetNumberField(TEXT("posY"), Json->GetNumberField(TEXT("posY")));

	FString ForwardBody;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ForwardBody);
	FJsonSerializer::Serialize(ForwardJson, Writer);

	return HandleAddAnimNode(ForwardBody);
}

FString FBlueprintMCPServer::HandleSetStateAnimation(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString StateName = Json->GetStringField(TEXT("stateName"));
	FString AnimAssetName = Json->GetStringField(TEXT("animationAsset"));

	if (BlueprintName.IsEmpty() || GraphName.IsEmpty() || StateName.IsEmpty() || AnimAssetName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph, stateName, animationAsset"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	UAnimationStateMachineGraph* SMGraph = FindStateMachineGraph(BP, GraphName);
	if (!SMGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State machine graph '%s' not found"), *GraphName));
	}

	UAnimStateNode* StateNode = FindStateByName(SMGraph, StateName);
	if (!StateNode)
	{
		return MakeErrorJson(FString::Printf(TEXT("State '%s' not found in graph '%s'"), *StateName, *GraphName));
	}

	UEdGraph* InnerGraph = StateNode->GetBoundGraph();
	if (!InnerGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State '%s' has no bound graph"), *StateName));
	}

	// Find the animation asset
	UAnimSequence* AnimSeq = nullptr;
	FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	TArray<FAssetData> AnimAssets;
	ARM.Get().GetAssetsByClass(UAnimSequence::StaticClass()->GetClassPathName(), AnimAssets, false);
	for (const FAssetData& Asset : AnimAssets)
	{
		if (Asset.AssetName.ToString() == AnimAssetName ||
			Asset.PackageName.ToString() == AnimAssetName)
		{
			AnimSeq = Cast<UAnimSequence>(Asset.GetAsset());
			break;
		}
	}

	if (!AnimSeq)
	{
		return MakeErrorJson(FString::Printf(TEXT("Animation asset '%s' not found"), *AnimAssetName));
	}

	// Find existing SequencePlayer or create one
	UAnimGraphNode_SequencePlayer* SeqNode = nullptr;
	for (UEdGraphNode* Node : InnerGraph->Nodes)
	{
		SeqNode = Cast<UAnimGraphNode_SequencePlayer>(Node);
		if (SeqNode) break;
	}

	bool bCreatedNew = false;
	if (!SeqNode)
	{
		SeqNode = NewObject<UAnimGraphNode_SequencePlayer>(InnerGraph);
		SeqNode->CreateNewGuid();
		SeqNode->PostPlacedNewNode();
		SeqNode->AllocateDefaultPins();
		SeqNode->NodePosX = 0;
		SeqNode->NodePosY = 0;
		InnerGraph->AddNode(SeqNode, false, false);
		bCreatedNew = true;
	}

	SeqNode->SetAnimationAsset(AnimSeq);

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("stateName"), StateName);
	Result->SetStringField(TEXT("animationAsset"), AnimSeq->GetName());
	Result->SetBoolField(TEXT("createdNewNode"), bCreatedNew);
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

FString FBlueprintMCPServer::HandleListAnimSlots(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	if (BlueprintName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: blueprint"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	// Walk all anim nodes to collect slot names
	TSet<FString> SlotNames;
	TArray<UEdGraph*> AllGraphs;
	BP->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (UAnimGraphNode_Base* AnimNode = Cast<UAnimGraphNode_Base>(Node))
			{
				// Check for SlotName property via reflection
				for (TFieldIterator<FNameProperty> PropIt(AnimNode->GetClass()); PropIt; ++PropIt)
				{
					if (PropIt->GetName().Contains(TEXT("SlotName")) || PropIt->GetName().Contains(TEXT("Slot")))
					{
						FName SlotValue = PropIt->GetPropertyValue_InContainer(AnimNode);
						if (!SlotValue.IsNone())
						{
							SlotNames.Add(SlotValue.ToString());
						}
					}
				}
			}
		}
	}

	TArray<TSharedPtr<FJsonValue>> SlotsArr;
	for (const FString& Slot : SlotNames)
	{
		SlotsArr.Add(MakeShared<FJsonValueString>(Slot));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("blueprint"), BlueprintName);
	Result->SetArrayField(TEXT("slots"), SlotsArr);
	Result->SetNumberField(TEXT("count"), SlotsArr.Num());
	return JsonToString(Result);
}

FString FBlueprintMCPServer::HandleListSyncGroups(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	if (BlueprintName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: blueprint"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	// Walk all anim nodes to collect sync group names
	TSet<FString> SyncGroupNames;
	TArray<UEdGraph*> AllGraphs;
	BP->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (UAnimGraphNode_Base* AnimNode = Cast<UAnimGraphNode_Base>(Node))
			{
				// Check for SyncGroup/GroupName property via reflection
				for (TFieldIterator<FNameProperty> PropIt(AnimNode->GetClass()); PropIt; ++PropIt)
				{
					if (PropIt->GetName().Contains(TEXT("SyncGroup")) || PropIt->GetName().Contains(TEXT("GroupName")))
					{
						FName GroupValue = PropIt->GetPropertyValue_InContainer(AnimNode);
						if (!GroupValue.IsNone())
						{
							SyncGroupNames.Add(GroupValue.ToString());
						}
					}
				}
			}
		}
	}

	TArray<TSharedPtr<FJsonValue>> GroupsArr;
	for (const FString& Group : SyncGroupNames)
	{
		GroupsArr.Add(MakeShared<FJsonValueString>(Group));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("blueprint"), BlueprintName);
	Result->SetArrayField(TEXT("syncGroups"), GroupsArr);
	Result->SetNumberField(TEXT("count"), GroupsArr.Num());
	return JsonToString(Result);
}

// ============================================================
// HandleCreateBlendSpace — create a new 2D Blend Space asset
// ============================================================

FString FBlueprintMCPServer::HandleCreateBlendSpace(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString Name = Json->GetStringField(TEXT("name"));
	FString PackagePath = Json->GetStringField(TEXT("packagePath"));
	FString SkeletonName = Json->GetStringField(TEXT("skeleton"));

	if (Name.IsEmpty() || PackagePath.IsEmpty() || SkeletonName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: name, packagePath, skeleton"));
	}

	if (!PackagePath.StartsWith(TEXT("/Game")))
	{
		return MakeErrorJson(TEXT("packagePath must start with '/Game'"));
	}

	// Check if asset already exists
	FString FullAssetPath = PackagePath / Name;
	{
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		TArray<FAssetData> ExistingAssets;
		ARM.Get().GetAssetsByClass(UBlendSpace::StaticClass()->GetClassPathName(), ExistingAssets, true);
		for (const FAssetData& Asset : ExistingAssets)
		{
			if (Asset.AssetName.ToString() == Name || Asset.GetObjectPathString() == FullAssetPath)
			{
				return MakeErrorJson(FString::Printf(
					TEXT("Blend Space '%s' already exists. Use a different name or delete the existing asset first."),
					*Name));
			}
		}
	}

	// Resolve skeleton
	USkeleton* Skeleton = nullptr;

	if (SkeletonName == TEXT("__create_test_skeleton__"))
	{
		FString TestSkeletonPath = PackagePath / (Name + TEXT("_TestSkeleton"));
		UPackage* SkelPackage = CreatePackage(*TestSkeletonPath);
		Skeleton = NewObject<USkeleton>(SkelPackage, FName(*(Name + TEXT("_TestSkeleton"))), RF_Public | RF_Standalone);
		if (Skeleton)
		{
			Skeleton->MarkPackageDirty();
			UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created test skeleton '%s'"), *Skeleton->GetName());
		}
	}
	else
	{
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		TArray<FAssetData> SkeletonAssets;
		ARM.Get().GetAssetsByClass(USkeleton::StaticClass()->GetClassPathName(), SkeletonAssets, false);

		for (const FAssetData& Asset : SkeletonAssets)
		{
			if (Asset.AssetName.ToString() == SkeletonName ||
				Asset.PackageName.ToString() == SkeletonName ||
				Asset.GetObjectPathString() == SkeletonName)
			{
				Skeleton = Cast<USkeleton>(Asset.GetAsset());
				break;
			}
		}

		// Case-insensitive fallback
		if (!Skeleton)
		{
			for (const FAssetData& Asset : SkeletonAssets)
			{
				if (Asset.AssetName.ToString().Equals(SkeletonName, ESearchCase::IgnoreCase) ||
					Asset.PackageName.ToString().Equals(SkeletonName, ESearchCase::IgnoreCase))
				{
					Skeleton = Cast<USkeleton>(Asset.GetAsset());
					break;
				}
			}
		}
	}

	if (!Skeleton)
	{
		return MakeErrorJson(FString::Printf(
			TEXT("Skeleton '%s' not found. Provide the skeleton asset name or path. Use '__create_test_skeleton__' for testing."),
			*SkeletonName));
	}

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Creating Blend Space '%s' in '%s' with skeleton '%s'"),
		*Name, *PackagePath, *Skeleton->GetName());

	// Create the package
	FString FullPackagePath = PackagePath / Name;
	UPackage* Package = CreatePackage(*FullPackagePath);
	if (!Package)
	{
		return MakeErrorJson(FString::Printf(TEXT("Failed to create package at '%s'"), *FullPackagePath));
	}

	// Create the Blend Space
	UBlendSpace* NewBS = NewObject<UBlendSpace>(Package, FName(*Name), RF_Public | RF_Standalone);
	if (!NewBS)
	{
		return MakeErrorJson(TEXT("Failed to create Blend Space object"));
	}

	// Set skeleton
	NewBS->SetSkeleton(Skeleton);

	// Mark dirty and save
	NewBS->MarkPackageDirty();
	bool bSaved = SaveGenericPackage(NewBS);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Created Blend Space '%s' (saved: %s)"),
		*Name, bSaved ? TEXT("true") : TEXT("false"));

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("assetPath"), FullAssetPath);
	Result->SetStringField(TEXT("skeleton"), Skeleton->GetName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

// ============================================================
// HandleSetBlendSpaceSamples — add animation samples to a Blend Space
// ============================================================

FString FBlueprintMCPServer::HandleSetBlendSpaceSamples(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlendSpaceName = Json->GetStringField(TEXT("blendSpace"));
	if (BlendSpaceName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: blendSpace"));
	}

	// Load the blend space
	UBlendSpace* BS = nullptr;
	{
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		TArray<FAssetData> BSAssets;
		ARM.Get().GetAssetsByClass(UBlendSpace::StaticClass()->GetClassPathName(), BSAssets, true);
		for (const FAssetData& Asset : BSAssets)
		{
			if (Asset.AssetName.ToString() == BlendSpaceName ||
				Asset.PackageName.ToString() == BlendSpaceName ||
				Asset.GetObjectPathString() == BlendSpaceName)
			{
				BS = Cast<UBlendSpace>(Asset.GetAsset());
				break;
			}
		}
		// Try FName-based path match (e.g. /Game/Folder/BS_Name)
		if (!BS)
		{
			FString LeafName = FPaths::GetCleanFilename(BlendSpaceName);
			for (const FAssetData& Asset : BSAssets)
			{
				if (Asset.AssetName.ToString() == LeafName)
				{
					BS = Cast<UBlendSpace>(Asset.GetAsset());
					break;
				}
			}
		}
	}

	if (!BS)
	{
		return MakeErrorJson(FString::Printf(TEXT("Blend Space '%s' not found"), *BlendSpaceName));
	}

	// Set axis parameters
	BS->PreEditChange(nullptr);

	FString AxisXName = Json->GetStringField(TEXT("axisXName"));
	FString AxisYName = Json->GetStringField(TEXT("axisYName"));

	const FBlendParameter& ParamX = BS->GetBlendParameter(0);
	const FBlendParameter& ParamY = BS->GetBlendParameter(1);

	// We need to modify BlendParameters directly — use const_cast since there's no setter API
	FBlendParameter& MutableParamX = const_cast<FBlendParameter&>(ParamX);
	FBlendParameter& MutableParamY = const_cast<FBlendParameter&>(ParamY);

	if (!AxisXName.IsEmpty()) MutableParamX.DisplayName = AxisXName;
	if (Json->HasField(TEXT("axisXMin"))) MutableParamX.Min = (float)Json->GetNumberField(TEXT("axisXMin"));
	if (Json->HasField(TEXT("axisXMax"))) MutableParamX.Max = (float)Json->GetNumberField(TEXT("axisXMax"));

	if (!AxisYName.IsEmpty()) MutableParamY.DisplayName = AxisYName;
	if (Json->HasField(TEXT("axisYMin"))) MutableParamY.Min = (float)Json->GetNumberField(TEXT("axisYMin"));
	if (Json->HasField(TEXT("axisYMax"))) MutableParamY.Max = (float)Json->GetNumberField(TEXT("axisYMax"));

	// Clear existing samples (delete from end to start)
	int32 NumExisting = BS->GetNumberOfBlendSamples();
	for (int32 i = NumExisting - 1; i >= 0; --i)
	{
		BS->DeleteSample(i);
	}

	// Add new samples
	const TArray<TSharedPtr<FJsonValue>>* SamplesArray = nullptr;
	int32 SamplesSet = 0;

	if (Json->TryGetArrayField(TEXT("samples"), SamplesArray) && SamplesArray)
	{
		// Pre-load all animation sequences for lookup
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		TArray<FAssetData> AnimAssets;
		ARM.Get().GetAssetsByClass(UAnimSequence::StaticClass()->GetClassPathName(), AnimAssets, false);

		for (const TSharedPtr<FJsonValue>& SampleVal : *SamplesArray)
		{
			const TSharedPtr<FJsonObject>& SampleObj = SampleVal->AsObject();
			if (!SampleObj.IsValid()) continue;

			FString AnimAssetName = SampleObj->GetStringField(TEXT("animationAsset"));
			float X = (float)SampleObj->GetNumberField(TEXT("x"));
			float Y = (float)SampleObj->GetNumberField(TEXT("y"));

			UAnimSequence* AnimSeq = nullptr;
			if (!AnimAssetName.IsEmpty())
			{
				for (const FAssetData& Asset : AnimAssets)
				{
					if (Asset.AssetName.ToString() == AnimAssetName ||
						Asset.PackageName.ToString() == AnimAssetName ||
						Asset.GetObjectPathString() == AnimAssetName)
					{
						AnimSeq = Cast<UAnimSequence>(Asset.GetAsset());
						break;
					}
				}

				// Also try extracting leaf name from path
				if (!AnimSeq)
				{
					FString LeafName = FPaths::GetCleanFilename(AnimAssetName);
					for (const FAssetData& Asset : AnimAssets)
					{
						if (Asset.AssetName.ToString() == LeafName)
						{
							AnimSeq = Cast<UAnimSequence>(Asset.GetAsset());
							break;
						}
					}
				}
			}

			FVector SampleValue(X, Y, 0.0f);
			if (AnimSeq)
			{
				BS->AddSample(AnimSeq, SampleValue);
			}
			else
			{
				BS->AddSample(SampleValue);
			}
			SamplesSet++;
		}
	}

	BS->ValidateSampleData();
	BS->PostEditChange();

	// Save
	BS->MarkPackageDirty();
	bool bSaved = SaveGenericPackage(BS);

	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: Set %d samples on Blend Space '%s' (saved: %s)"),
		SamplesSet, *BS->GetName(), bSaved ? TEXT("true") : TEXT("false"));

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("blendSpace"), BS->GetPathName());
	Result->SetNumberField(TEXT("samplesSet"), SamplesSet);
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

// ============================================================
// HandleSetStateBlendSpace — place a BlendSpacePlayer in a state
// ============================================================

FString FBlueprintMCPServer::HandleSetStateBlendSpace(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid())
	{
		return MakeErrorJson(TEXT("Invalid JSON body"));
	}

	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString GraphName = Json->GetStringField(TEXT("graph"));
	FString StateName = Json->GetStringField(TEXT("stateName"));
	FString BlendSpaceName = Json->GetStringField(TEXT("blendSpace"));
	FString XVariable = Json->GetStringField(TEXT("xVariable"));
	FString YVariable = Json->GetStringField(TEXT("yVariable"));

	if (BlueprintName.IsEmpty() || GraphName.IsEmpty() || StateName.IsEmpty() || BlendSpaceName.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, graph, stateName, blendSpace"));
	}

	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);

	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP)
	{
		return MakeErrorJson(FString::Printf(TEXT("'%s' is not an Animation Blueprint"), *BlueprintName));
	}

	UAnimationStateMachineGraph* SMGraph = FindStateMachineGraph(BP, GraphName);
	if (!SMGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State machine graph '%s' not found"), *GraphName));
	}

	UAnimStateNode* StateNode = FindStateByName(SMGraph, StateName);
	if (!StateNode)
	{
		return MakeErrorJson(FString::Printf(TEXT("State '%s' not found in graph '%s'"), *StateName, *GraphName));
	}

	UEdGraph* InnerGraph = StateNode->GetBoundGraph();
	if (!InnerGraph)
	{
		return MakeErrorJson(FString::Printf(TEXT("State '%s' has no bound graph"), *StateName));
	}

	// Find the blend space asset
	UBlendSpace* BlendSpaceAsset = nullptr;
	{
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
		TArray<FAssetData> BSAssets;
		ARM.Get().GetAssetsByClass(UBlendSpace::StaticClass()->GetClassPathName(), BSAssets, true);
		for (const FAssetData& Asset : BSAssets)
		{
			if (Asset.AssetName.ToString() == BlendSpaceName ||
				Asset.PackageName.ToString() == BlendSpaceName ||
				Asset.GetObjectPathString() == BlendSpaceName)
			{
				BlendSpaceAsset = Cast<UBlendSpace>(Asset.GetAsset());
				break;
			}
		}
		// Leaf name fallback
		if (!BlendSpaceAsset)
		{
			FString LeafName = FPaths::GetCleanFilename(BlendSpaceName);
			for (const FAssetData& Asset : BSAssets)
			{
				if (Asset.AssetName.ToString() == LeafName)
				{
					BlendSpaceAsset = Cast<UBlendSpace>(Asset.GetAsset());
					break;
				}
			}
		}
	}

	if (!BlendSpaceAsset)
	{
		return MakeErrorJson(FString::Printf(TEXT("Blend Space '%s' not found"), *BlendSpaceName));
	}

	// Find existing BlendSpacePlayer or create one
	UAnimGraphNode_BlendSpacePlayer* BSNode = nullptr;
	for (UEdGraphNode* Node : InnerGraph->Nodes)
	{
		BSNode = Cast<UAnimGraphNode_BlendSpacePlayer>(Node);
		if (BSNode) break;
	}

	if (!BSNode)
	{
		BSNode = NewObject<UAnimGraphNode_BlendSpacePlayer>(InnerGraph);
		BSNode->CreateNewGuid();
		BSNode->PostPlacedNewNode();
		BSNode->AllocateDefaultPins();
		BSNode->NodePosX = 0;
		BSNode->NodePosY = 0;
		InnerGraph->AddNode(BSNode, false, false);
	}

	BSNode->SetAnimationAsset(BlendSpaceAsset);

	// Connect BlendSpacePlayer output to the Output Animation Pose node
	{
		// Find the AnimGraphNode_Root (Output Pose) in the inner graph
		UEdGraphNode* ResultNode = nullptr;
		for (UEdGraphNode* Node : InnerGraph->Nodes)
		{
			if (Node->GetClass()->GetName().Contains(TEXT("AnimGraphNode_Root")) ||
				Node->GetClass()->GetName().Contains(TEXT("AnimGraphNode_StateResult")))
			{
				ResultNode = Node;
				break;
			}
		}

		if (ResultNode)
		{
			// Find output pose pin on BlendSpacePlayer and input pose pin on result node
			UEdGraphPin* BSOutputPin = nullptr;
			for (UEdGraphPin* Pin : BSNode->Pins)
			{
				if (Pin && Pin->Direction == EGPD_Output && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Struct)
				{
					BSOutputPin = Pin;
					break;
				}
			}

			UEdGraphPin* ResultInputPin = nullptr;
			for (UEdGraphPin* Pin : ResultNode->Pins)
			{
				if (Pin && Pin->Direction == EGPD_Input && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Struct)
				{
					ResultInputPin = Pin;
					break;
				}
			}

			if (BSOutputPin && ResultInputPin)
			{
				// Break existing connections on the result input
				ResultInputPin->BreakAllPinLinks();
				const UEdGraphSchema* Schema = InnerGraph->GetSchema();
				if (Schema)
				{
					Schema->TryCreateConnection(BSOutputPin, ResultInputPin);
				}
			}
		}
	}

	// Wire X and Y variables if provided
	auto WireVariable = [&](const FString& VarName, const FString& PinName) -> bool
	{
		if (VarName.IsEmpty()) return false;

		// Verify the variable exists in the blueprint
		FName VarFName(*VarName);
		bool bVarFound = false;
		for (FBPVariableDescription& Var : BP->NewVariables)
		{
			if (Var.VarName == VarFName)
			{
				bVarFound = true;
				break;
			}
		}
		if (!bVarFound)
		{
			// Also check parent class properties
			if (UClass* GenClass = BP->SkeletonGeneratedClass)
			{
				if (FProperty* Prop = GenClass->FindPropertyByName(VarFName))
				{
					bVarFound = true;
				}
			}
		}
		if (!bVarFound)
		{
			UE_LOG(LogTemp, Warning, TEXT("BlueprintMCP: Variable '%s' not found in '%s', skipping wire"),
				*VarName, *BlueprintName);
			return false;
		}

		// Create a VariableGet node
		UK2Node_VariableGet* GetNode = NewObject<UK2Node_VariableGet>(InnerGraph);
		GetNode->VariableReference.SetSelfMember(VarFName);
		GetNode->NodePosX = BSNode->NodePosX - 250;
		GetNode->NodePosY = BSNode->NodePosY;
		InnerGraph->AddNode(GetNode, false, false);
		GetNode->AllocateDefaultPins();

		// Find the variable output pin
		UEdGraphPin* VarOutPin = nullptr;
		for (UEdGraphPin* Pin : GetNode->Pins)
		{
			if (Pin && Pin->Direction == EGPD_Output && Pin->PinName == VarFName)
			{
				VarOutPin = Pin;
				break;
			}
		}

		// Find the target pin on the BlendSpacePlayer
		UEdGraphPin* TargetPin = BSNode->FindPin(FName(*PinName));

		if (VarOutPin && TargetPin)
		{
			const UEdGraphSchema* Schema = InnerGraph->GetSchema();
			if (Schema)
			{
				Schema->TryCreateConnection(VarOutPin, TargetPin);
				return true;
			}
		}

		return false;
	};

	WireVariable(XVariable, TEXT("X"));
	WireVariable(YVariable, TEXT("Y"));

	// Compile and save
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	bool bSaved = SaveBlueprintPackage(AnimBP);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetStringField(TEXT("stateName"), StateName);
	Result->SetStringField(TEXT("blendSpace"), BlendSpaceAsset->GetName());
	Result->SetStringField(TEXT("nodeId"), BSNode->NodeGuid.ToString());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

// ============================================================
// HandleSetAnimNodeProperties - write property paths on an existing AnimGraph node (by GUID), recompile, read back
// ============================================================

FString FBlueprintMCPServer::HandleSetAnimNodeProperties(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) return MakeErrorJson(TEXT("Invalid JSON body"));
	FString BlueprintName = Json->GetStringField(TEXT("blueprint"));
	FString NodeId = Json->GetStringField(TEXT("nodeId"));
	const TSharedPtr<FJsonObject>* PropsObj = nullptr;
	if (BlueprintName.IsEmpty() || NodeId.IsEmpty() || !Json->TryGetObjectField(TEXT("properties"), PropsObj) || !PropsObj)
	{
		return MakeErrorJson(TEXT("Missing required fields: blueprint, nodeId, properties"));
	}
	FString LoadError;
	UBlueprint* BP = LoadBlueprintByName(BlueprintName, LoadError);
	if (!BP) return MakeErrorJson(LoadError);
	UAnimBlueprint* AnimBP = Cast<UAnimBlueprint>(BP);
	if (!AnimBP) return MakeErrorJson(TEXT("Not an Animation Blueprint"));
	FGuid Guid;
	FGuid::Parse(NodeId, Guid);
	UEdGraphNode* Found = nullptr;
	TArray<UEdGraph*> AllGraphs;
	BP->GetAllGraphs(AllGraphs);
	for (UEdGraph* G : AllGraphs)
	{
		for (UEdGraphNode* Nd : G->Nodes)
		{
			if (Nd && Nd->NodeGuid == Guid) { Found = Nd; break; }
		}
		if (Found) break;
	}
	if (!Found) return MakeErrorJson(FString::Printf(TEXT("Node %s not found"), *NodeId));
	TSharedRef<FJsonObject> Back = MakeShared<FJsonObject>();
	FString Err;
	if (!ApplyNodeProperties(Found, *PropsObj, Back, Err)) return MakeErrorJson(Err);
	Found->ReconstructNode();
	TArray<FString> CompileErrors;
	const bool bCompiledOk = CompileAnimBPChecked(AnimBP, CompileErrors);
	const bool bSaved = SaveBlueprintPackage(AnimBP);
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	SetCompileResult(Result, bCompiledOk, CompileErrors);
	Result->SetObjectField(TEXT("properties"), Back);
	Result->SetArrayField(TEXT("pins"), PinsJson(Found));
	Result->SetStringField(TEXT("nodeClass"), Found->GetClass()->GetName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}

