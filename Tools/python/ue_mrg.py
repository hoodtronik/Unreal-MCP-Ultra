# ue_mrg.py - Movie Render Graph: a graph config asset with globals (resolution, output folder), a BEAUTY render layer
# and a CLEAN-PLATE render layer (collection = actors the sequence spawns, modifier = hidden), rendered through Movie
# Render Queue. Behind shot_render_graph (Tools/src/tools/render-graph.ts). Exec'd after ue_posing.py.
#
# CLAUDE-NOTE (2026-10-22, live 5.6.1): the ActorType / ActorName query fields are not exposed to Python, but
# MovieGraphConditionGroupQuery_IsSpawnable needs no parameters - "everything the sequence spawns" is the collection.
import os

import unreal


def _edge(g, a, ap, b, bp):
    """Connect; an unnamed pin is "" on some nodes and "None" on others (live: Inputs.Globals -> GlobalOutputSetting
    connected only as "None", a setting node's output only as ""), so both spellings are tried."""
    alts = lambda x: [x] if x not in ("", "None") else ["None", ""]
    for x in alts(ap):
        for y in alts(bp):
            if g.add_labeled_edge(a, x, b, y):
                return
    raise RuntimeError("could not connect %s.%s -> %s.%s" % (type(a).__name__, ap, type(b).__name__, bp))


def _layer_chain(g, inp, outp, branch, layer_name, hide_spawnables=False):
    nodes = []
    if hide_spawnables:
        cn = g.create_node_by_class(unreal.MovieGraphCollectionNode)
        coll = cn.get_editor_property("collection")
        coll.set_collection_name("Spawnables")
        grp = coll.add_condition_group()
        grp.add_query(unreal.MovieGraphConditionGroupQuery_IsSpawnable)
        # CLAUDE-NOTE (2026-10-22, live): build 21's plate also removed the sequence-owned table. Bindings to KEEP carry
        # the actor tag MCPKeep (keep_in_plate) and are subtracted here; tags_to_match exists though dir() hides it.
        qk = grp.add_query(unreal.MovieGraphConditionGroupQuery_ActorTagName)
        qk.set_editor_property("tags_to_match", KEEP_TAG)
        qk.set_operation_type(unreal.MovieGraphConditionGroupQueryOpType.SUBTRACT)
        mn = g.create_node_by_class(unreal.MovieGraphModifierNode)
        # a new modifier node already holds a RenderPropertyModifier (add_modifier then returns None - live)
        mod = mn.add_modifier(unreal.MovieGraphRenderPropertyModifier) or mn.get_modifier(unreal.MovieGraphRenderPropertyModifier)
        mod.set_editor_property("override_b_is_hidden", True)
        mod.set_hidden(True)
        mn.add_collection("Spawnables")
        nodes += [cn, mn]
    rl = g.create_node_by_class(unreal.MovieGraphRenderLayerNode)
    rl.set_editor_property("layer_name", layer_name)
    dp = g.create_node_by_class(unreal.MovieGraphDeferredRenderPassNode)
    png = g.create_node_by_class(unreal.MovieGraphImageSequenceOutputNode_PNG)
    nodes += [rl, dp, png]
    _edge(g, inp, branch, nodes[0], "None")
    for a, b in zip(nodes, nodes[1:]):
        _edge(g, a, "", b, "None")
    _edge(g, nodes[-1], "None", outp, branch)
    return [type(n).__name__ for n in nodes]


KEEP_TAG = "MCPKeep"


def keep_in_plate(seq_path, names):
    """Tag bindings (template + live actor) so the clean plate keeps them; untag every other binding."""
    seq = load_sequence(seq_path, open_it=True)
    out = []
    for b in seq.get_bindings():
        n = str(b.get_display_name())
        objs = [o for o in (b.get_object_template(), bound_actor(seq, b)) if isinstance(o, unreal.Actor)]
        for o in objs:
            tags = [t for t in o.get_editor_property("tags") if str(t) != KEEP_TAG]
            if n in names:
                tags.append(KEEP_TAG)
            o.set_editor_property("tags", tags)
        if n in names:
            out.append(n)
    missing = [n for n in names if n not in out]
    if missing:
        raise ValueError("no binding(s) %s" % ", ".join(missing))
    return {"ok": True, "kept": out}


def default_out(seq_name):
    return os.path.abspath(unreal.Paths.project_saved_dir() + "MovieRenders/" + seq_name + "_graph").replace("\\", "/")


def mrg_build(path, width=960, height=540, out_dir=None, clean_plate=True):
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        unreal.EditorAssetLibrary.delete_asset(path)
    folder, name = path.rsplit("/", 1)
    g = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.MovieGraphConfig, unreal.MovieGraphConfigFactory())
    inp, outp = g.get_input_node(), g.get_output_node()
    gl = g.create_node_by_class(unreal.MovieGraphGlobalOutputSettingNode)
    gl.set_editor_property("override_output_resolution", True)
    # the resolution struct's ProfileName ("1080p (FHD)") wins over Resolution - live render came out 1920x1080
    res = gl.get_editor_property("output_resolution")
    res.import_text('(ProfileName="Custom",Resolution=(X=%d,Y=%d))' % (int(width), int(height)))
    gl.set_editor_property("output_resolution", res)
    if out_dir:
        gl.set_editor_property("override_output_directory", True)
        gl.set_editor_property("output_directory", unreal.DirectoryPath(out_dir))
    _edge(g, inp, "Globals", gl, "None")
    _edge(g, gl, "None", outp, "Globals")
    chains = {"beauty": _layer_chain(g, inp, outp, "DefaultLayer", "beauty")}
    if clean_plate:
        g.add_input("CleanPlate")
        g.add_output("CleanPlate")
        chains["cleanplate"] = _layer_chain(g, inp, outp, "CleanPlate", "cleanplate", hide_spawnables=True)
    unreal.EditorAssetLibrary.save_loaded_asset(g, False)
    return {"ok": True, "path": path, "branches": [str(x.get_member_name()) for x in g.get_outputs()], "chains": chains}


def mrg_render_start(seq_path, graph_path, out_dir=None):
    seq = load_sequence(seq_path, open_it=False)
    subsys = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    if subsys.is_rendering():
        raise RuntimeError("a Movie Render Queue render is already running")
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    mp = world.get_path_name().split(".")[0]
    od = out_dir or default_out(seq.get_name())
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        os.remove(os.path.join(od, f))
    q = subsys.get_queue()
    for j in list(q.get_jobs()):
        q.delete_job(j)
    job = q.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.sequence = unreal.SoftObjectPath(seq.get_path_name())
    job.map = unreal.SoftObjectPath(mp + "." + mp.rsplit("/", 1)[1])
    job.job_name = "mcp_graph_" + seq.get_name()
    job.set_graph_preset(unreal.load_asset(graph_path))
    subsys.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)
    return {"ok": True, "out_dir": od, "graph": graph_path}
