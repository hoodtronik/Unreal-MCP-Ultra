# ue_bake.py - bake a Sequencer character's performance (Control Rig keys, clips, anything that drives its
# skeleton) into an AnimSequence, behind anim_bake (Tools/src/tools/anim-bake.ts). Exec'd after ue_posing.py
# (uses load_sequence, find_binding, skel_comp, evaluate, current_frame, _world).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): SequencerTools.export_anim_sequence evaluates the sequence frame by frame
# and records the bound skeletal mesh. The clip is checked against the RENDERED pose afterwards (every bone,
# component space, sampled frames) - the export's bool says nothing about what was recorded.
import unreal


def _skeleton_of(sk):
    mesh = sk.get_skeletal_mesh_asset()
    return mesh, mesh.get_editor_property("skeleton")


def bake_to_anim(seq_path, binding_name, anim_path, overwrite=False):
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    sk = skel_comp(seq, b)
    if sk is None:
        raise ValueError("Binding '%s' has no skeletal mesh" % binding_name)
    mesh, skel = _skeleton_of(sk)
    exists = unreal.EditorAssetLibrary.does_asset_exist(anim_path)
    if exists and not overwrite:
        raise ValueError("%s exists - pass overwrite to re-bake it" % anim_path)
    if exists:
        anim = unreal.load_asset(anim_path)
        if not isinstance(anim, unreal.AnimSequence):
            raise ValueError("%s exists and is not an AnimSequence" % anim_path)
    else:
        pkg, name = anim_path.rsplit("/", 1)
        f = unreal.AnimSequenceFactory()
        f.set_editor_property("target_skeleton", skel)
        anim = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, pkg, unreal.AnimSequence, f)
        if anim is None:
            raise ValueError("Could not create " + anim_path)
    opt = unreal.AnimSeqExportOption()
    opt.set_editor_property("export_transforms", True)
    opt.set_editor_property("export_morph_targets", True)
    opt.set_editor_property("record_in_world_space", False)
    # CLAUDE-NOTE (live): the project enforces animation frame rates compatible with its default (30 fps): the
    # export and AnimationDataController.set_frame_rate both refused 24 ("not a multiple or factor of 30"). Record at
    # the sequence rate when allowed, else at the clip's own rate - timing is kept in seconds either way.
    rate = seq.get_display_rate()
    try:
        ctl = anim.controller
        ctl.open_bracket(unreal.Text("MCP bake frame rate"), False)
        try:
            ctl.set_frame_rate(rate, False)
        finally:
            ctl.close_bracket(False)
    except Exception:
        rate = anim.data_model_interface.get_frame_rate() if hasattr(anim.data_model_interface, "get_frame_rate") else unreal.FrameRate(30, 1)
    opt.set_editor_property("use_custom_frame_rate", True)
    opt.set_editor_property("custom_frame_rate", rate)
    ok = unreal.SequencerTools.export_anim_sequence(_world(), seq, anim, opt, b, False)
    unreal.EditorAssetLibrary.save_loaded_asset(anim, False)
    fps = rate
    return {"ok": bool(ok), "seq_fps": seq.get_display_rate().numerator / seq.get_display_rate().denominator, "anim": anim.get_path_name().split(".")[0], "length": anim.get_play_length(),
            "frames": int(round(anim.get_play_length() * fps.numerator / fps.denominator)),
            "start": seq.get_playback_start(), "end": seq.get_playback_end(), "fps": fps.numerator / fps.denominator,
            "skeleton": skel.get_path_name().split(".")[0], "mesh": mesh.get_path_name().split(".")[0]}


def bake_compare(seq_path, binding_name, anim_path, frame):
    """Rendered bones (component space) at the CURRENT frame vs the baked clip at the same time - scrub first."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    anim = unreal.load_asset(anim_path)
    fps = seq.get_display_rate()
    t = (int(frame) - seq.get_playback_start()) * fps.denominator / fps.numerator
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("optional_skeletal_mesh", sk.get_skeletal_mesh_asset())
    pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, min(t, anim.get_play_length()), opts)
    worst, wb, n = 0.0, None, 0
    for i in range(sk.get_num_bones()):
        bn = sk.get_bone_name(i)
        p = sk.get_socket_transform(bn, unreal.RelativeTransformSpace.RTS_COMPONENT).translation
        q = unreal.AnimPoseExtensions.get_bone_pose(pose, bn, unreal.AnimPoseSpaces.WORLD).translation
        d = (p - q).length()
        n += 1
        if d > worst:
            worst, wb = d, str(bn)
    return {"ok": True, "frame": current_frame(), "t": t, "bones": n, "worst": round(worst, 3), "worst_bone": wb}
