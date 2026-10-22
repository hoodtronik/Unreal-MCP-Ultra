# ue_space.py - Control Rig space switching and Sequencer animation constraints, behind pose_space_switch and
# pose_constrain (Tools/src/tools/pose-space.ts). Exec'd after ue_posing.py (load_sequence, find_binding, rig_proxy,
# skel_comp, control_type, evaluate, current_frame, _world, _eas, _v, L, FN, DR).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1, CR_Mannequin_Body): the hand/foot IK controls are multi-parent
# (hand_r_ik_ctrl: arm_r_controls_space, body_ctrl, chest_space, clavicle_r_ctrl). Their DEFAULT space already holds
# the hand still in the world when body_ctrl moves (a planted hand needs no switch); a WorldSpace key is then refused
# (set_control_rig_space returns False: "same as the current space"). Switching hand_l_ik_ctrl to body_ctrl made the
# hand ride the body exactly (+8 y, -12 z with the body), with no pop at the switch frame.
# Constraints (ControlRigSequencerLibrary.add_constraint) live in the world while the sequence is open and are keyed
# active in the Control Rig section; they come back when the sequence is reopened after a level reload.
# Bone positions only refresh between MCP calls: measure in a SEPARATE call after scrubbing (the TS tool does).
import unreal

CSL = unreal.ConstraintsScriptingLibrary
CONSTRAINT_TYPES = {"parent": "PARENT", "translation": "TRANSLATION", "rotation": "ROTATION"}


def _key(h, name):
    for t in (unreal.RigElementType.CONTROL, unreal.RigElementType.NULL, unreal.RigElementType.BONE):
        k = unreal.RigElementKey(type=t, name=name)
        if h.get_index(k) >= 0:
            return k
    return None


def _rig(seq, binding_name):
    b = find_binding(seq, binding_name)
    rig, track = rig_proxy(seq, b)
    return b, rig, track


def effector_bone(sk, control):
    """hand_r_ik_ctrl -> hand_r (the bone that should land on the control), or None."""
    names = {str(n) for n in sk.get_all_socket_names()} | {str(sk.get_bone_name(i)) for i in range(sk.get_num_bones())}
    for suf in ("_ik_ctrl", "_fk_ctrl", "_ctrl"):
        if control.endswith(suf) and control[: -len(suf)] in names:
            return control[: -len(suf)]
    return None


def spaces(seq_path, binding_name, control):
    seq = load_sequence(seq_path)
    _, rig, _ = _rig(seq, binding_name)
    if control_type(rig, control) is None:
        raise ValueError("No control named '%s'" % control)
    h = rig.get_hierarchy()
    return {"ok": True, "control": control,
            "rig_spaces": [str(p.name) for p in h.get_parents(_key(h, control))]}


def set_space(seq_path, binding_name, control, space, frame):
    seq = load_sequence(seq_path)
    _, rig, _ = _rig(seq, binding_name)
    if control_type(rig, control) is None:
        raise ValueError("No control named '%s'" % control)
    h = rig.get_hierarchy()
    if space == "world":
        k = L.get_world_space_reference_key()
    else:
        k = _key(h, space)
        if k is None:
            raise ValueError("Rig has no control/null/bone '%s'. Rig-defined spaces of %s: %s" % (
                space, control, ", ".join(str(p.name) for p in h.get_parents(_key(h, control)))))
    ok = L.set_control_rig_space(seq, rig, control, k, FN(int(frame)), DR)
    evaluate(seq, frame)
    return {"ok": True, "keyed": bool(ok), "space_type": str(k.type).split(".")[-1].split(":")[0].strip("<> ")}


def space_probe(seq_path, binding_name, control, space=None, bone=None):
    """Control (world), its offset in `space` (rig space; world for 'world'/None) and the bone gap - CURRENT frame."""
    seq = load_sequence(seq_path)
    b, rig, _ = _rig(seq, binding_name)
    sk = skel_comp(seq, b)
    h = rig.get_hierarchy()
    comp = sk.get_world_transform()
    cg = h.get_global_transform(_key(h, control))
    ctrl = comp.transform_location(cg.translation)
    out = {"ok": True, "frame": current_frame(), "ctrl": _v(ctrl), "rel": _v(ctrl), "space_pos": None}
    if space and space != "world":
        sg = h.get_global_transform(_key(h, space))
        out["space_pos"] = _v(comp.transform_location(sg.translation))
        out["rel"] = _v(sg.inverse_transform_location(cg.translation))
    bone = bone or effector_bone(sk, control)
    if bone:
        bw = sk.get_socket_location(bone)
        out["bone"], out["gap"] = bone, round((bw - ctrl).length(), 3)
    return out


# ------------------------------------------------------------------ constraints

def _actor_by(seq, spec):
    if spec.get("binding"):
        b = find_binding(seq, spec["binding"])
        a = bound_actor(seq, b)
        if a is None:
            raise ValueError("Binding '%s' has no actor at this frame" % spec["binding"])
        return b, a
    label = spec.get("actor")
    for a in _eas().get_all_level_actors():
        if a.get_actor_label() == label:
            return None, a
    raise ValueError("No level actor labelled '%s'" % label)


def _parent_handle(seq, w, spec):
    b, a = _actor_by(seq, spec)
    if spec.get("control"):
        if b is None:
            raise ValueError("A parent control needs the character's binding: {binding, control}")
        rig, _ = rig_proxy(seq, b)
        if control_type(rig, spec["control"]) is None:
            raise ValueError("Parent rig has no control '%s'" % spec["control"])
        return CSL.create_transformable_handle(w, rig, spec["control"])
    if spec.get("bone"):
        sk = a.get_component_by_class(unreal.SkeletalMeshComponent)
        if sk is None or sk.get_bone_index(spec["bone"]) < 0:
            raise ValueError("'%s' has no bone '%s'" % (a.get_actor_label(), spec["bone"]))
        return CSL.create_transformable_component_handle(w, sk, spec["bone"])
    return CSL.create_transformable_handle(w, a, "None")


def parent_xform(seq, spec):
    b, a = _actor_by(seq, spec)
    if spec.get("control"):
        rig, _ = rig_proxy(seq, b)
        h = rig.get_hierarchy()
        sk = a.get_component_by_class(unreal.SkeletalMeshComponent)
        return unreal.MathLibrary.compose_transforms(h.get_global_transform(_key(h, spec["control"])), sk.get_world_transform())
    if spec.get("bone"):
        sk = a.get_component_by_class(unreal.SkeletalMeshComponent)
        return sk.get_socket_transform(spec["bone"], unreal.RelativeTransformSpace.RTS_WORLD)
    return a.get_actor_transform()


def _constraints_on(seq, w, binding_name, control):
    # CLAUDE-NOTE (live 5.6.1): get_constraints_for_handle(world, <freshly created handle>) returned [] for a control
    # that WAS constrained (handles compare by identity), so a duplicate was added and "remove" removed nothing.
    # Match the constraints' own child handles by rig instance + control name instead.
    _, rig, _ = _rig(seq, binding_name)
    out = []
    for c in CSL.get_constraints_array(w):
        h = c.get_editor_property("child_trs_handle")
        if isinstance(h, unreal.TransformableControlHandle) and h.get_editor_property("control_rig") == rig                 and str(h.get_editor_property("control_name")) == control:
            out.append(c)
    return out


def constrain(seq_path, binding_name, control, parent, ctype="parent", maintain_offset=True, frame=0, replace=False):
    if ctype not in CONSTRAINT_TYPES:
        raise ValueError("type must be one of " + ", ".join(CONSTRAINT_TYPES))
    seq = load_sequence(seq_path)
    _, rig, track = _rig(seq, binding_name)
    if control_type(rig, control) is None:
        raise ValueError("No control named '%s'" % control)
    evaluate(seq, frame)   # the constraint is keyed active at the CURRENT time
    w = _world()
    existing = _constraints_on(seq, w, binding_name, control)
    if existing and not replace:
        raise ValueError("%s already has %d constraint(s) - pass replace to remove them first" % (control, len(existing)))
    for c in existing:
        CSL.remove_this_constraint(w, c)
    child = CSL.create_transformable_handle(w, rig, control)
    ph = _parent_handle(seq, w, parent)
    c = L.add_constraint(w, getattr(unreal.TransformConstraintType, CONSTRAINT_TYPES[ctype]), child, ph, bool(maintain_offset))
    if c is None:
        raise RuntimeError("add_constraint returned None (is the sequence open in Sequencer?)")
    keys = None
    for sec in track.get_sections():
        r = L.get_constraint_keys(c, sec)
        if r:
            keys = [[bool(a), int(f.value)] for a, f in zip(r[0], r[1])]
            break
    evaluate(seq, frame)
    return {"ok": True, "constraint": c.get_class().get_name(), "removed": len(existing), "keys": keys}


def constraint_probe(seq_path, binding_name, control, parent, bone=None):
    seq = load_sequence(seq_path)
    out = space_probe(seq_path, binding_name, control, None, bone)
    px = parent_xform(seq, parent)
    out["space_pos"] = _v(px.translation)
    # CLAUDE-NOTE (live): offset in the parent's frame WITHOUT its scale - inverse_transform_location divided by a
    # 0.03-thick tray's scale and inflated vertical offsets ~33x.
    out["rel"] = _v(px.rotation.unrotate_vector(unreal.Vector(*out["ctrl"]) - px.translation))
    out["constraints"] = len(_constraints_on(seq, _world(), binding_name, control))
    return out


def bake_constraints(seq_path, binding_name, control):
    """Bake every constraint on `control` to keys over its active range (constraint keyed inactive afterwards)."""
    seq = load_sequence(seq_path)
    w = _world()
    cs = _constraints_on(seq, w, binding_name, control)
    if not cs:
        raise ValueError("%s has no constraint to bake" % control)
    done = [bool(L.bake_constraint(w, c, [], DR)) for c in cs]
    evaluate(seq, current_frame())
    return {"ok": all(done), "baked": len(done)}


def seq_range(seq_path):
    seq = load_sequence(seq_path)
    return {"ok": True, "start": seq.get_playback_start(), "end": seq.get_playback_end()}


def unconstrain(seq_path, binding_name, control):
    seq = load_sequence(seq_path)
    w = _world()
    cs = _constraints_on(seq, w, binding_name, control)
    for c in cs:
        CSL.remove_this_constraint(w, c)
    evaluate(seq, current_frame())
    return {"ok": True, "removed": len(cs), "left": len(_constraints_on(seq, w, binding_name, control))}


# CLAUDE-NOTE (2026-10-21, live 5.6.1): the Snapper (ControlRigSequencerLibrary.snap_control_rig) keys the children
# (ControlRigForWorldTransforms: rig + control names) onto the parent (ActorForWorldTransforms: actor, or a skeletal
# component + socket) on every frame of [start, end]; ControlRigSnapSettings is a UObject (new_object), defaults
# keep_offset False, position only, KEYS_ONLY (parent's key frames). Unlike a constraint nothing stays live afterwards - the keys ARE the result.
def _clear_keys_after(seq, binding_name, controls, start, end):
    _, rig, track = _rig(seq, binding_name)
    want, n = set(controls), 0
    for sec in track.get_sections():
        for ch in sec.get_all_channels():
            if str(ch.channel_name).split(".")[0] not in want or not hasattr(ch, "get_keys"):
                continue
            for k in list(ch.get_keys()):
                f = int(k.get_time(DR).frame_number.value)
                if start < f <= end:
                    ch.remove_key(k)
                    n += 1
    return n


def snap(seq_path, binding_name, controls, parent, start, end, keep_offset=True, rotation=False, every_frame=True):
    seq = load_sequence(seq_path)
    _, rig, _ = _rig(seq, binding_name)
    missing = [c for c in controls if control_type(rig, c) is None]
    if missing:
        raise ValueError("No control named: " + ", ".join(missing))
    b, a = _actor_by(seq, parent)
    if parent.get("control"):
        raise ValueError("The Snapper takes an actor or a bone/socket as parent, not a control")
    child = unreal.ControlRigSnapperSelection()
    cr = unreal.ControlRigForWorldTransforms()
    cr.set_editor_property("control_rig", rig)
    cr.set_editor_property("control_names", list(controls))
    child.set_editor_property("control_rigs", [cr])
    par = unreal.ControlRigSnapperSelection()
    af = unreal.ActorForWorldTransforms()
    af.set_editor_property("actor", a)
    if parent.get("bone"):
        af.set_editor_property("component", a.get_component_by_class(unreal.SkeletalMeshComponent))
        af.set_editor_property("socket_name", parent["bone"])
    par.set_editor_property("actors", [af])
    st = unreal.new_object(unreal.ControlRigSnapSettings)
    st.set_editor_property("keep_offset", bool(keep_offset))
    st.set_editor_property("snap_position", True)
    st.set_editor_property("snap_rotation", bool(rotation))
    # CLAUDE-NOTE (live): the default KEYS_ONLY keyed only the parent's key frames (0/24/48) and the hand drifted up
    # to 7 cm off a cubic-moving tray in between; ALL_FRAMES keys every frame.
    st.set_editor_property("baking_key_settings", unreal.BakingKeySettings.ALL_FRAMES if every_frame else unreal.BakingKeySettings.KEYS_ONLY)
    # CLAUDE-NOTE (live): with keep_offset the Snapper took the child's transform from LATER in the range (old keys at
    # frame 48) against the parent at `start`: a re-snap after re-posing frame 0 lifted the hand 42 cm (the old frame-48
    # offset). Clearing the controls' keys in (start, end] first makes the start pose the one that is kept; every-frame
    # snapping rewrites those frames anyway.
    cleared = _clear_keys_after(seq, binding_name, controls, int(start), int(end))
    evaluate(seq, start)
    ok = L.snap_control_rig(seq, FN(int(start)), FN(int(end)), child, par, st, DR)
    evaluate(seq, start)
    return {"ok": bool(ok), "cleared": cleared}
