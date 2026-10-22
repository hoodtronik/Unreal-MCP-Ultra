# ue_stills.py - multi-camera stills through Movie Render Queue (every camera in the sequence at chosen frames, one
# job per frame with MoviePipelineCameraSetting.render_all_cameras) and MRQ config PRESETS saved / loaded as assets.
# Behind shot_stills (Tools/src/tools/shot-stills.ts). Exec'd after ue_posing.py.
import os

import unreal


def _cfg_for(job, preset):
    cfg = job.get_configuration()
    if preset:
        p = unreal.load_asset(preset)
        if not isinstance(p, unreal.MoviePipelinePrimaryConfig):
            raise ValueError("not an MRQ config preset: " + str(preset))
        cfg.copy_from(p)
    return cfg


def stills_start(seq_path, frames, width=1280, height=720, out_dir=None, preset=None, save_preset=None, all_cameras=True):
    seq = load_sequence(seq_path, open_it=False)
    subsys = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    if subsys.is_rendering():
        raise RuntimeError("a Movie Render Queue render is already running")
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    mp = world.get_path_name().split(".")[0]
    name = seq.get_name()
    od = out_dir or os.path.abspath(unreal.Paths.project_saved_dir() + "MovieRenders/" + name + "_stills").replace("\\", "/")
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        if f.startswith(name + "."):
            os.remove(os.path.join(od, f))
    q = subsys.get_queue()
    for j in list(q.get_jobs()):
        q.delete_job(j)
    # CLAUDE-NOTE (live): {camera_name} is the PIE camera ACTOR's name (CineCameraActor_20/_22/_23 for templates
    # _0/_1/_2); labelling the templates did not change it. cameras = binding names in template order, which the TS
    # side maps onto the rendered names in spawn order.
    cams = sorted(((b.get_object_template().get_name(), str(b.get_display_name())) for b in seq.get_bindings()
                   if isinstance(b.get_object_template(), unreal.CineCameraActor)),
                  key=lambda x: int(x[0].rsplit("_", 1)[1]) if x[0].rsplit("_", 1)[-1].isdigit() else 0)
    saved = None
    for fr in frames:
        job = q.allocate_new_job(unreal.MoviePipelineExecutorJob)
        job.sequence = unreal.SoftObjectPath(seq.get_path_name())
        job.map = unreal.SoftObjectPath(mp + "." + mp.rsplit("/", 1)[1])
        job.job_name = "mcp_stills_%s_%d" % (name, fr)
        cfg = _cfg_for(job, preset)
        out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
        if not preset:
            out.output_resolution = unreal.IntPoint(int(width), int(height))
            cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
            cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_PNG)
            cam = cfg.find_or_add_setting_by_class(unreal.MoviePipelineCameraSetting)
            cam.set_editor_property("render_all_cameras", bool(all_cameras))
            # CLAUDE-NOTE (2026-10-22, live): a one-frame job renders with no motion history - the look-at camera's f20
            # still was smeared by motion blur (the camera "jumped" into place). Warm-up frames + no motion blur.
            aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
            aa.set_editor_property("engine_warm_up_count", 8)
            aa.set_editor_property("render_warm_up_frames", True)
            aa.set_editor_property("render_warm_up_count", 8)
            cv = cfg.find_or_add_setting_by_class(unreal.MoviePipelineConsoleVariableSetting)
            cv.add_or_update_console_variable("r.MotionBlurQuality", 0.0)
        # per-job overrides that never belong in a preset: where and which frame
        out.output_directory = unreal.DirectoryPath(od)
        out.file_name_format = "{sequence_name}.{camera_name}.{frame_number}"
        out.use_custom_playback_range = True
        out.custom_start_frame = int(fr)
        out.custom_end_frame = int(fr) + 1
        if save_preset and saved is None:
            folder, pname = save_preset.rsplit("/", 1)
            if unreal.EditorAssetLibrary.does_asset_exist(save_preset):
                unreal.EditorAssetLibrary.delete_asset(save_preset)
            asset = unreal.AssetToolsHelpers.get_asset_tools().create_asset(pname, folder, unreal.MoviePipelinePrimaryConfig, None)
            if asset is None:
                raise RuntimeError("could not create preset " + save_preset)
            asset.copy_from(cfg)
            # the preset keeps the look (resolution, passes, cameras, format) - not this job's frame range
            po = asset.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
            po.use_custom_playback_range = False
            unreal.EditorAssetLibrary.save_loaded_asset(asset, False)
            saved = save_preset
    subsys.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)
    return {"ok": True, "out_dir": od, "prefix": name, "jobs": len(frames), "preset_saved": saved, "cameras": [c[1] for c in cams]}


def stills_status(out_dir, prefix):
    files = sorted(f for f in os.listdir(out_dir) if f.startswith(prefix + ".")) if os.path.isdir(out_dir) else []
    return {"ok": True, "rendering": unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem).is_rendering(),
            "files": files}


def preset_info(path):
    p = unreal.load_asset(path)
    out = p.find_setting_by_class(unreal.MoviePipelineOutputSetting)
    cam = p.find_setting_by_class(unreal.MoviePipelineCameraSetting)
    res = out.output_resolution if out else None
    return {"ok": True, "settings": [type(s).__name__ for s in p.get_all_settings()],
            "resolution": [res.x, res.y] if res else None,
            "render_all_cameras": cam.get_editor_property("render_all_cameras") if cam else None}
