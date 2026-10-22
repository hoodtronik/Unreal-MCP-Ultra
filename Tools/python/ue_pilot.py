# ue_pilot.py - pilot a camera in the level viewport (the viewport looks through it), move it (keys for a sequence
# camera, direct for a level actor) and eject. Behind viewport_pilot (Tools/src/tools/viewport-pilot.ts).
# Exec'd after ue_posing.py.
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): piloting syncs camera -> viewport only. set_level_viewport_camera_info while
# piloting is undone on the next tick (the viewport snaps back to the actor), and a SEQUENCE camera's actor is
# re-posed from its transform keys every tick - so moving a piloted camera means keying it (sequence) or moving the
# actor (level), and the viewport then follows.
import unreal

LES = lambda: unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)


def _target(seq_path, name):
    if seq_path:
        seq = load_sequence(seq_path, open_it=True)
        try:
            b = find_binding(seq, name)
            return bound_actor(seq, b), seq, b
        except ValueError:
            pass
    a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == name), None)
    if a is None:
        raise ValueError("no camera binding or level actor '%s'" % name)
    return a, None, None


def pilot(seq_path, name):
    a, _, _ = _target(seq_path, name)
    LES().eject_pilot_level_actor()
    LES().pilot_level_actor(a)
    return {"ok": True}


def _key_transform(seq, b, frame, loc, rot):
    sec = None
    for t in b.get_tracks():
        if isinstance(t, unreal.MovieScene3DTransformTrack) and t.get_sections():
            sec = t.get_sections()[0]
    if sec is None:
        sec = b.add_track(unreal.MovieScene3DTransformTrack).add_section()
        sec.set_range(-100000, 100000)
    ch = {str(c.channel_name): c for c in sec.get_all_channels()}
    vals = {"Location.X": loc[0], "Location.Y": loc[1], "Location.Z": loc[2]}
    if rot is not None:
        vals.update({"Rotation.Y": rot[0], "Rotation.Z": rot[1], "Rotation.X": rot[2]})
    for k, v in vals.items():
        for old in list(ch[k].get_keys()):
            if old.get_time().frame_number.value == FN(int(frame)).value:
                ch[k].remove_key(old)
        ch[k].add_key(FN(int(frame)), float(v))


def pilot_move(seq_path, name, loc, rot=None, frame=0):
    a, seq, b = _target(seq_path, name)
    if b is not None:
        _key_transform(seq, b, frame, loc, rot)
        evaluate(seq, int(frame))
        how = "keyed at frame %d" % int(frame)
    else:
        a.set_actor_location(unreal.Vector(*loc), False, False)
        if rot is not None:
            a.set_actor_rotation(unreal.Rotator(pitch=rot[0], yaw=rot[1], roll=rot[2]), False)
        how = "moved"
    return {"ok": True, "how": how}


def pilot_state(seq_path, name):
    a, _, _ = _target(seq_path, name)
    p = LES().get_pilot_level_actor()
    info = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_level_viewport_camera_info()
    v = lambda x: [round(x.x, 3), round(x.y, 3), round(x.z, 3)]
    r = lambda x: [round(x.pitch, 3), round(x.yaw, 3), round(x.roll, 3)]
    return {"ok": True, "piloting": p == a, "pilot": p.get_actor_label() if p else None,
            "actor": {"location": v(a.get_actor_location()), "rotation": r(a.get_actor_rotation())},
            "view": {"location": v(info[0]), "rotation": r(info[1])} if info else None}


def eject():
    LES().eject_pilot_level_actor()
    p = LES().get_pilot_level_actor()
    return {"ok": True, "pilot": p.get_actor_label() if p else None}
