# ue_retarget - IK Rig / IK Retargeter / Pose Asset helpers behind the ikrig_* / retarget_* / pose_asset_* tools.
# Shipped base64 + exec()'d by Tools/src/tools/retarget.ts (see the CLAUDE-NOTE there on why not as a file name).
#
# CLAUDE-NOTE (2026-10-21, UE 5.6.1 live, MyLab_5_6): every call here was probed by hand first:
#  * IKRigController.apply_auto_generated_retarget_definition() works for Epic-template skeletons (Manny: 28
#    chains) and returns False for custom skeletons (Fab girl02_*). The fallback maps chains by bone-name stem
#    (strip a model prefix and ONE trailing _NNN index) against a template rig.
#  * The retargeter's Pelvis Motion op ignores a SCALED root bone (glTF/Fab imports: _rootJoint scale 0.009346):
#    the pelvis landed at z=1.0 (= 113 * 0.0093) and the character sank into the floor. Compensated by setting the
#    op's scale_vertical/horizontal to 1/root_scale (verified: pelvis 106.6 = 113 * height ratio 0.943).
#  * IKRetargetBatchOperation.duplicate_and_retarget writes to /Game/<name><suffix> regardless of the source
#    folder, so outputs are moved into the requested folder afterwards.
import math
import re

import unreal

RC = unreal.IKRigController
RTC = unreal.IKRetargeterController
S = unreal.RetargetSourceOrTarget
EAL = unreal.EditorAssetLibrary

# Manny-template chain -> (start stem, end stem); alternates for skeletons with fewer spine/neck bones.
TEMPLATE_ALTS = {"spine_05": ["spine_04", "spine_03"], "neck_02": ["neck_01"], "spine_01": ["spine"]}


def _tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


def _load(path, cls=None):
    a = unreal.load_asset(path) if EAL.does_asset_exist(path) else None
    if a is None:
        raise ValueError("Asset not found: " + path)
    if cls is not None and not isinstance(a, cls):
        raise ValueError("%s is %s, not %s" % (path, type(a).__name__, cls.__name__))
    return a


def _create(path, cls, factory):
    if EAL.does_asset_exist(path):
        a = unreal.load_asset(path)
        if not isinstance(a, cls):
            raise ValueError("%s exists and is %s, not %s" % (path, type(a).__name__, cls.__name__))
        return a, False
    pkg, name = path.rsplit("/", 1)
    a = _tools().create_asset(name, pkg, cls, factory)
    if a is None:
        raise RuntimeError("create_asset failed for " + path)
    return a, True


def bone_names(mesh):
    return [str(n) for n in mesh.get_editor_property("skeleton").get_reference_pose().get_bone_names()]


def stem(name, prefix=None):
    n = name.lower().replace(":", "_")
    if prefix:
        n = re.sub("^" + re.escape(prefix.lower()), "", n)
    n = re.sub(r"^(mixamorig\d*_|[a-z]+\d+_)", "", n)   # mixamorig_, girl02_, char01_ ...
    return re.sub(r"_\d+$", "", n)                       # one trailing export index (_048); keeps spine_01


def root_scale(mesh):
    """Smallest uniform scale on any ancestor of the pelvis in the reference pose (1.0 = clean skeleton)."""
    rp = mesh.get_editor_property("skeleton").get_reference_pose()
    names = bone_names(mesh)
    worst = 1.0
    for n in names[:4]:   # root chain above the pelvis lives in the first few bones
        s = rp.get_ref_bone_pose(n, unreal.AnimPoseSpaces.LOCAL).scale3d
        m = max(abs(s.x), abs(s.y), abs(s.z))
        if abs(m - 1.0) > 1e-3:
            worst = m if abs(math.log(m)) > abs(math.log(worst)) else worst
    return worst


def chains_of(ctrl):
    return [{"chain": str(c.chain_name), "start": str(ctrl.get_retarget_chain_start_bone(c.chain_name)),
             "end": str(ctrl.get_retarget_chain_end_bone(c.chain_name)), "goal": str(c.ik_goal_name)}
            for c in ctrl.get_retarget_chains()]


def create_ik_rig(mesh_path, rig_path, template_rig=None, prefix=None, fbik=True):
    mesh = _load(mesh_path, unreal.SkeletalMesh)
    rig, created = _create(rig_path, unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
    c = RC.get_controller(rig)
    c.set_skeletal_mesh(mesh)
    method = "existing"
    if not c.get_retarget_chains():
        if c.apply_auto_generated_retarget_definition():
            method = "auto"
        else:
            if not template_rig:
                if created:   # do not leave an empty IK Rig behind on failure
                    EAL.delete_asset(rig_path)
                raise RuntimeError("Auto retarget definition failed (skeleton matches no Epic template) and no "
                                   "template_rig was given to map chains by bone name.")
            method = "name-map"
            _map_by_name(c, mesh, RC.get_controller(_load(template_rig, unreal.IKRigDefinition)), prefix)
        if fbik and method == "auto":
            c.apply_auto_fbik()
    EAL.save_asset(rig_path)
    out = {"ok": True, "rig": rig_path, "created": created, "method": method, "retarget_root": str(c.get_retarget_root()),
           "chains": chains_of(c), "goals": [str(g.goal_name) for g in c.get_all_goals()], "solvers": c.get_num_solvers(),
           "root_scale": round(root_scale(mesh), 6)}
    if method == "name-map":
        out["unmapped"] = _LAST_UNMAPPED[:]
    return out


_LAST_UNMAPPED = []


def _map_by_name(c, mesh, tc, prefix):
    del _LAST_UNMAPPED[:]
    by = {}
    for b in bone_names(mesh):
        by.setdefault(stem(b, prefix), b)
    tpl_root = str(tc.get_retarget_root())
    root = by.get(stem(tpl_root)) or by.get("pelvis") or by.get("hips")
    if not root:
        raise RuntimeError("No pelvis/hips bone found by name")
    c.set_retarget_root(root)
    for ch in tc.get_retarget_chains():
        s = str(tc.get_retarget_chain_start_bone(ch.chain_name)).lower()
        e = str(tc.get_retarget_chain_end_bone(ch.chain_name)).lower()

        def find(x):
            for k in [x] + TEMPLATE_ALTS.get(x, []):
                if k in by:
                    return by[k]
            return None
        sb, eb = find(s), find(e)
        if sb and eb:
            c.add_retarget_chain(ch.chain_name, sb, eb, "None")
        else:
            _LAST_UNMAPPED.append(str(ch.chain_name))


# CLAUDE-NOTE (2026-10-21, live 5.6.1): IK Rigs auto-generated for Epic skeletons get foot/hand goals + an FBIK
# solver; name-mapped custom skeletons get chains only, so the retargeter's "Retarget IK Goals" / "Run IK Rig" ops
# do nothing and legs retarget FK-only. Copying the template's goals + FBIK onto the Fab girl (root scale 0.0093)
# made it WORSE in every variant tried (spine bent 18-26 deg, legs swung 11-27 deg), so the tools report the IK
# state instead of silently adding goals.
def ik_status(retargeter):
    c = RTC.get_controller(_load(retargeter, unreal.IKRetargeter))
    k = RC.get_controller(c.get_ik_rig(S.TARGET))
    ops = {str(c.get_op_name(i)): bool(c.get_retarget_op_enabled(i)) for i in range(c.get_num_retarget_ops())}
    goals = [str(g.goal_name) for g in k.get_all_goals()]
    ik_chains = [x["chain"] for x in chains_of(k) if x["goal"] not in ("None", "")]
    on = lambda name: any(v for n, v in ops.items() if n.replace(" ", "").lower() == name)
    active = bool(goals) and bool(ik_chains) and k.get_num_solvers() > 0 and on("retargetikgoals") and on("runikrig")
    return {"ok": True, "ik_active": active, "goals": goals, "ik_chains": ik_chains, "solvers": k.get_num_solvers(), "ops": ops}


def create_retargeter(path, source_rig, target_rig, source_mesh=None, target_mesh=None):
    rtg, created = _create(path, unreal.IKRetargeter, unreal.IKRetargetFactory())
    c = RTC.get_controller(rtg)
    c.set_ik_rig(S.SOURCE, _load(source_rig, unreal.IKRigDefinition))
    c.set_ik_rig(S.TARGET, _load(target_rig, unreal.IKRigDefinition))
    if source_mesh:
        c.set_preview_mesh(S.SOURCE, _load(source_mesh, unreal.SkeletalMesh))
    if target_mesh:
        c.set_preview_mesh(S.TARGET, _load(target_mesh, unreal.SkeletalMesh))
    if c.get_num_retarget_ops() == 0:
        c.add_default_ops()
    c.auto_map_chains(unreal.AutoMapChainType.EXACT, True)
    comp = None
    if target_mesh:
        rs = root_scale(_load(target_mesh, unreal.SkeletalMesh))
        if abs(rs - 1.0) > 1e-3:
            comp = _compensate_root_scale(c, rs)
    tgt = RC.get_controller(_load(target_rig, unreal.IKRigDefinition))
    mapping = {str(ch.chain_name): str(c.get_source_chain(ch.chain_name)) for ch in tgt.get_retarget_chains()}
    EAL.save_asset(path)
    return {"ok": True, "retargeter": path, "created": created,
            "ops": [str(c.get_op_name(i)) for i in range(c.get_num_retarget_ops())],
            "chain_map": mapping, "unmapped_target_chains": [k for k, v in mapping.items() if v in ("None", "")],
            "root_scale_compensation": comp}


def _compensate_root_scale(c, rs):
    for i in range(c.get_num_retarget_ops()):
        oc = c.get_op_controller(i)
        if type(oc).__name__ == "IKRetargetPelvisMotionController":
            st = oc.get_settings()
            k = 1.0 / rs
            st.set_editor_property("scale_vertical", k)
            st.set_editor_property("scale_horizontal", k)
            oc.set_settings(st)
            got = oc.get_settings().get_editor_property("scale_vertical")
            return {"root_scale": rs, "pelvis_scale": round(got, 4)}
    return {"root_scale": rs, "pelvis_scale": None, "warning": "no Pelvis Motion op to compensate"}


def retarget(anims, source_mesh, target_mesh, retargeter, out_folder, suffix="_RTG"):
    datas = []
    for p in anims:
        _load(p, unreal.AnimationAsset)
        datas.append(EAL.find_asset_data(p))
    out = unreal.IKRetargetBatchOperation.duplicate_and_retarget(
        datas, _load(source_mesh, unreal.SkeletalMesh), _load(target_mesh, unreal.SkeletalMesh),
        _load(retargeter, unreal.IKRetargeter), "", "", "", suffix, False)
    moved = []
    for d in out:
        src = str(d.package_name)
        dst = out_folder.rstrip("/") + "/" + src.rsplit("/", 1)[1]
        if src != dst:
            if EAL.does_asset_exist(dst):
                EAL.delete_asset(dst)
            if not EAL.rename_asset(src, dst):
                raise RuntimeError("could not move %s -> %s" % (src, dst))
        moved.append(dst)
    return {"ok": bool(moved), "outputs": moved, "error": None if moved else "duplicate_and_retarget returned nothing"}


# ------------------------------------------------------------------ verification (pure anim data, no viewport)

ROLES = {"pelvis": ["pelvis", "hips"], "head": ["head"], "upperarm_l": ["upperarm_l", "leftarm"],
         "upperarm_r": ["upperarm_r", "rightarm"], "hand_l": ["hand_l", "lefthand"], "hand_r": ["hand_r", "righthand"],
         "thigh_l": ["thigh_l", "leftupleg"], "thigh_r": ["thigh_r", "rightupleg"],
         "foot_l": ["foot_l", "leftfoot"], "foot_r": ["foot_r", "rightfoot"]}


def _role_map(names):
    st = {}
    for b in names:
        st.setdefault(stem(b), b)
    out = {}
    for role, cands in ROLES.items():
        for c in cands:
            if c in st:
                out[role] = st[c]
                break
    return out


def _pose(anim, t):
    return unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, float(t), unreal.AnimPoseEvaluationOptions())


def _pts(pose, roles, ref=False):
    P = unreal.AnimPoseExtensions
    get = P.get_ref_bone_pose if ref else P.get_bone_pose
    return {r: get(pose, b, unreal.AnimPoseSpaces.WORLD).translation for r, b in roles.items()}


def _yaw(pts):
    l, r = pts["upperarm_l"], pts["upperarm_r"]
    return math.atan2(l.x - r.x, -(l.y - r.y))


def _dir(a, b, yaw):
    v = b - a
    n = v.length() or 1.0
    c, s = math.cos(-yaw), math.sin(-yaw)
    return (v.x / n * c - v.y / n * s, v.x / n * s + v.y / n * c, v.z / n)


def _ang(u, v):
    return math.degrees(math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(u, v))))))


LIMBS = [("upperarm_l", "hand_l"), ("upperarm_r", "hand_r"), ("thigh_l", "foot_l"), ("thigh_r", "foot_r"),
         ("pelvis", "head")]


def compare(source_anim, target_anim, source_mesh, target_mesh, samples=5):
    """How faithfully target_anim reproduces source_anim. Per limb (root->tip direction, facing removed):
      ref_offset  = angle between the two skeletons' REFERENCE directions (A-pose vs T-pose arms etc.)
      motion_err  = |angle(ref, now) on source - angle(ref, now) on target| - how differently the limb moved
      abs_angle   = angle between the two directions now (includes ref_offset)
    Pelvis height is in RENDERED space relative to each mesh's reference pelvis height.
    CLAUDE-NOTE (2026-10-21, calibrated live): AnimPose WORLD space omits a scaled root bone, so a height ratio
    taken purely from AnimPose scored the known-BROKEN retarget (girl sunk to z=1 cm) as a perfect 0.0 and the
    good one as 126. Rendered height = AnimPose z * root scale, compared with the mesh reference pose (which
    includes the root scale)."""
    sa, ta = _load(source_anim, unreal.AnimSequence), _load(target_anim, unreal.AnimSequence)
    sm, tm = _load(source_mesh, unreal.SkeletalMesh), _load(target_mesh, unreal.SkeletalMesh)
    sr, tr = _role_map(bone_names(sm)), _role_map(bone_names(tm))
    need = sorted({x for l in LIMBS for x in l} | {"upperarm_l", "upperarm_r"})
    miss = [r for r in need if r not in sr or r not in tr]
    if miss:
        return {"ok": False, "error": "roles not found: " + ", ".join(miss)}
    length = min(sa.get_play_length(), ta.get_play_length())
    s0, t0 = _pose(sa, 0.0), _pose(ta, 0.0)
    sref, tref = _pts(s0, sr, ref=True), _pts(t0, tr, ref=True)
    syaw, tyaw = _yaw(sref), _yaw(tref)
    s_rs, t_rs = root_scale(sm), root_scale(tm)
    ref_z = lambda mesh, bone: mesh.get_editor_property("skeleton").get_reference_pose().get_ref_bone_pose(
        bone, unreal.AnimPoseSpaces.WORLD).translation.z
    s_mref, t_mref = ref_z(sm, sr["pelvis"]), ref_z(tm, tr["pelvis"])
    keys = [f"{a}->{b}" for a, b in LIMBS]
    ref_off = {k: round(_ang(_dir(sref[a], sref[b], syaw), _dir(tref[a], tref[b], tyaw)), 2)
               for k, (a, b) in zip(keys, LIMBS)}
    motion, absang, heights = {k: [] for k in keys}, {k: [] for k in keys}, []
    for i in range(int(samples)):
        t = length * (i + 0.5) / samples
        sp, tp = _pts(_pose(sa, t), sr), _pts(_pose(ta, t), tr)
        for k, (a, b) in zip(keys, LIMBS):
            ds, dt = _dir(sp[a], sp[b], syaw), _dir(tp[a], tp[b], tyaw)
            ms = _ang(_dir(sref[a], sref[b], syaw), ds)
            mt = _ang(_dir(tref[a], tref[b], tyaw), dt)
            motion[k].append(abs(ms - mt))
            absang[k].append(_ang(ds, dt))
        heights.append((sp["pelvis"].z * s_rs / s_mref, tp["pelvis"].z * t_rs / t_mref))
    avg = lambda d: {k: round(sum(v) / len(v), 2) for k, v in d.items()}
    m, a_ = avg(motion), avg(absang)
    return {"ok": True, "samples": int(samples), "ref_offset_deg": ref_off, "motion_err_deg": m,
            "mean_motion_err_deg": round(sum(m.values()) / len(m), 2), "abs_angle_deg": a_,
            "pelvis_height_rel": [[round(x, 3), round(y, 3)] for x, y in heights],
            "pelvis_height_max_diff": round(max(abs(x - y) for x, y in heights), 3)}


def foot_fidelity(source_anim, target_anim, source_mesh, target_mesh, fps=30):
    """Where the target's FEET land vs the source's feet scaled by the height ratio (what IK goals are for).
    Rendered space (AnimPose z * root scale, see compare). err = |(foot - pelvis) target - h * (foot - pelvis) source|;
    floor = lowest foot z of each clip (target vs h * source).
    CLAUDE-NOTE (2026-10-21): added for the IK-goals A/B (FK-only retarget vs IK Goals + FBIK)."""
    sa, ta = _load(source_anim, unreal.AnimSequence), _load(target_anim, unreal.AnimSequence)
    sm, tm = _load(source_mesh, unreal.SkeletalMesh), _load(target_mesh, unreal.SkeletalMesh)
    sr, tr = _role_map(bone_names(sm)), _role_map(bone_names(tm))
    # CLAUDE-NOTE (calibration): the IK goals sit on the BALL bones; measuring the foot (ankle) bone mixed in the two
    # skeletons' different foot lengths, so use the balls when both rigs have them.
    for side in ("l", "r"):
        for rm, names in ((sr, bone_names(sm)), (tr, bone_names(tm))):
            st = {stem(b): b for b in names}
            if "ball_" + side in st:
                rm["ball_" + side] = st["ball_" + side]
    feet = ["ball_l", "ball_r"] if all(k in sr and k in tr for k in ("ball_l", "ball_r")) else ["foot_l", "foot_r"]
    if any(r not in sr or r not in tr for r in feet + ["pelvis"]):
        return {"ok": False, "error": "foot/pelvis roles not found"}
    s_rs, t_rs = root_scale(sm), root_scale(tm)
    ref_z = lambda mesh, bone: mesh.get_editor_property("skeleton").get_reference_pose().get_ref_bone_pose(
        bone, unreal.AnimPoseSpaces.WORLD).translation.z
    h = ref_z(tm, tr["pelvis"]) / ref_z(sm, sr["pelvis"])
    length = min(sa.get_play_length(), ta.get_play_length())
    n = max(2, int(length * fps))
    errs, smin, tmin = [], 1e9, 1e9
    for i in range(n + 1):
        t = min(length, i / float(fps))
        sp = _pts(_pose(sa, t), {f: sr[f] for f in feet + ["pelvis"]})
        tp = _pts(_pose(ta, t), {f: tr[f] for f in feet + ["pelvis"]})
        for f in feet:
            a, b = sp[f] * (s_rs * h), tp[f] * t_rs
            # CLAUDE-NOTE (calibration, live): measured relative to the PELVIS - in world space the retargeted root
            # carried a ~7 cm offset (Root Motion op) that swamped the foot placement being measured.
            errs.append(((a - sp["pelvis"] * (s_rs * h)) - (b - tp["pelvis"] * t_rs)).length())
            smin, tmin = min(smin, a.z), min(tmin, b.z)
    errs.sort()
    return {"ok": True, "bones": feet, "frames": n + 1, "height_ratio": round(h, 4), "foot_err_mean": round(sum(errs) / len(errs), 2),
            "foot_err_p90": round(errs[int(0.9 * (len(errs) - 1))], 2), "foot_err_max": round(errs[-1], 2),
            "floor_source_scaled": round(smin, 2), "floor_target": round(tmin, 2)}


# ------------------------------------------------------------------ pose assets

def create_pose_asset(anim_path, path, pose_names=None):
    anim = _load(anim_path, unreal.AnimSequence)
    f = unreal.PoseAssetFactory()
    f.set_editor_property("source_animation", anim)
    if EAL.does_asset_exist(path):
        raise ValueError(path + " already exists")
    pkg, name = path.rsplit("/", 1)
    pa = _tools().create_asset(name, pkg, unreal.PoseAsset, f)
    if pa is None:
        raise RuntimeError("PoseAsset creation failed")
    names = [str(n) for n in pa.get_pose_names()]
    renamed = []
    if pose_names:
        for old, new in zip(names, pose_names):
            if new and new != old:
                pa.rename_pose(old, new)
                renamed.append([old, new])
        names = [str(n) for n in pa.get_pose_names()]
    EAL.save_asset(path)
    return {"ok": len(names) > 0, "pose_asset": path, "poses": names[:200], "count": len(names), "renamed": renamed}
