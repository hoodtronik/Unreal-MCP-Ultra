# ue_poseasset.py - Pose Assets (poses sampled from a clip) and curve-driven Pose Blender checks, behind the
# pose_asset tools (Tools/src/tools/pose-asset.ts). Exec'd after ue_posing.py, ue_anim.py, ue_abp.py, ue_montage.py.
import unreal

AL = unreal.AnimationLibrary


def pa_create(path, clip, names=None):
    pkg, name = path.rsplit("/", 1)
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        raise ValueError(path + " exists")
    src = resolve_anim(clip, ("AnimSequence",))
    f = unreal.PoseAssetFactory()
    f.set_editor_property("source_animation", src)
    if names:
        f.set_editor_property("pose_names", list(names))
    pa = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, pkg, unreal.PoseAsset, f)
    if pa is None:
        raise RuntimeError("create_asset returned None for " + path)
    unreal.EditorAssetLibrary.save_loaded_asset(pa, False)
    return pa_info(path)


def pa_info(path):
    pa = unreal.load_asset(path)
    if not isinstance(pa, unreal.PoseAsset):
        raise ValueError("Not a PoseAsset: " + path)
    names = [str(n) for n in pa.get_pose_names()]
    return {"ok": True, "path": path, "poses": len(names), "names": names[:40], "base": str(pa.get_base_pose_name()),
            "additive": bool(pa.get_editor_property("additive_pose")),
            "skeleton": pa.get_skeleton().get_path_name().split(".")[0]}


def pa_rename(path, renames):
    pa = unreal.load_asset(path)
    for old, new in renames.items():
        pa.rename_pose(old, new)
    unreal.EditorAssetLibrary.save_loaded_asset(pa, False)
    return pa_info(path)


def curve_driver(path, base_clip, weights):
    """A copy of base_clip carrying constant float curves {curve: weight} (the Pose Blender reads curves named after
    the poses). Re-run to change the weights (curves replaced)."""
    if not unreal.EditorAssetLibrary.does_asset_exist(path):
        src = resolve_anim(base_clip, ("AnimSequence",))
        if not unreal.EditorAssetLibrary.duplicate_asset(src.get_path_name().split(".")[0], path):
            raise RuntimeError("could not duplicate %s to %s" % (base_clip, path))
    a = unreal.load_asset(path)
    for c in [str(x) for x in AL.get_animation_curve_names(a, unreal.RawCurveTrackTypes.RCT_FLOAT)]:
        AL.remove_curve(a, c, False)
    length = a.get_play_length()
    for c, w in weights.items():
        AL.add_curve(a, c, unreal.RawCurveTrackTypes.RCT_FLOAT, False)
        AL.add_float_curve_keys(a, c, [0.0, length], [float(w), float(w)])
    unreal.EditorAssetLibrary.save_loaded_asset(a, False)
    got = {}
    for c in weights:
        got[c] = round(AL.get_float_value_at_time(a, c, length * 0.5), 4) if hasattr(AL, "get_float_value_at_time") else None
    return {"ok": True, "path": path, "curves": got}


def pa_pose_time(path, pose):
    """(source clip, time) a pose was sampled from: pose index i of a pose asset made from a clip = key i."""
    pa = unreal.load_asset(path)
    names = [str(n) for n in pa.get_pose_names()]
    if pose not in names:
        raise ValueError("pose '%s' not in %s (%d poses)" % (pose, path, len(names)))
    src = pa.get_editor_property("source_animation")
    if src is None:
        raise ValueError("%s has no source animation to compare with" % path)
    keys = AL.get_num_keys(src)
    t = names.index(pose) * src.get_play_length() / max(1, keys - 1)
    return {"ok": True, "source": src.get_path_name().split(".")[0], "t": round(t, 5), "index": names.index(pose)}
