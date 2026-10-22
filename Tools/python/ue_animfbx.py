# ue_animfbx.py - skeletal animation FBX export / import (clip <-> .fbx), behind anim_fbx (Tools/src/tools/anim-fbx.ts).
# Exec'd after ue_posing.py and ue_anim.py (resolve_anim).
import os

import unreal


def anim_fbx_export(clip, path):
    anim = resolve_anim(clip, ("AnimSequence",))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    t = unreal.AssetExportTask()
    t.set_editor_property("object", anim)
    t.set_editor_property("filename", path)
    t.set_editor_property("exporter", unreal.AnimSequenceExporterFBX())
    t.set_editor_property("automated", True)
    t.set_editor_property("prompt", False)
    t.set_editor_property("replace_identical", True)
    opts = unreal.FbxExportOption()
    t.set_editor_property("options", opts)
    ok = unreal.Exporter.run_asset_export_task(t)
    return {"ok": bool(ok) and os.path.exists(path), "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
            "errors": [str(e) for e in t.get_editor_property("errors")][:5]}


def anim_fbx_import(path, dest_dir, name, skeleton):
    """Import the animation in an .fbx onto an existing skeleton as <dest_dir>/<name>."""
    if not os.path.exists(path):
        raise ValueError("no file " + path)
    skel = unreal.load_asset(skeleton)
    if not isinstance(skel, unreal.Skeleton):
        raise ValueError("Not a Skeleton: " + skeleton)
    ui = unreal.FbxImportUI()
    ui.set_editor_property("import_mesh", False)
    ui.set_editor_property("import_as_skeletal", True)
    ui.set_editor_property("import_animations", True)
    ui.set_editor_property("import_materials", False)
    ui.set_editor_property("import_textures", False)
    ui.set_editor_property("skeleton", skel)
    ui.set_editor_property("mesh_type_to_import", unreal.FBXImportType.FBXIT_ANIMATION)
    ui.set_editor_property("override_animation_name", name)
    t = unreal.AssetImportTask()
    t.set_editor_property("filename", path)
    t.set_editor_property("destination_path", dest_dir)
    t.set_editor_property("destination_name", name)
    t.set_editor_property("automated", True)
    t.set_editor_property("replace_existing", True)
    t.set_editor_property("save", True)
    t.set_editor_property("options", ui)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([t])
    paths = [str(p) for p in t.get_editor_property("imported_object_paths")]
    anims = [p for p in paths if isinstance(unreal.load_asset(p.split(".")[0]), unreal.AnimSequence)]
    return {"ok": bool(anims), "imported": paths[:10], "anim": anims[0].split(".")[0] if anims else None}


def anim_compare(a_path, b_path, times, bones=None):
    """Worst bone distance (component space incl. root motion) between two clips at the given times."""
    a = unreal.load_asset(a_path)
    b = unreal.load_asset(b_path)
    opts = unreal.AnimPoseEvaluationOptions()
    out = []
    worst, wb, wt = 0.0, None, None
    for t in times:
        pa = unreal.AnimPoseExtensions.get_anim_pose_at_time(a, float(t), opts)
        pb = unreal.AnimPoseExtensions.get_anim_pose_at_time(b, float(t), opts)
        names = bones or [str(n) for n in unreal.AnimPoseExtensions.get_bone_names(pa)]
        w = 0.0
        for n in names:
            d = (unreal.AnimPoseExtensions.get_bone_pose(pa, n, unreal.AnimPoseSpaces.WORLD).translation -
                 unreal.AnimPoseExtensions.get_bone_pose(pb, n, unreal.AnimPoseSpaces.WORLD).translation).length()
            if d > w:
                w = d
                if d > worst:
                    worst, wb, wt = d, n, t
        out.append(round(w, 4))
    return {"ok": True, "per_time": out, "worst": round(worst, 4), "bone": wb, "at": wt,
            "lengths": [round(a.get_play_length(), 4), round(b.get_play_length(), 4)]}


def anim_restore_meta(src_path, dst_path):
    """FBX drops Unreal-only clip metadata: copy root motion settings, notifies and sync markers from the source.
    CLAUDE-NOTE (2026-10-22, live): MF_Unarmed_Walk_Fwd -> FBX -> import kept the root travel (450 cm) but came back
    with root motion OFF, force_root_lock off and no sync markers (R/L foot markers drive sync groups)."""
    src = unreal.load_asset(src_path)
    dst = unreal.load_asset(dst_path)
    AL = unreal.AnimationLibrary
    AL.set_root_motion_enabled(dst, AL.is_root_motion_enabled(src))
    for k in ("force_root_lock", "root_motion_root_lock"):
        dst.set_editor_property(k, src.get_editor_property(k))
    AL.copy_anim_notifies_from_sequence(src, dst, True)
    AL.remove_all_animation_sync_markers(dst)
    track = "Markers"
    if not AL.is_valid_anim_notify_track_name(dst, track):
        AL.add_animation_notify_track(dst, track)
    for m in AL.get_animation_sync_markers(src):
        AL.add_animation_sync_marker(dst, m.marker_name, m.time, track)
    unreal.EditorAssetLibrary.save_loaded_asset(dst, False)
    return {"ok": True, "root_motion": bool(AL.is_root_motion_enabled(dst)),
            "markers": [[str(m.marker_name), round(m.time, 4)] for m in AL.get_animation_sync_markers(dst)],
            "notifies": len(AL.get_animation_notify_events(dst))}
