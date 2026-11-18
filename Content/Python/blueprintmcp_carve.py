"""Carve the world around an actor so it sits cleanly in terrain and foliage.

CLAUDE-NOTE (2026-11-18): built for the SciFiModules spline corridors, after doing it by hand in the
LevelUp project: grass grew through the floor, hills and rocks blocked the interior, and lowered ground
left props floating. carve() automates that pass for any actor and is re-runnable after edits:

  1. Trough: lower the landscape (edit layer, via UBlueprintMCPLandscapeLibrary) under the actor's real
     footprint - the union of every mesh/instance box, optionally shrunk by `inset` - to
     `depth` below each piece's underside. Only lowers; never raises.
  2. Settle: everything else standing on ground that was lowered (other actors and instances; not
     landscape grass, which regenerates) drops by the same amount. Anything that was inside the
     footprint ends up under the floor, which is the cull.
  3. Cut through (actors with a SplineComponent): every mesh - actor or instance - whose geometry
     crosses the corridor envelope (one box per spline segment) is boolean-cut so only the slot is
     removed; the cut copy is saved under /Game/CarvedMeshes/<level>/. Small instances are removed.

Lives in BlueprintMCP's Content/Python, so it only exists where BlueprintMCP is installed. Entry points:
the MCP tool carve_under_actor, and the Carve button on BP_SFM_CorridorSpline.
"""
import json
import math
import os

import numpy as np
import unreal

LIB = getattr(unreal, "BlueprintMCPLandscapeLibrary", None)


def _actor(target):
    if isinstance(target, unreal.Actor):
        return target
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    for a in eas.get_all_level_actors():
        if a.get_actor_label() == target or a.get_path_name() == target or a.get_name() == target:
            return a
    raise ValueError("No actor labelled or named '%s' in the current level." % target)


def _oriented_boxes(actor):
    """(corners_xy[4,2], bottom_z) for every mesh piece of the actor, in world space."""
    boxes = []
    for c in actor.get_components_by_class(unreal.StaticMeshComponent):
        sm = c.get_editor_property("static_mesh")
        if not sm or not c.is_visible():
            continue
        bb = sm.get_bounding_box()
        lo, hi = bb.min, bb.max
        local = [unreal.Vector(x, y, z) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
        if isinstance(c, unreal.InstancedStaticMeshComponent):
            xforms = [c.get_instance_transform(i, True) for i in range(c.get_instance_count())]
        else:
            xforms = [c.get_world_transform()]
        for t in xforms:
            w = [t.transform_location(p) for p in local]
            zs = [p.z for p in w]
            bottom = [p for p in w if p.z <= min(zs) + 1e-3][:4]
            if len(bottom) < 4:
                continue
            pts = np.array([[p.x, p.y] for p in bottom])
            # order the four bottom corners around their centre so the polygon test works
            cen = pts.mean(axis=0)
            pts = pts[np.argsort(np.arctan2(pts[:, 1] - cen[1], pts[:, 0] - cen[0]))]
            boxes.append((pts, min(zs)))
    return boxes


def _inside(poly, X, Y):
    # convex polygon, counter-clockwise: inside if left of every edge
    ok = np.ones(X.shape, bool)
    for k in range(len(poly)):
        ax, ay = poly[k]
        bx, by = poly[(k + 1) % len(poly)]
        ok &= (bx - ax) * (Y - ay) - (by - ay) * (X - ax) >= 0
    return ok


_ISM_PROPS = ("static_mesh", "override_materials", "cast_shadow", "mobility", "instance_start_cull_distance",
              "instance_end_cull_distance", "lightmap_type", "visible_in_ray_tracing", "evaluate_world_position_offset",
              "world_position_offset_disable_distance", "translucency_sort_priority", "min_lod", "forced_lod_model")


def _is_blueprint_owned(comp):
    """True if edits to the component would be rebuilt away on load: its owner is a Blueprint actor and
    the component is not a plain per-instance component. (Packed-level-actor components report neither
    'inherited' nor 'instanced' through the subobject API, and creation_method is not exposed to Python,
    so the owner's class decides.)"""
    owner = comp.get_owner()
    if owner is None or not isinstance(owner.get_class(), unreal.BlueprintGeneratedClass):
        return False
    sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    lib = unreal.SubobjectDataBlueprintFunctionLibrary
    for h in sds.k2_gather_subobject_data_for_instance(owner):
        d = lib.get_data(h)
        if lib.get_associated_object(d) == comp:
            return not lib.is_instanced_component(d)
    return True


def _unpack(owner, cache):
    """Copy a Blueprint actor's instanced meshes into a plain level actor and delete the original.

    CLAUDE-NOTE (2026-11-18): edits to instances inside a placed Blueprint actor (e.g. the packed-level
    rock clusters BPP_PLA_rock_*) look fine until the level reloads, then the Blueprint rebuilds them
    and every removal/move is gone (verified in LevelUp: 3,600 settled grass instances and 19 removed
    rocks all came back). A plain actor with INSTANCE components saves its instances, so carve edits
    those instead. Level-local: the shared Blueprint asset is untouched. Returns {old_comp_name: new_comp}.
    """
    key = owner.get_path_name()
    if key in cache:
        return cache[key]
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    lib = unreal.SubobjectDataBlueprintFunctionLibrary
    xf = owner.get_actor_transform()
    new = eas.spawn_actor_from_class(unreal.Actor, xf.translation, xf.rotation.rotator())
    new.set_actor_label(owner.get_actor_label() + "_Carved")
    try:
        new.set_folder_path(owner.get_folder_path())
    except Exception:
        pass
    handles = sds.k2_gather_subobject_data_for_instance(new)
    parent = handles[0]
    root_params = unreal.AddNewSubobjectParams(parent_handle=parent, new_class=unreal.SceneComponent, blueprint_context=None)
    root_h, _ = sds.add_new_subobject(root_params)
    mapping = {}
    for c in owner.get_components_by_class(unreal.InstancedStaticMeshComponent):
        params = unreal.AddNewSubobjectParams(parent_handle=root_h, new_class=unreal.HierarchicalInstancedStaticMeshComponent, blueprint_context=None)
        h, fail = sds.add_new_subobject(params)
        nc = lib.get_object(lib.get_data(h))
        sds.rename_subobject(h, c.get_name())
        for p in _ISM_PROPS:
            try:
                nc.set_editor_property(p, c.get_editor_property(p))
            except Exception:
                pass
        nc.set_collision_profile_name(c.get_collision_profile_name())
        nc.set_collision_enabled(c.get_collision_enabled())
        nc.add_instances([c.get_instance_transform(i, True) for i in range(c.get_instance_count())], False, True)
        mapping[c.get_name()] = nc
    eas.destroy_actor(owner)
    cache[key] = mapping
    return mapping


def _editable(comp, cache, unpacked):
    """The component to edit for `comp`: itself, or its copy after unpacking a Blueprint owner."""
    owner = comp.get_owner()
    if owner is None or not _is_blueprint_owned(comp) or isinstance(owner, unreal.LandscapeProxy):
        return comp
    name = comp.get_name()
    unpacked.add(owner.get_actor_label())  # read before _unpack destroys the owner
    return _unpack(owner, cache).get(name, comp)


GS = unreal  # GeometryScript lives on the unreal module (GeometryScript_* libraries)


def _segment_boxes(samples, half_w, zlo, zhi, overlap):
    """One oriented box per straight run of the spline (world space): centre, yaw (deg), length, width,
    height. Consecutive samples in the same direction merge into one box, so a 90-degree grid corridor
    becomes a handful of boxes instead of hundreds (each box costs six plane slices per mesh)."""
    runs = []
    for (p0, _), (p1, _) in zip(samples, samples[1:]):
        dx, dy = p1.x - p0.x, p1.y - p0.y
        if math.hypot(dx, dy) < 1:
            continue
        yaw = math.degrees(math.atan2(dy, dx))
        if runs and abs((yaw - runs[-1][2] + 180) % 360 - 180) < 0.5:
            runs[-1][1] = p1
        else:
            runs.append([p0, p1, yaw])
    out = []
    for p0, p1, yaw in runs:
        L = math.hypot(p1.x - p0.x, p1.y - p0.y)
        out.append(((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (zlo + zhi) / 2, yaw, L + 2 * overlap, 2 * half_w, zhi - zlo))
    return out


def _box_aabb(b):
    cx, cy, cz, yaw, L, Wd, Hh = b
    r = math.radians(yaw)
    ex = abs(math.cos(r)) * L / 2 + abs(math.sin(r)) * Wd / 2
    ey = abs(math.sin(r)) * L / 2 + abs(math.cos(r)) * Wd / 2
    return (cx - ex, cy - ey, cz - Hh / 2, cx + ex, cy + ey, cz + Hh / 2)


def _overlaps(a, b):
    return a[0] < b[3] and b[0] < a[3] and a[1] < b[4] and b[1] < a[4] and a[2] < b[5] and b[2] < a[5]


def _mesh_of(sm):
    dm = unreal.DynamicMesh()
    dm, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_from_static_mesh(
        sm, dm, unreal.GeometryScriptCopyMeshFromAssetOptions(), unreal.GeometryScriptMeshReadLOD())
    return dm if outcome == unreal.GeometryScriptOutcomePins.SUCCESS else None


def _cut_mesh(sm, xform, boxes):
    """Remove the parts of `sm` (placed at `xform`) inside the boxes. Returns the cut mesh in the mesh's
    local space, or None when nothing lies inside.

    CLAUDE-NOTE (2026-11-18): slice + delete, not a CSG boolean. Landscape-art meshes are often open
    surfaces; on those the boolean misclassified inside/outside (it "intersected" a whole 62k-triangle
    mountain and reported a rock 3,000 units from the corridor). Slicing along the six box planes and
    deleting the triangles left fully inside works on any mesh and leaves a straight-edged slot.
    """
    dm = _mesh_of(sm)
    if dm is None:
        return None
    TM = unreal.GeometryScript_MeshTransforms
    SEL = unreal.GeometryScript_MeshSelection
    TM.transform_mesh(dm, xform)                     # mesh local -> world
    slice_opts = unreal.GeometryScriptMeshPlaneSliceOptions()
    try:
        slice_opts.set_editor_property("fill_holes", False)
    except Exception:
        pass
    removed = 0
    for cx, cy, cz, yaw, L, Wd, Hh in boxes:
        bt = unreal.Transform(unreal.Vector(cx, cy, cz), unreal.Rotator(0, 0, yaw), unreal.Vector(1, 1, 1))
        TM.transform_mesh(dm, bt.inverse())          # world -> box frame (box centred, axis aligned)
        hx, hy, hz = L / 2, Wd / 2, Hh / 2
        box = unreal.Box(unreal.Vector(-hx, -hy, -hz), unreal.Vector(hx, hy, hz))
        big = unreal.Box(unreal.Vector(-hx - 1, -hy - 1, -hz - 1), unreal.Vector(hx + 1, hy + 1, hz + 1))
        mb = unreal.GeometryScript_MeshQueries.get_mesh_bounding_box(dm)
        if (mb.min.x < hx and mb.max.x > -hx and mb.min.y < hy and mb.max.y > -hy and mb.min.z < hz and mb.max.z > -hz):
            for loc, nrm in (((hx, 0, 0), (1, 0, 0)), ((-hx, 0, 0), (1, 0, 0)), ((0, hy, 0), (0, 1, 0)),
                             ((0, -hy, 0), (0, 1, 0)), ((0, 0, hz), (0, 0, 1)), ((0, 0, -hz), (0, 0, 1))):
                # GeometryScript plane frames use the frame's Z axis as the plane normal
                frame = unreal.Transform(unreal.Vector(*loc), unreal.MathLibrary.make_rot_from_z(unreal.Vector(*nrm)), unreal.Vector(1, 1, 1))
                unreal.GeometryScript_MeshBooleans.apply_mesh_plane_slice(dm, frame, slice_opts)
            dm, sel = SEL.select_mesh_elements_in_box(dm, big, unreal.GeometryScriptMeshSelectionType.TRIANGLES, False, 3)
            # CLAUDE-NOTE (2026-11-18): only cut if some triangle's centroid is clearly inside (2 units in
            # from every face). The 1-unit-padded selection also catches slivers hugging an earlier cut,
            # which made every re-run re-cut and re-save the same meshes.
            ids = SEL.convert_mesh_selection_to_index_array(dm, sel)
            ids = ids[1] if isinstance(ids, tuple) else ids
            idl = list(ids.get_editor_property("list")) if hasattr(ids, "get_editor_property") else list(ids)
            strict = False
            for tid in idl:
                r = unreal.GeometryScript_MeshQueries.get_triangle_positions(dm, tid)
                v = [p for p in (r if isinstance(r, tuple) else (r,)) if isinstance(p, unreal.Vector)][:3]
                if len(v) == 3:
                    cx_, cy_, cz_ = (sum(q.x for q in v) / 3, sum(q.y for q in v) / 3, sum(q.z for q in v) / 3)
                    if abs(cx_) < hx - 2 and abs(cy_) < hy - 2 and abs(cz_) < hz - 2:
                        strict = True
                        break
            if strict:
                dm, n = unreal.GeometryScript_MeshEdits.delete_selected_triangles_from_mesh(dm, sel)
                removed += n
        TM.transform_mesh(dm, bt)                    # back to world
    if removed == 0:
        return None
    TM.transform_mesh(dm, xform.inverse())           # back to mesh local
    return dm


def _save_cut_asset(src_sm, dm, folder, name):
    """Write `dm` to folder/name (creating or overwriting), copying materials + Nanite from the source."""
    path = "%s/%s" % (folder, name)
    eal = unreal.EditorAssetLibrary
    if eal.does_asset_exist(path):
        sm = unreal.load_asset(path)
        unreal.GeometryScript_AssetUtils.copy_mesh_to_static_mesh(dm, sm, unreal.GeometryScriptCopyMeshToAssetOptions(),
                                                                   unreal.GeometryScriptMeshWriteLOD())
    else:
        o = unreal.GeometryScriptCreateNewStaticMeshAssetOptions()
        try:
            o.set_editor_property("enable_nanite", src_sm.get_editor_property("nanite_settings").enabled)
        except Exception:
            pass
        sm, outcome = unreal.GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(dm, path, o)
        if outcome != unreal.GeometryScriptOutcomePins.SUCCESS:
            raise RuntimeError("Could not create %s" % path)
    sm.set_editor_property("static_materials", src_sm.get_editor_property("static_materials"))
    try:
        sm.get_editor_property("body_setup").set_editor_property("collision_trace_flag", unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
    except Exception:
        pass
    eal.save_loaded_asset(sm, False)
    return sm


def _spline_samples(actor, step=200.0):
    sp = actor.get_component_by_class(unreal.SplineComponent)
    if not sp:
        return None
    L = sp.get_spline_length()
    n = max(2, int(L / step) + 1)
    # Always sample exactly at every spline point too: a sample pair that straddles a corner makes a
    # chord that cuts the corner and leaves the actor through its wall, reporting outside rocks/grass
    # as intrusions (seen on the LevelUp rampart: 19 false hits).
    ds = {L * i / (n - 1) for i in range(n)}
    ds |= {sp.get_distance_along_spline_at_spline_point(i) for i in range(sp.get_number_of_spline_points())}
    out = []
    for d in sorted(ds):
        out.append((sp.get_location_at_distance_along_spline(d, unreal.SplineCoordinateSpace.WORLD),
                    sp.get_right_vector_at_distance_along_spline(d, unreal.SplineCoordinateSpace.WORLD)))
    return out


def carve(target, depth=450.0, inset=0.0, landscape="", layer="", settle=True, clear_intrusions=True,
          dry_run=False, work_dir="", settle_baseline="", cut_half_width=270.0,
          floor_margin=-20.0, small_size=250.0, ground_snap=150.0):
    """settle_baseline: optional .r16 of the terrain as it was BEFORE earlier edits (e.g. a heightmap
    backup); props are then settled by the total drop since that baseline, not just this carve's."""
    if LIB is None:
        raise RuntimeError("BlueprintMCPLandscapeLibrary is missing: BlueprintMCP's C++ module is not loaded.")
    actor = _actor(target)
    label = actor.get_actor_label()
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    land = LIB.find_editor_landscape(landscape)
    if not land:
        raise RuntimeError("No landscape found (pass landscape=<label> if the level has several).")
    work_dir = work_dir or os.path.join(unreal.Paths.project_saved_dir(), "BlueprintMCP", "Carve", label)
    os.makedirs(work_dir, exist_ok=True)
    report = {"actor": label, "landscape": land.get_actor_label(), "dryRun": dry_run, "workDir": work_dir}

    # ---- 1. trough under the footprint --------------------------------------------------------
    cur = os.path.join(work_dir, "current.r16")
    info = json.loads(LIB.export_landscape_heightmap(land, cur, layer))
    if "error" in info:
        raise RuntimeError(info["error"])
    W, H = int(info["width"]), int(info["height"])
    ox, oy, oz = info["originX"], info["originY"], info["originZ"]
    sx, sy, sz = info["scaleX"], info["scaleY"], info["scaleZ"]
    old = np.fromfile(cur, "<u2").astype(np.int64).reshape(H, W)
    new = old.copy()
    to_z = lambda v: oz + (v - 32768) / 128.0 * sz
    to_v = lambda z: np.clip(np.round(32768 + (z - oz) * 128.0 / sz), 0, 65535).astype(np.int64)

    # CLAUDE-NOTE (2026-11-18): the inset shrinks the UNION footprint, not each box. Shrinking every mesh box
    # on its own left a 2*inset gap on every seam between neighbouring pieces; with 200-wide junction floor
    # panels and a 100-unit landscape grid every seam sits on a vertex row, so every other row stayed uncarved
    # (striped trough, grass through the floor - LevelUp street maze). A vertex is now carved when it and the
    # four points `inset` away from it each lie inside SOME box; its depth comes from the boxes over it.
    # Default inset is 0: with a 100-unit landscape grid the wall line itself is a vertex row, and any inset
    # left it up, so the terrain ramped back up inside the walls and grass showed along both wall bases.
    boxes = _oriented_boxes(actor)
    offs = [(0.0, 0.0), (inset, 0.0), (-inset, 0.0), (0.0, inset), (0.0, -inset)]
    cover = [np.zeros((H, W), bool) for _ in offs]
    target = np.full((H, W), np.iinfo(np.int64).max, np.int64)
    for poly, bottom in boxes:
        i0 = max(0, int(math.floor((poly[:, 0].min() - inset - ox) / sx)))
        i1 = min(W - 1, int(math.ceil((poly[:, 0].max() + inset - ox) / sx)))
        j0 = max(0, int(math.floor((poly[:, 1].min() - inset - oy) / sy)))
        j1 = min(H - 1, int(math.ceil((poly[:, 1].max() + inset - oy) / sy)))
        if i1 < i0 or j1 < j0:
            continue
        X, Y = np.meshgrid(ox + np.arange(i0, i1 + 1) * sx, oy + np.arange(j0, j1 + 1) * sy)
        for k, (dx, dy) in enumerate(offs):
            m = _inside(poly, X + dx, Y + dy)
            if m.any():
                cover[k][j0:j1 + 1, i0:i1 + 1] |= m
                if k == 0:
                    t = target[j0:j1 + 1, i0:i1 + 1]
                    t[m] = np.minimum(t[m], to_v(bottom - depth))
    keep = np.logical_and.reduce(cover)
    new[keep] = np.minimum(new[keep], target[keep])
    changed = int((new != old).sum())
    report.update(pieces=len(boxes), troughVerts=changed)
    base = old
    if settle_baseline:
        base = np.fromfile(settle_baseline, "<u2").astype(np.int64)
        if base.size != W * H:
            raise RuntimeError("settle_baseline %s has %d values; the landscape has %d." % (settle_baseline, base.size, W * H))
        base = base.reshape(H, W)
    dz = (to_z(new) - to_z(base))

    if not dry_run and changed:
        out = os.path.join(work_dir, "carved.r16")
        new.astype("<u2").tofile(out)
        with unreal.ScopedEditorTransaction("Carve terrain under %s" % label):
            res = json.loads(LIB.import_landscape_heightmap(land, out, layer, os.path.join(work_dir, "before_carve.r16"), False))
        if "error" in res:
            raise RuntimeError(res["error"])
        report["backup"] = os.path.join(work_dir, "before_carve.r16")

    znew = to_z(new)

    def dz_at(x, y):
        i = int(round((x - ox) / sx))
        j = int(round((y - oy) / sy))
        return dz[j, i] if (0 <= i < W and 0 <= j < H) else 0.0

    def gz_at(x, y):
        i = int(round((x - ox) / sx))
        j = int(round((y - oy) / sy))
        return znew[j, i] if (0 <= i < W and 0 <= j < H) else -1e9

    zbase = to_z(base)

    def gz_old(x, y):
        i = int(round((x - ox) / sx))
        j = int(round((y - oy) / sy))
        return zbase[j, i] if (0 <= i < W and 0 <= j < H) else 1e9

    def still_floating(x, y, z, d):
        # CLAUDE-NOTE (2026-11-18): only settle what is still up in the air. Re-running carve (or using
        # settle_baseline) must not drop things a second time: a first version sank a tree and three
        # rocks that an earlier pass had already lowered. "Floating" = more than half the drop above
        # the new ground; things already settled sit within their usual small offset of it.
        # It must also have STOOD on the ground before the carve (within ground_snap of it): carving stair
        # pieces one by one dropped their neighbours - pieces built hundreds of units up - by the drop under
        # them, breaking every flight (LevelUp labyrinth).
        return z - gz_at(x, y) > 0.5 * abs(d) and z - gz_old(x, y) < ground_snap

    # ---- 2. settle what stood on lowered ground ----------------------------------------------
    settled_actors, settled_instances = [], 0
    unpack_cache, unpacked = {}, set()
    if settle and (changed or settle_baseline):
        eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        with unreal.ScopedEditorTransaction("Carve: settle props around %s" % label):
            for a in list(eas.get_all_level_actors()):
                if a == actor or isinstance(a, unreal.LandscapeProxy):
                    continue
                if isinstance(a, unreal.StaticMeshActor):
                    p = a.get_actor_location()
                    d = dz_at(p.x, p.y)
                    bo, be = a.get_actor_bounds(False)
                    if d < -10 and still_floating(p.x, p.y, bo.z - be.z, d):
                        settled_actors.append(a.get_actor_label())
                        if not dry_run:
                            a.modify()
                            a.set_actor_location(p + unreal.Vector(0, 0, d), False, False)
                    continue
                # collect this actor's moves first: unpacking destroys `a` and replaces its components
                pending = []
                for c in a.get_components_by_class(unreal.InstancedStaticMeshComponent):
                    ups = []
                    for k in range(c.get_instance_count()):
                        t = c.get_instance_transform(k, True)
                        d = dz_at(t.translation.x, t.translation.y)
                        if d < -10 and still_floating(t.translation.x, t.translation.y, t.translation.z, d):
                            t.translation = t.translation + unreal.Vector(0, 0, d)
                            ups.append((k, t))
                    if ups:
                        pending.append((c, ups))
                        settled_instances += len(ups)
                if pending and not dry_run:
                    targets = [(_editable(c, unpack_cache, unpacked), ups) for c, ups in pending]
                    for c, ups in targets:
                        c.modify()
                        # CLAUDE-NOTE (2026-11-18): the last update must mark the render state dirty.
                        # With False on every call the moves showed in the editor but were not saved:
                        # after a reload all 4,209 settled grass instances floated again (LevelUp).
                        for n, (k, t) in enumerate(ups):
                            c.update_instance_transform(k, t, True, n == len(ups) - 1, True)
    report.update(settledActors=settled_actors, settledInstances=settled_instances)

    # ---- 3. cut through every mesh that crosses the corridor envelope -------------------------
    # CLAUDE-NOTE (2026-11-18): geometry, not collision. The first version ray-traced the interior and
    # missed a rock that visibly blocked the corridor: its collision did not match its render mesh, so
    # no trace (Visibility or object type) could see it. Now each candidate is boolean-intersected with
    # the corridor envelope; anything that truly crosses it is cut (CSG subtract) into its own asset under
    # /Game/CarvedMeshes/<level>/ (the shared source mesh is untouched). Small instances (grass, pebbles)
    # are removed instead of cut.
    samples = _spline_samples(actor)
    if clear_intrusions and samples is None:
        report["intrusions"] = "skipped: actor has no SplineComponent to follow"
    elif clear_intrusions:
        o, e = actor.get_actor_bounds(False)
        boxes = _segment_boxes(samples, cut_half_width, o.z - e.z + floor_margin, o.z + e.z + 20, cut_half_width)
        aabbs = [_box_aabb(b) for b in boxes]
        folder = "/Game/CarvedMeshes/%s" % world.get_name()
        eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        cut_assets, removed, converted = [], 0, 0
        with unreal.ScopedEditorTransaction("Carve: cut through meshes in %s" % label):
            for a in list(eas.get_all_level_actors()):
                if a == actor or isinstance(a, unreal.LandscapeProxy):
                    continue
                for c in a.get_components_by_class(unreal.StaticMeshComponent):
                    sm = c.get_editor_property("static_mesh")
                    if not sm or not c.is_visible():
                        continue
                    bb = sm.get_bounding_box()
                    corners = [unreal.Vector(x, y, z) for x in (bb.min.x, bb.max.x) for y in (bb.min.y, bb.max.y) for z in (bb.min.z, bb.max.z)]
                    is_ism = isinstance(c, unreal.InstancedStaticMeshComponent)
                    xfs = [c.get_instance_transform(i, True) for i in range(c.get_instance_count())] if is_ism else [c.get_world_transform()]
                    kill, convert = [], []
                    for idx, t in enumerate(xfs):
                        w = [t.transform_location(q) for q in corners]
                        wb = (min(q.x for q in w), min(q.y for q in w), min(q.z for q in w), max(q.x for q in w), max(q.y for q in w), max(q.z for q in w))
                        near = [boxes[i] for i, ab in enumerate(aabbs) if _overlaps(wb, ab)]
                        if not near:
                            continue
                        cut = _cut_mesh(sm, t, near)
                        if cut is None:
                            continue
                        size = max(wb[3] - wb[0], wb[4] - wb[1], wb[5] - wb[2])
                        if is_ism and size < small_size:
                            kill.append(idx)
                        elif is_ism:
                            convert.append((idx, t, cut))
                        else:
                            convert.append((None, t, cut))
                    if dry_run:
                        removed += len(kill)
                        cut_assets += ["%s/%s" % (a.get_actor_label(), c.get_name())] * len(convert)
                        continue
                    if not kill and not convert:
                        continue
                    owner_label = a.get_actor_label()
                    owner_folder = a.get_folder_path()
                    target = _editable(c, unpack_cache, unpacked) if is_ism else c
                    for idx, t, cut in convert:
                        src_path = sm.get_path_name().split(".")[0]
                        if src_path.startswith(folder + "/"):
                            name = src_path.split("/")[-1]          # re-carving a carved mesh: update in place
                        else:
                            name = "%s__%s_%s" % (sm.get_name(), owner_label, c.get_name()) + ("" if idx is None else "_%d" % idx)
                        new_sm = _save_cut_asset(sm, cut, folder, name)
                        cut_assets.append("%s/%s" % (folder, name))
                        if idx is None:
                            target.modify()
                            target.set_static_mesh(new_sm)
                        else:
                            # the instance becomes its own actor carrying the cut mesh
                            na = eas.spawn_actor_from_object(new_sm, t.translation, t.rotation.rotator())
                            na.set_actor_scale3d(t.scale3d)
                            na.set_actor_label("%s_cut" % name)
                            na.set_folder_path(owner_folder)
                            for i, m in enumerate(c.get_editor_property("override_materials") or []):
                                if m:
                                    na.static_mesh_component.set_material(i, m)
                            kill.append(idx)
                            converted += 1
                    if kill and is_ism:
                        target.modify()
                        target.remove_instances(sorted(set(kill)))
                        removed += len([k for k in kill if k not in {i for i, _, _ in convert}])
        report.update(cutMeshes=cut_assets, removedInstances=removed, instancesConvertedToCutActors=converted)
    report["unpackedActors"] = sorted(unpacked)
    return report


def carve_json(target, **kw):
    """carve() with the report printed as JSON, for MCP and button callers."""
    try:
        r = carve(target, **kw)
    except Exception as ex:  # report, do not raise into the Blueprint VM
        r = {"error": str(ex)}
    s = json.dumps(r)
    (unreal.log_error if "error" in r else unreal.log)("BlueprintMCP carve: " + s)
    print(s)
    return s
