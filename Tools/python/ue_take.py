# ue_take.py - Take Recorder: record live actors (animation + transforms) into a take sequence and its AnimSequence
# assets, behind take_record (Tools/src/tools/take-record.ts). Exec'd after ue_posing.py (_eas, load_sequence).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): TakeRecorderSubsystem is an ENGINE subsystem (get_editor_subsystem raises).
# The project's take settings (RootTakeSaveDir /Cinematics/Takes, 3 s countdown) are the user's - this module passes
# its own TakeRecorderParameters to TakeRecorderBlueprintLibrary.start_recording instead of changing them.
import unreal

TRL = unreal.TakeRecorderBlueprintLibrary


def take_subject(label, clip, mesh="/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple", location=(0, 0, 0), rate=1.0):
    """A level SkeletalMeshActor looping `clip` in the editor world (anim update in editor on) - a live source."""
    anim = unreal.load_asset(clip)
    if not isinstance(anim, unreal.AnimSequenceBase):
        raise ValueError("not an animation: " + str(clip))
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        act = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*location))
        act.set_actor_label(label)
    c = act.skeletal_mesh_component
    c.set_skeletal_mesh_asset(unreal.load_asset(mesh))
    c.set_update_animation_in_editor(True)
    c.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    c.play_animation(anim, True)
    c.set_play_rate(float(rate))
    return {"ok": True, "actor": label}


def take_start(actors, slate="MCP", take=1, root="/Game/_MCPLab/Takes", base=None):
    if TRL.is_recording():
        raise RuntimeError("a take is already recording")
    sources = unreal.new_object(unreal.TakeRecorderSources)
    found = []
    for lab in actors:
        a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == lab), None)
        if a is None:
            raise ValueError("no level actor '%s'" % lab)
        unreal.TakeRecorderActorSource.add_source_for_actor(a, sources)
        found.append(lab)
    meta = unreal.new_object(unreal.TakeMetaData)
    meta.set_slate(slate)
    meta.set_take_number(int(take))
    p = TRL.get_default_parameters()
    u, pr = p.user, p.project
    u.set_editor_property("countdown_seconds", 0.0)
    u.set_editor_property("maximize_viewport", False)
    d = unreal.DirectoryPath()
    # RootTakeSaveDir is relative to /Game ("/Cinematics/Takes"): "/Game/_MCPLab/Takes" landed in /Game/Game/_MCPLab
    d.set_editor_property("path", root[5:] if root.startswith("/Game/") else root)
    pr.set_editor_property("root_take_save_dir", d)
    pr.set_editor_property("take_save_dir", "{slate}_{take}")
    p.user, p.project = u, pr
    # the base sequence is played during the take and DUPLICATED into the result; an empty lab one by default
    seq = load_sequence(base or root + "/TakeBase", create=True, fps=24, end=24)
    rec = TRL.start_recording(seq, sources, meta, p)
    if rec is None:
        raise RuntimeError("Take Recorder refused to start")
    return {"ok": True, "state": str(rec.get_state()), "sources": found}


def take_stop():
    rec = TRL.get_active_recorder()
    seq = rec.get_sequence() if rec else None
    TRL.stop_recording()
    path = seq.get_path_name().split(".")[0] if seq else None
    return {"ok": True, "sequence": path}


def take_info(seq_path):
    """Bindings and tracks of a recorded take, and the AnimSequence assets its animation sections reference."""
    seq = unreal.load_asset(seq_path)
    # CLAUDE-NOTE (live): takes start at the recording TIMECODE (playback 1117149-1117233), not frame 0 - scrubbing
    # frame 0 showed nothing. The range is returned so callers scrub start + n.
    out = {"ok": True, "sequence": seq_path, "bindings": [], "anims": [], "range": [seq.get_playback_start(), seq.get_playback_end()]}
    seqs = [seq]
    # recorded sources go into sub-sequences by default (bRecordSourcesIntoSubSequences)
    for t in seq.get_tracks() if hasattr(seq, "get_tracks") else seq.get_master_tracks():
        for s in t.get_sections():
            sub = s.get_sequence() if hasattr(s, "get_sequence") else None
            if sub:
                seqs.append(sub)
    for sq in seqs:
        for b in sq.get_bindings():
            tr = []
            for t in b.get_tracks():
                tr.append(type(t).__name__)
                if isinstance(t, unreal.MovieSceneSkeletalAnimationTrack):
                    for s in t.get_sections():
                        a = s.get_editor_property("params").get_editor_property("animation")
                        if a:
                            out["anims"].append({"path": a.get_path_name().split(".")[0], "length": round(a.get_play_length(), 3),
                                                 "frames": unreal.AnimationLibrary.get_num_frames(a)})
            out["bindings"].append({"sequence": sq.get_name(), "name": str(b.get_display_name()), "tracks": tr})
    return out


def anim_vs_clip(rec_path, clip_path, samples=8, bones=("pelvis", "head", "hand_l", "hand_r", "foot_l", "foot_r")):
    """For `samples` times spread over the recorded anim: best-matching time in the (looping) clip and the worst
    pelvis-relative bone distance there. A real-time recording of a looping clip advances ~1 s of clip per 1 s."""
    rec, clip = unreal.load_asset(rec_path), unreal.load_asset(clip_path)
    opts = unreal.AnimPoseEvaluationOptions()

    def pose(a, t):
        p = unreal.AnimPoseExtensions.get_anim_pose_at_time(a, t, opts)
        pel = unreal.AnimPoseExtensions.get_bone_pose(p, "pelvis", unreal.AnimPoseSpaces.WORLD).translation
        return {b: unreal.AnimPoseExtensions.get_bone_pose(p, b, unreal.AnimPoseSpaces.WORLD).translation - pel for b in bones}
    cl = clip.get_play_length()
    grid = [cl * i / 180.0 for i in range(180)]
    cposes = [pose(clip, t) for t in grid]
    L = rec.get_play_length()
    out = []
    for i in range(samples):
        t = L * (i + 0.5) / samples
        rp = pose(rec, t)
        best = min(range(len(grid)), key=lambda j: max((rp[b] - cposes[j][b]).length() for b in bones))
        out.append({"t": round(t, 3), "clip_t": round(grid[best], 3), "cm": round(max((rp[b] - cposes[best][b]).length() for b in bones), 3)})
    return {"ok": True, "rec_length": round(L, 3), "clip_length": round(cl, 3), "samples": out}
