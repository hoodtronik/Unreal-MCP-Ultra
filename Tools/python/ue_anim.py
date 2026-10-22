# ue_anim.py - blend spaces and animation-asset checks behind create_blend_space / set_blend_space_samples /
# blend_space_check and the Anim Blueprint tool guards (Tools/src/tools/animation-mutation.ts). Exec'd after
# ue_posing.py (uses _eas, _v, _bone_map, resolve_role, MESH_YAW_OFFSET).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): the C++ set_blend_space_samples wiped every sample before adding, skipped
# unresolved animations silently (an empty blend space reported success), had no 1D option and no undo
# (audit #6). Python can write BlendSpace.blend_parameters / sample_data directly (FixedArray of 3 BlendParameter;
# struct fields only via get/set_editor_property), and set_editor_property runs the asset's PostEditChange, so
# the blend space rebuilds; blend_space_check proves that by evaluating the asset at each sample point.
import unreal


def resolve_anim(name_or_path, kinds=("AnimSequence",), skeleton=None):
    """Resolve an animation asset by object path, package path or bare asset name. Raises (never skips)."""
    if not name_or_path:
        raise ValueError("empty animation asset name")
    s = str(name_or_path).split(".")[0] if str(name_or_path).startswith("/") else str(name_or_path)
    a = unreal.load_asset(s) if s.startswith("/") and unreal.EditorAssetLibrary.does_asset_exist(s) else None
    if a is None and not s.startswith("/"):
        ar = unreal.AssetRegistryHelpers.get_asset_registry()
        hits = []
        for k in kinds:
            hits += [d for d in ar.get_assets_by_class(unreal.TopLevelAssetPath("/Script/Engine", k), True)
                     if str(d.asset_name) == s]
        if len(hits) > 1:
            raise ValueError("'%s' is ambiguous: %s - pass a path" % (s, ", ".join(str(h.package_name) for h in hits[:6])))
        if hits:
            a = unreal.load_asset(str(hits[0].package_name))
    if a is None:
        raise ValueError("animation asset not found: '%s'" % name_or_path)
    cls = a.get_class().get_name()
    if not any(isinstance(a, getattr(unreal, k)) for k in kinds):
        raise ValueError("'%s' is a %s, expected %s" % (name_or_path, cls, " or ".join(kinds)))
    if skeleton is not None and a.get_editor_property("skeleton") != skeleton:
        raise ValueError("'%s' uses skeleton %s, not %s" % (
            name_or_path, a.get_editor_property("skeleton").get_path_name(), skeleton.get_path_name()))
    return a


def check_anim(name_or_path, kinds, skeleton_of=None):
    """Tool guard: resolve an anim asset (and optionally match the skeleton of an AnimBlueprint/asset path)."""
    sk = None
    if skeleton_of:
        owner = unreal.load_asset(skeleton_of) if str(skeleton_of).startswith("/") else None
        if owner is not None:
            sk = owner.get_editor_property("target_skeleton") if isinstance(owner, unreal.AnimBlueprint) \
                else owner.get_editor_property("skeleton")
    a = resolve_anim(name_or_path, tuple(kinds), sk)
    return {"ok": True, "path": a.get_path_name().split(".")[0], "name": a.get_name(), "class": a.get_class().get_name(),
            "skeleton": a.get_editor_property("skeleton").get_path_name().split(".")[0]}


def _bs_kind(bs):
    return 1 if isinstance(bs, unreal.BlendSpace1D) else 2


def bs_create(name, package_path, skeleton, dimensions=2):
    path = package_path.rstrip("/") + "/" + name
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        bs = unreal.load_asset(path)
        if not isinstance(bs, unreal.BlendSpace):
            raise ValueError(path + " exists and is not a BlendSpace")
        return {"ok": True, "path": path, "created": False, "dimensions": _bs_kind(bs), "class": bs.get_class().get_name()}
    sk = unreal.load_asset(skeleton) if str(skeleton).startswith("/") else None
    if sk is None:
        ar = unreal.AssetRegistryHelpers.get_asset_registry()
        hits = [d for d in ar.get_assets_by_class(unreal.TopLevelAssetPath("/Script/Engine", "Skeleton"), True)
                if str(d.asset_name) == str(skeleton)]
        sk = unreal.load_asset(str(hits[0].package_name)) if hits else None
    if not isinstance(sk, unreal.Skeleton):
        raise ValueError("skeleton not found: " + str(skeleton))
    # CLAUDE-NOTE (2026-10-22): 'aim2d' / 'aim1d' make an Aim Offset (additive mesh-space rotation offsets driven by
    # yaw / pitch); its samples must be AAT_ROTATION_OFFSET_MESH_SPACE clips.
    if str(dimensions) == "aim2d":
        f, cls = unreal.AimOffsetBlendSpaceFactoryNew(), unreal.AimOffsetBlendSpace
    elif str(dimensions) == "aim1d":
        f, cls = unreal.AimOffsetBlendSpaceFactory1D(), unreal.AimOffsetBlendSpace1D
    elif int(dimensions) == 1:
        f, cls = unreal.BlendSpaceFactory1D(), unreal.BlendSpace1D
    else:
        f, cls = unreal.BlendSpaceFactoryNew(), unreal.BlendSpace
    f.set_editor_property("target_skeleton", sk)
    bs = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, package_path, cls, f)
    if bs is None:
        raise RuntimeError("could not create " + path)
    unreal.EditorAssetLibrary.save_loaded_asset(bs)
    return {"ok": True, "path": path, "created": True, "dimensions": _bs_kind(bs), "class": cls.__name__}


def bs_read(path):
    bs = unreal.load_asset(path) if str(path).startswith("/") else resolve_anim(path, ("BlendSpace",))
    if not isinstance(bs, unreal.BlendSpace):
        raise ValueError(str(path) + " is not a BlendSpace")
    axes = []
    for i, p in enumerate(bs.get_editor_property("blend_parameters")):
        if i >= _bs_kind(bs):
            break
        axes.append({"name": p.get_editor_property("display_name"), "min": p.get_editor_property("min"),
                     "max": p.get_editor_property("max"), "grid": p.get_editor_property("grid_num")})
    samples = []
    for s in bs.get_editor_property("sample_data"):
        a = s.get_editor_property("animation")
        v = s.get_editor_property("sample_value")
        samples.append({"anim": a.get_path_name().split(".")[0] if a else None, "x": round(v.x, 4), "y": round(v.y, 4),
                        "rate": s.get_editor_property("rate_scale")})
    return {"ok": True, "path": bs.get_path_name().split(".")[0], "dimensions": _bs_kind(bs), "axes": axes,
            "aim": isinstance(bs, (unreal.AimOffsetBlendSpace, unreal.AimOffsetBlendSpace1D)),
            "samples": samples, "skeleton": bs.get_editor_property("skeleton").get_path_name().split(".")[0]}


def bs_write(path, samples, axes=None, mode="replace"):
    """Set axes ([{name,min,max,grid}] per dimension) and samples ([{anim,x,y,rate}]) on a blend space.
    mode 'replace' (default, documented) or 'merge' (a sample at the same coordinates is replaced, others kept).
    Every animation must resolve and share the blend space's skeleton, and every point must lie inside the axes
    - otherwise nothing is written."""
    bs = unreal.load_asset(path) if str(path).startswith("/") else resolve_anim(path, ("BlendSpace",))
    if not isinstance(bs, unreal.BlendSpace):
        raise ValueError(str(path) + " is not a BlendSpace")
    dims = _bs_kind(bs)
    sk = bs.get_editor_property("skeleton")
    params = bs.get_editor_property("blend_parameters")
    if axes:
        for i, ax in enumerate(axes[:dims]):
            p = params[i]
            for k, prop in (("name", "display_name"), ("min", "min"), ("max", "max"), ("grid", "grid_num")):
                if ax.get(k) is not None:
                    p.set_editor_property(prop, ax[k] if k == "name" else (int(ax[k]) if k == "grid" else float(ax[k])))
            params[i] = p
    lims = [(params[i].get_editor_property("min"), params[i].get_editor_property("max")) for i in range(dims)]
    new = []
    aim = isinstance(bs, (unreal.AimOffsetBlendSpace, unreal.AimOffsetBlendSpace1D))
    for s in samples:
        a = resolve_anim(s["anim"], ("AnimSequence",), sk)
        x, y = float(s.get("x", 0.0)), float(s.get("y", 0.0)) if dims == 2 else 0.0
        for v, (lo, hi), ax in zip((x, y), lims, "XY"):
            if not lo - 1e-6 <= v <= hi + 1e-6:
                raise ValueError("sample %s at %s=%g is outside the axis [%g, %g]" % (a.get_name(), ax, v, lo, hi))
        new.append((a, x, y, float(s.get("rate", 1.0))))
    seen = set()
    for a, x, y, _ in new:
        if (x, y) in seen:
            raise ValueError("two samples at (%g, %g)" % (x, y))
        seen.add((x, y))
    out = []
    if mode == "merge":
        for s in bs.get_editor_property("sample_data"):
            v = s.get_editor_property("sample_value")
            if (round(v.x, 6), round(v.y, 6)) not in {(round(x, 6), round(y, 6)) for _, x, y, _ in new}:
                out.append(s)
    elif mode != "replace":
        raise ValueError("mode must be 'replace' or 'merge'")
    for a, x, y, r in new:
        b = unreal.BlendSample()
        b.set_editor_property("animation", a)
        b.set_editor_property("sample_value", unreal.Vector(x, y, 0.0))
        b.set_editor_property("rate_scale", r)
        out.append(b)
    if aim:
        # CLAUDE-NOTE (2026-10-22, live 5.6.1): aim offset samples must be mesh-space rotation-offset additives. Base =
        # the center sample's frame 0 (Epic's AO convention). Written with modify + set_editor_property so the editor's
        # PostEditChange rebuilds the compressed data: the first AO_Look clips (made additive earlier through the
        # AnimationLibrary setters) evaluated COMPRESSED as the full pose (root scale 2, pelvis 191.8 vs 95.9 raw) and the
        # AimOffset node stretched Manny ~4x (pelvis z 379) while the head still turned the right way. Re-writing the
        # properties fixed it; a fresh-clip repro of the setter path did NOT reproduce it, so the trigger is unknown -
        # aim_offset_check measures the body vs the base pose to catch it.
        center = next((a for a, x, y, _ in new if abs(x) < 1e-6 and abs(y) < 1e-6), None)
        if center is None:
            raise ValueError("an aim offset needs a sample at (0, 0): it is the additive base pose of every sample")
        for a, _, _, _ in new:
            if (a.get_editor_property("additive_anim_type") != unreal.AdditiveAnimationType.AAT_ROTATION_OFFSET_MESH_SPACE
                    or a.get_editor_property("ref_pose_type") != unreal.AdditiveBasePoseType.ABPT_ANIM_FRAME
                    or a.get_editor_property("ref_pose_seq") != center or a.get_editor_property("ref_frame_index") != 0):
                a.modify()
                a.set_editor_property("ref_pose_type", unreal.AdditiveBasePoseType.ABPT_ANIM_FRAME)
                a.set_editor_property("ref_pose_seq", center)
                a.set_editor_property("ref_frame_index", 0)
                a.set_editor_property("additive_anim_type", unreal.AdditiveAnimationType.AAT_ROTATION_OFFSET_MESH_SPACE)
                unreal.EditorAssetLibrary.save_loaded_asset(a, False)
    bs.modify()
    bs.set_editor_property("blend_parameters", params)
    bs.set_editor_property("sample_data", out)
    unreal.EditorAssetLibrary.save_loaded_asset(bs)
    return bs_read(bs.get_path_name().split(".")[0])


def bs_preview(label, bs_path, x=0.0, y=0.0, mesh=None, location=(0, 0, 0), facing=None):
    """Hold a blend space at (x, y), time 0, on a level SkeletalMeshActor (spawned if missing). Bones update on
    the next tick - read with read_actor_pose in a later call."""
    bs = unreal.load_asset(bs_path)
    if not isinstance(bs, unreal.BlendSpace):
        raise ValueError(str(bs_path) + " is not a BlendSpace")
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        if not mesh:
            raise ValueError("No actor '%s'; pass mesh to spawn one" % label)
        act = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*location))
        act.set_actor_label(label)
    c = act.get_component_by_class(unreal.SkeletalMeshComponent)
    if mesh:
        c.set_skeletal_mesh_asset(unreal.load_asset(mesh))
    if facing is not None:
        act.set_actor_rotation(unreal.Rotator(pitch=0.0, yaw=float(facing) - MESH_YAW_OFFSET, roll=0.0), False)
    c.set_update_animation_in_editor(True)
    c.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    c.play_animation(bs, False)
    ai = c.get_anim_instance()
    ai.set_blend_space_position(unreal.Vector(float(x), float(y), 0.0))
    c.set_position(0.0, False)
    c.set_play_rate(0.0)
    return {"ok": True, "actor": label, "x": float(x), "y": float(y)}


def pose_signature(label, bones=("hand_l", "hand_r", "foot_l", "foot_r", "head", "ball_l", "ball_r")):
    """Bone positions relative to the actor (actor space), so two previews at different places compare."""
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        raise ValueError("No level actor labelled '%s'" % label)
    sk = act.get_component_by_class(unreal.SkeletalMeshComponent)
    allb = _bone_map(sk)
    xf = act.get_actor_transform()
    out = {}
    for w in bones:
        real = w if w in allb else resolve_role(allb, w)
        if real:
            out[w] = _v(xf.inverse_transform_location(sk.get_socket_location(real)))
    ai = sk.get_anim_instance()
    asset = ai.get_animation_asset() if isinstance(ai, unreal.AnimSingleNodeInstance) else None
    return {"ok": True, "bones": out, "asset": asset.get_path_name().split(".")[0] if asset else None}


def remove_actor(label):
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act:
        _eas().destroy_actor(act)
    return {"ok": True, "removed": bool(act)}


def resolve_abp(name_or_path):
    """AnimBlueprint package path from a name or path (raises when missing or ambiguous)."""
    s = str(name_or_path).split(".")[0]
    if s.startswith("/"):
        a = unreal.load_asset(s) if unreal.EditorAssetLibrary.does_asset_exist(s) else None
    else:
        ar = unreal.AssetRegistryHelpers.get_asset_registry()
        hits = [d for d in ar.get_assets_by_class(unreal.TopLevelAssetPath("/Script/Engine", "AnimBlueprint"), True)
                if str(d.asset_name) == s]
        if len(hits) > 1:
            raise ValueError("'%s' is ambiguous: %s - pass a path" % (s, ", ".join(str(h.package_name) for h in hits[:6])))
        a = unreal.load_asset(str(hits[0].package_name)) if hits else None
    if not isinstance(a, unreal.AnimBlueprint):
        raise ValueError("Animation Blueprint not found: '%s'" % name_or_path)
    return {"ok": True, "path": a.get_path_name().split(".")[0],
            "skeleton": a.get_editor_property("target_skeleton").get_path_name().split(".")[0]}


def bs_resample(path, close=True):
    """Rebuild a blend space's runtime data (segments / triangulation) the way the editor does.
    CLAUDE-NOTE (2026-10-21, live + engine source): UBlendSpace::ResampleData() is not exposed to Python and is not
    run by PostEditChangeProperty or PostLoad - only SBlendSpaceEditor calls it (on construction and on edits).
    Samples written from Python therefore evaluated to the REFERENCE POSE until the asset editor had been opened;
    opening and closing it rebuilds the data (verified: x=0/150/300 then matched idle/jog/walk exactly)."""
    bs = unreal.load_asset(path)
    aes = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem)
    was_open = bool(aes.find_editor_for_asset(bs, False)) if hasattr(aes, "find_editor_for_asset") else False
    aes.open_editor_for_assets([bs])
    if close and not was_open:
        aes.close_all_editors_for_asset(bs)
    unreal.EditorAssetLibrary.save_loaded_asset(bs, False)
    return {"ok": True, "path": path}


def abp_preview(label, abp_path, mesh, location=(0, 0, -5000)):
    """Run an AnimBlueprint on a hidden level mannequin (editor anim update on); read with pose_signature next tick."""
    abp = unreal.load_asset(abp_path)
    if not isinstance(abp, unreal.AnimBlueprint):
        raise ValueError(str(abp_path) + " is not an AnimBlueprint")
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        act = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*location))
        act.set_actor_label(label)
    c = act.skeletal_mesh_component
    c.set_skeletal_mesh_asset(unreal.load_asset(mesh))
    c.set_update_animation_in_editor(True)
    c.set_animation_mode(unreal.AnimationMode.ANIMATION_BLUEPRINT)
    c.set_anim_instance_class(None)                      # force a fresh instance of the just-compiled class
    c.set_anim_instance_class(abp.generated_class())
    return {"ok": True, "actor": label}


def ref_preview(label, mesh, location=(0, 300, -5000)):
    """Same mannequin in its reference pose (no animation) - the 'plays nothing' baseline."""
    act = next((a for a in _eas().get_all_level_actors() if a.get_actor_label() == label), None)
    if act is None:
        act = _eas().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*location))
        act.set_actor_label(label)
    c = act.skeletal_mesh_component
    c.set_skeletal_mesh_asset(unreal.load_asset(mesh))
    c.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    c.set_animation(None)
    return {"ok": True, "actor": label}
