# ue_subseq.py - subsequences: place a child level sequence inside a parent on a Subsequences track at a frame, and
# read a child binding's actor in the PARENT's playback. Behind seq_subsequence (Tools/src/tools/seq-subsequence.ts).
# Exec'd after ue_posing.py (load_sequence, find_binding, bound_actor, evaluate).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): a child's spawnables do not show in get_all_level_actors while the parent plays;
# they resolve with bound_actor(child, binding) after focus_level_sequence(sub_section) (then focus_parent_sequence).
# Parent f75 / f90 with the child at 50 matched the child alone at f25 / f40 exactly; before 50 nothing is spawned.
import unreal

L2 = unreal.LevelSequenceEditorBlueprintLibrary


def sub_add(parent, child, start, create=True):
    seq = load_sequence(parent, open_it=False, create=create, fps=24, end=200)
    c = unreal.load_asset(child)
    if not isinstance(c, unreal.LevelSequence):
        raise ValueError("not a LevelSequence: " + str(child))
    t = next(iter(seq.find_tracks_by_exact_type(unreal.MovieSceneSubTrack)), None) or seq.add_track(unreal.MovieSceneSubTrack)
    for s in list(t.get_sections()):
        if s.get_sequence() == c:
            t.remove_section(s)
    s = t.add_section()
    s.set_sequence(c)
    n = c.get_playback_end() - c.get_playback_start()
    s.set_range(int(start), int(start) + n)
    end = max(seq.get_playback_end(), int(start) + n)
    seq.set_playback_end(end)
    return {"ok": True, "range": [s.get_start_frame(), s.get_end_frame()], "child_length": n, "parent_end": end}


def sub_actor(parent, child, binding):
    """Location of a child binding's actor at the parent's CURRENT frame (None when not spawned)."""
    seq = load_sequence(parent, open_it=True)
    c = unreal.load_asset(child)
    t = next(iter(seq.find_tracks_by_exact_type(unreal.MovieSceneSubTrack)), None)
    s = next((x for x in (t.get_sections() if t else []) if x.get_sequence() == c), None)
    if s is None:
        raise ValueError("%s is not a subsequence of %s" % (child, parent))
    out = {"ok": True, "frame": L2.get_current_time(), "p": None}
    try:
        L2.focus_level_sequence(s)
        lse = unreal.MovieSceneSequenceExtensions.get_binding_id(c, find_binding(c, binding))
        a = next((o for o in L2.get_bound_objects(lse) if isinstance(o, unreal.Actor)), None)
        if a is not None:
            l = a.get_actor_location()
            out["p"] = [round(l.x, 3), round(l.y, 3), round(l.z, 3)]
    finally:
        L2.focus_parent_sequence()
    return out


def child_actor(child, binding):
    seq = load_sequence(child, open_it=True)
    a = bound_actor(seq, find_binding(seq, binding))
    l = a.get_actor_location()
    return {"ok": True, "frame": L2.get_current_time(), "p": [round(l.x, 3), round(l.y, 3), round(l.z, 3)]}
