# ue_meshfbx.py - skeletal MESH FBX export / import and comparison, behind skel_fbx (Tools/src/tools/skel-fbx.ts).
# Exec'd after ue_posing.py.
import os

import unreal


def mesh_fbx_export(mesh_path, path):
    m = unreal.load_asset(mesh_path)
    if not isinstance(m, unreal.SkeletalMesh):
        raise ValueError("not a SkeletalMesh: " + str(mesh_path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    t = unreal.AssetExportTask()
    t.set_editor_property("object", m)
    t.set_editor_property("filename", path)
    t.set_editor_property("exporter", unreal.SkeletalMeshExporterFBX())
    t.set_editor_property("automated", True)
    t.set_editor_property("prompt", False)
    t.set_editor_property("options", unreal.FbxExportOption())
    ok = unreal.Exporter.run_asset_export_task(t)
    return {"ok": bool(ok) and os.path.exists(path), "bytes": os.path.getsize(path) if os.path.exists(path) else 0}


def mesh_fbx_import(path, dest_dir, name, skeleton=None, materials=False):
    """Import a skeletal mesh .fbx as <dest_dir>/<name>; onto an existing skeleton if given, else a new one."""
    if not os.path.exists(path):
        raise ValueError("no file " + path)
    ui = unreal.FbxImportUI()
    ui.set_editor_property("import_mesh", True)
    ui.set_editor_property("import_as_skeletal", True)
    ui.set_editor_property("import_animations", False)
    ui.set_editor_property("import_materials", bool(materials))
    ui.set_editor_property("import_textures", bool(materials))
    ui.set_editor_property("mesh_type_to_import", unreal.FBXImportType.FBXIT_SKELETAL_MESH)
    ui.set_editor_property("create_physics_asset", False)
    if skeleton:
        sk = unreal.load_asset(skeleton)
        if not isinstance(sk, unreal.Skeleton):
            raise ValueError("Not a Skeleton: " + skeleton)
        ui.set_editor_property("skeleton", sk)
    t = unreal.AssetImportTask()
    t.set_editor_property("filename", path)
    t.set_editor_property("destination_path", dest_dir)
    t.set_editor_property("destination_name", name)
    t.set_editor_property("automated", True)
    t.set_editor_property("replace_existing", True)
    t.set_editor_property("save", True)
    t.set_editor_property("options", ui)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([t])
    paths = [str(p).split(".")[0] for p in t.get_editor_property("imported_object_paths")]
    meshes = [p for p in paths if isinstance(unreal.load_asset(p), unreal.SkeletalMesh)]
    return {"ok": bool(meshes), "imported": paths[:10], "mesh": meshes[0] if meshes else None}


def _mesh_info(m):
    sk = m.skeleton
    ref = unreal.AnimPoseExtensions.get_reference_pose(sk)
    names = [str(n) for n in unreal.AnimPoseExtensions.get_bone_names(ref)]
    b = m.get_bounds()
    sub = unreal.get_editor_subsystem(unreal.SkeletalMeshEditorSubsystem) if hasattr(unreal, "SkeletalMeshEditorSubsystem") else None
    verts = None
    if sub and hasattr(sub, "get_num_verts"):
        verts = sub.get_num_verts(m, 0)
    return sk, ref, names, b, verts


def mesh_compare(a_path, b_path, bones=("pelvis", "spine_05", "head", "hand_l", "hand_r", "foot_l", "foot_r")):
    a, b = unreal.load_asset(a_path), unreal.load_asset(b_path)
    _, ra, na, ba, va = _mesh_info(a)
    skb, rb, nb, bb, vb = _mesh_info(b)
    W = unreal.AnimPoseSpaces.WORLD
    d = {}
    for bn in bones:
        if bn in na and bn in nb:
            d[bn] = round((unreal.AnimPoseExtensions.get_bone_pose(ra, bn, W).translation -
                           unreal.AnimPoseExtensions.get_bone_pose(rb, bn, W).translation).length(), 4)
    return {"ok": True, "bones": [len(na), len(nb)], "missing": sorted(set(na) - set(nb))[:10], "extra": sorted(set(nb) - set(na))[:10],
            "ref_cm": d, "verts": [va, vb], "bounds_extent": [[round(x, 2) for x in (ba.box_extent.x, ba.box_extent.y, ba.box_extent.z)],
                                                             [round(x, 2) for x in (bb.box_extent.x, bb.box_extent.y, bb.box_extent.z)]],
            "skeleton_b": skb.get_path_name().split(".")[0]}
