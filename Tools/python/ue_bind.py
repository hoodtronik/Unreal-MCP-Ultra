# ue_bind.py - sequence bindings (possess level actors, rebind) and FBX export/import of bindings, behind seq_bind /
# seq_fbx (Tools/src/tools/seq-bind.ts). Exec'd after ue_posing.py and ue_shot.py.
import os

import unreal


def _world():
    return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()


def _actor(label):
    a = next((a for a in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
              if a.get_actor_label() == label), None)
    if a is None:
        raise ValueError("No level actor labelled '%s'" % label)
    return a


def bind_possess(seq_path, label, name=None):
    seq = load_sequence(seq_path, open_it=True)
    a = _actor(label)
    for b in seq.get_bindings():
        if bound_actor(seq, b) == a:
            return {"ok": True, "binding": str(b.get_display_name()), "created": False}
    b = unreal.MovieSceneSequenceExtensions.add_possessable(seq, a)
    if name:
        b.set_display_name(name)
    return {"ok": True, "binding": str(b.get_display_name()), "created": True}


def bind_rebind(seq_path, binding_name, labels):
    seq = load_sequence(seq_path, open_it=True)
    b = find_binding(seq, binding_name)
    actors = [_actor(l) for l in labels]
    unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem).replace_binding_with_actors(actors, b)   # acts on the OPEN sequence (load_sequence opened it)
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    return {"ok": True}


def bind_list(seq_path):
    seq = load_sequence(seq_path, open_it=True)
    out = []
    for b in seq.get_bindings():
        objs = unreal.LevelSequenceEditorBlueprintLibrary.get_bound_objects(unreal.MovieSceneSequenceExtensions.get_binding_id(seq, b)) \
            if hasattr(unreal.LevelSequenceEditorBlueprintLibrary, "get_bound_objects") else []
        live = bound_actor(seq, b)
        out.append({"binding": str(b.get_display_name()), "spawnable": bool(b.get_object_template() is not None) if hasattr(b, "get_object_template") else None,
                    "actor": live.get_actor_label() if live else None,
                    "tracks": [t.get_class().get_name().replace("MovieScene", "") for t in b.get_tracks()]})
    return {"ok": True, "bindings": out}


def actor_xform(seq_path, binding_name, next_frame=None):
    """CURRENT frame (posed last tick): world location / rotation of the binding's live actor."""
    seq = load_sequence(seq_path)
    a = bound_actor(seq, find_binding(seq, binding_name))
    if a is None:
        raise RuntimeError("'%s' has no live actor" % binding_name)
    t = a.get_actor_transform()
    r = t.rotation.rotator()
    out = {"ok": True, "frame": unreal.LevelSequenceEditorBlueprintLibrary.get_current_time(),
           "loc": [round(t.translation.x, 3), round(t.translation.y, 3), round(t.translation.z, 3)],
           "rot": [round(r.pitch, 3), round(r.yaw, 3), round(r.roll, 3)]}
    if next_frame is not None:
        evaluate(seq, int(next_frame))
    return out


def fbx_export(seq_path, bindings, path):
    seq = load_sequence(seq_path, open_it=True)
    bs = [find_binding(seq, n) for n in bindings]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    p = unreal.SequencerExportFBXParams()
    p.set_editor_property("world", _world())
    p.set_editor_property("sequence", seq)
    p.set_editor_property("root_sequence", seq)
    p.set_editor_property("bindings", bs)
    p.set_editor_property("fbx_file_name", path)
    p.set_editor_property("override_options", unreal.FbxExportOption())
    ok = unreal.SequencerTools.export_level_sequence_fbx(p)
    return {"ok": bool(ok) and os.path.exists(path), "bytes": os.path.getsize(path) if os.path.exists(path) else 0}


def fbx_import(seq_path, bindings, path):
    seq = load_sequence(seq_path, open_it=True)
    bs = [find_binding(seq, n) for n in bindings]
    s = unreal.MovieSceneUserImportFBXSettings()
    s.set_editor_property("match_by_name_only", True)
    s.set_editor_property("create_cameras", False)
    s.set_editor_property("replace_transform_track", True)
    s.set_editor_property("reduce_keys", False)
    ok = unreal.SequencerTools.import_level_sequence_fbx(_world(), seq, bs, s, path)
    evaluate(seq, unreal.LevelSequenceEditorBlueprintLibrary.get_current_time())
    keys = 0
    for b in bs:
        for t in b.get_tracks():
            if isinstance(t, unreal.MovieScene3DTransformTrack):
                for sec in t.get_sections():
                    keys += sum(len(c.get_keys()) for c in sec.get_all_channels() if hasattr(c, "get_keys"))
    return {"ok": bool(ok), "transform_keys": keys}
