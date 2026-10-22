// BlueprintMCPPoseSearch - optional Pose Search (Motion Matching) endpoints for BlueprintMCP.
//
// CLAUDE-NOTE (2026-10-22, UE 5.6.1 source read; see ReverseEngineerMCP targets/unreal NOTES round 20): Python cannot
// author Pose Search assets. Both factories return None without a modal picker, the schema's skeleton entry
// (FPoseSearchRoledSkeleton) and the database's AnimationAssets array are invisible to Python, and the index is built
// asynchronously in C++ only. These endpoints do the C++ half:
//   /api/posesearch-build  create/load schema + database, AddSkeleton + AddDefaultChannels, add sequences, BruteForce
//                          search mode (keeps raw pose values for checking), save, build the index (wait) and report.
//   /api/posesearch-query  offline nearest-pose search over the built index: the feature vector stored for
//                          (sequence, time) against every pose (optionally excluding that sequence), so a database can
//                          be tested without PIE or a Pose History node (expect itself at cost ~0).
// GetSearchIndex() check()s when the index is not built - every handler confirms Success first.

#include "Modules/ModuleManager.h"
#include "BlueprintMCPServer.h"
#include "PoseSearch/PoseSearchDatabase.h"
#include "PoseSearch/PoseSearchSchema.h"
#include "PoseSearch/PoseSearchIndex.h"
#include "PoseSearch/PoseSearchDerivedData.h"
#include "Animation/AnimSequence.h"
#include "Animation/Skeleton.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "EditorAssetLibrary.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "StructUtils/InstancedStruct.h"

using namespace UE::PoseSearch;

namespace
{
	FString ToJson(const TSharedRef<FJsonObject>& O)
	{
		FString Out;
		TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(O, W);
		return Out;
	}

	FString Error(const FString& Msg)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("error"), Msg);
		return ToJson(O);
	}

	TSharedPtr<FJsonObject> Parse(const FString& Body)
	{
		TSharedPtr<FJsonObject> O;
		TSharedRef<TJsonReader<>> R = TJsonReaderFactory<>::Create(Body);
		FJsonSerializer::Deserialize(R, O);
		return O;
	}

	FString ObjectPath(const FString& P)
	{
		return P.Contains(TEXT(".")) ? P : P + TEXT(".") + FPackageName::GetShortName(P);
	}

	template <typename T>
	T* LoadOrCreate(const FString& Path, bool& bCreated, FString& Err)
	{
		bCreated = false;
		if (T* Existing = LoadObject<T>(nullptr, *ObjectPath(Path), nullptr, LOAD_NoWarn | LOAD_Quiet))
		{
			return Existing;
		}
		if (!FPackageName::IsValidLongPackageName(Path))
		{
			Err = FString::Printf(TEXT("'%s' is not a valid package path (e.g. /Game/Anims/PSS_Loco)"), *Path);
			return nullptr;
		}
		UPackage* Pkg = CreatePackage(*Path);
		T* Obj = NewObject<T>(Pkg, *FPackageName::GetShortName(Path), RF_Public | RF_Standalone | RF_Transactional);
		FAssetRegistryModule::AssetCreated(Obj);
		Obj->MarkPackageDirty();
		bCreated = true;
		return Obj;
	}

	// GetAssetForPose is not exported from PoseSearch (LNK2019); the Safe variant is.
	const FSearchIndexAsset& AssetOf(const FSearchIndex& Index, int32 PoseIdx)
	{
		static const FSearchIndexAsset Empty;
		const FSearchIndexAsset* A = Index.GetAssetForPoseSafe(PoseIdx);
		return A ? *A : Empty;
	}

	const TCHAR* ResultName(EAsyncBuildIndexResult R)
	{
		return R == EAsyncBuildIndexResult::Success ? TEXT("Success") : R == EAsyncBuildIndexResult::Failed ? TEXT("Failed") : TEXT("InProgress");
	}

	TSharedRef<FJsonObject> Describe(const UPoseSearchDatabase* Db, bool bIndexReady)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("database"), Db->GetPathName());
		const UPoseSearchSchema* Schema = Db->Schema;
		O->SetStringField(TEXT("schema"), Schema ? Schema->GetPathName() : TEXT(""));
		if (Schema)
		{
			O->SetNumberField(TEXT("sampleRate"), Schema->SampleRate);
			O->SetNumberField(TEXT("cardinality"), Schema->SchemaCardinality);
			TArray<TSharedPtr<FJsonValue>> Ch;
			for (const TObjectPtr<UPoseSearchFeatureChannel>& C : Schema->GetChannels())
			{
				if (C) Ch.Add(MakeShared<FJsonValueString>(C->GetClass()->GetName()));
			}
			O->SetArrayField(TEXT("channels"), Ch);
			TArray<TSharedPtr<FJsonValue>> Sk;
			for (const FPoseSearchRoledSkeleton& R : Schema->GetRoledSkeletons())
			{
				Sk.Add(MakeShared<FJsonValueString>(R.Skeleton ? R.Skeleton->GetPathName() : TEXT("")));
			}
			O->SetArrayField(TEXT("skeletons"), Sk);
		}
		TArray<TSharedPtr<FJsonValue>> Assets;
		for (int32 i = 0; i < Db->GetNumAnimationAssets(); ++i)
		{
			const UObject* A = Db->GetAnimationAsset(i);
			Assets.Add(MakeShared<FJsonValueString>(A ? A->GetPathName() : TEXT("")));
		}
		O->SetArrayField(TEXT("assets"), Assets);
		O->SetBoolField(TEXT("indexReady"), bIndexReady);
		if (bIndexReady)
		{
			const FSearchIndex& Index = Db->GetSearchIndex();
			O->SetNumberField(TEXT("poses"), Index.GetNumPoses());
			// Pose count per source asset (non-mirrored), from the index's asset table.
			TMap<int32, int32> PerAsset;
			for (int32 p = 0; p < Index.GetNumPoses(); ++p)
			{
				PerAsset.FindOrAdd(AssetOf(Index, p).GetSourceAssetIdx())++;
			}
			TArray<TSharedPtr<FJsonValue>> Counts;
			for (int32 i = 0; i < Db->GetNumAnimationAssets(); ++i)
			{
				TSharedRef<FJsonObject> C = MakeShared<FJsonObject>();
				const UObject* A = Db->GetAnimationAsset(i);
				C->SetStringField(TEXT("asset"), A ? A->GetPathName() : TEXT(""));
				C->SetNumberField(TEXT("poses"), PerAsset.FindRef(i));
				if (const UAnimSequenceBase* S = Cast<UAnimSequenceBase>(A)) C->SetNumberField(TEXT("length"), S->GetPlayLength());
				Counts.Add(MakeShared<FJsonValueObject>(C));
			}
			O->SetArrayField(TEXT("perAsset"), Counts);
		}
		return O;
	}

	FString HandleBuild(const FString& Body)
	{
		TSharedPtr<FJsonObject> J = Parse(Body);
		if (!J.IsValid()) return Error(TEXT("Invalid JSON body"));
		const FString SchemaPath = J->GetStringField(TEXT("schema"));
		const FString DbPath = J->GetStringField(TEXT("database"));
		const FString SkelPath = J->GetStringField(TEXT("skeleton"));
		const TArray<TSharedPtr<FJsonValue>>* Seqs = nullptr;
		if (SchemaPath.IsEmpty() || DbPath.IsEmpty() || SkelPath.IsEmpty() || !J->TryGetArrayField(TEXT("sequences"), Seqs) || Seqs->Num() == 0)
		{
			return Error(TEXT("Need schema, database, skeleton and a non-empty sequences list"));
		}
		USkeleton* Skel = LoadObject<USkeleton>(nullptr, *ObjectPath(SkelPath));
		if (!Skel) return Error(FString::Printf(TEXT("Skeleton '%s' not found"), *SkelPath));
		TArray<UAnimSequence*> Anims;
		for (const TSharedPtr<FJsonValue>& V : *Seqs)
		{
			UAnimSequence* A = LoadObject<UAnimSequence>(nullptr, *ObjectPath(V->AsString()));
			if (!A) return Error(FString::Printf(TEXT("AnimSequence '%s' not found (nothing was changed)"), *V->AsString()));
			if (A->GetSkeleton() != Skel && !Skel->IsCompatibleForEditor(A->GetSkeleton()))
			{
				return Error(FString::Printf(TEXT("'%s' uses another skeleton (nothing was changed)"), *A->GetPathName()));
			}
			Anims.Add(A);
		}
		FString Err;
		bool bNewSchema = false, bNewDb = false;
		UPoseSearchSchema* Schema = LoadOrCreate<UPoseSearchSchema>(SchemaPath, bNewSchema, Err);
		if (!Schema) return Error(Err);
		UPoseSearchDatabase* Db = LoadOrCreate<UPoseSearchDatabase>(DbPath, bNewDb, Err);
		if (!Db) return Error(Err);

		Schema->Modify();
		double Rate = 0;
		if (J->TryGetNumberField(TEXT("sampleRate"), Rate) && Rate > 0) Schema->SampleRate = (int32)Rate;
		bool bHasSkel = false;
		for (const FPoseSearchRoledSkeleton& R : Schema->GetRoledSkeletons()) bHasSkel |= (R.Skeleton == Skel);
		if (!bHasSkel) Schema->AddSkeleton(Skel);
		if (Schema->GetChannels().Num() == 0) Schema->AddDefaultChannels();   // trajectory + pose (mannequin feet)
		Schema->PostEditChange();

		Db->Modify();
		Db->Schema = Schema;
		Db->PoseSearchMode = EPoseSearchMode::BruteForce;
		bool bReplace = true;
		J->TryGetBoolField(TEXT("replace"), bReplace);
		if (bReplace)
		{
			while (Db->GetNumAnimationAssets() > 0) Db->RemoveAnimationAssetAt(Db->GetNumAnimationAssets() - 1);
		}
		for (UAnimSequence* A : Anims)
		{
			FPoseSearchDatabaseSequence Entry;
			Entry.Sequence = A;
			Db->AddAnimationAsset(FInstancedStruct::Make(Entry));
		}
		Db->PostEditChange();

		const bool bSavedSchema = UEditorAssetLibrary::SaveLoadedAsset(Schema, false);
		const bool bSavedDb = UEditorAssetLibrary::SaveLoadedAsset(Db, false);
		const EAsyncBuildIndexResult R = FAsyncPoseSearchDatabasesManagement::RequestAsyncBuildIndex(Db,
			ERequestAsyncBuildFlag::NewRequest | ERequestAsyncBuildFlag::WaitForCompletion);

		TSharedRef<FJsonObject> O = Describe(Db, R == EAsyncBuildIndexResult::Success);
		O->SetBoolField(TEXT("success"), R == EAsyncBuildIndexResult::Success && bSavedSchema && bSavedDb);
		O->SetStringField(TEXT("build"), ResultName(R));
		O->SetBoolField(TEXT("schemaCreated"), bNewSchema);
		O->SetBoolField(TEXT("databaseCreated"), bNewDb);
		O->SetBoolField(TEXT("saved"), bSavedSchema && bSavedDb);
		return ToJson(O);
	}

	UPoseSearchDatabase* ReadyDb(const FString& Path, FString& Err)
	{
		UPoseSearchDatabase* Db = LoadObject<UPoseSearchDatabase>(nullptr, *ObjectPath(Path));
		if (!Db) { Err = FString::Printf(TEXT("PoseSearchDatabase '%s' not found"), *Path); return nullptr; }
		const EAsyncBuildIndexResult R = FAsyncPoseSearchDatabasesManagement::RequestAsyncBuildIndex(Db,
			ERequestAsyncBuildFlag::ContinueRequest | ERequestAsyncBuildFlag::WaitForCompletion);
		if (R != EAsyncBuildIndexResult::Success) { Err = FString::Printf(TEXT("Index not ready (%s)"), ResultName(R)); return nullptr; }
		return Db;
	}

	FString HandleStatus(const FString& Body)
	{
		TSharedPtr<FJsonObject> J = Parse(Body);
		if (!J.IsValid()) return Error(TEXT("Invalid JSON body"));
		UPoseSearchDatabase* Db = LoadObject<UPoseSearchDatabase>(nullptr, *ObjectPath(J->GetStringField(TEXT("database"))));
		if (!Db) return Error(TEXT("PoseSearchDatabase not found"));
		const EAsyncBuildIndexResult R = FAsyncPoseSearchDatabasesManagement::RequestAsyncBuildIndex(Db,
			ERequestAsyncBuildFlag::ContinueRequest | ERequestAsyncBuildFlag::WaitForCompletion);
		TSharedRef<FJsonObject> O = Describe(Db, R == EAsyncBuildIndexResult::Success);
		O->SetStringField(TEXT("build"), ResultName(R));
		O->SetBoolField(TEXT("success"), true);
		return ToJson(O);
	}

	FString HandleQuery(const FString& Body)
	{
		TSharedPtr<FJsonObject> J = Parse(Body);
		if (!J.IsValid()) return Error(TEXT("Invalid JSON body"));
		FString Err;
		UPoseSearchDatabase* Db = ReadyDb(J->GetStringField(TEXT("database")), Err);
		if (!Db) return Error(Err);
		UAnimSequence* Seq = LoadObject<UAnimSequence>(nullptr, *ObjectPath(J->GetStringField(TEXT("sequence"))));
		if (!Seq) return Error(TEXT("Query sequence not found"));
		const float Time = (float)J->GetNumberField(TEXT("time"));
		bool bExcludeSame = false;
		J->TryGetBoolField(TEXT("excludeSameAsset"), bExcludeSame);

		const FSearchIndex& Index = Db->GetSearchIndex();
		const int32 QueryIdx = Db->GetPoseIndex(Seq, Time, false, FVector::ZeroVector);
		if (QueryIdx == INDEX_NONE) return Error(FString::Printf(TEXT("No indexed pose for '%s' at %.3f s (the database trims clip ends)"), *Seq->GetName(), Time));
		TArray<float> QBuf, PBuf;
		const TArray<float> Query(Index.GetPoseValuesSafe(QueryIdx, QBuf));
		const int32 QueryAsset = AssetOf(Index, QueryIdx).GetSourceAssetIdx();

		int32 Best = INDEX_NONE;
		float BestCost = TNumericLimits<float>::Max();
		float SelfCost = -1.f;
		for (int32 p = 0; p < Index.GetNumPoses(); ++p)
		{
			const FSearchIndexAsset& A = AssetOf(Index, p);
			const float Cost = CompareFeatureVectors(Query, Index.GetPoseValuesSafe(p, PBuf));
			if (p == QueryIdx) SelfCost = Cost;
			if (bExcludeSame && A.GetSourceAssetIdx() == QueryAsset) continue;
			if (Cost < BestCost) { BestCost = Cost; Best = p; }
		}
		if (Best == INDEX_NONE) return Error(TEXT("No candidate pose (only the query's own asset is indexed?)"));
		const FSearchIndexAsset& BA = AssetOf(Index, Best);
		const UObject* BestAsset = Db->GetAnimationAsset(BA.GetSourceAssetIdx());
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetBoolField(TEXT("success"), true);
		O->SetNumberField(TEXT("queryPose"), QueryIdx);
		O->SetNumberField(TEXT("queryAssetTime"), AssetOf(Index, QueryIdx).GetTimeFromPoseIndex(QueryIdx, Db->Schema->SampleRate));
		O->SetNumberField(TEXT("selfCost"), SelfCost);
		O->SetNumberField(TEXT("bestPose"), Best);
		O->SetStringField(TEXT("bestAsset"), BestAsset ? BestAsset->GetPathName() : TEXT(""));
		O->SetNumberField(TEXT("bestTime"), BA.GetTimeFromPoseIndex(Best, Db->Schema->SampleRate));
		O->SetNumberField(TEXT("bestCost"), BestCost);
		O->SetNumberField(TEXT("poses"), Index.GetNumPoses());
		return ToJson(O);
	}
}

class FBlueprintMCPPoseSearchModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		// Registration must happen during module load (routes are bound once in FBlueprintMCPServer::Start()).
		auto Add = [](const TCHAR* Route, const TCHAR* Key, TFunction<FString(const FString&)> H, bool bMutation)
		{
			FBlueprintMCPServer::FExternalEndpoint E;
			E.Route = Route;
			E.EndpointKey = Key;
			E.Handler = MoveTemp(H);
			E.bIsMutation = bMutation;
			E.bIsPost = true;
			FBlueprintMCPServer::RegisterExternalEndpoint(MoveTemp(E));
		};
		Add(TEXT("/api/posesearch-build"), TEXT("posesearch-build"), &HandleBuild, true);
		Add(TEXT("/api/posesearch-status"), TEXT("posesearch-status"), &HandleStatus, false);
		Add(TEXT("/api/posesearch-query"), TEXT("posesearch-query"), &HandleQuery, false);
	}
};

IMPLEMENT_MODULE(FBlueprintMCPPoseSearchModule, BlueprintMCPPoseSearch);
