# ue_walk.py - walk a character along a path in a LevelSequence with an in-place locomotion clip (anim_walk,
# anim_foot_report MCP tools). Exec'd after ue_posing.py (load_sequence, find_binding, bound_actor, skel_comp,
# evaluate, _xform_section, MESH_YAW_OFFSET, _v, _bone_map, resolve_role).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): travel comes from TRANSFORM KEYS at the clip's measured speed, and the clip
# plays root-locked (an in-place copy saved beside the sequence - the project's own clip is never edited). A
# root-motion clip played as-is in Sequencer moves the mesh forward inside the actor and snaps back every loop.
# Speed is the clip's root displacement / length; the per-frame foot report verifies it (a planted foot must not
# slide) instead of trusting it.
import math

import unreal

AL = unreal.AnimationLibrary


def clip_info(clip_path):
    a = unreal.load_asset(clip_path)
    if not isinstance(a, unreal.AnimSequence):
        raise ValueError("Not an AnimSequence: " + clip_path)
    length = AL.get_sequence_length(a)
    p0 = AL.get_bone_pose_for_time(a, "root", 0.0, False).translation
    p1 = AL.get_bone_pose_for_time(a, "root", length, False).translation
    d = p1 - p0
    return {"clip": clip_path, "length_s": round(length, 4), "root_travel": _v(d),
            "speed_cm_s": round(d.length() / length, 3) if length > 0 else 0.0}


def inplace_clip(seq_path, clip_path):
    """Root-locked copy of `clip_path` in <sequence folder>/Anims/<name>_InPlace (created once)."""
    name = clip_path.rsplit("/", 1)[1] + "_InPlace"
    folder = seq_path.rsplit("/", 1)[0] + "/Anims"
    dst = folder + "/" + name
    eal = unreal.EditorAssetLibrary
    if not eal.does_asset_exist(dst):
        if not eal.duplicate_asset(clip_path, dst):
            raise RuntimeError("could not duplicate %s to %s" % (clip_path, dst))
    a = unreal.load_asset(dst)
    AL.set_root_motion_enabled(a, True)
    AL.set_root_motion_lock_type(a, unreal.RootMotionRootLock.REF_POSE)
    AL.set_is_root_motion_lock_forced(a, True)
    eal.save_loaded_asset(a)
    return a


def setup_walker(seq_path, name, mesh, location=(0, 0, 0)):
    """Skeletal-mesh spawnable WITHOUT a Control Rig track (a rig track would override the clip)."""
    seq = load_sequence(seq_path, open_it=True, create=True)
    try:
        return seq, find_binding(seq, name), False
    except ValueError:
        pass
    m = unreal.load_asset(mesh)
    if not isinstance(m, unreal.SkeletalMesh):
        raise ValueError("Not a SkeletalMesh: " + mesh)
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    tmp = eas.spawn_actor_from_object(m, unreal.Vector(*location), unreal.Rotator())
    b = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).add_spawnable_from_instance(seq, tmp)
    b.set_display_name(name)
    eas.destroy_actor(tmp)
    return seq, b, True


def _strip_rig(binding):
    """Remove Control Rig tracks and EMPTY animation tracks from a walker binding.
    CLAUDE-NOTE (2026-10-21, live 5.6.1): add_spawnable_from_instance auto-adds the mesh's default animating rig
    (CR_Mannequin_Body for SKM_Manny) plus an empty Skeletal Animation track. That rig track evaluates as an
    absolute layer, so the walk clip never showed: the mesh slid along in its reference pose (feet symmetric at
    every frame) while the anim section, weight and play rate all read back correctly."""
    removed = []
    for t in list(binding.get_tracks()):
        if isinstance(t, unreal.MovieSceneControlRigParameterTrack):
            binding.remove_track(t)
            removed.append("control_rig")
        elif isinstance(t, unreal.MovieSceneSkeletalAnimationTrack) and not any(
                s.get_editor_property("params").animation for s in t.get_sections()):
            binding.remove_track(t)
            removed.append("empty_anim")
    return removed


def _anim_track(binding):
    for t in binding.get_tracks():
        if isinstance(t, unreal.MovieSceneSkeletalAnimationTrack):
            return t
    return binding.add_track(unreal.MovieSceneSkeletalAnimationTrack)


def _key(ch, frame, value):
    ch.add_key(unreal.FrameNumber(int(math.floor(frame))), float(value), sub_frame=float(frame - math.floor(frame)),
               time_unit=unreal.MovieSceneTimeUnit.DISPLAY_RATE, interpolation=unreal.MovieSceneKeyInterpolation.LINEAR)


def _offset_at(offsets, frame):
    """Cumulative foot-lock offset in force at `frame` (offsets: {frame: [dx, dy]} cumulative, applied from frame on)."""
    cur = (0.0, 0.0)
    for f in sorted(offsets, key=float):
        if float(f) <= frame + 1e-6:
            cur = offsets[f]
    return cur


def walk(seq_path, name, path, clip, mesh, start_frame=0, speed=None, turn_frames=6, play_rate=1.0, hold_end=0,
         offsets=None):
    """Key `name` walking through `path` (world points, z = floor) at the clip's speed from start_frame.
    Returns the frames it arrives at each waypoint. Replaces the binding's walk section and transform keys."""
    if len(path) < 2:
        raise ValueError("path needs at least 2 points")
    seq, b, created = setup_walker(seq_path, name, mesh, path[0])
    stripped = _strip_rig(b)
    info = clip_info(clip)
    v = float(speed) if speed else info["speed_cm_s"] * float(play_rate)
    if v <= 0:
        raise ValueError("clip %s has no root travel; pass speed (cm/s)" % clip)
    fps = seq.get_display_rate().numerator / float(seq.get_display_rate().denominator)
    pts = [unreal.Vector(*p) for p in path]
    t = [float(start_frame)]
    yaws = []
    for i in range(1, len(pts)):
        d = pts[i] - pts[i - 1]
        t.append(t[-1] + d.length() / v * fps)
        yaws.append(math.degrees(math.atan2(d.y, d.x)))
    for i in range(1, len(yaws)):                       # unwrap so a corner turns the short way
        while yaws[i] - yaws[i - 1] > 180:
            yaws[i] -= 360
        while yaws[i] - yaws[i - 1] < -180:
            yaws[i] += 360
    end = t[-1]
    # transform: linear location keys at the waypoints, yaw keys eased around each corner
    sec = _xform_section(b)
    for ch in sec.get_all_channels():
        for k in list(ch.get_keys()):
            ch.remove_key(k)
    chans = {str(c.channel_name): c for c in sec.get_all_channels()}
    offsets = offsets or {}

    def base(frame):                                     # path position at a frame (linear between waypoints)
        for i in range(1, len(t)):
            if frame <= t[i] or i == len(t) - 1:
                u = 0.0 if t[i] == t[i - 1] else max(0.0, min(1.0, (frame - t[i - 1]) / (t[i] - t[i - 1])))
                return pts[i - 1] + (pts[i] - pts[i - 1]) * u
        return pts[0]

    # CLAUDE-NOTE (2026-10-21, live): turning the actor about its origin while a foot is planted swung that foot
    # 9 cm sideways at the corner. Foot lock: the TS tool measures planted slides and passes cumulative offsets;
    # the path is keyed at every corrected frame (and the frame before, holding the previous offset) so the
    # planted ball stays put and the rest of the walk carries the shift.
    key_frames = set(t)
    for f in offsets:
        key_frames.add(float(f))
        key_frames.add(float(f) - 1.0)
    for fr in sorted(k for k in key_frames if t[0] <= k <= t[-1]):
        p = base(fr)
        dx, dy = _offset_at(offsets, fr)
        _key(chans["Location.X"], fr, p.x + dx)
        _key(chans["Location.Y"], fr, p.y + dy)
        _key(chans["Location.Z"], fr, p.z)
    ry = chans["Rotation.Z"]
    _key(ry, t[0], yaws[0] - MESH_YAW_OFFSET)
    for i in range(1, len(yaws)):
        half = min(turn_frames / 2.0, (t[i] - t[i - 1]) / 2.0, (t[i + 1] - t[i]) / 2.0)
        _key(ry, t[i] - half, yaws[i - 1] - MESH_YAW_OFFSET)
        _key(ry, t[i] + half, yaws[i] - MESH_YAW_OFFSET)
    _key(ry, end, yaws[-1] - MESH_YAW_OFFSET)
    # animation: one looping in-place section over the walk (a section longer than the clip repeats it)
    anim = inplace_clip(seq_path, clip)
    tr = _anim_track(b)
    for s in list(tr.get_sections()):
        tr.remove_section(s)
    s = tr.add_section()
    s.set_range(int(math.floor(t[0])), int(math.ceil(end)) + int(hold_end))
    prm = s.get_editor_property("params")
    prm.set_editor_property("animation", anim)
    if abs(play_rate - 1.0) > 1e-6:
        prm.set_editor_property("play_rate", unreal.MovieSceneTimeWarpVariant(float(play_rate)))
    s.set_editor_property("params", prm)
    if seq.get_playback_end() < int(math.ceil(end)) + int(hold_end):
        seq.set_playback_end(int(math.ceil(end)) + int(hold_end))
    evaluate(seq, start_frame)
    return {"ok": True, "binding": name, "created": created, "clip": anim.get_path_name().split(".")[0], "removed_tracks": stripped,
            "speed_cm_s": round(v, 3), "clip_speed_cm_s": info["speed_cm_s"], "arrive_frames": [round(x, 2) for x in t],
            "yaws": [round(y, 2) for y in yaws], "end_frame": int(math.ceil(end)),
            "end_offset": [round(v, 2) for v in _offset_at(offsets, end)]}


def feet_now(seq_path, name, next_frame=None):
    """World positions of feet/balls at the CURRENT frame, then scrub to next_frame (one request per frame)."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, name))
    allb = _bone_map(sk)
    out = {"ok": True, "frame": current_frame(), "bones": {}}
    for role in ("foot_l", "foot_r", "ball_l", "ball_r", "pelvis"):
        real = resolve_role(allb, role)
        if real:
            out["bones"][role] = _v(sk.get_socket_location(real))
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out
