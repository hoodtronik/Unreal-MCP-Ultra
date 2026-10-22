# ue_camfollow.py - a camera that FOLLOWS a subject (keyed pan / truck + focus pull), behind shot_camera_follow
# (Tools/src/tools/shot-follow.ts). Exec'd after ue_posing.py and ue_shot.py (load_sequence, find_binding, skel_comp,
# bound_actor, evaluate, current_frame, _cam_xform_section, _bone_map, resolve_role).
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): Sequencer cameras cannot point at a spawnable through the camera's own
# look-at tracking (actor_to_track needs a real actor, and spawnables only exist while the sequence evaluates), so a
# tracking shot is KEYED: per sample frame the subject's bone is read (posed on the previous call) and the camera's
# transform channels are keyed to aim at it. Focus is keyed on the camera component's existing
# FocusSettings.ManualFocusDistance float track. camera_pose()/framing() read static (first-key) values; the follow check
# reads the live spawned camera instead.
import math

import unreal


def _key(section, name, frame, value):
    for ch in section.get_all_channels():
        if str(ch.channel_name) == name:
            fn = unreal.FrameNumber(int(frame))
            for k in list(ch.get_keys()):
                if k.get_time().frame_number.value == int(frame):
                    ch.remove_key(k)
            ch.add_key(fn, float(value))
            return True
    return False


def _comp_track(cam_binding, prop):
    for c in cam_binding.get_child_possessables():
        for t in c.get_tracks():
            if hasattr(t, "get_property_path") and str(t.get_property_path()) == prop:
                if not t.get_sections():
                    s = t.add_section()
                    s.set_range(-100000, 100000)
                return t.get_sections()[0]
    return None


def _bone(sk, bone):
    allb = _bone_map(sk)
    real = bone if bone in allb else resolve_role(allb, bone)
    if not real:
        raise ValueError("bone/role '%s' not found" % bone)
    return real


def follow_key(seq_path, cam_name, subject, bone, frame, mode="pan", offset=None, location=None, lead=0.0,
               focus=True, prev_yaw=None, lock_z=None, screen=None):
    """Key the camera at `frame` (subject posed at this frame by the previous call). mode 'pan': camera stays at
    `location` (default: where it is) and turns; 'truck': camera = bone + `offset` (world cm), aimed at the bone.
    lead: yaw offset (deg) to leave room ahead. prev_yaw keeps the yaw continuous across keys."""
    seq = load_sequence(seq_path)
    cb = find_binding(seq, cam_name)
    sk = skel_comp(seq, find_binding(seq, subject))
    real = _bone(sk, bone)
    p = sk.get_socket_location(real)
    if mode == "truck":
        if offset is None:
            raise ValueError("truck mode needs offset [x, y, z]")
        # CLAUDE-NOTE (live): following the bone's height copied the walk's vertical bob into the camera (z 121-129
        # cm, a handheld wobble); lock_z holds the camera height (the aim still follows the bone).
        loc = unreal.Vector(p.x + offset[0], p.y + offset[1], float(lock_z) if lock_z is not None else p.z + offset[2])
    else:
        if location is not None:
            loc = unreal.Vector(*location)
        else:
            live = bound_actor(seq, cb)
            loc = live.get_actor_location() if live else unreal.Vector(0, 0, 0)
    d = p - loc
    yaw = math.degrees(math.atan2(d.y, d.x)) + float(lead)
    if prev_yaw is not None:
        while yaw - prev_yaw > 180:
            yaw -= 360
        while yaw - prev_yaw < -180:
            yaw += 360
    pitch = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    if screen:
        # CLAUDE-NOTE (live): centring the chest at 50 mm cut the head off; `screen` puts the bone at (u, v) of the
        # frame in the same angle units follow_check measures (u, v = angle / half-FOV), e.g. v -0.25 for headroom.
        live = bound_actor(seq, cb)
        cc = live.get_cine_camera_component() if live else cb.get_object_template().get_cine_camera_component()
        fl = cc.get_editor_property("current_focal_length")
        fb = cc.get_editor_property("filmback")
        yaw -= float(screen[0]) * math.degrees(math.atan(fb.sensor_width / 2.0 / fl))
        pitch -= float(screen[1]) * math.degrees(math.atan(fb.sensor_height / 2.0 / fl))
    sec = _cam_xform_section(cb)
    for name, v in (("Location.X", loc.x), ("Location.Y", loc.y), ("Location.Z", loc.z),
                    ("Rotation.X", 0.0), ("Rotation.Y", pitch), ("Rotation.Z", yaw)):
        if not _key(sec, name, frame, v):
            raise RuntimeError("camera transform has no channel " + name)
    dist = d.length()
    focused = False
    if focus:
        fs = _comp_track(cb, "FocusSettings.ManualFocusDistance")
        if fs is not None:
            focused = _key(fs, [str(c.channel_name) for c in fs.get_all_channels()][0], frame, dist)
    return {"ok": True, "frame": int(frame), "bone": real, "location": [round(loc.x, 2), round(loc.y, 2), round(loc.z, 2)],
            "yaw": round(yaw, 3), "pitch": round(pitch, 3), "focus_cm": round(dist, 2), "focus_keyed": focused}


def follow_setup(seq_path, cam_name, aperture=None):
    """Manual focus on (template + live) so the keyed focus distance is used; optional aperture (f-stop)."""
    seq = load_sequence(seq_path)
    cb = find_binding(seq, cam_name)
    tpl = cb.get_object_template()
    live = bound_actor(seq, cb)
    comps = [c for c in (tpl.get_cine_camera_component() if tpl else None,
                         live.get_cine_camera_component() if live else None) if c]
    for cc in comps:
        fs = cc.get_editor_property("focus_settings")
        fs.focus_method = unreal.CameraFocusMethod.MANUAL
        cc.set_editor_property("focus_settings", fs)
        if aperture:
            cc.set_editor_property("current_aperture", float(aperture))
    if aperture:
        sec = _comp_track(cb, "CurrentAperture")
        if sec is not None:
            for ch in sec.get_all_channels():
                for k in list(ch.get_keys()):
                    ch.remove_key(k)
                ch.set_default(float(aperture))
    return {"ok": True, "components": len(comps)}


def follow_check(seq_path, cam_name, subject, bone):
    """At the CURRENT frame (posed last tick): where the bone lands in the LIVE camera (u, v in [-1, 1]) and the focus
    distance vs the camera-bone distance."""
    seq = load_sequence(seq_path)
    cb = find_binding(seq, cam_name)
    live = bound_actor(seq, cb)
    if live is None:
        raise RuntimeError("camera '%s' is not spawned at this frame" % cam_name)
    cc = live.get_cine_camera_component()
    sk = skel_comp(seq, find_binding(seq, subject))
    p = sk.get_socket_location(_bone(sk, bone))
    t = cc.get_world_transform()
    rot = t.rotation.rotator()
    fwd, right, up = rot.get_forward_vector(), rot.get_right_vector(), rot.get_up_vector()
    d = p - t.translation
    fl = cc.get_editor_property("current_focal_length")
    fb = cc.get_editor_property("filmback")
    hh = math.atan(fb.sensor_width / 2.0 / fl)
    vh = math.atan(fb.sensor_height / 2.0 / fl)
    z = d.dot(fwd)
    fsd = cc.get_editor_property("focus_settings").manual_focus_distance
    return {"ok": True, "frame": current_frame(), "u": round(math.atan2(d.dot(right), z) / hh, 4) if z > 0 else None,
            "v": round(math.atan2(d.dot(up), z) / vh, 4) if z > 0 else None, "dist": round(d.length(), 2),
            "focus": round(fsd, 2), "focus_method": str(cc.get_editor_property("focus_settings").focus_method).split(".")[-1].split(":")[0],
            "camera": [round(t.translation.x, 1), round(t.translation.y, 1), round(t.translation.z, 1)]}
