# ue_abp.py - Anim Blueprint state-machine rules and runtime checks behind anim_transition_rule / anim_bp_drive
# (Tools/src/tools/anim-rules.ts). Exec'd after ue_posing.py and ue_anim.py (uses _eas, _v, _bone_map, resolve_role,
# pose_signature, remove_actor).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): every transition's rule graph is an object named "Transition" (outer = its
# AnimStateTransitionNode_N), so the C++ graph tools - which pick the FIRST graph whose name matches - could only
# ever edit the first transition of a blueprint. Python can reach the nodes by path and rename the graphs, but cannot
# read a node's pins/guid; the C++ graph reader reports from/to + guid but not the object name. tr_mark() writes a
# unique crossfade marker on every node so the two views can be joined, tr_rename() restores the crossfade and
# names each rule graph "<From> to <To>" (unique, and what the editor shows as the transition title).
import unreal

_MARK = 9000.0


def _bp_root(bp_path):
    bp = unreal.load_asset(bp_path)
    if not isinstance(bp, unreal.AnimBlueprint):
        raise ValueError("Animation Blueprint not found: '%s'" % bp_path)
    return bp, bp.get_path_name()


def sm_graph(bp_path, sm_name):
    """The AnimationStateMachineGraph object of a state machine in the AnimGraph (by its display name)."""
    _, root = _bp_root(bp_path)
    for i in range(64):
        node = root + ":AnimGraph.AnimGraphNode_StateMachine_%d" % i
        g = unreal.find_object(None, node + "." + sm_name)
        if g:
            return g
    raise ValueError("State machine '%s' not found in %s's AnimGraph" % (sm_name, bp_path))


def sm_rename(bp_path, old, new):
    """Rename the NEWEST state machine called `old` (add_state_machine's C++ ignores its name argument)."""
    _, root = _bp_root(bp_path)
    hit = None
    for i in range(64):
        g = unreal.find_object(None, root + ":AnimGraph.AnimGraphNode_StateMachine_%d.%s" % (i, old))
        if g:
            hit = g
    if hit is None:
        raise ValueError("State machine '%s' not found" % old)
    unreal.BlueprintEditorLibrary.rename_graph(hit, new)
    return {"ok": True, "name": hit.get_name()}


def _tr_nodes(sm):
    out, miss = [], 0
    for i in range(256):
        n = unreal.find_object(None, sm.get_path_name() + ".AnimStateTransitionNode_%d" % i)
        if n:
            out.append(n)
            miss = 0
        else:
            miss += 1
            if miss > 32 and out:
                break
    return out


def _tr_graph(node, want=None):
    for nm in ([want] if want else []) + ["Transition"]:
        g = unreal.find_object(None, node.get_path_name() + "." + nm)
        if g:
            return g
    return None


def tr_mark(bp_path, sm_name):
    """Write crossfade marker 9000+i on every transition node; returns the originals (restore with tr_rename)."""
    sm = sm_graph(bp_path, sm_name)
    out = []
    for i, n in enumerate(_tr_nodes(sm)):
        out.append({"name": n.get_name(), "crossfade": n.get_editor_property("crossfade_duration"), "mark": _MARK + i})
        n.set_editor_property("crossfade_duration", _MARK + i)
    return {"ok": True, "nodes": out}


def tr_rename(bp_path, sm_name, joined):
    """joined: [{name, crossfade, from, to}] -> restore crossfades, rename rule graphs '<from> to <to>'."""
    sm = sm_graph(bp_path, sm_name)
    out = []
    for j in joined:
        n = unreal.find_object(None, sm.get_path_name() + "." + j["name"])
        n.set_editor_property("crossfade_duration", j["crossfade"])
        if not j.get("from"):
            out.append({"node": j["name"], "graph": None})
            continue
        want = "%s to %s" % (j["from"], j["to"])
        g = _tr_graph(n, want)
        if g is None:
            raise ValueError("No rule graph under %s" % j["name"])
        if g.get_name() != want:
            unreal.BlueprintEditorLibrary.rename_graph(g, want)    # what the editor's rename runs
        out.append({"node": j["name"], "graph": g.get_name(), "from": j["from"], "to": j["to"]})
    return {"ok": True, "transitions": out}


def abp_var_type(bp_path, name):
    """'bool' | 'float' | 'int' for a member variable of the blueprint (read from the generated class CDO)."""
    bp, _ = _bp_root(bp_path)
    cdo = unreal.get_default_object(bp.generated_class())
    try:
        v = cdo.get_editor_property(name)
    except Exception:
        raise ValueError("%s has no variable '%s' (add it with add_variable)" % (bp_path, name))
    t = "bool" if isinstance(v, bool) else "int" if isinstance(v, int) else "float" if isinstance(v, float) else None
    if t is None:
        raise ValueError("Variable '%s' is %s - rules support bool, int and float" % (name, type(v).__name__))
    return {"ok": True, "type": t}


def _world(pie):
    if not pie:
        return None
    w = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world()
    if w is None:
        raise ValueError("PIE is not running")
    return w


def abp_set_vars(label, values, pie=False):
    """Set member variables on the running anim instance of a level actor (preview, or its PIE copy)."""
    act = _find_actor(label, _world(pie))
    ai = act.get_component_by_class(unreal.SkeletalMeshComponent).get_anim_instance()
    if ai is None:
        raise ValueError("'%s' has no anim instance" % label)
    out = {}
    for k, v in values.items():
        ai.set_editor_property(k, v)
        out[k] = ai.get_editor_property(k)
    return {"ok": True, "values": out}


def _find_actor(label, world=None):
    if world is None:
        act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    else:
        act = next((a for a in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.SkeletalMeshActor)
                    if a.get_actor_label() == label), None)
    if act is None:
        raise ValueError("No actor labelled '%s'" % label)
    return act


_MATCH_BONES = ("hand_l", "hand_r", "foot_l", "foot_r", "head", "ball_l", "ball_r", "lowerarm_l", "lowerarm_r", "calf_l", "calf_r")


def clip_match(label, clips, fps=120.0, pie=False):
    """Which clip is this actor showing right now? Its rendered bones (component space) vs every clip sampled at
    1/fps (default 120 - a walking foot moves ~2.5 cm per 1/60 s): per clip, the best frame's worst-bone distance (cm). Clips are evaluated without root-motion extraction,
    the way a state's sequence player plays them."""
    act = _find_actor(label, _world(pie))
    sk = act.get_component_by_class(unreal.SkeletalMeshComponent)
    # CLAUDE-NOTE (live): an ABP state's sequence player strips root motion (the root bone stays put) while the raw
    # clip walks its root forward 1-2 m, so absolute positions only matched near t=0; compare root-relative.
    root = sk.get_bone_name(0)
    r0 = sk.get_socket_transform(root, unreal.RelativeTransformSpace.RTS_COMPONENT).translation
    now = {}
    for b in _MATCH_BONES:
        if sk.get_bone_index(b) >= 0:
            now[b] = sk.get_socket_transform(b, unreal.RelativeTransformSpace.RTS_COMPONENT).translation - r0
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("optional_skeletal_mesh", sk.get_skeletal_mesh_asset())
    out = {}
    for c in clips:
        anim = unreal.load_asset(c)
        n = max(1, int(anim.get_play_length() * fps))
        best, best_t = 1e9, 0.0
        for i in range(n + 1):
            t = min(anim.get_play_length(), i / fps)
            pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, t, opts)
            worst = 0.0
            q0 = unreal.AnimPoseExtensions.get_bone_pose(pose, root, unreal.AnimPoseSpaces.WORLD).translation
            for b, p in now.items():
                q = unreal.AnimPoseExtensions.get_bone_pose(pose, b, unreal.AnimPoseSpaces.WORLD).translation - q0
                worst = max(worst, (p - q).length())
            if worst < best:
                best, best_t = worst, t
        out[c] = {"cm": round(best, 2), "at": round(best_t, 3)}
    return {"ok": True, "clips": out, "bones": len(now)}


def abp_expose(bp_path, names):
    """Make variables instance-editable (the 'eye' icon) so tools and PIE checks can set them on a running instance.
    CLAUDE-NOTE (live): AnimInstance.set_editor_property refused a default ABP variable ('cannot be edited on
    instances'), and Python has no other setter for blueprint members."""
    bp, _ = _bp_root(bp_path)
    for n in names:
        unreal.BlueprintEditorLibrary.set_blueprint_variable_instance_editable(bp, n, True)
    unreal.BlueprintEditorLibrary.compile_blueprint(bp)
    unreal.EditorAssetLibrary.save_loaded_asset(bp, False)
    return {"ok": True, "exposed": list(names)}


def pie_has(label):
    w = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world()
    if w is None:
        return {"ok": True, "running": False, "found": False}
    try:
        _find_actor(label, w)
        return {"ok": True, "running": True, "found": True}
    except ValueError:
        return {"ok": True, "running": True, "found": False}


def abp_face(label, facing):
    """Turn a level actor so the mannequin faces world yaw `facing` (deg; mesh offset as in bs_preview)."""
    act = _find_actor(label)
    act.set_actor_rotation(unreal.Rotator(pitch=0.0, yaw=float(facing) - MESH_YAW_OFFSET, roll=0.0), False)
    return {"ok": True}
