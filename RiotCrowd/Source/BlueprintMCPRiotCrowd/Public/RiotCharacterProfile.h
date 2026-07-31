#pragma once

#include "CoreMinimal.h"
#include "RiotCrowdTypes.h"

class FJsonObject;

/**
 * Rigged-character profiles and representation profiles.
 *
 * CLAUDE-NOTE: plain structs in an editor-side store, exactly like FRiotScenario and for the same
 * reason (see RiotScenario.h) — profiles are authored over MCP before PIE starts and must survive
 * PIE start/stop cycles. A UObject or world subsystem would lose every profile on world teardown,
 * which would make "register profiles, then run the scenario three times" impossible.
 *
 * Asset REFERENCES are stored as path strings rather than TSoftObjectPtr. The profile model is
 * deliberately free of engine asset types so it compiles and round-trips identically whether or not
 * Mass/rendering is available, matching the RiotCrowdTypes.h separation. Resolution and validation
 * happen in one place (ValidateRiotCharacterProfile) where the assets are actually loaded.
 */

/** Current schema version. Bump when a field's meaning changes, not when one is added. */
inline constexpr int32 RiotCharacterProfileSchemaVersion = 1;
inline constexpr int32 RiotRepresentationProfileSchemaVersion = 1;

/**
 * How a profile's animation is driven.
 *
 * CLAUDE-NOTE: both modes exist in the model from day one because the public MCP schema must not
 * change shape when the second one ships. The capability report distinguishes implemented-and-proven
 * from implemented-but-unproven, so a mode being present here is not a claim that it is live.
 */
enum class ERiotAnimationMode : uint8
{
	/** Profile supplies an Animation Blueprint which reads Riot state from the character actor. */
	AnimationBlueprint,
	/** Riot Crowd selects and plays mapped Animation Sequences directly on the mesh component. */
	SequenceSet,
};

/**
 * Animation slots a profile can bind.
 *
 * CLAUDE-NOTE: slots are named for RIOT INTENT, not for agent state, and are shared between rioters
 * and defenders where the intent is the same (Inactive). The state->slot mapping is a function of
 * faction type and lives in RiotAnimationSlotForState() — keeping it in one place is what lets the
 * mapping be documented and tested rather than scattered through the representation code.
 */
enum class ERiotAnimationSlot : uint8
{
	// ----- rioter -----
	Idle,
	Gathering,
	Advancing,
	Pressuring,
	Breaching,
	Panicked,
	Retreating,
	// ----- defender -----
	Holding,
	Bracing,
	Fallback,
	Broken,
	// ----- shared -----
	Inactive,

	Max,
};

/** Outcome of validating a profile against real loaded assets. */
enum class ERiotValidationState : uint8
{
	/** Registered but never validated. Never a successful simulation input. */
	NotValidated,
	/** Every asset resolved and every required slot bound. */
	Valid,
	/** Usable, but something fell back or is missing a non-required slot. See Warnings. */
	Warning,
	/** Unusable. The profile is retained so the operator can read why, but it is never selected. */
	Invalid,
};

/** Which camera drives representation LOD. */
enum class ERiotCameraSource : uint8
{
	/** The active PIE player camera. Engine default: MassLODSubsystem already gathers it. */
	PiePlayerCamera,
	/** An explicit world-space transform supplied by the operator. */
	ExplicitTransform,
	/** The active Sequencer camera. Not claimed as supported unless live-proven. */
	SequencerCamera,
};

/** What a agent falls back to when it has no valid character profile. */
enum class ERiotRepresentationFallback : uint8
{
	/** The foundation's placeholder cylinder/cube. Diagnostic only — never a successful result. */
	PlaceholderMesh,
	/** Render nothing. */
	Hidden,
};

/** One animation binding within a profile. */
struct FRiotAnimationBinding
{
	ERiotAnimationSlot Slot = ERiotAnimationSlot::Idle;
	/** Object path to an AnimSequence (or BlendSpace, when supported). */
	FString AnimationPath;
	/** Base play rate. Per-agent deterministic variation multiplies this; see the architecture doc. */
	double PlayRate = 1.0;
	bool bLooping = true;
	/**
	 * Ground speed (uu/s) this clip was authored for. When > 0, playback rate is additionally scaled
	 * by (actual agent speed / this), clamped, so feet track the ground instead of sliding.
	 *
	 * CLAUDE-NOTE: exists because the milestone requires playback speed to derive from agent
	 * velocity, and because the mismatch is visible - the user watched agents travel slower than
	 * their run cycle suggested. 0 (the default) means "play at the fixed rate", which is right for
	 * non-locomotion clips like attacks, deaths and idles.
	 */
	double ReferenceSpeed = 0.0;
	/**
	 * Minimum agent speed (uu/s) for this binding to apply. Lets one slot carry a walk clip from 0
	 * and a jog clip from, say, 280, so clip CHOICE follows speed as well as playback rate.
	 *
	 * CLAUDE-NOTE: added because rate scaling alone could not make a mixed crowd read - the user
	 * watched an advance where every agent played the walk clip, and at 400uu/s a 1.7x walk reads as
	 * a runner, so "there are no walkers" even though the walk clip was playing everywhere. One clip
	 * per state cannot express walk-or-run; a threshold per binding can.
	 */
	double MinSpeed = 0.0;
};

/**
 * A registered rigged character.
 *
 * CLAUDE-NOTE: profiles are NOT hardcoded into the plugin. Every asset is supplied by the operator
 * as a project asset path, which is the milestone's hard requirement — the plugin ships no character
 * content and must work against whatever a project already owns.
 */
struct FRiotCharacterProfile
{
	FString ProfileId;
	FString DisplayName;
	int32 SchemaVersion = RiotCharacterProfileSchemaVersion;

	/** Which faction types this profile may represent. Empty = any. */
	TArray<ERiotFactionType> FactionTypes;

	/**
	 * Relative likelihood of this profile being picked among the eligible profiles for a faction.
	 * Must be > 0. Selection is deterministic given the scenario seed; see SelectProfileForAgent.
	 */
	double SelectionWeight = 1.0;

	FString SkeletalMeshPath;
	FString SkeletonPath;

	ERiotAnimationMode AnimationMode = ERiotAnimationMode::SequenceSet;
	/** Required when AnimationMode == AnimationBlueprint. */
	FString AnimationBlueprintPath;
	TArray<FRiotAnimationBinding> AnimationSet;

	/** Material overrides by material slot index. Empty entries leave the mesh's own material. */
	TArray<FString> MaterialOverrides;

	/**
	 * Yaw applied to the mesh component relative to the actor, in degrees.
	 *
	 * CLAUDE-NOTE: defaults to -90 because Epic's skeletal meshes (Manny/Quinn and everything else
	 * derived from the UE mannequin) are authored facing +Y, while the actor's forward is +X — the
	 * Third Person template's character BP applies exactly this -90 on its mesh component. Without
	 * it the whole crowd visibly runs sideways, which is how the user found it. Per-profile rather
	 * than hardcoded because an operator's own characters may be authored with any forward axis.
	 */
	double MeshYawOffsetDegrees = -90.0;

	/** Which representation profile governs this character's LOD. Empty = the scenario default. */
	FString RepresentationProfileId;

	bool bEnabled = true;

	// ----- validation results, filled by ValidateRiotCharacterProfile -----
	ERiotValidationState ValidationState = ERiotValidationState::NotValidated;
	TArray<FString> Warnings;
	/** Populated only when ValidationState == Invalid. */
	FString FailureCode;
	FString FailureMessage;

	const FRiotAnimationBinding* FindBinding(ERiotAnimationSlot Slot) const;

	/** Speed-aware lookup: among this slot's bindings, the one with the highest MinSpeed <= Speed. */
	const FRiotAnimationBinding* FindBindingForSpeed(ERiotAnimationSlot Slot, double Speed) const;

	/** True when this profile may be used for an agent of the given faction type. */
	bool SupportsFactionType(ERiotFactionType Type) const;

	/** Usable as a real (non-placeholder) representation. */
	bool IsUsable() const
	{
		return bEnabled
			&& (ValidationState == ERiotValidationState::Valid
				|| ValidationState == ERiotValidationState::Warning);
	}

	TSharedRef<FJsonObject> ToJson() const;
};

/**
 * Distance thresholds, budgets and update rates for the three representation tiers.
 *
 * CLAUDE-NOTE: HysteresisDistance is expressed in ABSOLUTE Unreal units even though the engine's
 * FMassVisualizationLODParameters expresses hysteresis as a PERCENTAGE of the band distance
 * (BufferHysteresisOnDistancePercentage, default 10%). The public MCP vocabulary must stay
 * engine-agnostic, and an absolute distance is the form an operator can reason about, so the
 * conversion happens at apply time. One absolute value maps to a different percentage per band; that
 * is reported rather than hidden. See UE56-RIGGED-REPRESENTATION-API-FINDINGS.md §8.
 */
struct FRiotRepresentationProfile
{
	FString ProfileId;
	int32 SchemaVersion = RiotRepresentationProfileSchemaVersion;

	/** Tier 1 (full skeletal) applies from 0 to NearDistance. */
	double NearDistance = 2500.0;
	/** Tier 2 (cheap skeletal) applies from NearDistance to MidDistance. */
	double MidDistance = 7000.0;
	/** Tier 3 (animated instances) applies from MidDistance to FarDistance. Beyond it: nothing. */
	double FarDistance = 20000.0;
	/** Band-edge dead zone, absolute uu, applied symmetrically. 0 disables hysteresis. */
	double HysteresisDistance = 500.0;

	int32 MaxNearActors = 24;
	int32 MaxMidRepresentations = 200;
	bool bFarRepresentationEnabled = true;

	/** Seconds between representation updates per tier. 0 = every frame. */
	double NearUpdateInterval = 0.0;
	double MidUpdateInterval = 0.1;
	double FarUpdateInterval = 0.25;

	ERiotCameraSource CameraSource = ERiotCameraSource::PiePlayerCamera;
	/** Used only when CameraSource == ExplicitTransform. */
	FTransform ExplicitCameraTransform = FTransform::Identity;

	ERiotRepresentationFallback FallbackBehavior = ERiotRepresentationFallback::PlaceholderMesh;

	TSharedRef<FJsonObject> ToJson() const;
};

/**
 * Process-wide profile store.
 *
 * CLAUDE-NOTE: same singleton rationale as FRiotScenarioStore — must outlive PIE worlds. Kept as a
 * separate store rather than fields on FRiotScenario because profiles are reusable ACROSS scenarios;
 * a scenario references them by id. That is also what makes "delete a profile that is in use" a
 * meaningful error rather than an impossible one.
 */
class FRiotCharacterProfileStore
{
public:
	static FRiotCharacterProfileStore& Get();

	// ----- character profiles -----
	FRiotCharacterProfile* Find(const FString& ProfileId);
	const FRiotCharacterProfile* Find(const FString& ProfileId) const;
	FRiotCharacterProfile& Add(FRiotCharacterProfile Profile);
	bool Remove(const FString& ProfileId);
	const TArray<FRiotCharacterProfile>& All() const { return Profiles; }
	TArray<FRiotCharacterProfile>& AllMutable() { return Profiles; }

	// ----- representation profiles -----
	FRiotRepresentationProfile* FindRepresentation(const FString& ProfileId);
	const FRiotRepresentationProfile* FindRepresentation(const FString& ProfileId) const;
	FRiotRepresentationProfile& AddRepresentation(FRiotRepresentationProfile Profile);
	bool RemoveRepresentation(const FString& ProfileId);
	const TArray<FRiotRepresentationProfile>& AllRepresentations() const { return RepresentationProfiles; }

	/** Wipes both tables. Test-support only; never called by a tool. */
	void ResetForTests();

private:
	TArray<FRiotCharacterProfile> Profiles;
	TArray<FRiotRepresentationProfile> RepresentationProfiles;
};

// ============================================================
// State -> animation slot mapping
// ============================================================

/**
 * The single authoritative mapping from simulation state to animation intent.
 *
 * CLAUDE-NOTE: faction-dependent on purpose. The same ERiotAgentState means different things to a
 * rioter and to a defender — Pressuring is a rioter pushing forward and a defender bracing against
 * that push, and Breaching is a rioter breaking through and a defender's line breaking. Mapping both
 * through one table would force one of the two to animate wrongly.
 */
ERiotAnimationSlot RiotAnimationSlotForState(ERiotAgentState State, ERiotFactionType FactionType);

/**
 * Fallback chain for a slot: what to play when the profile has no binding for it.
 * Returns Max when the slot IS the chain root (Idle), i.e. there is nothing further to fall back to.
 */
ERiotAnimationSlot RiotAnimationSlotFallback(ERiotAnimationSlot Slot);

/**
 * Resolves a slot to a bound slot by walking the fallback chain.
 * Returns false when nothing in the chain is bound.
 * bOutUsedFallback reports whether the result differs from the requested slot, so the runtime report
 * can state honestly how much of what is on screen is a reused animation.
 */
bool ResolveRiotAnimationSlot(const FRiotCharacterProfile& Profile, ERiotAnimationSlot Requested,
	ERiotAnimationSlot& OutResolved, bool& bOutUsedFallback);

/** Slots that must resolve for a profile to be Valid rather than Invalid, given its faction types. */
TArray<ERiotAnimationSlot> RequiredRiotAnimationSlots(const FRiotCharacterProfile& Profile);

const TCHAR* LexToStringRiotAnimationSlot(ERiotAnimationSlot Slot);
const TCHAR* LexToStringRiotAnimationMode(ERiotAnimationMode Mode);
const TCHAR* LexToStringRiotValidationState(ERiotValidationState State);
const TCHAR* LexToStringRiotCameraSource(ERiotCameraSource Source);
bool LexFromStringRiotAnimationSlot(const FString& In, ERiotAnimationSlot& Out);
bool LexFromStringRiotAnimationMode(const FString& In, ERiotAnimationMode& Out);
bool LexFromStringRiotCameraSource(const FString& In, ERiotCameraSource& Out);
bool LexFromStringRiotFactionType(const FString& In, ERiotFactionType& Out);

// ============================================================
// Validation
// ============================================================

/**
 * Structural validation only: ids, weights, mode/field consistency. Loads nothing.
 *
 * CLAUDE-NOTE: split from asset validation so the schema can be checked in the automated suite
 * without a loaded editor or any project content, and so a dry run can report exactly what a real
 * call would reject before touching the store.
 */
bool ValidateRiotCharacterProfileSchema(const FRiotCharacterProfile& Profile,
	FString& OutErrorCode, FString& OutMessage);

/**
 * Full validation: loads and interrogates every referenced asset, checks skeleton compatibility for
 * the mesh and for every animation, and resolves every required slot.
 *
 * Writes ValidationState, Warnings, FailureCode and FailureMessage onto the profile.
 *
 * CLAUDE-NOTE: a parseable path is never treated as proof. Each asset is loaded and its type and
 * skeleton checked, because the failure this guards against — an animation authored for a different
 * skeleton — resolves and loads perfectly well and then plays as garbage.
 */
bool ValidateRiotCharacterProfileAssets(FRiotCharacterProfile& Profile,
	FString& OutErrorCode, FString& OutMessage);

/** Distances ordered and positive, hysteresis in range, budgets non-negative. */
bool ValidateRiotRepresentationProfile(const FRiotRepresentationProfile& Profile,
	FString& OutErrorCode, FString& OutMessage);

/**
 * Deterministic weighted profile selection.
 *
 * CLAUDE-NOTE: driven by the agent's stored SeedSalt rather than by entity index or a global RNG, so
 * the same scenario seed produces the same character on every re-run regardless of entity allocation
 * order. This is the same reasoning that put SeedSalt on FRiotAgentFragment in the first place.
 *
 * Returns INDEX_NONE when no eligible usable profile exists, which is the only path to a legitimate
 * placeholder fallback.
 */
int32 SelectRiotProfileForAgent(const TArray<const FRiotCharacterProfile*>& Eligible, uint32 SeedSalt);
