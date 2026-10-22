# ue_props_track.py - keyed property tracks on any binding / component (lights, materials params on components,
# visibility...), behind seq_property (Tools/src/tools/seq-property.ts). Exec'd after ue_posing.py (load_sequence,
# find_binding, bound_actor, evaluate, _eas).
import unreal


def light_add(seq_path, name, kind="point", location=(0, 0, 300), intensity=None, color=None):
    """Spawnable light in the sequence (template set to intensity/color)."""
    seq = load_sequence(seq_path, open_it=True)
    try:
        return {"ok": True, "created": False, "binding": str(find_binding(seq, name).get_display_name())}
    except ValueError:
        pass
    cls = {"point": unreal.PointLight, "spot": unreal.SpotLight, "rect": unreal.RectLight}[kind]
    tmp = _eas().spawn_actor_from_class(cls, unreal.Vector(*location), unreal.Rotator())
    if intensity is not None:
        tmp.light_component.set_intensity(float(intensity))
    if color is not None:
        tmp.light_component.set_light_color(unreal.LinearColor(*color, 1.0))
    b = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).add_spawnable_from_instance(seq, tmp)
    b.set_display_name(name)
    _eas().destroy_actor(tmp)
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "created": True, "binding": name}


TRACKS = {"float": unreal.MovieSceneFloatTrack, "bool": unreal.MovieSceneBoolTrack, "color": unreal.MovieSceneColorTrack,
          "vector": unreal.MovieSceneDoubleVectorTrack}


def _target(seq, binding_name, component):
    """(binding, live object) for an actor binding or one of its components (child possessable; reused when it
    exists - CLAUDE-NOTE (live): add_possessable on a spawned light's component duplicated the LightComponent0 child
    Sequencer had already created)."""
    b = find_binding(seq, binding_name)
    live = bound_actor(seq, b)
    if not component:
        return b, live
    kids = [c for c in b.get_child_possessables() if str(c.get_display_name()) == component]
    if len(kids) > 1:
        for extra in kids[1:]:
            extra.remove()
    if kids:
        cb = kids[0]
    else:
        comp = next((c for c in live.get_components_by_class(unreal.ActorComponent) if c.get_name() == component), None) if live else None
        if comp is None:
            raise ValueError("'%s' has no component '%s' (components: %s)" % (binding_name, component, ", ".join(
                c.get_name() for c in (live.get_components_by_class(unreal.ActorComponent) if live else []))))
        cb = unreal.MovieSceneSequenceExtensions.add_possessable(seq, comp)
    obj = next((c for c in live.get_components_by_class(unreal.ActorComponent) if c.get_name() == component), None) if live else None
    return cb, obj


def prop_key(seq_path, binding_name, component, prop, kind, keys, interp="auto"):
    """Key a property: kind float|bool|color|vector, keys [{frame, value}] (color [r,g,b(,a)], vector [x,y,z])."""
    seq = load_sequence(seq_path, open_it=True)
    tb, obj = _target(seq, binding_name, component)
    tr = next((t for t in tb.get_tracks() if isinstance(t, TRACKS[kind]) and hasattr(t, "get_property_path")
               and str(t.get_property_path()) == prop), None)
    if tr is None:
        tr = tb.add_track(TRACKS[kind])
        tr.set_property_name_and_path(prop.split(".")[-1], prop)
    sec = tr.get_sections()[0] if tr.get_sections() else tr.add_section()
    sec.set_range(-100000, 100000)
    chans = sec.get_all_channels()
    names = [str(c.channel_name) for c in chans]
    for k in keys:
        f = unreal.FrameNumber(int(k["frame"]))
        vals = k["value"] if isinstance(k["value"], (list, tuple)) else [k["value"]]
        if kind == "color" and len(vals) == 3:
            vals = list(vals) + [1.0]
        for ch, v in zip(chans, vals):
            for old in list(ch.get_keys()):
                if old.get_time().frame_number.value == int(k["frame"]):
                    ch.remove_key(old)
            key = ch.add_key(f, bool(v) if kind == "bool" else float(v))
            if interp == "linear" and hasattr(key, "set_interpolation_mode"):
                key.set_interpolation_mode(unreal.RichCurveInterpMode.RCIM_LINEAR)
            elif interp == "constant" and hasattr(key, "set_interpolation_mode"):
                key.set_interpolation_mode(unreal.RichCurveInterpMode.RCIM_CONSTANT)
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True, "track": tr.get_class().get_name(), "channels": names, "bound": obj is not None}


def prop_read(seq_path, binding_name, component, prop):
    """CURRENT frame value of the property on the live object (posed last tick)."""
    seq = load_sequence(seq_path)
    b = find_binding(seq, binding_name)
    live = bound_actor(seq, b)
    obj = live
    if component:
        obj = next((c for c in live.get_components_by_class(unreal.ActorComponent) if c.get_name() == component), None)
    if obj is None:
        raise ValueError("no live object for %s.%s" % (binding_name, component))
    v = obj
    for part in prop.split("."):
        v = v.get_editor_property(unreal.StringLibrary.conv_string_to_name(part) if False else _snake(part))
    if isinstance(v, unreal.LinearColor) or isinstance(v, unreal.Color):
        out = [round(v.r, 4), round(v.g, 4), round(v.b, 4), round(v.a, 4)]
    elif hasattr(v, "x") and hasattr(v, "y") and hasattr(v, "z"):
        out = [round(v.x, 4), round(v.y, 4), round(v.z, 4)]
    elif isinstance(v, bool):
        out = v
    else:
        out = round(float(v), 4)
    return {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(), "value": out}


def _snake(name):
    import re
    s = re.sub(r"(?<=[a-z0-9])([A-Z])", lambda m: "_" + m.group(1), name)
    return s.lower()
