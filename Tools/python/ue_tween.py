# ue_tween.py - breakdown / in-between poses with the Control Rig Tween tool, behind pose_tween
# (Tools/src/tools/pose-tween.ts). Exec'd after ue_posing.py (load_sequence, find_binding, rig_proxy, control_type,
# get_control_value, evaluate, L, DR).
#
# CLAUDE-NOTE (2026-10-21, live 5.6.1): ControlRigSequencerLibrary.tween_control_rig(seq, rig, v) acts on the rig's
# SELECTED controls at the current Sequencer time and keys them at value = prev + (next - prev) * (v + 1) / 2 per
# channel (v=0.5 -> 75% of the way: hand z -17.014 -> 45.399 gave 29.796 exactly). Selecting a control also selects
# its proxy/animation channels (arm_r_stretch_switch, Softness_2, ...), which get tweened too. The user's selection is
# restored afterwards. Clip-baked poses step (constant keys), so without a breakdown the in-between frames hold the
# previous pose.
import unreal


def _keys_by_control(track):
    out = {}
    for sec in track.get_sections():
        for ch in sec.get_all_channels():
            name = str(ch.channel_name).split(".")[0]
            for k in (ch.get_keys() if hasattr(ch, "get_keys") else []):
                out.setdefault(name, set()).add(int(k.get_time(DR).frame_number.value))
    return out


def _num(v):
    out = []
    for k in ("location", "rotation", "scale"):
        if k in v:
            out += list(v[k])
    if "value" in v and not isinstance(v["value"], bool):
        out += list(v["value"]) if isinstance(v["value"], list) else [v["value"]]
    return out


def tween(seq_path, binding_name, frame, value, controls=None):
    value = float(value)
    if not -1.0 <= value <= 1.0:
        raise ValueError("value must be in [-1, 1] (-1 = previous key's pose, 1 = next key's pose)")
    frame = int(frame)
    seq = load_sequence(seq_path)
    rig, track = rig_proxy(seq, find_binding(seq, binding_name))
    keys = _keys_by_control(track)
    if controls:
        missing = [c for c in controls if control_type(rig, c) is None]
        if missing:
            raise ValueError("No control named: " + ", ".join(missing))
        names = list(controls)
    else:
        names = sorted(n for n in keys if control_type(rig, n) is not None)
    plan, skipped = {}, []
    for c in names:
        ks = keys.get(c, set())
        prev = [k for k in ks if k < frame]
        nxt = [k for k in ks if k > frame]
        if not prev or not nxt:
            skipped.append(c)
            continue
        p, n = max(prev), min(nxt)
        try:
            plan[c] = {"prev": p, "next": n, "pv": get_control_value(seq, rig, c, p), "nv": get_control_value(seq, rig, c, n)}
        except ValueError:
            skipped.append(c)   # unsupported control type (bool etc.)
    if not plan:
        raise ValueError("No control has keys on both sides of frame %d%s" % (
            frame, (" (checked: %s)" % ", ".join(names[:12])) if names else ""))
    old = [str(x) for x in rig.current_control_selection()]
    rig.clear_control_selection()
    for c in plan:
        rig.select_control(c, True)
    evaluate(seq, frame)
    try:
        ok = L.tween_control_rig(seq, rig, value)
    finally:
        rig.clear_control_selection()
        for c in old:
            rig.select_control(c, True)
    t = (value + 1.0) / 2.0
    res, worst, moved = {}, 0.0, 0
    for c, pl in plan.items():
        got = _num(get_control_value(seq, rig, c, frame))
        a, b = _num(pl["pv"]), _num(pl["nv"])
        exp = [x + (y - x) * t for x, y in zip(a, b)]
        err = max([abs(g - e) for g, e in zip(got, exp)] or [0.0])
        span = max([abs(y - x) for x, y in zip(a, b)] or [0.0])
        if span > 1e-3:
            moved += 1
        worst = max(worst, err)
        res[c] = {"prev": pl["prev"], "next": pl["next"], "err": round(err, 4), "span": round(span, 3)}
    # CLAUDE-NOTE (live): the tween keys only controls whose neighbour keys differ (an IK switch at 1 on both sides
    # got no key), so "keyed" counts the changing controls only.
    now = _keys_by_control(track)
    keyed = sum(1 for c in plan if res[c]["span"] > 1e-3 and frame in now.get(c, set()))
    evaluate(seq, frame)
    return {"ok": bool(ok), "t": t, "controls": res, "skipped": len(skipped), "skipped_names": skipped[:12],
            "keyed": keyed, "changing": moved, "worst": round(worst, 4)}
