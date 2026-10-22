# ue_layer.py - additive (LAYERED) Control Rig over a character's clip, behind pose_layer (Tools/src/tools/pose-layer.ts).
# Exec'd after ue_posing.py and ue_tween.py (load_sequence, find_binding, skel_comp, rig_proxy, control_type, _set_one,
# evaluate, current_frame, _world, L, FN, DR, _keys_by_control).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1, Manny walk + CR_Mannequin_Body): find_or_create_control_rig_track(...,
# is_layered_control_rig=True) adds a rig whose control values are OFFSETS on top of the clip (zero = the clip). It is
# not a pure pass-through by default: the legs start in IK and the IK re-solve swung the knees 1.2 cm / 4 deg off the
# clip (feet exact). Keying leg_*_fk_ik_switch False on the layer made every bone position match (<= 0.007 cm; spine_01
# twists 0.79 deg about its own axis with all children exact). Muting the layer section returns the exact clip, which
# is how the tool reads the reference. pose_reach / pose_look_at / pose_set_controls work on the layer unchanged
# (they write world transforms / offsets and verify by readback); a key holds its offset over the whole clip until
# bounded by zero keys.
import unreal

RTS_COMP = unreal.RelativeTransformSpace.RTS_COMPONENT
RTS_PARENT = unreal.RelativeTransformSpace.RTS_PARENT_BONE_SPACE
PASS_THROUGH_FK = ("leg_l_fk_ik_switch", "leg_r_fk_ik_switch")


def _q(q):
    return [q.x, q.y, q.z, q.w]


def _layer(seq, b):
    """(rig, track) of the binding's LAYERED rig, or raise with what is there instead."""
    rig, tr = rig_proxy(seq, b)
    if not L.is_layered_control_rig(rig):
        raise ValueError("'%s' has an ABSOLUTE Control Rig track (it replaces the clip, e.g. pose_setup_character); "
                         "a layer needs a clip underneath (anim_walk / a Skeletal Animation track) and no absolute rig"
                         % b.get_display_name())
    return rig, tr


def _has_clip(b):
    for t in b.get_tracks():
        if isinstance(t, unreal.MovieSceneSkeletalAnimationTrack):
            for s in t.get_sections():
                if s.get_editor_property("params").animation:
                    return True
    return False


def bones_local(seq_path, binding_name, bones=None, next_frame=None):
    """CURRENT frame (posed last tick): bones in component space (location) and parent-bone space (rotation quat),
    so a clip under a moving actor compares frame to frame. Then scrub to next_frame."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    names = bones or [str(n) for n in sk.get_all_socket_names() if sk.get_bone_index(n) >= 0]
    out = {}
    for n in names:
        c = sk.get_socket_transform(n, RTS_COMP)
        p = sk.get_socket_transform(n, RTS_PARENT)
        out[n] = {"c": [c.translation.x, c.translation.y, c.translation.z], "q": _q(p.rotation)}
    res = {"ok": True, "frame": current_frame(), "bones": out}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return res


def add_layer(seq_path, binding_name, rig_bp, frame=0):
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    try:
        rig, tr = rig_proxy(seq, b)
        created = False
    except ValueError:
        rig = None
    if rig is not None and not L.is_layered_control_rig(rig):
        _layer(seq, b)   # raises with the explanation
    if rig is None:
        if not _has_clip(b):
            raise ValueError("'%s' plays no clip - a layered rig adds offsets ON TOP of an animation (anim_walk or a "
                             "Skeletal Animation track first)" % binding_name)
        cls = unreal.load_asset(rig_bp)
        if cls is None or not hasattr(cls, "get_control_rig_class"):
            raise ValueError("Not a Control Rig Blueprint: " + str(rig_bp))
        L.find_or_create_control_rig_track(_world(), seq, cls.get_control_rig_class(), b, True)
        rig, tr = _layer(seq, b)
        created = True
    evaluate(seq, current_frame())
    return {"ok": True, "created": created, "rig": rig.get_class().get_name(),
            "controls": len(rig.get_hierarchy().get_controls())}


def layer_passthrough(seq_path, binding_name, frame=0):
    """Key the legs to FK on the layer so it passes the clip through (see the note at the top), read the keys back.
    CLAUDE-NOTE (live): keys set in the SAME call that creates the layered track were silently dropped (no key, switch
    still True) - this runs as its own call after add_layer."""
    seq = load_sequence(seq_path)
    rig, tr = _layer(seq, find_binding(seq, binding_name))
    fk = [c for c in PASS_THROUGH_FK if control_type(rig, c) == "BOOL"]
    for c in fk:
        L.set_local_control_rig_bool(seq, rig, c, FN(int(frame)), False, DR, True)
    keys = _keys_by_control(tr)
    evaluate(seq, current_frame())
    return {"ok": True, "fk": fk, "keyed": [c for c in fk if int(frame) in keys.get(c, set())]}


def layer_active(seq_path, binding_name, active):
    """Mute / unmute the layer's sections so the clip underneath can be read; posed next tick."""
    seq = load_sequence(seq_path)
    _, tr = _layer(seq, find_binding(seq, binding_name))
    for s in tr.get_sections():
        s.set_is_active(bool(active))
    evaluate(seq, current_frame())
    return {"ok": True, "sections": len(tr.get_sections())}


def layer_zero(seq_path, binding_name, frames, controls=None):
    """Key ZERO offsets (= the clip) at each frame for the given controls, default every transform control the layer
    has keys on. Bounds an edit: a lone key otherwise holds its offset across the whole clip."""
    seq = load_sequence(seq_path)
    rig, tr = _layer(seq, find_binding(seq, binding_name))
    if controls:
        missing = [c for c in controls if control_type(rig, c) is None]
        if missing:
            raise ValueError("No control named: " + ", ".join(missing))
        names = list(controls)
    else:
        names = sorted(n for n in _keys_by_control(tr) if control_type(rig, n) in ("EULER_TRANSFORM", "TRANSFORM"))
    done = []
    for c in names:
        if control_type(rig, c) not in ("EULER_TRANSFORM", "TRANSFORM"):
            continue
        for f in frames:
            _set_one(seq, rig, {"control": c, "location": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, f)
        done.append(c)
    evaluate(seq, current_frame())
    return {"ok": True, "controls": done, "frames": [int(f) for f in frames]}


def layer_range(seq_path):
    seq = load_sequence(seq_path)
    return {"ok": True, "start": seq.get_playback_start(), "end": seq.get_playback_end()}
