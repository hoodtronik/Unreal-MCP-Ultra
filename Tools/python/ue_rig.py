# ue_rig.py - camera rigs (rail dolly, crane) in a sequence, behind shot_rig (Tools/src/tools/shot-rig.ts). Exec'd after
# ue_posing.py, ue_shot.py, ue_props_track.py (load_sequence, find_binding, bound_actor, evaluate, _eas, _same_id,
# _cam_xform_section, _write_channel).
import unreal

MOUNTS = {"rail": "RailCameraMount", "crane": "CraneCameraMount"}


def rig_add(seq_path, name, kind, location, yaw=0.0, rail_points=None, arm=None, lock_orientation=None):
    """Spawnable rail / crane. rail_points: local spline points [[x,y,z],...] (rail start at the actor)."""
    seq = load_sequence(seq_path, open_it=True)
    try:
        b = find_binding(seq, name)
        created = False
    except ValueError:
        cls = unreal.CameraRig_Rail if kind == "rail" else unreal.CameraRig_Crane
        tmp = _eas().spawn_actor_from_class(cls, unreal.Vector(*location), unreal.Rotator(yaw=float(yaw)))
        if kind == "rail" and rail_points:
            sp = tmp.get_rail_spline_component()
            sp.clear_spline_points(False)
            for p in rail_points:
                sp.add_spline_point(unreal.Vector(*p), unreal.SplineCoordinateSpace.LOCAL, False)
            sp.update_spline()
        if lock_orientation is not None and kind == "rail":
            tmp.set_editor_property("lock_orientation_to_rail", bool(lock_orientation))
        if arm is not None and kind == "crane":
            tmp.set_editor_property("crane_arm_length", float(arm))
        b = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).add_spawnable_from_instance(seq, tmp)
        b.set_display_name(name)
        _eas().destroy_actor(tmp)
        created = True
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    live = bound_actor(seq, b)
    comps = [c.get_name() for c in live.get_components_by_class(unreal.SceneComponent)] if live else []
    out = {"ok": True, "created": created, "components": comps}
    if live and kind == "rail":
        sp = live.get_rail_spline_component()
        out["rail_length"] = round(sp.get_spline_length(), 2)
        out["points"] = sp.get_number_of_spline_points()
    return out


def rig_mount(seq_path, cam_name, rig_name, kind, rotation=None):
    """Attach the camera to the rig's mount (Attach track, component name), camera transform = relative offset.
    CLAUDE-NOTE (live): re-running the mount reset the rotation channels and wiped aim keys; rotation channels are now
    only rewritten when a rotation is given (location is always zeroed onto the mount)."""
    seq = load_sequence(seq_path, open_it=True)
    cb = find_binding(seq, cam_name)
    rb = find_binding(seq, rig_name)
    t = next((t for t in cb.get_tracks() if isinstance(t, unreal.MovieScene3DAttachTrack)), None) or cb.add_track(unreal.MovieScene3DAttachTrack)
    sec = t.get_sections()[0] if t.get_sections() else t.add_section()
    sec.set_range(-100000, 100000)
    sec.set_constraint_binding_id(unreal.MovieSceneSequenceExtensions.get_binding_id(seq, rb))
    sec.set_editor_property("attach_component_name", MOUNTS[kind])
    xs = _cam_xform_section(cb)
    vals = {"Location.X": 0.0, "Location.Y": 0.0, "Location.Z": 0.0}
    if rotation is not None:
        vals.update({"Rotation.X": rotation[2], "Rotation.Y": rotation[0], "Rotation.Z": rotation[1]})
    for ch in xs.get_all_channels():
        n = str(ch.channel_name)
        if n in vals:
            for k in list(ch.get_keys()):
                ch.remove_key(k)
            ch.set_default(float(vals[n]))
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True}


def rig_state(seq_path, cam_name, rig_name, kind):
    """CURRENT frame: camera world location vs the rig's mount (and, for a rail, the spline point the position maps to)."""
    seq = load_sequence(seq_path)
    cam = bound_actor(seq, find_binding(seq, cam_name))
    rig = bound_actor(seq, find_binding(seq, rig_name))
    if cam is None or rig is None:
        raise RuntimeError("camera or rig not spawned at this frame")
    mount = next(c for c in rig.get_components_by_class(unreal.SceneComponent) if c.get_name() == MOUNTS[kind])
    cpos = cam.get_actor_location()
    mpos = mount.get_world_location()
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(),
           "camera": [round(cpos.x, 2), round(cpos.y, 2), round(cpos.z, 2)],
           "mount": [round(mpos.x, 2), round(mpos.y, 2), round(mpos.z, 2)],
           "camera_vs_mount_cm": round((cpos - mpos).length(), 3), "attached_to": str(cam.get_attach_parent_actor().get_actor_label()) if cam.get_attach_parent_actor() else None}
    if kind == "rail":
        sp = rig.get_rail_spline_component()
        pos = rig.get_editor_property("current_position_on_rail")
        want = sp.get_location_at_distance_along_spline(pos * sp.get_spline_length(), unreal.SplineCoordinateSpace.WORLD)
        out.update({"position": round(pos, 4), "spline_point": [round(want.x, 2), round(want.y, 2), round(want.z, 2)],
                    "mount_vs_spline_cm": round((mpos - want).length(), 3)})
    else:
        out.update({"pitch": round(rig.get_editor_property("crane_pitch"), 3), "yaw": round(rig.get_editor_property("crane_yaw"), 3),
                    "arm": round(rig.get_editor_property("crane_arm_length"), 3)})
    return out


def rig_aim_key(seq_path, cam_name, rig_name, kind, subject, bone, frame, screen=None):
    """Key the mounted camera's RELATIVE rotation at `frame` (posed last tick) so it aims at the subject's bone.
    CLAUDE-NOTE (live): a dolly with a fixed camera heading let the subject cross out of frame at both ends of a 3 m
    rail; the camera's transform channels are relative to the mount once attached, so the world aim is converted with
    the mount's world rotation at that frame."""
    import math
    seq = load_sequence(seq_path)
    cb = find_binding(seq, cam_name)
    rig = bound_actor(seq, find_binding(seq, rig_name))
    cam = bound_actor(seq, cb)
    sk = skel_comp(seq, find_binding(seq, subject))
    allb = _bone_map(sk)
    real = bone if bone in allb else resolve_role(allb, bone)
    p = sk.get_socket_location(real)
    mount = next(c for c in rig.get_components_by_class(unreal.SceneComponent) if c.get_name() == MOUNTS[kind])
    mt = mount.get_world_transform()
    c = mt.translation
    d = p - c
    yaw = math.degrees(math.atan2(d.y, d.x))
    pitch = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    if screen:
        cc = cam.get_cine_camera_component()
        fl = cc.get_editor_property("current_focal_length")
        fb = cc.get_editor_property("filmback")
        yaw -= float(screen[0]) * math.degrees(math.atan(fb.sensor_width / 2.0 / fl))
        pitch -= float(screen[1]) * math.degrees(math.atan(fb.sensor_height / 2.0 / fl))
    want = unreal.Rotator(pitch=pitch, yaw=yaw, roll=0.0).quaternion()
    rel = mt.rotation.inverse().multiply(want).rotator() if hasattr(mt.rotation, "inverse") else None
    if rel is None:
        wt = unreal.Transform(location=c, rotation=unreal.Rotator(pitch=pitch, yaw=yaw, roll=0.0), scale=unreal.Vector(1, 1, 1))
        rel = wt.make_relative(unreal.Transform(location=c, rotation=mt.rotation.rotator(), scale=unreal.Vector(1, 1, 1))).rotation.rotator()
    sec = _cam_xform_section(cb)
    for name, v in (("Rotation.X", rel.roll), ("Rotation.Y", rel.pitch), ("Rotation.Z", rel.yaw)):
        for ch in sec.get_all_channels():
            if str(ch.channel_name) == name:
                for k in list(ch.get_keys()):
                    if k.get_time().frame_number.value == int(frame):
                        ch.remove_key(k)
                ch.add_key(unreal.FrameNumber(int(frame)), float(v))
    return {"ok": True, "frame": int(frame), "world": [round(pitch, 3), round(yaw, 3)], "relative": [round(rel.pitch, 3), round(rel.yaw, 3), round(rel.roll, 3)]}
