# ue_props.py - props held by / attached to characters in a LevelSequence (prop_attach, prop_check MCP tools).
# Exec'd after ue_posing.py (uses load_sequence, find_binding, bound_actor, skel_comp, evaluate, _v).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): a prop follows a character through a Sequencer ATTACH track
# (MovieScene3DAttachTrack, constraint = the character's binding id, socket = a bone name) - not a level attach,
# because characters here are spawnables that only exist while the sequence evaluates. With the default
# KEEP_RELATIVE rules the prop's own Transform track is read as the offset in BONE space, so the grip is
# computed once in bone space and then rides every frame of the animation (verified: prop == hand_r at offset 0).
import math

import unreal

PROP_DEFAULT_MESH = "/Engine/BasicShapes/Cylinder"


def _binding_or_none(seq, name):
    try:
        return find_binding(seq, name)
    except ValueError:
        return None


def _prop_actor(seq, name):
    b = find_binding(seq, name)
    a = bound_actor(seq, b)
    if a is None:
        raise RuntimeError("prop '%s' is not spawned at the current frame" % name)
    return b, a


def _local_box(mesh):
    bb = mesh.get_bounding_box()
    return bb.min, bb.max


def _attach_section(binding):
    for t in binding.get_tracks():
        if isinstance(t, unreal.MovieScene3DAttachTrack):
            secs = t.get_sections()
            if secs:
                return secs[0]
    t = binding.add_track(unreal.MovieScene3DAttachTrack)
    s = t.add_section()
    s.set_range(-100000, 100000)
    return s


def _set_xform_defaults(binding, loc, rot, scale):
    """Write the prop's Transform track as constant defaults (no keys): with the attach track this is the offset."""
    sec = None
    for t in binding.get_tracks():
        if isinstance(t, unreal.MovieScene3DTransformTrack) and t.get_sections():
            sec = t.get_sections()[0]
    if sec is None:
        sec = binding.add_track(unreal.MovieScene3DTransformTrack).add_section()
        sec.set_range(-100000, 100000)
    vals = {"Location.X": loc.x, "Location.Y": loc.y, "Location.Z": loc.z,
            "Rotation.X": rot.roll, "Rotation.Y": rot.pitch, "Rotation.Z": rot.yaw,
            "Scale.X": scale.x, "Scale.Y": scale.y, "Scale.Z": scale.z}
    for ch in sec.get_all_channels():
        n = str(ch.channel_name)
        if n in vals:
            for k in list(ch.get_keys()):
                ch.remove_key(k)
            ch.set_default(float(vals[n]))


def _posed_verts(sk):
    dm = unreal.DynamicMesh()
    res = unreal.GeometryScript_SceneUtils.copy_mesh_from_component(
        sk, dm, unreal.GeometryScriptCopyMeshFromComponentOptions(), True)
    if str(res[-1]).find("SUCCESS") < 0:
        raise RuntimeError("could not copy the posed mesh: %s" % res[-1])
    return unreal.GeometryScript_MeshQueries.get_all_vertex_positions(dm, False)[1].convert_vector_list_to_array()


def _hand_frame(sk, side):
    """Hand basis from bones: h wrist, km knuckle centre, f toward the fingers, axis pinky->index, n palm normal."""
    h = sk.get_socket_location("hand_" + side)
    k = [sk.get_socket_location("%s_01_%s" % (f, side)) for f in ("index", "middle", "ring", "pinky")]
    km = (k[0] + k[1] + k[2] + k[3]) / 4.0
    f = km - h
    f = f / f.length()
    axis = k[0] - k[3]
    span = axis.length()
    axis = axis / span
    n = f.cross(axis)
    n = n / n.length() * (1.0 if side == "r" else -1.0)
    return h, km, f, axis, n, span


def grip_world(sk, side, radius, gap=None):
    """World transform for a cylinder-like prop held in a power grip: axis along the knuckle line (pinky -> index,
    so the top pokes out of the thumb side), surface resting on the measured PALM SKIN.
    Call with the fingers OPEN: the prop is laid on the flat hand (palm + straight fingers, thumb excluded) and the
    fingers are then curled onto it (prop_attach grip solve).
    CLAUDE-NOTE (2026-10-21, live): placing the centre from bones alone (knuckles + n * (r + 1.5)) put Manny's
    curled fingers 3.5 cm deep inside a 7 cm cup; using only palm skin left the straight proximal fingers 2.6 cm
    inside. The lift is now solved against the posed skin of palm + fingers as a circle-contact problem in the
    plane square to the prop axis. Palm normal convention = ue_posing.palm (calibrated for pose_palm)."""
    h, km, f, axis, n, span = _hand_frame(sk, side)
    f2 = n.cross(axis)
    f2 = f2 / f2.length() * (1.0 if f2.dot(f) >= 0 else -1.0)   # finger direction, square to axis and normal
    reach = (km - h).length()
    anchors = _hand_anchors(sk, side)
    need = radius + (GRIP_GAP if gap is None else gap)
    base = km + f2 * (GRIP_ALONG * radius)
    # Lift the circle (radius+gap, in the plane square to the axis) along n until no palm vertex is inside it:
    # vertex at (df, o) relative to base needs t >= o + sqrt(need^2 - df^2) when |df| < need.
    t = None
    for v in _posed_verts(sk):
        if (v - h).length() > 22.0:
            continue
        d = v - base
        if abs(d.dot(axis)) > 0.5 * span or d.dot(f2) < -reach:
            continue
        if _region(anchors, v) == "thumb":
            continue
        df, o = d.dot(f2), d.dot(n)
        if abs(df) < need:
            ti = o + math.sqrt(need * need - df * df)
            t = ti if t is None else max(t, ti)
    if t is None:
        raise RuntimeError("no palm skin found for hand_" + side)
    centre = base + n * t
    rot = unreal.MathLibrary.make_rot_from_zx(axis, n)
    return unreal.Transform(location=centre, rotation=rot), {"palm": _v(n), "axis": _v(axis), "lift_cm": round(t, 2)}


GRIP_ALONG = -0.9  # x radius along the fingers from the knuckle line: negative = over the palm, so the knuckles
                   # sit at the prop's front edge and curling fingers wrap it (at +1 cm they curled INTO it)
GRIP_GAP = 0.3     # cm between palm skin and the prop surface


def _hand_anchors(sk, side, by_segment=False):
    """(region, start, end) bone SEGMENTS of a hand: 'palm' = wrist -> metacarpals -> knuckles, fingers = 01->02,
    02->03, 03->tip (tip extrapolated). Skin vertices go to the nearest segment (_region).
    CLAUDE-NOTE (2026-10-21, live): nearest-JOINT assignment gave the distal half of each proximal phalanx to the
    next joint, so 'segment 01' never touched and the grip solve curled 01 to its 108 deg limit; thumb skin in
    front of the palm also read as palm surface under a plain offset test."""
    names = set(str(sk.get_bone_name(i)) for i in range(sk.get_num_bones()))
    loc = sk.get_socket_location
    h = loc("hand_" + side)
    out = []
    for fn in ("thumb", "index", "middle", "ring", "pinky"):
        chain = ["%s_%s_%s" % (fn, j, side) for j in ("01", "02", "03")]
        chain = [c for c in chain if c in names]
        if not chain:
            continue
        mc = "%s_metacarpal_%s" % (fn, side)
        if fn != "thumb":
            if mc in names:
                out += [("palm", h, loc(mc)), ("palm", loc(mc), loc(chain[0]))]
            else:
                out.append(("palm", h, loc(chain[0])))
        pts = [loc(c) for c in chain]
        if len(pts) >= 2:
            pts.append(pts[-1] + (pts[-1] - pts[-2]) * 0.9)
        for i in range(len(pts) - 1):
            label = "%s_%02d" % (fn, i + 1) if by_segment else fn
            out.append((label, pts[i], pts[i + 1]))
    return out


def _seg_dist(v, a, b):
    ab = b - a
    L2 = ab.dot(ab)
    t = 0.0 if L2 <= 0 else max(0.0, min(1.0, (v - a).dot(ab) / L2))
    return (v - (a + ab * t)).length()


def _region(anchors, v):
    return min(anchors, key=lambda a: _seg_dist(v, a[1], a[2]))[0]


HAND_SKIN_CM = 3.0  # hand skin lies within this of a hand bone segment (Manny); farther skin is "body"


def finger_gaps(sk, side, centre, axis, radius, half, verts=None, by_segment=False):
    """Per finger (+ 'palm'), the smallest skin gap to a cylinder (centre, unit axis, radius, half-height):
    negative = skin inside the prop. Vertices go to the nearest hand bone segment; skin farther than HAND_SKIN_CM
    from every hand segment is the rest of the BODY and reported apart (body_inside / body_deepest_cm).
    CLAUDE-NOTE (2026-10-21, live): with only a 22 cm radius filter, the face entered the 'grip' when the cup
    reached the mouth and read as fingers 2.5 cm inside the cup."""
    hand = sk.get_socket_location("hand_" + side)
    anchors = _hand_anchors(sk, side, by_segment)
    gaps, inside, body_in, body_deep = {}, 0, 0, 0.0
    for v in (verts if verts is not None else _posed_verts(sk)):
        if (v - hand).length() > 30.0:
            continue
        d = v - centre
        along = d.dot(axis)
        if abs(along) > half + 1.0:
            continue
        g = (d - axis * along).length() - radius
        if g > 6.0:
            continue
        near = min(anchors, key=lambda a: _seg_dist(v, a[1], a[2]))
        if _seg_dist(v, near[1], near[2]) > HAND_SKIN_CM:
            if g < 0 and abs(along) <= half:
                body_in += 1
                body_deep = max(body_deep, -g)
            continue
        who = near[0]
        if who not in gaps or g < gaps[who]:
            gaps[who] = g
        if g < 0 and abs(along) <= half:
            inside += 1
    return {k: round(v, 2) for k, v in gaps.items()}, inside, body_in, round(body_deep, 2)


def _color_material(seq_path, name, color):
    """MaterialInstance of BasicShapeMaterial tinted `color` ([r,g,b] 0-1), stored beside the sequence in Props/."""
    folder = seq_path.rsplit("/", 1)[0] + "/Props"
    path = "%s/MI_%s" % (folder, name)
    eal = unreal.EditorAssetLibrary
    mi = unreal.load_asset(path) if eal.does_asset_exist(path) else None
    if mi is None:
        mi = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
            "MI_" + name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
        mi.set_editor_property("parent", unreal.load_asset("/Engine/BasicShapes/BasicShapeMaterial"))
    unreal.MaterialEditingLibrary.set_material_instance_vector_parameter_value(
        mi, "Color", unreal.LinearColor(float(color[0]), float(color[1]), float(color[2]), 1.0))
    unreal.MaterialEditingLibrary.update_material_instance(mi)
    eal.save_loaded_asset(mi)
    return mi


def prop_attach(seq_path, name, character, bone="hand_r", mesh=None, size=None, offset=None,
                rotation=None, grip=None, color=None):
    """Add (or update) a prop bound in the sequence and attached to `character`'s `bone`.
    size: [x, y, z] cm of the prop's bounding box (scales the mesh). grip: 'l'/'r' computes the offset so a
    cylinder-like prop sits in that hand's power grip at the CURRENT frame; else offset/rotation (bone space)."""
    seq = load_sequence(seq_path)
    cb = find_binding(seq, character)
    sk = skel_comp(seq, cb)
    if sk is None:
        raise RuntimeError("no skeletal mesh bound to '%s'" % character)
    if bone not in [str(b) for b in sk.get_all_socket_names()] and sk.get_bone_index(bone) < 0:
        raise ValueError("'%s' has no bone/socket '%s'" % (character, bone))
    mesh_path = mesh or PROP_DEFAULT_MESH
    m = unreal.load_asset(mesh_path)
    if not isinstance(m, unreal.StaticMesh):
        raise ValueError("Not a StaticMesh: " + mesh_path)
    created = False
    pb = _binding_or_none(seq, name)
    if pb is None:
        eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        tmp = eas.spawn_actor_from_object(m, unreal.Vector(0, 0, 0), unreal.Rotator())
        pb = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).add_spawnable_from_instance(seq, tmp)
        pb.set_display_name(name)
        eas.destroy_actor(tmp)
        created = True
    sec = _attach_section(pb)
    sec.set_constraint_binding_id(unreal.MovieSceneSequenceExtensions.get_binding_id(seq, cb))
    sec.set_editor_property("attach_socket_name", bone)
    lo, hi = _local_box(m)
    ext = hi - lo
    if size:
        scale = unreal.Vector(*(float(s) / max(e, 1e-6) for s, e in zip(size, (ext.x, ext.y, ext.z))))
    else:
        scale = unreal.Vector(1, 1, 1)
    info = {}
    if grip:
        radius = 0.5 * min(ext.x * scale.x, ext.y * scale.y)
        gw, info = grip_world(sk, grip, radius)
        bone_w = sk.get_socket_transform(bone, unreal.RelativeTransformSpace.RTS_WORLD)
        rel = gw.make_relative(bone_w)    # grip in bone space
        loc, rot = rel.translation, rel.rotation.rotator()
        info["radius"] = round(radius, 2)
    else:
        loc = unreal.Vector(*(offset or (0, 0, 0)))
        rot = unreal.Rotator(roll=(rotation or (0, 0, 0))[0], pitch=(rotation or (0, 0, 0))[1], yaw=(rotation or (0, 0, 0))[2])
    _set_xform_defaults(pb, loc, rot, scale)
    if color:
        # Template (persists, used on respawn) AND the live spawned instance (what renders now) - see ue_shot.
        mi = _color_material(seq_path, name, color)
        for obj in (pb.get_object_template(), bound_actor(seq, pb)):
            # CLAUDE-NOTE (live): get_component_by_class() returns None on a spawnable's TEMPLATE actor (components
            # not registered); StaticMeshActor.static_mesh_component works on both template and instance.
            c = getattr(obj, "static_mesh_component", None) if obj else None
            if c:
                c.set_material(0, mi)
    evaluate(seq, current_frame())
    return {"ok": True, "prop": name, "created": created, "mesh": mesh_path, "bone": bone,
            "offset": _v(loc), "rotation": [round(rot.roll, 3), round(rot.pitch, 3), round(rot.yaw, 3)],
            "scale": _v(scale), "size": [round(ext.x * scale.x, 2), round(ext.y * scale.y, 2), round(ext.z * scale.z, 2)],
            "grip": info or None}


def prop_state(seq_path, name, character, bone, side=None, next_frame=None, near=None):
    """Read the CURRENT frame (posed last tick): prop vs bone offset, and - with side - how the hand's skin sits
    around the prop (treated as a cylinder along its local Z). Then scrub to next_frame so the following call
    reads that frame: one request per frame, never a same-call stale read."""
    seq = load_sequence(seq_path)
    frame = current_frame()
    cb = find_binding(seq, character)
    sk = skel_comp(seq, cb)
    _, pa = _prop_actor(seq, name)
    pt = pa.get_actor_transform()
    bone_w = sk.get_socket_transform(bone, unreal.RelativeTransformSpace.RTS_WORLD)
    rel = pt.make_relative(bone_w)
    out = {"ok": True, "frame": frame, "prop_world": _v(pt.translation), "offset": _v(rel.translation),
           "attached_to": str(pa.root_component.get_attach_socket_name())}
    if side:
        comp = pa.get_component_by_class(unreal.StaticMeshComponent)
        lo, hi = _local_box(comp.static_mesh)
        sc = pa.get_actor_scale3d()
        radius = 0.5 * min((hi.x - lo.x) * sc.x, (hi.y - lo.y) * sc.y)
        half = 0.5 * (hi.z - lo.z) * sc.z
        axis = pt.rotation.rotator().get_up_vector()
        centre = pt.transform_location(unreal.Vector(0.5 * (lo.x + hi.x), 0.5 * (lo.y + hi.y), 0.5 * (lo.z + hi.z)))
        verts = _posed_verts(sk)
        gaps, inside, body_in, body_deep = finger_gaps(sk, side, centre, axis, radius, half, verts)
        seg = finger_gaps(sk, side, centre, axis, radius, half, verts, by_segment=True)[0]
        out["grip"] = {"radius": round(radius, 2), "gaps_cm": gaps, "segment_gaps_cm": seg, "skin_inside_verts": inside,
                       "body_inside_verts": body_in, "body_deepest_cm": body_deep}
    if near:
        tp = unreal.Vector(*seq_target(seq_path, near))
        out["near_cm"] = round((pt.translation - tp).length(), 2)
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out


def grip_curl(seq_path, binding_name, side, scales, frame=0):
    """Key each finger's curl as a fraction of the 'fist' shape: scales = {finger: s}, s=0 open, 1 fist, <0 extends.
    Applied next tick - read back with prop_state in a later call."""
    seq = load_sequence(seq_path)
    rig, _ = rig_proxy(seq, find_binding(seq, binding_name))
    fist = HAND_SHAPES["fist"]
    n = 0
    for fname, sc in scales.items():
        base = fist["thumb"] if fname == "thumb" else fist["fingers"]
        for j, deg in zip(("01", "02", "03"), base):
            c = "%s_%s_%s_ctrl" % (fname, j, side)
            if control_type(rig, c) is None:
                continue
            _set_one(seq, rig, {"control": c, "rotation": [0.0, float(deg) * float(sc), 0.0]}, frame)
            n += 1
    evaluate(seq, frame)
    return {"ok": True, "controls": n}
