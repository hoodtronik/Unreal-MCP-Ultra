# ue_stitch.py - stitch root-motion clips back to back on one character so each continues where the previous ended,
# behind anim_stitch (Tools/src/tools/anim-stitch.ts). Exec'd after ue_posing.py, ue_anim.py, ue_walk.py
# (setup_walker, _strip_rig, _anim_track).
import math

import unreal


def stitch(seq_path, binding_name, clips, start=0, mesh="/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple",
           location=(0, 0, 0), match=True, swap_root="ACTOR", blend=0):
    """clips: [{clip, rate?}] laid end to end from `start`; with match each section's start offsets carry the root
    travel and turn accumulated by the clips before it (root motion stays in the clips; the actor does not move)."""
    seq, b, created = setup_walker(seq_path, binding_name, mesh, location)
    _strip_rig(b)
    tr = _anim_track(b)
    if swap_root:
        tr.set_editor_property("swap_root_bone", getattr(unreal.SwapRootBone, "SWAP_ROOT_BONE_" + swap_root))
    for s in list(tr.get_sections()):
        tr.remove_section(s)
    fps = seq.get_display_rate().numerator / float(seq.get_display_rate().denominator)
    pos = int(start)
    acc_loc = unreal.Vector(0, 0, 0)
    acc_yaw = 0.0
    out = []
    tpf = seq.get_tick_resolution().numerator / max(1, seq.get_display_rate().numerator)   # ticks per frame
    prev = None
    blend = int(blend)
    for idx, c in enumerate(clips):
        anim = resolve_anim(c["clip"], ("AnimSequence",))
        rate = 1.0
        frames = int(round(anim.get_play_length() / rate * fps))
        sec = tr.add_section()
        b_here = blend if (idx > 0 and blend > 0) else 0
        sec.set_range(pos - b_here, pos - b_here + frames)
        if blend > 0:
            # CLAUDE-NOTE (2026-10-22, live): a walk -> jog cut snapped the stride in one frame; overlapping sections on
            # alternate rows with manual ease out / ease in (b frames) cross-fades the poses. The offset of the incoming
            # clip is taken at the overlap START (previous clip's root at its end minus b frames).
            sec.set_row_index(idx % 2)
            if b_here:
                sec.get_editor_property("easing").import_text(
                    "(bManualEaseIn=True,ManualEaseInDuration=%d)" % int(b_here * tpf))
                if prev is not None:
                    prev.get_editor_property("easing").import_text(
                        "(bManualEaseOut=True,ManualEaseOutDuration=%d)" % int(b_here * tpf))
        p = sec.get_editor_property("params")
        p.set_editor_property("animation", anim)
        # CLAUDE-NOTE (live 5.6): params.play_rate is a MovieSceneTimeWarpVariant struct (float rejected) - rate fixed at 1.
        sec.set_editor_property("params", p)
        if match:
            sec.set_editor_property("start_location_offset", acc_loc)
            sec.set_editor_property("start_rotation_offset", unreal.Rotator(yaw=acc_yaw))
        r0 = unreal.AnimationLibrary.extract_root_track_transform(anim, 0.0)
        # CLAUDE-NOTE (live): offsets must use the root at the SECTION's end, not the clip's - a 1.77 s jog fills 42.48
        # frames, the section holds 42, and the full-clip travel left a 13 cm gap at the next cut (38.6 cm step vs 25).
        end_t = min(anim.get_play_length(), (frames - (blend if blend > 0 and idx + 1 < len(clips) else 0)) / fps)
        r1 = unreal.AnimationLibrary.extract_root_track_transform(anim, end_t)
        d = r1.translation - r0.translation
        dyaw = r1.rotation.rotator().yaw - r0.rotation.rotator().yaw
        rad = math.radians(acc_yaw)
        acc_loc = acc_loc + unreal.Vector(d.x * math.cos(rad) - d.y * math.sin(rad), d.x * math.sin(rad) + d.y * math.cos(rad), d.z)
        acc_yaw += dyaw
        out.append({"clip": anim.get_name(), "range": [pos - b_here, pos - b_here + frames], "blend_in": b_here, "root_travel": [round(d.x, 1), round(d.y, 1), round(d.z, 1)],
                    "turn": round(dyaw, 2), "offset": [round(x, 1) for x in (sec.get_editor_property("start_location_offset").x,
                                                                         sec.get_editor_property("start_location_offset").y,
                                                                         sec.get_editor_property("start_location_offset").z)]})
        pos = pos - b_here + frames
        prev = sec
    seq.set_playback_end(pos)   # the stitched clips define the shot length (a longer old range rendered empty tail frames)
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "sections": out, "end": pos}


def bone_world(seq_path, binding_name, bone, next_frame=None):
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    p = sk.get_socket_location(bone)
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "p": [round(p.x, 3), round(p.y, 3), round(p.z, 3)]}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out
