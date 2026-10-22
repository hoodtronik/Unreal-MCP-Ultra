// Blend profiles / blend masks on a Skeleton (create or update, per-bone scales), for transitions (TimeFactor /
// WeightFactor) and for LayeredBoneBlend in BlendMask mode.

#include "BlueprintMCPServer.h"

#include "Animation/BlendProfile.h"
#include "Animation/Skeleton.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

// CLAUDE-NOTE (2026-10-22): Python exposes only Skeleton.get_blend_profile - no way to create a profile or set bone
// scales - so masks for LayeredBoneBlend (BlendMask mode) could not be authored. This creates/updates one.
FString FBlueprintMCPServer::HandleSetBlendProfile(const FString& Body)
{
	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body")); }
	FString SkelPath, Name, ModeText = TEXT("BlendMask");
	if (!Json->TryGetStringField(TEXT("skeleton"), SkelPath)) { return MakeErrorJson(TEXT("Missing 'skeleton'")); }
	if (!Json->TryGetStringField(TEXT("name"), Name)) { return MakeErrorJson(TEXT("Missing 'name'")); }
	Json->TryGetStringField(TEXT("mode"), ModeText);
	USkeleton* Skel = LoadObject<USkeleton>(nullptr, *SkelPath);
	if (!Skel) { return MakeErrorJson(FString::Printf(TEXT("Skeleton not found: %s"), *SkelPath)); }

	const TArray<TSharedPtr<FJsonValue>>* Bones = nullptr;
	Json->TryGetArrayField(TEXT("bones"), Bones);
	// validate every bone first: nothing is written when one is wrong
	TArray<FString> Missing;
	if (Bones)
	{
		for (const TSharedPtr<FJsonValue>& V : *Bones)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			FString Bone;
			if (!O.IsValid() || !O->TryGetStringField(TEXT("bone"), Bone) || Skel->GetReferenceSkeleton().FindBoneIndex(FName(*Bone)) == INDEX_NONE)
			{
				Missing.Add(Bone);
			}
		}
	}
	if (Missing.Num()) { return MakeErrorJson(FString::Printf(TEXT("Bones not in %s: %s"), *Skel->GetName(), *FString::Join(Missing, TEXT(", ")))); }

	Skel->Modify();
	bool bRemove = false;
	Json->TryGetBoolField(TEXT("remove"), bRemove);
	if (bRemove)
	{
		UBlendProfile* Existing = Skel->GetBlendProfile(FName(*Name));
		if (!Existing) { return MakeErrorJson(FString::Printf(TEXT("No blend profile '%s' on %s"), *Name, *Skel->GetName())); }
		Skel->BlendProfiles.Remove(Existing);
		Skel->MarkPackageDirty();
		UPackage* RPkg = Skel->GetOutermost();
		FSavePackageArgs RArgs;
		RArgs.TopLevelFlags = RF_Public | RF_Standalone;
		RArgs.SaveFlags = SAVE_NoError;
		const bool bRSaved = UPackage::SavePackage(RPkg, Skel, *FPackageName::LongPackageNameToFilename(RPkg->GetName(), FPackageName::GetAssetPackageExtension()), RArgs);
		TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
		R->SetBoolField(TEXT("removed"), Skel->GetBlendProfile(FName(*Name)) == nullptr);
		R->SetBoolField(TEXT("saved"), bRSaved);
		return JsonToString(R);
	}
	UBlendProfile* Profile = Skel->GetBlendProfile(FName(*Name));
	const bool bCreated = Profile == nullptr;
	if (!Profile) { Profile = Skel->CreateNewBlendProfile(FName(*Name)); }
	if (!Profile) { return MakeErrorJson(TEXT("CreateNewBlendProfile failed")); }
	Profile->Modify();
	Profile->Mode = ModeText.Equals(TEXT("TimeFactor"), ESearchCase::IgnoreCase) ? EBlendProfileMode::TimeFactor
		: ModeText.Equals(TEXT("WeightFactor"), ESearchCase::IgnoreCase) ? EBlendProfileMode::WeightFactor : EBlendProfileMode::BlendMask;
	bool bClear = false;
	Json->TryGetBoolField(TEXT("clear"), bClear);
	if (bClear) { Profile->ProfileEntries.Reset(); }
	if (Bones)
	{
		for (const TSharedPtr<FJsonValue>& V : *Bones)
		{
			const TSharedPtr<FJsonObject> O = V->AsObject();
			FString Bone; double Scale = 1.0; bool bRecurse = true;
			O->TryGetStringField(TEXT("bone"), Bone);
			O->TryGetNumberField(TEXT("scale"), Scale);
			O->TryGetBoolField(TEXT("recurse"), bRecurse);
			Profile->SetBoneBlendScale(FName(*Bone), (float)Scale, bRecurse, true);
		}
	}
	Skel->MarkPackageDirty();
	UPackage* Pkg = Skel->GetOutermost();
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	const bool bSaved = UPackage::SavePackage(Pkg, Skel, *FPackageName::LongPackageNameToFilename(Pkg->GetName(), FPackageName::GetAssetPackageExtension()), Args);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("profile"), Profile->GetPathName());
	Result->SetBoolField(TEXT("created"), bCreated);
	Result->SetStringField(TEXT("mode"), Profile->Mode == EBlendProfileMode::TimeFactor ? TEXT("TimeFactor") : Profile->Mode == EBlendProfileMode::WeightFactor ? TEXT("WeightFactor") : TEXT("BlendMask"));
	Result->SetNumberField(TEXT("entries"), Profile->GetNumBlendEntries());
	TSharedRef<FJsonObject> Probe = MakeShared<FJsonObject>();
	const TArray<TSharedPtr<FJsonValue>>* ProbeBones = nullptr;
	if (Json->TryGetArrayField(TEXT("probe"), ProbeBones))
	{
		for (const TSharedPtr<FJsonValue>& V : *ProbeBones)
		{
			const FString B = V->AsString();
			Probe->SetNumberField(B, Profile->GetBoneBlendScale(FName(*B)));
		}
	}
	Result->SetObjectField(TEXT("probe"), Probe);
	Result->SetBoolField(TEXT("saved"), bSaved);
	return JsonToString(Result);
}
