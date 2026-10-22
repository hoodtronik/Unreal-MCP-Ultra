# ue_lightrig.py - place a light around a subject RELATIVE TO THE SHOT CAMERA (key / fill / rim by azimuth and
# elevation), aimed at a bone, with intensity, colour or temperature, cone and size. Behind shot_light
# (Tools/src/tools/shot-light.ts), which verifies it on before/after renders. Exec'd after ue_posing.py, ue_shot.py,
# ue_props_track.py (light_add), ue_look.py (_subject_point).
import math

import unreal


def _aim_rotator(src, dst):
    d = dst - src
    yaw = math.degrees(math.atan2(d.y, d.x))
    pitch = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    return unreal.Rotator(pitch=pitch, yaw=yaw, roll=0.0)


def light_place(seq_path, name, subject, cam_name, kind="spot", bone="head", azimuth=45.0, elevation=30.0,
                distance=250.0, intensity=None, color=None, temperature=None, cone=None, size=None, shadows=True):
    """azimuth: degrees around the subject measured from the CAMERA side (0 = from the camera, +90 = from the
    camera's right, 180 = behind the subject = rim). elevation: degrees above the subject point."""
    seq = load_sequence(seq_path, open_it=True)
    cam = bound_actor(seq, find_binding(seq, cam_name))
    if cam is None:
        raise RuntimeError("camera '%s' is not spawned at this frame" % cam_name)
    p = _subject_point(seq, subject, bone)
    c = cam.get_actor_location()
    a0 = math.atan2(c.y - p.y, c.x - p.x)               # direction subject -> camera (horizontal)
    right = cam.get_actor_rotation().get_right_vector()
    # +azimuth must swing toward the camera's right: pick the rotation sense that does
    test = unreal.Vector(math.cos(a0 + 0.3), math.sin(a0 + 0.3), 0)
    sense = 1.0 if test.dot(right) > unreal.Vector(math.cos(a0 - 0.3), math.sin(a0 - 0.3), 0).dot(right) else -1.0
    a = a0 + sense * math.radians(azimuth)
    el = math.radians(elevation)
    loc = unreal.Vector(p.x + distance * math.cos(el) * math.cos(a), p.y + distance * math.cos(el) * math.sin(a),
                        p.z + distance * math.sin(el))
    rot = _aim_rotator(loc, p)
    light_add(seq_path, name, kind, (loc.x, loc.y, loc.z), intensity, color)
    b = find_binding(seq, name)
    sec = _xform_section(b)
    for ch, v in {"Location.X": loc.x, "Location.Y": loc.y, "Location.Z": loc.z,
                  "Rotation.X": 0.0, "Rotation.Y": rot.pitch, "Rotation.Z": rot.yaw}.items():
        _write_channel(sec, ch, v)
    tpl = b.get_object_template()
    evaluate(seq)
    live = bound_actor(seq, b)
    for act in [x for x in (tpl, live) if x]:
        # templates (archetypes) return None from get_component_by_class; ALight.light_component works on both
        lc = act.get_editor_property("light_component")
        # CLAUDE-NOTE (live): set_intensity & co. are ignored on the spawnable's template (and a re-run kept 2000 cd
        # when 3000 was asked); property writes work on template and instance alike.
        props = {}
        if intensity is not None:
            props["intensity"] = float(intensity)
        if color is not None:
            props["light_color"] = unreal.LinearColor(color[0], color[1], color[2], 1.0).to_color(True)   # linear -> sRGB FColor
        if temperature is not None:
            props["use_temperature"] = True
            props["temperature"] = float(temperature)
        props["cast_shadows"] = bool(shadows)
        props["attenuation_radius"] = max(lc.get_editor_property("attenuation_radius"), distance * 3)
        if cone and isinstance(lc, unreal.SpotLightComponent):
            props["inner_cone_angle"], props["outer_cone_angle"] = float(cone[0]), float(cone[1])
        if size and isinstance(lc, unreal.RectLightComponent):
            props["source_width"], props["source_height"] = float(size[0]), float(size[-1])
        elif size:
            props["source_radius"] = float(size[0])
        for k, v in props.items():
            lc.set_editor_property(k, v)
    evaluate(seq)
    live = bound_actor(seq, b)
    lc = live.get_component_by_class(unreal.LocalLightComponent)
    lloc = live.get_actor_location()
    fwd = live.get_actor_forward_vector()
    to_p = p - lloc
    aim_err = math.degrees(math.acos(max(-1.0, min(1.0, fwd.dot(to_p) / max(1e-6, to_p.length())))))
    out = {"ok": True, "light": name, "kind": kind, "location": [round(lloc.x, 1), round(lloc.y, 1), round(lloc.z, 1)],
           "distance": round(to_p.length(), 1), "aim_error_deg": round(aim_err, 2),
           "intensity": round(lc.get_editor_property("intensity"), 3),
           "units": str(lc.get_editor_property("intensity_units")).split(".")[-1].split(":")[0]}
    if temperature is not None:
        out["temperature"] = round(lc.get_editor_property("temperature"), 1)
    if isinstance(lc, unreal.SpotLightComponent):
        out["cone"] = [round(lc.get_editor_property("inner_cone_angle"), 2), round(lc.get_editor_property("outer_cone_angle"), 2)]
    return out


def light_remove(seq_path, name):
    seq = load_sequence(seq_path, open_it=True)
    b = find_binding(seq, name)
    b.remove()
    evaluate(seq)
    return {"ok": True, "removed": name}
