# ue_posing.py - Control Rig posing helpers behind the pose_* MCP tools (Tools/src/tools/posing.ts).
#
# The TS tool prepends this file to a short call and runs it through /api/run-python; every public
# function returns a JSON-able dict. Kept as a real .py file so it can be exec()'d and probed by hand:
#   exec(open(r"<repo>/Tools/python/ue_posing.py").read()); print(read_pose("/Game/X/SEQ", "Manny"))
#
# CLAUDE-NOTE (2026-10-21): ported from .agents/skills/ue5-previz-sequencer/scripts/previz_lib.py (live-verified
# on 5.6.1 + 5.8.3) and re-verified on UE 5.6.1 / MyLab_5_6. Three rules shape this module:
#  1. Control Rig reads/writes only work while the sequence is OPEN in Sequencer (else identity / silent no-op).
#  2. Sequencer applies a Control Rig pose on the editor TICK: bones read in the same run_python call as the
#     write are stale. Writers here never report bone positions; the TS tool reads back on a later call.
#  3. Typed accessors must match the control type; the wrong one silently returns 0 / identity. Dispatch on type.
import math

import unreal

L = unreal.ControlRigSequencerLibrary
LSE = unreal.LevelSequenceEditorBlueprintLibrary
FN = unreal.FrameNumber
DR = unreal.MovieSceneTimeUnit.DISPLAY_RATE

# CLAUDE-NOTE (2026-10-21, live): UE5 mannequin / MetaHuman meshes face +Y at actor yaw 0, so the direction a
# bare SkeletalMeshActor visually faces is actor_yaw + 90. Measured: toes foot->ball 96/137 deg at yaw 0.
MESH_YAW_OFFSET = 90.0

# Bone-name candidates per role, mannequin first. Matched case-insensitively as a suffix-insensitive stem.
ROLE_BONES = {
    "pelvis": ["pelvis", "hips"], "head": ["head"],
    "upperarm_l": ["upperarm_l", "leftarm"], "upperarm_r": ["upperarm_r", "rightarm"],
    "hand_l": ["hand_l", "lefthand"], "hand_r": ["hand_r", "righthand"],
    "foot_l": ["foot_l", "leftfoot"], "foot_r": ["foot_r", "rightfoot"],
    "ball_l": ["ball_l", "lefttoebase"], "ball_r": ["ball_r", "righttoebase"],
}
# Effector -> (IK control, FK/IK switch control) on CR_Mannequin_Body (148 controls) and rigs that copy its naming.
EFFECTORS = {
    "hand_l": ("hand_l_ik_ctrl", "arm_l_fk_ik_switch"), "hand_r": ("hand_r_ik_ctrl", "arm_r_fk_ik_switch"),
    "foot_l": ("foot_l_ik_ctrl", "leg_l_fk_ik_switch"), "foot_r": ("foot_r_ik_ctrl", "leg_r_fk_ik_switch"),
}


def _v(x):
    return [round(float(x.x), 3), round(float(x.y), 3), round(float(x.z), 3)]


def _rot(r):
    # unreal.Rotator's POSITIONAL order is (roll, pitch, yaw); tools take [pitch, yaw, roll] and pass keywords.
    return unreal.Rotator(pitch=float(r[0]), yaw=float(r[1]), roll=float(r[2]))


def _r(r):
    return [round(float(r.pitch), 3), round(float(r.yaw), 3), round(float(r.roll), 3)]


def _world():
    return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()


def _eas():
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


# ------------------------------------------------------------------ sequence + binding resolution

def load_sequence(path, open_it=True, create=False, fps=24, end=48):
    seq = unreal.load_asset(path) if unreal.EditorAssetLibrary.does_asset_exist(path) else None
    if seq is None:
        if not create:
            raise ValueError("LevelSequence not found: " + path)
        pkg, name = path.rsplit("/", 1)
        seq = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
            name, pkg, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
        seq.set_display_rate(unreal.FrameRate(int(fps), 1))
        seq.set_playback_start(0)
        seq.set_playback_end(int(end))
    if not isinstance(seq, unreal.LevelSequence):
        raise ValueError(path + " is not a LevelSequence")
    if open_it and LSE.get_focused_level_sequence() != seq:
        LSE.open_level_sequence(seq)
    return seq


def find_binding(seq, name):
    for b in seq.get_bindings():
        if str(b.get_display_name()) == name:
            return b
    raise ValueError("No binding '%s' in %s. Bindings: %s" % (
        name, seq.get_name(), ", ".join(str(b.get_display_name()) for b in seq.get_bindings())))


def set_time(frame):
    # set_current_time(int) is deprecated on 5.6; the playback-params form is the replacement on 5.6 and 5.8.
    pp = unreal.MovieSceneSequencePlaybackParams()
    pp.position_type = unreal.MovieScenePositionType.FRAME
    pp.frame = unreal.FrameTime(FN(int(frame)))
    LSE.set_global_position(pp, DR)


def current_frame():
    return int(LSE.get_global_position(DR).frame.frame_number.value)


def evaluate(seq, frame=None):
    if hasattr(LSE, "refresh_current_level_sequence"):
        LSE.refresh_current_level_sequence()
    set_time(seq.get_playback_start() if frame is None else frame)


def bound_actor(seq, binding):
    bid = unreal.MovieSceneSequenceExtensions.get_binding_id(seq, binding)
    for _ in range(2):
        for o in LSE.get_bound_objects(bid):
            if isinstance(o, unreal.Actor):
                return o
        evaluate(seq)  # a spawnable added in this call only exists after the next evaluation
    return None


def skel_comp(seq, binding):
    a = bound_actor(seq, binding)
    return a.get_component_by_class(unreal.SkeletalMeshComponent) if a else None


def rig_proxy(seq, binding):
    """(control_rig, track) for ONE binding - multi-character shots must never use index 0."""
    tracks = list(binding.get_tracks())
    for pr in L.get_control_rigs(seq):
        if pr.track in tracks:
            return pr.control_rig, pr.track
    raise ValueError("Binding '%s' has no Control Rig track (pose_setup_character adds one)" % binding.get_display_name())


def control_type(rig, name):
    key = unreal.RigElementKey(type=unreal.RigElementType.CONTROL, name=name)
    h = rig.get_hierarchy()
    # CLAUDE-NOTE (2026-10-21, live 5.6.1): find_control() on a MISSING name returns a default element (index -1)
    # whose type is EulerTransform, so a typo looked like a real transform control and writes "succeeded".
    if hasattr(h, "get_index") and h.get_index(key) < 0:
        return None
    if hasattr(h, "get_control_settings"):
        if hasattr(h, "contains") and not h.contains(key):
            return None
        ct = h.get_control_settings(key).control_type
    else:
        el = h.find_control(key)
        if not el:
            return None
        ct = el.settings.control_type
    return str(ct).split(".")[-1].split(":")[0].strip("<> ")


# ------------------------------------------------------------------ setup

def setup_character(seq_path, name, mesh, rig_bp, location=(0, 0, 0), facing=None, fps=24, end=48,
                    clip=None, clip_frame=0, frame=0):
    seq = load_sequence(seq_path, open_it=True, create=True, fps=fps, end=end)
    created = False
    try:
        b = find_binding(seq, name)
    except ValueError:
        m = unreal.load_asset(mesh)
        if not isinstance(m, unreal.SkeletalMesh):
            raise ValueError("Not a SkeletalMesh: " + mesh)
        tmp = _eas().spawn_actor_from_object(m, unreal.Vector(*location), unreal.Rotator())
        b = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).add_spawnable_from_instance(seq, tmp)
        b.set_display_name(name)
        _eas().destroy_actor(tmp)
        created = True
    rig_cls = unreal.load_asset(rig_bp)
    if rig_cls is None or not hasattr(rig_cls, "get_control_rig_class"):
        raise ValueError("Not a Control Rig Blueprint: " + str(rig_bp))
    try:
        rig, track = rig_proxy(seq, b)
    except ValueError:
        L.find_or_create_control_rig_track(_world(), seq, rig_cls.get_control_rig_class(), b)
        rig, track = rig_proxy(seq, b)
    if facing is not None:
        set_actor_yaw(seq, b, float(facing) - MESH_YAW_OFFSET, location)
    baked = None
    if clip:
        baked = bake_clip_frame(seq, b, clip, int(clip_frame), int(frame))
    evaluate(seq, frame)
    return {"ok": True, "sequence": seq.get_path_name().split(".")[0], "binding": name, "created": created,
            "rig": rig.get_class().get_name(), "controls": len(rig.get_hierarchy().get_controls()), "clip_baked": baked}


def _xform_section(binding):
    for t in binding.get_tracks():
        if isinstance(t, unreal.MovieScene3DTransformTrack):
            secs = t.get_sections()
            if secs:
                return secs[0]
    t = binding.add_track(unreal.MovieScene3DTransformTrack)
    s = t.add_section()
    s.set_range(-100000, 100000)
    return s


def _write_channel(section, channel, value):
    for ch in section.get_all_channels():
        if str(ch.channel_name) == channel:
            keys = ch.get_keys() if hasattr(ch, "get_keys") else []
            if keys:
                for k in keys:
                    k.set_value(float(value))
            else:
                ch.set_default(float(value))
            return True
    return False


def set_actor_yaw(seq, binding, yaw, location=None):
    sec = _xform_section(binding)
    if not _write_channel(sec, "Rotation.Z", yaw):
        raise RuntimeError("transform section has no Rotation.Z channel")
    if location is not None:
        for ch, v in zip(("Location.X", "Location.Y", "Location.Z"), location):
            _write_channel(sec, ch, v)
    evaluate(seq)
    return {"ok": True, "yaw": float(yaw)}


# ------------------------------------------------------------------ clip -> held pose

def _clear_keys(section):
    n = 0
    for ch in section.get_all_channels():
        if hasattr(ch, "get_keys"):
            for k in list(ch.get_keys()):
                ch.remove_key(k)
                n += 1
    return n


def _collapse(section, at_frame):
    for ch in section.get_all_channels():
        if not hasattr(ch, "get_keys"):
            continue
        kept = False
        for k in list(ch.get_keys()):
            t = k.get_time(DR)
            if t.frame_number.value == int(at_frame) and abs(t.sub_frame) < 1e-6 and not kept:
                kept = True
                continue
            ch.remove_key(k)


def bake_clip_frame(seq, binding, clip, clip_frame, at_frame=0):
    """Hold ONE frame of an AnimSequence on the Control Rig at at_frame (replaces existing keys)."""
    rig, track = rig_proxy(seq, binding)
    sec = track.get_sections()[0]
    anim = unreal.load_asset(clip)
    if not isinstance(anim, unreal.AnimSequence):
        raise ValueError("Not an AnimSequence: " + str(clip))
    sk = skel_comp(seq, binding)
    L.show_all_controls(sec)   # a masked section silently bakes 0 keys while returning True
    _clear_keys(sec)
    ok = L.load_anim_sequence_into_control_rig_section_with_range(
        sec, anim, sk, FN(at_frame), True, FN(clip_frame), FN(clip_frame + 1), DR,
        False, 0.001, unreal.MovieSceneKeyInterpolation.CONSTANT, True, False)
    if ok:
        _collapse(sec, at_frame)
    keys = sum(len(ch.get_keys()) for ch in sec.get_all_channels() if hasattr(ch, "get_keys"))
    if not ok or keys == 0:
        raise RuntimeError("Clip bake wrote %d keys (ok=%s) - skeleton mismatch or masked section?" % (keys, ok))
    return {"clip": clip, "clip_frame": clip_frame, "at_frame": at_frame, "keys": keys}


# ------------------------------------------------------------------ controls

def list_controls(seq_path, binding_name, contains=None, kind=None, limit=400):
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    out = []
    for k in rig.get_hierarchy().get_controls():
        n = str(k.name)
        if contains and contains.lower() not in n.lower():
            continue
        t = control_type(rig, n)
        if kind and t != kind.upper():
            continue
        out.append([n, t])
    return {"ok": True, "count": len(out), "controls": out[:int(limit)], "truncated": len(out) > int(limit)}


def get_control_value(seq, rig, name, frame, world=False):
    t = control_type(rig, name)
    f = FN(int(frame))
    if t is None:
        raise ValueError("No control named '%s'" % name)
    if world:
        x = L.get_control_rig_world_transform(seq, rig, name, f, DR)
        return {"type": t, "space": "world", "location": _v(x.translation), "rotation": _r(x.rotation.rotator())}
    if t == "EULER_TRANSFORM":
        e = L.get_local_control_rig_euler_transform(seq, rig, name, f, DR)
        return {"type": t, "location": _v(e.location), "rotation": _r(e.rotation), "scale": _v(e.scale)}
    if t == "TRANSFORM":
        x = L.get_local_control_rig_transform(seq, rig, name, f, DR)
        return {"type": t, "location": _v(x.translation), "rotation": _r(x.rotation.rotator()), "scale": _v(x.scale3d)}
    if t == "TRANSFORM_NO_SCALE":
        x = L.get_local_control_rig_transform_no_scale(seq, rig, name, f, DR)
        return {"type": t, "location": _v(x.location), "rotation": _r(x.rotation.rotator())}
    if t == "FLOAT":
        return {"type": t, "value": round(L.get_local_control_rig_float(seq, rig, name, f, DR), 5)}
    if t == "BOOL":
        return {"type": t, "value": bool(L.get_local_control_rig_bool(seq, rig, name, f, DR))}
    if t == "INTEGER":
        return {"type": t, "value": int(L.get_local_control_rig_int(seq, rig, name, f, DR))}
    if t == "POSITION":
        return {"type": t, "location": _v(L.get_local_control_rig_position(seq, rig, name, f, DR))}
    if t == "ROTATOR":
        return {"type": t, "rotation": _r(L.get_local_control_rig_rotator(seq, rig, name, f, DR))}
    if t == "VECTOR2D":
        v = L.get_local_control_rig_vector2d(seq, rig, name, f, DR)
        return {"type": t, "value": [v.x, v.y]}
    raise ValueError("%s: unsupported control type %s" % (name, t))


def _set_one(seq, rig, c, frame, key=True):
    name = c["control"]
    t = control_type(rig, name)
    f = FN(int(frame))
    if t is None:
        raise ValueError("No control named '%s'" % name)
    loc, rot, scl, val = c.get("location"), c.get("rotation"), c.get("scale"), c.get("value")
    if c.get("world"):
        cur = L.get_control_rig_world_transform(seq, rig, name, f, DR)
        x = unreal.Transform(location=unreal.Vector(*loc) if loc is not None else cur.translation,
                             rotation=_rot(rot) if rot is not None else cur.rotation.rotator(),
                             scale=cur.scale3d)
        L.set_control_rig_world_transform(seq, rig, name, f, x, DR, key)
    elif t == "EULER_TRANSFORM":
        cur = L.get_local_control_rig_euler_transform(seq, rig, name, f, DR)
        L.set_local_control_rig_euler_transform(seq, rig, name, f, unreal.EulerTransform(
            location=unreal.Vector(*loc) if loc is not None else cur.location,
            rotation=_rot(rot) if rot is not None else cur.rotation,
            scale=unreal.Vector(*scl) if scl is not None else cur.scale), DR, key)
    elif t == "TRANSFORM":
        cur = L.get_local_control_rig_transform(seq, rig, name, f, DR)
        L.set_local_control_rig_transform(seq, rig, name, f, unreal.Transform(
            location=unreal.Vector(*loc) if loc is not None else cur.translation,
            rotation=_rot(rot) if rot is not None else cur.rotation.rotator(),
            scale=unreal.Vector(*scl) if scl is not None else cur.scale3d), DR, key)
    elif t == "FLOAT":
        L.set_local_control_rig_float(seq, rig, name, f, float(val), DR, key)
    elif t == "BOOL":
        L.set_local_control_rig_bool(seq, rig, name, f, bool(val), DR, key)
    elif t == "INTEGER":
        L.set_local_control_rig_int(seq, rig, name, f, int(val), DR, key)
    elif t == "POSITION":
        L.set_local_control_rig_position(seq, rig, name, f, unreal.Vector(*loc), DR, key)
    elif t == "ROTATOR":
        L.set_local_control_rig_rotator(seq, rig, name, f, _rot(rot), DR, key)
    else:
        raise ValueError("%s: unsupported control type %s" % (name, t))
    return t


def set_controls(seq_path, binding_name, frame, controls, key=True):
    """Write several controls at one frame. Bone effects are only visible on the NEXT call (read_pose)."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = rig_proxy(seq, b)
    written = []
    for c in controls:
        written.append([c["control"], _set_one(seq, rig, c, frame, key)])
    evaluate(seq, frame)
    return {"ok": True, "written": written}


# ------------------------------------------------------------------ readback

def _bone_map(sk):
    return [str(sk.get_bone_name(i)) for i in range(sk.get_num_bones())]


def resolve_role(bones, role):
    low = {b.lower(): b for b in bones}
    for cand in ROLE_BONES.get(role, [role]):
        if cand in low:
            return low[cand]
    for cand in ROLE_BONES.get(role, [role]):   # prefixed / suffixed names (mixamorig:LeftHand, girl02_hand_l_09)
        for lb, b in low.items():
            if cand in lb.replace(":", "_") and "twist" not in lb and "ik_" not in lb:
                return b
    return None


def measure_facing(sk):
    """World yaw the character visually faces, from shoulders (convention-free) and toes (foot->ball)."""
    bones = _bone_map(sk)
    out = {}
    ul, ur = resolve_role(bones, "upperarm_l"), resolve_role(bones, "upperarm_r")
    if ul and ur:
        l, r = sk.get_socket_location(ul), sk.get_socket_location(ur)
        lx, ly = l.x - r.x, l.y - r.y
        # UE is left-handed (X fwd, Y right, Z up): facing +X puts the LEFT shoulder on -Y.
        out["shoulders"] = round(math.degrees(math.atan2(lx, -ly)), 2)
    toes = []
    for s in ("l", "r"):
        fb, bb = resolve_role(bones, "foot_" + s), resolve_role(bones, "ball_" + s)
        if fb and bb:
            f, t = sk.get_socket_location(fb), sk.get_socket_location(bb)
            toes.append(math.atan2(t.y - f.y, t.x - f.x))
    if toes:
        out["toes"] = round(math.degrees(math.atan2(sum(math.sin(a) for a in toes), sum(math.cos(a) for a in toes))), 2)
    return out


def read_pose(seq_path, binding_name, frame=None, bones=None, controls=None, world_controls=False):
    """Posed WORLD bone positions + facing + ground contact for a binding. Call on a later tick than a write."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    if frame is not None and current_frame() != int(frame):
        evaluate(seq, frame)
        stale = True   # scrubbed in this call: Control Rig poses apply on the next tick
    else:
        stale = False
    sk = skel_comp(seq, b)
    if sk is None:
        raise RuntimeError("No SkeletalMeshComponent bound to '%s' (sequence open?)" % binding_name)
    allb = _bone_map(sk)
    want = bones or ["pelvis", "head", "hand_l", "hand_r", "foot_l", "foot_r"]
    pos = {}
    for w in want:
        real = w if w in allb else resolve_role(allb, w)
        pos[w] = _v(sk.get_socket_location(real)) if real else None
    feet = [sk.get_socket_location(x).z for x in (resolve_role(allb, "foot_l"), resolve_role(allb, "foot_r"),
                                                   resolve_role(allb, "ball_l"), resolve_role(allb, "ball_r")) if x]
    act = sk.get_owner()
    res = {"ok": True, "frame": current_frame(), "stale": stale, "bones": pos,
           "facing": measure_facing(sk), "lowest_foot_z": round(min(feet), 3) if feet else None,
           "actor": {"location": _v(act.get_actor_location()), "yaw": round(act.get_actor_rotation().yaw, 3)}}
    if controls:
        rig, _ = rig_proxy(seq, b)
        res["controls"] = {c: get_control_value(seq, rig, c, res["frame"], world_controls) for c in controls}
    return res


# ------------------------------------------------------------------ IK reach

def reach(seq_path, binding_name, effector, target, frame=0, rotation=None):
    """Switch a limb to IK and put its IK control at a WORLD point. Verify with read_pose on the next call."""
    if effector not in EFFECTORS:
        raise ValueError("effector must be one of " + ", ".join(EFFECTORS))
    ctrl, switch = EFFECTORS[effector]
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = rig_proxy(seq, b)
    if control_type(rig, ctrl) is None:
        raise ValueError("Rig %s has no control '%s' - reach supports CR_Mannequin_Body-style rigs" % (rig.get_class().get_name(), ctrl))
    if control_type(rig, switch) == "BOOL":
        L.set_local_control_rig_bool(seq, rig, switch, FN(int(frame)), True, DR, True)
    elif control_type(rig, switch) == "FLOAT":
        L.set_local_control_rig_float(seq, rig, switch, FN(int(frame)), 1.0, DR, True)
    _set_one(seq, rig, {"control": ctrl, "location": target, "rotation": rotation, "world": True}, frame)
    # Reach budget from the reference skeleton (pose-independent): root of the limb -> target vs. limb length.
    side = effector[-1]
    chain = ["upperarm_", "lowerarm_", "hand_"] if effector.startswith("hand") else ["thigh_", "calf_", "foot_"]
    out = {"ok": True, "control": ctrl, "switch": switch, "target": list(target)}
    sk = skel_comp(seq, b)
    if sk is not None:
        ref = [sk.get_socket_location(c + side) for c in chain]   # current pose; only bone LENGTHS are used
        out["limb_length"] = round((ref[1] - ref[0]).length() + (ref[2] - ref[1]).length(), 2)
        out["limb_root"] = chain[0] + side
    evaluate(seq, frame)
    return out


def target_point(spec):
    """[x,y,z] | {"actor": label} | {"actor": label, "bone": name} | {"actor": label, "offset": [x,y,z]}"""
    if isinstance(spec, (list, tuple)):
        return [float(v) for v in spec]
    lbl = spec.get("actor")
    a = next((x for x in _eas().get_all_level_actors() if x.get_actor_label() == lbl), None)
    if a is None:
        raise ValueError("No level actor labelled '%s'" % lbl)
    if spec.get("bone"):
        p = a.get_component_by_class(unreal.SkeletalMeshComponent).get_socket_location(spec["bone"])
    else:
        p = a.get_actor_location()
    o = spec.get("offset") or [0, 0, 0]
    return [p.x + o[0], p.y + o[1], p.z + o[2]]


# ------------------------------------------------------------------ preview a clip on a level actor

def preview_anim(label, anim_path, time=0.0, mesh=None, location=None, facing=None):
    """Show one moment of an AnimSequence on a level SkeletalMeshActor (spawned if missing). Bones update on the
    NEXT editor tick - read them back with read_actor_pose on a later call.
    CLAUDE-NOTE (2026-10-21, live 5.6.1): override_animation_data / set_animation + set_position on an editor
    component do NOT re-evaluate bones (sockets kept the previous clip's pose across calls). What works:
    set_update_animation_in_editor(True) + single-node play_animation + set_position, applied on the next tick."""
    anim = unreal.load_asset(anim_path)
    if not isinstance(anim, unreal.AnimSequenceBase):
        raise ValueError("Not an animation asset: " + str(anim_path))
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    created = False
    if act is None:
        if not mesh:
            raise ValueError("No actor '%s'; pass mesh to spawn one" % label)
        act = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*(location or (0, 0, 0))))
        act.set_actor_label(label)
        created = True
    c = act.get_component_by_class(unreal.SkeletalMeshComponent)
    if mesh:
        c.set_skeletal_mesh_asset(unreal.load_asset(mesh))
    if location is not None:
        act.set_actor_location(unreal.Vector(*location), False, False)
    if facing is not None:
        act.set_actor_rotation(unreal.Rotator(pitch=0.0, yaw=float(facing) - MESH_YAW_OFFSET, roll=0.0), False)
    sk = c.get_skeletal_mesh_asset()
    if sk is None or sk.get_editor_property("skeleton") != anim.get_editor_property("skeleton"):
        raise ValueError("Animation skeleton does not match the actor's mesh skeleton")
    c.set_update_animation_in_editor(True)
    c.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    c.play_animation(anim, False)
    c.set_position(float(time), False)
    c.set_play_rate(0.0)
    return {"ok": True, "actor": label, "created": created, "anim": anim_path, "time": float(time),
            "length": round(anim.get_play_length(), 4)}


def read_actor_pose(label, bones=None):
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        raise ValueError("No level actor labelled '%s'" % label)
    sk = act.get_component_by_class(unreal.SkeletalMeshComponent)
    allb = _bone_map(sk)
    want = bones or ["pelvis", "head", "hand_l", "hand_r", "foot_l", "foot_r"]
    pos = {}
    for w in want:
        real = w if w in allb else resolve_role(allb, w)
        pos[w] = _v(sk.get_socket_location(real)) if real else None
    feet = [sk.get_socket_location(x).z for x in (resolve_role(allb, "foot_l"), resolve_role(allb, "foot_r"),
                                                   resolve_role(allb, "ball_l"), resolve_role(allb, "ball_r")) if x]
    # The live clip is on the single-node instance; animation_data.anim_to_play is the stale saved field.
    ai = sk.get_anim_instance()
    asset = ai.get_animation_asset() if isinstance(ai, unreal.AnimSingleNodeInstance) else None
    return {"ok": True, "actor": label, "bones": pos, "facing": measure_facing(sk),
            "lowest_foot_z": round(min(feet), 3) if feet else None,
            "anim": asset.get_path_name() if asset else None,
            "position": round(sk.get_position(), 4) if hasattr(sk, "get_position") else None}


# ------------------------------------------------------------------ gaze / look-at

# CLAUDE-NOTE (2026-10-21, live 5.6.1): on the UE5 mannequin (and MetaHuman-style skeletons) the head bone's +Y
# axis is the gaze direction and +X runs up the neck (Manny facing +Y: head Y = (0.25, 0.95, -0.19)).
GAZE_AXIS = "Y"


def gaze(seq_path, binding_name, target=None, frame=None):
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    if sk is None:
        raise RuntimeError("no skeletal mesh bound to '%s'" % binding_name)
    head = resolve_role(_bone_map(sk), "head")
    t = sk.get_socket_transform(head, unreal.RelativeTransformSpace.RTS_WORLD)
    r = t.rotation.rotator()
    g = r.get_right_vector() if GAZE_AXIS == "Y" else r.get_forward_vector()
    out = {"ok": True, "head": _v(t.translation), "gaze": _v(g),
           "gaze_yaw": round(math.degrees(math.atan2(g.y, g.x)), 2),
           "gaze_pitch": round(math.degrees(math.asin(max(-1.0, min(1.0, g.z)))), 2)}
    f = measure_facing(sk)
    face = f.get("shoulders", f.get("toes"))
    if face is not None:
        out["head_turn_vs_body"] = round((out["gaze_yaw"] - face + 540) % 360 - 180, 2)
    if target is not None:
        d = unreal.Vector(*target) - t.translation
        d = d / (d.length() or 1.0)
        out["error_deg"] = round(math.degrees(math.acos(max(-1.0, min(1.0, g.dot(d))))), 3)
    return out


def look_at_step(seq_path, binding_name, target, frame=0, control="head_ctrl", max_turn=75.0):
    """Rotate `control` in WORLD space by the rotation that takes the current gaze onto the target direction.
    One step; the effect is only visible on the next tick (the TS tool iterates write -> read)."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    rig, _ = rig_proxy(seq, b)
    if control_type(rig, control) is None:
        raise ValueError("rig has no control '%s'" % control)
    gz = gaze(seq_path, binding_name, target)
    g = unreal.Vector(*gz["gaze"])
    d = unreal.Vector(*target) - unreal.Vector(*gz["head"])
    d = d / (d.length() or 1.0)
    axis = g.cross(d)
    ang = math.degrees(math.acos(max(-1.0, min(1.0, g.dot(d)))))
    if axis.length() < 1e-6 or ang < 1e-3:
        return {"ok": True, "applied_deg": 0.0, "before_error_deg": gz["error_deg"]}
    q_delta = unreal.MathLibrary.rotator_from_axis_and_angle(axis / axis.length(), ang).quaternion()
    f = FN(int(frame))
    cur = L.get_control_rig_world_transform(seq, rig, control, f, DR)
    new_q = q_delta.multiply(cur.rotation)
    L.set_control_rig_world_transform(seq, rig, control, f,
                                      unreal.Transform(location=cur.translation, rotation=new_q.rotator(), scale=cur.scale3d), DR, True)
    evaluate(seq, frame)
    res = {"ok": True, "applied_deg": round(ang, 3), "before_error_deg": gz["error_deg"]}
    turn = gz.get("head_turn_vs_body")
    if turn is not None:
        dyaw = math.degrees(math.atan2(d.y, d.x)) - (gz["gaze_yaw"] - turn)
        dyaw = (dyaw + 540) % 360 - 180
        if abs(dyaw) > max_turn:
            res["warning"] = "target is %.0f deg off the body's facing (> %.0f): turn the body/spine too" % (dyaw, max_turn)
    return res


def seq_target(seq_path, spec):
    """[x,y,z] | {binding, bone?, offset?} (a character in this sequence) | {actor, bone?, offset?} (level actor)."""
    if isinstance(spec, dict) and spec.get("binding"):
        seq = load_sequence(seq_path)
        b = find_binding(seq, spec["binding"])
        sk = skel_comp(seq, b)
        o = spec.get("offset") or [0, 0, 0]
        if sk is None:   # a camera or prop binding: its actor location (look into the lens = {binding: 'ShotCam'})
            act = bound_actor(seq, b)
            if act is None:
                raise ValueError("binding '%s' has no bound actor" % spec["binding"])
            p = act.get_actor_location()
            return [p.x + o[0], p.y + o[1], p.z + o[2]]
        bones = _bone_map(sk)
        bone = spec.get("bone") or "head"
        real = bone if bone in bones else resolve_role(bones, bone)
        if not real:
            raise ValueError("bone/role '%s' not on '%s'" % (bone, spec["binding"]))
        p = sk.get_socket_location(real)
        o = spec.get("offset") or [0, 0, 0]
        return [p.x + o[0], p.y + o[1], p.z + o[2]]
    return target_point(spec)


# ------------------------------------------------------------------ ground contact from the POSED SKIN

# Region -> bones whose nearest vertices belong to it. Bone centres cannot judge contact: a knee joint at z=-1.1
# meant skin 6 cm under the floor (measured 2026-10-21). The skin is read with GeometryScript's
# copy_mesh_from_component, which returns the CURRENT pose in world space (43,761 verts in 0.16 s for Quinn).
CONTACT_REGIONS = {
    "foot_l": ["foot_l", "ball_l"], "foot_r": ["foot_r", "ball_r"],
    "knee_l": ["calf_l"], "knee_r": ["calf_r"],
    "hand_l": ["hand_l"], "hand_r": ["hand_r"],
    "seat": ["pelvis", "thigh_l", "thigh_r"],
}
_OTHER = ["spine_01", "spine_03", "head", "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"]


def mesh_contacts(seq_path, binding_name, floor_z=0.0, tol=1.0):
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    if sk is None:
        raise RuntimeError("no skeletal mesh bound to '%s'" % binding_name)
    dm = unreal.DynamicMesh()
    res = unreal.GeometryScript_SceneUtils.copy_mesh_from_component(
        sk, dm, unreal.GeometryScriptCopyMeshFromComponentOptions(), True)
    if str(res[-1]).find("SUCCESS") < 0:
        raise RuntimeError("could not copy the posed mesh: %s" % res[-1])
    verts = unreal.GeometryScript_MeshQueries.get_all_vertex_positions(dm, False)[1].convert_vector_list_to_array()
    allb = _bone_map(sk)
    anchors = []
    for region, names in CONTACT_REGIONS.items():
        for n in names:
            real = resolve_role(allb, n) or (n if n in allb else None)
            if real:
                anchors.append((region, sk.get_socket_location(real)))
    for n in _OTHER:
        real = resolve_role(allb, n) or (n if n in allb else None)
        if real:
            anchors.append(("other", sk.get_socket_location(real)))
    low = {}
    cutoff = floor_z + 25.0   # only skin near the floor can be a contact; keeps the nearest-bone loop small
    for v in verts:
        if v.z > cutoff:
            continue
        region = min(anchors, key=lambda a: (a[1] - v).length())[0]
        if region not in low or v.z < low[region][2]:
            low[region] = (v.x, v.y, v.z)
    out = {}
    for region, p in low.items():
        if region == "other":
            continue
        h = p[2] - floor_z
        out[region] = {"lowest": [round(p[0], 2), round(p[1], 2), round(p[2], 2)], "height": round(h, 2),
                       "state": "PENETRATING" if h < -tol else ("contact" if h <= tol else "above")}
    zmin = min(v.z for v in verts)
    return {"ok": True, "floor_z": floor_z, "vertices": len(verts), "mesh_min_z": round(zmin, 2),
            "regions": out, "penetration": round(max(0.0, floor_z - zmin), 2)}


def nudge_control_z(seq_path, binding_name, control, dz, frame=0):
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    f = FN(int(frame))
    cur = L.get_control_rig_world_transform(seq, rig, control, f, DR)
    cur.translation = unreal.Vector(cur.translation.x, cur.translation.y, cur.translation.z + float(dz))
    L.set_control_rig_world_transform(seq, rig, control, f, cur, DR, True)
    evaluate(seq, frame)
    return {"ok": True, "control": control, "z": round(cur.translation.z, 3)}


# ------------------------------------------------------------------ animation: interpolation + motion readback

_INTERP = {"smooth": ("RCIM_CUBIC", "RCTM_AUTO"), "linear": ("RCIM_LINEAR", None), "constant": ("RCIM_CONSTANT", None)}


def set_interpolation(seq_path, binding_name, mode="smooth", controls=None):
    """Set key interpolation on a character's Control Rig channels (all, or channels of the named controls).
    CLAUDE-NOTE (2026-10-21): clip bakes (pose_setup_character) write CONSTANT keys so held poses step; keys added
    later inherit no smoothing, so pose-to-pose animation snaps unless the moving controls are set to smooth.
    Bool channels (switches) have no interpolation and are skipped."""
    if mode not in _INTERP:
        raise ValueError("mode must be one of " + ", ".join(_INTERP))
    seq = load_sequence(seq_path)
    _, track = rig_proxy(seq, find_binding(seq, binding_name))
    interp, tangent = _INTERP[mode]
    want = set(controls or [])
    n = 0
    for sec in track.get_sections():
        for ch in sec.get_all_channels():
            name = str(ch.channel_name)
            if want and name.split(".")[0] not in want:
                continue
            for k in (ch.get_keys() if hasattr(ch, "get_keys") else []):
                if hasattr(k, "set_interpolation_mode"):
                    k.set_interpolation_mode(getattr(unreal.RichCurveInterpMode, interp))
                    if tangent and hasattr(k, "set_tangent_mode"):
                        k.set_tangent_mode(getattr(unreal.RichCurveTangentMode, tangent))
                    n += 1
    evaluate(seq)
    return {"ok": True, "mode": mode, "keys": n}


def key_frames(seq_path, binding_name, controls=None):
    """Frames that hold keys on the character's Control Rig (optionally only these controls)."""
    seq = load_sequence(seq_path)
    _, track = rig_proxy(seq, find_binding(seq, binding_name))
    want = set(controls or [])
    fr = set()
    for sec in track.get_sections():
        for ch in sec.get_all_channels():
            if want and str(ch.channel_name).split(".")[0] not in want:
                continue
            for k in (ch.get_keys() if hasattr(ch, "get_keys") else []):
                fr.add(int(k.get_time(DR).frame_number.value))
    return {"ok": True, "frames": sorted(fr)}


def scrub(seq_path, frame):
    seq = load_sequence(seq_path)
    evaluate(seq, frame)
    return {"ok": True, "frame": int(frame)}


def bones_now(seq_path, binding_name, bones):
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    allb = _bone_map(sk)
    out = {}
    for w in bones:
        real = w if w in allb else resolve_role(allb, w)
        out[w] = _v(sk.get_socket_location(real)) if real else None
    return {"ok": True, "frame": current_frame(), "bones": out}


# ------------------------------------------------------------------ hand shapes

# CLAUDE-NOTE (2026-10-21, live 5.6.1, CR_Mannequin_Body): finger joint controls curl toward the palm with NEGATIVE
# yaw (index_02/03 yaw -45 shortened knuckle->tip; +45 lengthened it; pitch/roll barely moved it). The idle clip's
# own finger values sit at yaw -3..-19, consistent with that. Per-joint curl (deg) for 01/02/03:
HAND_SHAPES = {
    "open":    {"fingers": (0, 0, 0), "thumb": (0, 0, 0)},
    "relaxed": {"fingers": (-15, -20, -12), "thumb": (0, -10, -5)},
    "fist":    {"fingers": (-75, -95, -60), "thumb": (0, -35, -30)},
    "point":   {"fingers": (-75, -95, -60), "thumb": (0, -35, -30), "index": (0, 0, 0)},
}
FINGERS = ["index", "middle", "ring", "pinky"]


def hand_shape(seq_path, binding_name, side, shape, frame=0):
    if shape not in HAND_SHAPES:
        raise ValueError("shape must be one of " + ", ".join(HAND_SHAPES))
    if side not in ("l", "r"):
        raise ValueError("side must be 'l' or 'r'")
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    spec = HAND_SHAPES[shape]
    written = []
    for fname in FINGERS + ["thumb"]:
        curl = spec.get(fname) or (spec["thumb"] if fname == "thumb" else spec["fingers"])
        for j, deg in zip(("01", "02", "03"), curl):
            c = "%s_%s_%s_ctrl" % (fname, j, side)
            if control_type(rig, c) is None:
                continue
            _set_one(seq, rig, {"control": c, "rotation": [0.0, float(deg), 0.0]}, frame)
            written.append(c)
    evaluate(seq, frame)
    if not written:
        raise ValueError("rig has no finger controls named like index_01_%s_ctrl" % side)
    return {"ok": True, "shape": shape, "side": side, "controls": len(written)}


def hand_curl(seq_path, binding_name, side):
    """Measured curl per finger: knuckle(01)->joint(03) chord / straight length (1.0 = straight)."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    out = {}
    for fname in FINGERS:
        try:
            p = [sk.get_socket_location("%s_%s_%s" % (fname, j, side)) for j in ("01", "02", "03")]
        except Exception:
            continue
        straight = (p[1] - p[0]).length() + (p[2] - p[1]).length()
        out[fname] = round((p[2] - p[0]).length() / straight, 3) if straight > 0 else None
    return {"ok": True, "side": side, "chord_ratio": out}


# ------------------------------------------------------------------ palm direction

def palm(seq_path, binding_name, side, target=None):
    """Palm normal from geometry: (+1 right / -1 left) * cross(finger_dir, index_01 - pinky_01).
    CLAUDE-NOTE (2026-10-21, live): calibrated on Manny - right palm = +Y of hand_r (a fist moves the middle finger
    toward it), left palm = -Y of hand_l; at rest both point at the thighs. The cross product alone has the same
    sign on both hands (knuckle line and finger direction do not mirror), hence the side factor."""
    seq = load_sequence(seq_path)
    sk = skel_comp(seq, find_binding(seq, binding_name))
    h = sk.get_socket_location("hand_" + side)
    f = sk.get_socket_location("middle_01_" + side) - h
    sd = sk.get_socket_location("index_01_" + side) - sk.get_socket_location("pinky_01_" + side)
    f, sd = f / f.length(), sd / sd.length()
    n = f.cross(sd)
    n = n / n.length() * (1.0 if side == "r" else -1.0)
    out = {"ok": True, "hand": _v(h), "palm": _v(n), "fingers": _v(f)}
    if target is not None:
        d = unreal.Vector(*target) - h
        d = d / (d.length() or 1.0)
        out["error_deg"] = round(math.degrees(math.acos(max(-1.0, min(1.0, n.dot(d))))), 3)
    out["fingers_up_deg"] = round(math.degrees(math.acos(max(-1.0, min(1.0, f.z)))), 1)
    return out


def palm_step(seq_path, binding_name, side, target, frame=0, fingers=(0.0, 0.0, 1.0)):
    """Rotate the hand IK control so the palm faces `target` AND the fingers point as close to `fingers` (world
    direction, default up) as that allows.
    CLAUDE-NOTE (2026-10-21, live): a shortest-arc palm rotation faced the palm to camera but left the fingers
    pointing DOWN (wrist twisted backwards) - a wave needs the full orientation from two vectors. Built as
    delta = basis(desired palm, desired fingers) * basis(current palm, current fingers)^-1."""
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    ctrl = "hand_%s_ik_ctrl" % side
    if control_type(rig, ctrl) is None:
        raise ValueError("rig has no control " + ctrl)
    pm = palm(seq_path, binding_name, side, target)
    n, f = unreal.Vector(*pm["palm"]), unreal.Vector(*pm["fingers"])
    d = unreal.Vector(*target) - unreal.Vector(*pm["hand"])
    d = d / (d.length() or 1.0)
    want_f = unreal.Vector(*fingers)
    want_f = want_f - d * want_f.dot(d)          # fingers perpendicular to the palm normal
    if want_f.length() < 1e-3:
        want_f = f - d * f.dot(d)
    want_f = want_f / want_f.length()
    f_perp = f - n * f.dot(n)
    f_perp = f_perp / (f_perp.length() or 1.0)
    cur_basis = unreal.MathLibrary.make_rot_from_xz(n, f_perp).quaternion()
    new_basis = unreal.MathLibrary.make_rot_from_xz(d, want_f).quaternion()
    q = new_basis.multiply(cur_basis.inversed())
    ang = math.degrees(q.get_angle())
    fr = FN(int(frame))
    cur = L.get_control_rig_world_transform(seq, rig, ctrl, fr, DR)
    L.set_control_rig_world_transform(seq, rig, ctrl, fr, unreal.Transform(
        location=cur.translation, rotation=q.multiply(cur.rotation).rotator(), scale=cur.scale3d), DR, True)
    evaluate(seq, frame)
    return {"ok": True, "applied_deg": round(ang, 3)}
