# ue_crauthor.py - author a Control Rig asset: bones imported from a skeletal mesh, one control per effector bone,
# a forward solve that drives a Full Body IK (PBIK) from the controls and a backward solve that writes the controls
# from the bones (so clips can be baked onto the rig). Behind cr_build (Tools/src/tools/cr-author.ts).
# Exec'd after ue_posing.py.
import unreal

# CLAUDE-NOTE (2026-10-22, live 5.6.1): ControlRigBlueprintFactory.create_control_rig_from_skeletal_mesh_or_skeleton
# imports the bones but writes "<Mesh>_CtrlRig" NEXT TO THE MESH (here inside the Mannequins folder) and the graph is
# empty - no Forward Solve node. The asset is renamed to the requested path straight away and both solve events added.

DEFAULT_EFFECTORS = ["hand_l", "hand_r", "foot_l", "foot_r", "head"]


def _ctrl_name(bone):
    # Epic's CR_Mannequin_Body names (hand_l_ik_ctrl ...) so the pose_* role maps find them.
    return bone + ("_ctrl" if bone in ("pelvis", "head") else "_ik_ctrl")


def _key(t, name):
    return '(Type=%s,Name="%s")' % (t, name)


def cr_build(path, mesh_path, effectors=None, root="pelvis", overwrite=False, iterations=200):
    effectors = list(effectors or DEFAULT_EFFECTORS)
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        if not overwrite:
            raise ValueError("%s exists (pass overwrite)" % path)
        unreal.EditorAssetLibrary.delete_asset(path)
    mesh = unreal.load_asset(mesh_path)
    if not isinstance(mesh, unreal.SkeletalMesh):
        raise ValueError("not a SkeletalMesh: " + str(mesh_path))
    bp = unreal.ControlRigBlueprintFactory.create_control_rig_from_skeletal_mesh_or_skeleton(mesh, False)
    if bp is None:
        raise RuntimeError("Control Rig creation failed")
    tmp = bp.get_path_name().split(".")[0]
    if tmp != path and not unreal.EditorAssetLibrary.rename_asset(tmp, path):
        unreal.EditorAssetLibrary.delete_asset(tmp)
        raise RuntimeError("could not move the new rig to " + path)
    bp = unreal.load_asset(path)
    h = bp.hierarchy
    bones = [str(k.name) for k in h.get_bones()]
    missing = [b for b in effectors + [root] if b not in bones]
    if missing:
        raise ValueError("bones not in %s: %s" % (mesh_path, ", ".join(missing)))
    hc = bp.get_hierarchy_controller()
    # controls: top level, offset = the bone's initial global transform, value identity -> control == bone at rest
    ctrls = []
    for b in [root] + effectors:
        name = _ctrl_name(b)
        s = unreal.RigControlSettings()
        s.set_editor_property("control_type", unreal.RigControlType.EULER_TRANSFORM)
        s.set_editor_property("animation_type", unreal.RigControlAnimationType.ANIMATION_CONTROL)
        s.set_editor_property("display_name", name)
        s.set_editor_property("shape_name", "Circle_Thick" if b == root else "Box_Thin")
        s.set_editor_property("shape_color", unreal.LinearColor(1, 0.8, 0, 1) if b == root else unreal.LinearColor(0, 0.6, 1, 1))
        val = unreal.RigHierarchy.make_control_value_from_euler_transform(unreal.EulerTransform())
        k = hc.add_control(name, unreal.RigElementKey(), s, val, True, True)
        bt = h.get_global_transform(unreal.RigElementKey(unreal.RigElementType.BONE, b), True)
        h.set_control_offset_transform(k, bt, True, True, False, False)
        ctrls.append((b, name))
    c = bp.get_controller(bp.get_default_model())
    y = [0]

    def node(struct, name, x):
        n = c.add_unit_node_from_struct_path(struct, "Execute", unreal.Vector2D(x, y[0]), name)
        if n is None:
            raise RuntimeError("could not add " + struct)
        return name

    def setpin(pin, val):
        c.set_pin_default_value(pin, val, True, True, False, False)

    # forward solve: pelvis follows its control, then PBIK pulls the effectors to theirs (root pinned to input)
    begin = node("/Script/ControlRig.RigUnit_BeginExecution", "ForwardSolve", -800)
    gp = node("/Script/ControlRig.RigUnit_GetTransform", "Get_" + _ctrl_name(root), -600)
    setpin(gp + ".Item", _key("Control", _ctrl_name(root)))
    sp = node("/Script/ControlRig.RigUnit_SetTransform", "Set_" + root, -300)
    setpin(sp + ".Item", _key("Bone", root))
    c.add_link(gp + ".Transform", sp + ".Value")
    c.add_link(begin + ".ExecutePin", sp + ".ExecutePin")
    ik = node("/Script/PBIK.RigUnit_PBIK", "FBIK", 0)
    setpin(ik + ".Root", root)
    setpin(ik + ".Settings.Iterations", str(int(iterations)))
    setpin(ik + ".Settings.RootBehavior", "PinToInput")
    c.add_link(sp + ".ExecutePin", ik + ".ExecutePin")
    for i, (b, name) in enumerate(ctrls[1:]):
        c.add_array_pin(ik + ".Effectors", "", True, False)
        y[0] = 200 + i * 160
        g = node("/Script/ControlRig.RigUnit_GetTransform", "Get_" + name, -300)
        setpin(g + ".Item", _key("Control", name))
        setpin("%s.Effectors.%d.Bone" % (ik, i), b)
        c.add_link(g + ".Transform", "%s.Effectors.%d.Transform" % (ik, i))
    # backward solve: every control = its bone (global), so baking a clip onto the rig reproduces the clip
    y[0] = 1400
    prev = node("/Script/ControlRig.RigUnit_InverseExecution", "BackwardSolve", -800)
    prev_pin = prev + ".ExecutePin"
    for i, (b, name) in enumerate(ctrls):
        y[0] = 1400 + i * 160
        g = node("/Script/ControlRig.RigUnit_GetTransform", "GetBone_" + b, -600)
        setpin(g + ".Item", _key("Bone", b))
        s = node("/Script/ControlRig.RigUnit_SetTransform", "SetCtrl_" + name, -300 + i * 250)
        setpin(s + ".Item", _key("Control", name))
        c.add_link(g + ".Transform", s + ".Value")
        c.add_link(prev_pin, s + ".ExecutePin")
        prev_pin = s + ".ExecutePin"
    bp.set_preview_mesh(mesh, True)
    bp.recompile_vm()
    unreal.EditorAssetLibrary.save_loaded_asset(bp, False)
    return cr_info(path)


def cr_info(path):
    bp = unreal.load_asset(path)
    if not isinstance(bp, unreal.ControlRigBlueprint):
        raise ValueError("not a Control Rig Blueprint: " + str(path))
    h = bp.hierarchy
    model = bp.get_default_model()
    nodes = []
    for n in model.get_nodes():
        st = n.get_script_struct() if hasattr(n, "get_script_struct") else None
        nodes.append({"name": str(n.get_node_path()), "struct": st.get_name() if st else type(n).__name__})
    links = len(model.get_links())
    ctrls = [str(k.name) for k in h.get_controls()]
    return {"ok": True, "path": path, "bones": len(h.get_bones()), "controls": ctrls, "nodes": nodes, "links": links}


CHECK_BONES = ["pelvis", "spine_03", "head", "upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r",
               "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r"]


def rig_vs_clip(seq_path, binding_name, clip, clip_frame, bones=None, t=None):
    """Posed bones of a sequence binding (posed on the previous tick) vs `clip` at clip_frame, component space
    relative to the root: per-bone distance (cm). Measures what a rig's backward+forward solve reproduces."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    anim = unreal.load_asset(clip)
    t = unreal.AnimationLibrary.get_time_at_frame(anim, int(clip_frame)) if t is None else float(t)
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("optional_skeletal_mesh", sk.get_skeletal_mesh_asset())
    pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, t, opts)
    # CLAUDE-NOTE (2026-10-22, live): relative to the PELVIS, not the root - a rig without a root control (cr_build)
    # carries the clip's root motion in the pelvis (walk frame 10: a uniform ~100 cm vs root-relative), which is the
    # same world pose. The root's own offset is reported separately as root_motion_cm.
    root = sk.get_bone_name(0)
    rp = sk.get_socket_transform(root, unreal.RelativeTransformSpace.RTS_COMPONENT).translation
    rq = unreal.AnimPoseExtensions.get_bone_pose(pose, root, unreal.AnimPoseSpaces.WORLD).translation
    r0 = sk.get_socket_transform("pelvis", unreal.RelativeTransformSpace.RTS_COMPONENT).translation
    q0 = unreal.AnimPoseExtensions.get_bone_pose(pose, "pelvis", unreal.AnimPoseSpaces.WORLD).translation
    out = {}
    for b in bones or CHECK_BONES:
        if sk.get_bone_index(b) < 0:
            continue
        p = sk.get_socket_transform(b, unreal.RelativeTransformSpace.RTS_COMPONENT).translation - r0
        q = unreal.AnimPoseExtensions.get_bone_pose(pose, b, unreal.AnimPoseSpaces.WORLD).translation - q0
        out[b] = round((p - q).length(), 3)
    return {"ok": True, "t": round(t, 4), "cm": out, "root_motion_cm": round(((r0 - rp) - (q0 - rq)).length(), 3)}


def rest_vs_ref(seq_path, binding_name, bones=None):
    # the sequence must be OPEN: a closed one reads the spawnable template (reference pose) - see cr-author.ts
    """Posed bones of a binding (previous tick) vs the mesh's reference pose, component space: per-bone cm."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    ref = unreal.AnimPoseExtensions.get_reference_pose(sk.get_skeletal_mesh_asset().skeleton)
    out = {}
    for b in bones or CHECK_BONES:
        if sk.get_bone_index(b) < 0:
            continue
        p = sk.get_socket_transform(b, unreal.RelativeTransformSpace.RTS_COMPONENT).translation
        q = unreal.AnimPoseExtensions.get_bone_pose(ref, b, unreal.AnimPoseSpaces.WORLD).translation
        out[b] = round((p - q).length(), 3)
    return {"ok": True, "cm": out}


def drop_binding(seq_path, binding_name):
    seq = load_sequence(seq_path, open_it=True)
    try:
        find_binding(seq, binding_name).remove()
    except ValueError:
        return {"ok": True, "removed": False}
    return {"ok": True, "removed": True}


def drop_sequence(seq_path):
    """Close and delete a scratch sequence (cr_build's check)."""
    if unreal.LevelSequenceEditorBlueprintLibrary.get_current_level_sequence():
        unreal.LevelSequenceEditorBlueprintLibrary.close_level_sequence()
    return {"ok": True, "deleted": unreal.EditorAssetLibrary.delete_asset(seq_path)}
