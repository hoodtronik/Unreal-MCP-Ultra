#include "BlueprintMCPServer.h"
#include "Animation/AnimMontage.h"
#include "Animation/AnimSequenceBase.h"
#include "Animation/AnimSequence.h"
#include "Dom/JsonValue.h"
#include "Misc/PackageName.h"

// CLAUDE-NOTE (2026-10-22, live 5.6.1): Python can create a montage (AnimMontageFactory) and play it, but cannot read
// or edit its slot tracks, segments or sections (UAnimMontage::SlotAnimTracks / CompositeSections are not exposed to
// Python: "Failed to find property 'slot_anim_tracks'"). These two endpoints fill that gap for the anim_montage tool:
// /api/montage-read returns tracks, segments and sections (with start times and next links); /api/montage-edit
// replaces the segments of one slot track, renames that slot, replaces the sections and sets blend times, then
// recomputes the montage length and saves.

namespace
{
	UAnimMontage* LoadMontage(const FString& InPath, FString& OutError)
	{
		FString Path = InPath;
		if (!Path.Contains(TEXT(".")))
		{
			Path = Path + TEXT(".") + FPackageName::GetShortName(Path);
		}
		UAnimMontage* M = LoadObject<UAnimMontage>(nullptr, *Path);
		if (!M)
		{
			OutError = FString::Printf(TEXT("AnimMontage '%s' not found (pass the object path)"), *InPath);
		}
		return M;
	}

	TSharedRef<FJsonObject> MontageToJson(UAnimMontage* M)
	{
		TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
		R->SetStringField(TEXT("montage"), M->GetPathName());
		R->SetNumberField(TEXT("length"), M->GetPlayLength());
		R->SetNumberField(TEXT("blendIn"), M->BlendIn.GetBlendTime());
		R->SetNumberField(TEXT("blendOut"), M->BlendOut.GetBlendTime());
		R->SetNumberField(TEXT("blendOutTriggerTime"), M->BlendOutTriggerTime);
		R->SetBoolField(TEXT("autoBlendOut"), M->bEnableAutoBlendOut);
		TArray<TSharedPtr<FJsonValue>> Tracks;
		for (const FSlotAnimationTrack& T : M->SlotAnimTracks)
		{
			TSharedRef<FJsonObject> TJ = MakeShared<FJsonObject>();
			TJ->SetStringField(TEXT("slot"), T.SlotName.ToString());
			TArray<TSharedPtr<FJsonValue>> Segs;
			for (const FAnimSegment& S : T.AnimTrack.AnimSegments)
			{
				TSharedRef<FJsonObject> SJ = MakeShared<FJsonObject>();
				const UAnimSequenceBase* A = S.GetAnimReference();
				SJ->SetStringField(TEXT("anim"), A ? A->GetPathName() : TEXT(""));
				SJ->SetNumberField(TEXT("startPos"), S.StartPos);
				SJ->SetNumberField(TEXT("animStart"), S.AnimStartTime);
				SJ->SetNumberField(TEXT("animEnd"), S.AnimEndTime);
				SJ->SetNumberField(TEXT("rate"), S.AnimPlayRate);
				SJ->SetNumberField(TEXT("loops"), S.LoopingCount);
				SJ->SetNumberField(TEXT("length"), S.GetLength());
				Segs.Add(MakeShared<FJsonValueObject>(SJ));
			}
			TJ->SetArrayField(TEXT("segments"), Segs);
			TJ->SetNumberField(TEXT("length"), T.AnimTrack.GetLength());
			Tracks.Add(MakeShared<FJsonValueObject>(TJ));
		}
		R->SetArrayField(TEXT("tracks"), Tracks);
		TArray<TSharedPtr<FJsonValue>> Secs;
		for (const FCompositeSection& C : M->CompositeSections)
		{
			TSharedRef<FJsonObject> CJ = MakeShared<FJsonObject>();
			CJ->SetStringField(TEXT("name"), C.SectionName.ToString());
			CJ->SetNumberField(TEXT("start"), C.GetTime());
			CJ->SetStringField(TEXT("next"), C.NextSectionName.ToString());
			Secs.Add(MakeShared<FJsonValueObject>(CJ));
		}
		R->SetArrayField(TEXT("sections"), Secs);
		return R;
	}
}

FString FBlueprintMCPServer::HandleMontageRead(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) return MakeErrorJson(TEXT("Invalid JSON body"));
	FString Path, Err;
	if (!Json->TryGetStringField(TEXT("montage"), Path) || Path.IsEmpty()) return MakeErrorJson(TEXT("Missing 'montage'"));
	UAnimMontage* M = LoadMontage(Path, Err);
	if (!M) return MakeErrorJson(Err);
	TSharedRef<FJsonObject> R = MontageToJson(M);
	R->SetBoolField(TEXT("success"), true);
	return JsonToString(R);
}

FString FBlueprintMCPServer::HandleMontageEdit(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) return MakeErrorJson(TEXT("Invalid JSON body"));
	FString Path, Err;
	if (!Json->TryGetStringField(TEXT("montage"), Path) || Path.IsEmpty()) return MakeErrorJson(TEXT("Missing 'montage'"));
	UAnimMontage* M = LoadMontage(Path, Err);
	if (!M) return MakeErrorJson(Err);
	if (M->SlotAnimTracks.Num() == 0) return MakeErrorJson(TEXT("Montage has no slot track"));

	int32 TrackIdx = 0;
	double TrackD = 0;
	if (Json->TryGetNumberField(TEXT("track"), TrackD)) TrackIdx = (int32)TrackD;
	if (!M->SlotAnimTracks.IsValidIndex(TrackIdx)) return MakeErrorJson(TEXT("Track index out of range"));

	// Validate everything before touching the asset.
	struct FSegSpec { UAnimSequenceBase* Anim; float AnimStart; float AnimEnd; float Rate; int32 Loops; };
	TArray<FSegSpec> NewSegs;
	const TArray<TSharedPtr<FJsonValue>>* SegArr = nullptr;
	const bool bSegs = Json->TryGetArrayField(TEXT("segments"), SegArr) && SegArr && SegArr->Num() > 0;
	if (bSegs)
	{
		for (const TSharedPtr<FJsonValue>& V : *SegArr)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			if (!O.IsValid()) return MakeErrorJson(TEXT("segments[] must be objects"));
			FString AnimPath = O->GetStringField(TEXT("anim"));
			if (!AnimPath.Contains(TEXT("."))) AnimPath = AnimPath + TEXT(".") + FPackageName::GetShortName(AnimPath);
			UAnimSequenceBase* A = LoadObject<UAnimSequenceBase>(nullptr, *AnimPath);
			if (!A) return MakeErrorJson(FString::Printf(TEXT("Segment anim '%s' not found (nothing was changed)"), *O->GetStringField(TEXT("anim"))));
			if (A->GetSkeleton() && M->GetSkeleton() && !M->GetSkeleton()->IsCompatibleForEditor(A->GetSkeleton()))
			{
				return MakeErrorJson(FString::Printf(TEXT("Segment anim '%s' uses another skeleton (nothing was changed)"), *A->GetPathName()));
			}
			const float Len = A->GetPlayLength();
			double S = 0, E = Len, Rt = 1, Lp = 1;
			O->TryGetNumberField(TEXT("animStart"), S);
			O->TryGetNumberField(TEXT("animEnd"), E);
			O->TryGetNumberField(TEXT("rate"), Rt);
			O->TryGetNumberField(TEXT("loops"), Lp);
			if (S < 0 || E > Len + 1e-3 || E <= S) return MakeErrorJson(FString::Printf(TEXT("Segment '%s': need 0 <= animStart < animEnd <= %.3f"), *A->GetName(), Len));
			if (Rt <= 0 || Lp < 1) return MakeErrorJson(TEXT("Segment rate must be > 0 and loops >= 1"));
			NewSegs.Add({ A, (float)S, (float)E, (float)Rt, (int32)Lp });
		}
	}

	M->Modify();
	FSlotAnimationTrack& Track = M->SlotAnimTracks[TrackIdx];
	FString Slot;
	if (Json->TryGetStringField(TEXT("slot"), Slot) && !Slot.IsEmpty())
	{
		Track.SlotName = FName(*Slot);
	}
	if (bSegs)
	{
		Track.AnimTrack.AnimSegments.Empty();
		float Pos = 0.f;
		for (const FSegSpec& Sp : NewSegs)
		{
			FAnimSegment Seg;
			Seg.SetAnimReference(Sp.Anim, true);
			Seg.AnimStartTime = Sp.AnimStart;
			Seg.AnimEndTime = Sp.AnimEnd;
			Seg.AnimPlayRate = Sp.Rate;
			Seg.LoopingCount = Sp.Loops;
			Seg.StartPos = Pos;
			Pos += Seg.GetLength();
			Track.AnimTrack.AnimSegments.Add(Seg);
		}
	}
	// Length = the longest track (the montage editor does the same on segment edits).
	float Length = 0.f;
	for (const FSlotAnimationTrack& T : M->SlotAnimTracks) Length = FMath::Max(Length, T.AnimTrack.GetLength());
	static_cast<UAnimCompositeBase*>(M)->SetCompositeLength(Length);

	double BI = -1, BO = -1;
	if (Json->TryGetNumberField(TEXT("blendIn"), BI) && BI >= 0) M->BlendIn.SetBlendTime((float)BI);
	if (Json->TryGetNumberField(TEXT("blendOut"), BO) && BO >= 0) M->BlendOut.SetBlendTime((float)BO);

	const TArray<TSharedPtr<FJsonValue>>* SecArr = nullptr;
	if (Json->TryGetArrayField(TEXT("sections"), SecArr) && SecArr && SecArr->Num() > 0)
	{
		// Replace all sections. The montage needs a section at 0; sections play in time order and by default link to the
		// next one (the editor's behaviour); "next" overrides the link ("" = stop, own name = loop).
		M->CompositeSections.Empty();
		for (const TSharedPtr<FJsonValue>& V : *SecArr)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			const FString Name = O->GetStringField(TEXT("name"));
			double Start = O->GetNumberField(TEXT("start"));
			if (Start < 0 || Start > Length + 1e-3) return MakeErrorJson(FString::Printf(TEXT("Section '%s' start %.3f outside 0..%.3f (montage left WITHOUT sections - re-run)"), *Name, Start, Length));
			if (M->AddAnimCompositeSection(FName(*Name), (float)Start) == INDEX_NONE)
			{
				return MakeErrorJson(FString::Printf(TEXT("Section name '%s' is not unique (montage left partial - re-run)"), *Name));
			}
		}
		// AddAnimCompositeSection sorts by start; link each to the following one unless "next" was given.
		for (int32 i = 0; i < M->CompositeSections.Num(); ++i)
		{
			FCompositeSection& C = M->CompositeSections[i];
			C.NextSectionName = i + 1 < M->CompositeSections.Num() ? M->CompositeSections[i + 1].SectionName : NAME_None;
		}
		for (const TSharedPtr<FJsonValue>& V : *SecArr)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			FString Next;
			if (O->TryGetStringField(TEXT("next"), Next))
			{
				const int32 Idx = M->GetSectionIndex(FName(*O->GetStringField(TEXT("name"))));
				if (Idx != INDEX_NONE) M->CompositeSections[Idx].NextSectionName = Next.IsEmpty() ? NAME_None : FName(*Next);
			}
		}
	}
	M->UpdateLinkableElements();
	M->PostEditChange();
	M->MarkPackageDirty();
	const bool bSaved = SaveGenericPackage(M);

	TSharedRef<FJsonObject> R = MontageToJson(M);
	R->SetBoolField(TEXT("success"), bSaved);
	R->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(R);
}
