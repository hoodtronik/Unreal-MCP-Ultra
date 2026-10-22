# ue_constrain.py - Sequencer constraints between ACTORS (a prop / camera / light constrained to another binding, a
# bone or socket of it, or a level actor), keyed active on/off. Behind seq_constrain (Tools/src/tools/seq-constrain.ts).
# Exec'd after ue_posing.py (load_sequence, find_binding, bound_actor, evaluate, _world, _eas, FN, L).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): ControlRigSequencerLibrary.add_constraint(world, type, child, parent,
# maintain_offset) on TransformableComponentHandles (prop root <- walker's skeletal mesh 'hand_r') adds the constraint
# while the sequence is open; set_constraint_active_key writes its active channel into the CHILD's 3D transform
# section (get_constraint_keys(constraint, that section) reads it back). The setter's bool return does not match what
# was keyed (False for a key that exists) - keys are verified by reading them back.
import unreal

CSL = unreal.ConstraintsScriptingLibrary
CRL = unreal.ControlRigSequencerLibrary
TYPES = {"parent": "PARENT", "translation": "TRANSLATION", "rotation": "ROTATION", "look_at": "LOOK_AT", "scale": "SCALE"}


def _comp(actor, bone=None):
    if bone:
        sk = actor.get_component_by_class(unreal.SkeletalMeshComponent)
        if sk is not None and sk.get_bone_index(bone) >= 0:
            return sk, bone
        for c in actor.get_components_by_class(unreal.SceneComponent):
            if c.does_socket_exist(bone):
                return c, bone
        raise ValueError("'%s' has no bone or socket '%s'" % (actor.get_actor_label(), bone))
    return actor.root_component, "None"


def _actor(seq, name):
    try:
        return bound_actor(seq, find_binding(seq, name)), True
    except ValueError:
        a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == name), None)
        if a is None:
            raise ValueError("no binding or level actor '%s'" % name)
        return a, False


def _child_section(seq, child):
    b = find_binding(seq, child)
    for t in b.get_tracks():
        if isinstance(t, unreal.MovieScene3DTransformTrack) and t.get_sections():
            return t.get_sections()[0]
    return None


def constraints_on(seq_path, child):
    """Constraints driving `child`: they are owned by the child's 3D transform section (a fresh handle to the same
    component does not match get_constraints_for_handle - live)."""
    seq = load_sequence(seq_path, open_it=True)
    sec = _child_section(seq, child)
    if sec is None:
        return []
    root = sec.get_path_name() + "."
    return [c for c in CSL.get_constraints_array(_world()) if c.get_path_name().startswith(root)]


def constrain(seq_path, child, parent, bone=None, ctype="parent", maintain_offset=True, keys=None, at_frame=None):
    """Constrain binding `child` (root) to `parent` (binding or level actor, optional bone/socket). keys:
    [{frame, active}] (default active from frame 0). Returns the keys read back from the child's transform section."""
    seq = load_sequence(seq_path, open_it=True)
    keys = keys or [{"frame": 0, "active": True}]
    # evaluate at the first ACTIVE key so maintain_offset captures the offset where the constraint takes over
    first_on = next((int(k["frame"]) for k in sorted(keys, key=lambda k: k["frame"]) if k["active"]), int(keys[0]["frame"]))
    evaluate(seq, int(at_frame) if at_frame is not None else first_on)
    w = _world()
    ca, _ = _actor(seq, child)
    pa, _ = _actor(seq, parent)
    pc, sock = _comp(pa, bone)
    ph = CSL.create_transformable_component_handle(w, pc, sock)
    ch = CSL.create_transformable_component_handle(w, ca.root_component, "None")
    c = CRL.add_constraint(w, getattr(unreal.TransformConstraintType, TYPES[ctype]), ch, ph, bool(maintain_offset))
    if c is None:
        raise RuntimeError("add_constraint returned None (is the sequence open? child already constrained?)")
    if ctype == "look_at" and not maintain_offset:
        # CLAUDE-NOTE (2026-10-22, live): the look-at constraint is created with `axis` = the child's CURRENT local
        # direction to the target (0.77, 0.64, 0 for a camera 40 deg off), whatever maintain_offset says - it then keeps
        # the initial misaim (40 deg). Forward (+X: cameras, lights) is set explicitly for a true aim.
        c.set_editor_property("axis", unreal.Vector(1, 0, 0))
    for k in sorted(keys, key=lambda k: k["frame"]):
        CRL.set_constraint_active_key(c, bool(k["active"]), FN(int(k["frame"])))
    sec = _child_section(seq, child)
    got = CRL.get_constraint_keys(c, sec) if sec else None
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "constraint": str(c.get_name()), "type": type(c).__name__,
            "keys": [[f.value, bool(v)] for v, f in zip(got[0], got[1])] if got else []}


def unconstrain(seq_path, child, bake=True):
    """Remove the child's constraints. bake (default): first bake each one's active ranges into world keys
    (bake_constraint) - the compensation keys Sequencer wrote while it was active are in the PARENT's space, so a bare
    removal would throw the prop to near the world origin for those frames (live: cup keys 0.03/0.01/-0.06 at f20)."""
    seq = load_sequence(seq_path, open_it=True)
    n = 0
    for c in constraints_on(seq_path, child):
        if bake and not CRL.bake_constraint(_world(), c, []):
            raise RuntimeError("bake_constraint failed on " + c.get_name())
        CSL.remove_this_constraint(_world(), c) if hasattr(CSL, "remove_this_constraint") else CSL.remove_constraint(_world(), c)
        n += 1
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "removed": n, "baked": bool(bake)}


def reset_keys(seq_path, child, keep_frame=0):
    """Scratch helper: drop the child's transform keys except keep_frame."""
    seq = load_sequence(seq_path, open_it=True)
    sec = _child_section(seq, child)
    for ch in sec.get_all_channels():
        for k in list(ch.get_keys()):
            if k.get_time().frame_number.value != keep_frame:
                ch.remove_key(k)
    return {"ok": True}


def sample_pair(seq_path, child, parent, bone=None, next_frame=None, aim=False):
    """World transform of the child root and of the parent (bone) at the CURRENT frame; then scrub to next_frame."""
    seq = load_sequence(seq_path)
    ca, _ = _actor(seq, child)
    pa, _ = _actor(seq, parent)
    pc, sock = _comp(pa, bone)
    ct = ca.get_actor_transform()
    pt = pc.get_socket_transform(sock, unreal.RelativeTransformSpace.RTS_WORLD) if bone else pc.get_world_transform()
    rel = ct.make_relative(pt)   # child in parent space

    def v(x):
        return [round(x.x, 3), round(x.y, 3), round(x.z, 3)]
    r = rel.rotation.rotator()
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "child": v(ct.translation),
           "parent": v(pt.translation), "rel": v(rel.translation), "rel_rot": [round(r.pitch, 3), round(r.yaw, 3), round(r.roll, 3)]}
    if aim:
        # look_at: angle between the child's +X (camera / light forward) and the direction to the parent, in rel[0]
        import math
        fwd = ct.rotation.get_forward_vector() if hasattr(ct.rotation, "get_forward_vector") else ct.rotation.rotate_vector(unreal.Vector(1, 0, 0))
        to = pt.translation - ct.translation
        n = max(to.length(), 1e-6)
        cosv = max(-1.0, min(1.0, (fwd.x * to.x + fwd.y * to.y + fwd.z * to.z) / n))
        out["rel"] = [round(math.degrees(math.acos(cosv)), 3), 0, 0]
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out
