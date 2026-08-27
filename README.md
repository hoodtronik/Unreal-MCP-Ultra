# UE5 MCP — Give AI agents full access to your UE5 assets

Vibe code your Blueprints, materials, and Anim Blueprints. This plugin lets Claude Code (or any MCP client) read, modify, and create Unreal Engine 5 Blueprints — just describe what you want in plain English.

> "Add a health component to my player character" · "Find everywhere I use GetActorLocation and replace it" · "What does my damage system do?"

https://github.com/user-attachments/assets/11b86d62-982b-42b3-bddb-aeeddc3e675c

## Requirements

Unreal Engine **5.6.1** (Win64) and Node 18+. That is the only engine version this plugin is built
and tested against — the `.uplugin` deliberately declares no `EngineVersion`, so other 5.x versions
will load, but expect to fix API drift yourself.

## Getting Started

Tell Claude Code:

```
Set up https://github.com/hoodtronik/Unreal-MCP-Ultra in my project
```

## Prebuilt binaries (no C++ toolchain needed)

Using a **Blueprint-only** project, or don't want to compile? A precompiled, drop-in
build is available here:

**➡️ [hoodtronik/BlueprintMCP-prebuilt](https://github.com/hoodtronik/BlueprintMCP-prebuilt)** — UE 5.6, Win64

Copy that plugin into your project's `Plugins/` folder and the editor loads it directly,
no build step required. (Prebuilt binaries are engine-version-specific — for other engine
versions, build from source in this repo.)

## How It Works

A UE5 editor plugin exposes your project's Blueprints over a local HTTP server. An [MCP](https://modelcontextprotocol.io) wrapper connects that to AI tools like Claude Code. When the editor is open, it runs inside the editor process with zero overhead. When the editor is closed, it can spawn a headless process instead.

## Editor console commands

Driven via the `exec_command` tool, or typed into the editor console.

- `BlueprintMCP.Restart` — stop the HTTP server (if running) and attempt a fresh bind on port 9847.
  Recovers an editor session where the port was taken at startup (typically by a second UE project)
  without restarting the editor.

The Voxel Sandbox → StaticMesh baker adds:

- `Voxel.BakeChunks [all|single] [cellSize] [outFolderNameOrPath]` — during PIE, bakes runtime voxel
  chunks (ProceduralMeshComponents) into saved `UStaticMesh` assets (preserving vertex colors +
  per-section materials). Optional output folder lets variants coexist.
- `Voxel.AssembleLevel [/Game/Path/LevelName]` — after stopping PIE, assembles the baked meshes into a
  fresh level and saves the `.umap`.

## Tools

The MCP server exposes **242 tools**, grouped by area below. Every mutation tool supports a
`dryRun` parameter where applicable and returns human-readable summaries with `nextSteps` hints.

**Scripting / Python**
- `run_python` — execute Unreal Editor Python and return captured output. Full reflected editor API
  (`EditorAssetLibrary`, `EditorActorSubsystem`, the PCG framework, etc.). The escape hatch for
  anything without a dedicated tool.
- `discover_python_class` · `discover_python_search` — introspect the reflected Python API: dump a
  class's methods/properties, or search across the API surface for a name.

**Discovery / meta**
- `list_skills` — list the built-in guided workflows (blueprints, materials, anim, niagara, pcg,
  groom, mirror-tables, levels, sky) the server ships as MCP resources.
- `list_examples` — list runnable end-to-end example recipes (e.g. create a blueprint component,
  spawn a static mesh, build a PCG scatter graph).
- Opt-in catalog mode (`MCP_DISCOVERY_MODE=true`) adds `list_tool_categories` · `describe_category`
  · `search_tools` for browsing the tool set instead of registering them all up front.

**Blueprints — read**
- `list_blueprints` · `get_blueprint` · `get_blueprint_summary` · `get_blueprint_graph` · `describe_graph`
  · `search_blueprints` · `search_by_type` · `find_asset_references`

**Blueprints — graph mutation**
- `create_blueprint` · `reparent_blueprint` · `create_graph` · `delete_graph` · `rename_graph`
- `add_node` · `delete_node` · `move_node` · `duplicate_nodes` · `connect_pins` · `disconnect_pin`
  · `set_pin_default` · `refresh_all_nodes` · `replace_function_calls` · `change_struct_node_type`
  · `get_node_comment` · `set_node_comment`
- `build_graph` — construct or extend an entire event graph (nodes + wiring) in one batched call.
- `screenshot_graph` — render a Blueprint graph to a PNG image for visual inspection.

**Blueprints — members**
- `add_variable` · `remove_variable` · `change_variable_type` · `set_variable_metadata` · `set_blueprint_default`
- `add_function_parameter` · `remove_function_parameter` · `change_function_parameter_type`
- `add_interface` · `remove_interface` · `list_interfaces`
- `add_event_dispatcher` · `list_event_dispatchers`
- `add_component` · `remove_component` · `list_components`
- `rename_asset` · `delete_asset`

**Discovery / reflection**
- `list_classes` · `list_functions` · `list_properties` · `get_pin_info` · `check_pin_compatibility`

**Structs / enums / data assets**
- `create_struct` · `add_struct_property` · `remove_struct_property` · `create_enum`
- `create_data_asset` · `create_data_table` · `create_curve_table`
- Mirror tables: `list_mirror_table_rows` · `set_mirror_table_rows` · `remove_mirror_table_rows`

**Validation / graph snapshots**
- `validate_blueprint` · `validate_all_blueprints` · `diff_blueprints`
- `snapshot_graph` · `diff_graph` · `restore_graph` · `find_disconnected_pins` · `analyze_rebuild_impact`

**Materials**
- `list_materials` · `get_material` · `get_material_graph` · `describe_material` · `search_materials`
  · `find_material_references` · `list_material_functions` · `get_material_function`
- `create_material` · `set_material_property` · `add_material_expression` · `delete_material_expression`
  · `move_material_expression` · `connect_material_pins` · `disconnect_material_pin` · `set_expression_value`
  · `set_material_scalar_default` · `create_material_function` · `validate_material`
  · `snapshot_material_graph` · `diff_material_graph` · `restore_material_graph`
- `create_material_instance` · `set_material_instance_parameter` · `get_material_instance_parameters`
  · `reparent_material_instance`

> **Substrate works with no special handling.** `add_material_expression` resolves the class by
> dynamic `UClass` lookup, and the Substrate expressions live in the Engine module, so
> `SubstrateSlabBSDF`, `SubstrateHorizontalMixing`, `SubstrateAdd` and the rest all resolve.
> The material root exposes a `Front Material` pin to connect a slab's output to — present even
> when `r.Substrate=0`. **Verified end to end with `r.Substrate=1`**: authoring a slab, wiring a
> colour into its `Diffuse Albedo` and the slab into `Front Material` produces a material that
> `validate_material` reports as valid with zero errors, and `describe_material` traces the chain
> back through the slab. Note the root keeps its legacy `Base Color`/`Metallic`/etc. pins listed
> under Substrate; they are simply unused.
>
> `get_material_graph` reports each node's real `expressionClass`
> (`MaterialExpressionSubstrateSlabBSDF`) plus a short `expressionType` (`SubstrateSlabBSDF`) that
> feeds straight back into `add_material_expression`. Two traps worth knowing: adding an expression
> **regenerates the graph GUIDs of earlier nodes**, so re-read the graph after your last add before
> calling `connect_material_pins`; and the read route is `/api/material-graph`, not
> `/api/get-material-graph`.

**Animation Blueprints**
- `create_anim_blueprint` · `add_anim_state` · `remove_anim_state` · `add_anim_transition`
  · `set_transition_rule` · `add_anim_node` · `add_state_machine` · `set_state_animation`
  · `create_blend_space` · `set_blend_space_samples` · `set_state_blend_space` · `list_anim_slots`
  · `list_sync_groups`

**Skeletons**
- `get_skeleton` · `add_skeleton_socket` · `remove_skeleton_socket` · `copy_skeleton_sockets`

**Niagara**
- `create_niagara_system` · `create_niagara_emitter` · `add_emitter_to_system` · `remove_emitter_from_system`
  · `list_niagara_systems` · `get_niagara_system_summary` · `get_niagara_emitter_summary`
  · `list_emitter_modules` · `list_module_inputs` · `list_module_library` · `set_emitter_sim_target`
  · `add_niagara_renderer` · `remove_niagara_renderer` · `set_renderer_property` · `add_niagara_module`
  · `set_module_input` · `set_system_module_input` · `add_user_parameter` · `remove_user_parameter`
  · `set_user_parameter_default`

**PCG (Procedural Content Generation)**
- `create_pcg_graph` · `get_pcg_graph` · `list_pcg_graphs` · `list_pcg_nodes` · `add_pcg_node`
  · `connect_pcg_nodes` · `delete_pcg_node` · `set_pcg_node_property` · `execute_pcg_graph`
- User parameters: `pcg_add_user_param` · `pcg_set_user_param` · `pcg_list_user_params`
  · `pcg_remove_user_param` · `pcg_bind_override`

**Widgets (UMG)**
- `create_widget_blueprint` · `list_widget_tree` · `get_widget_properties` · `add_widget` · `remove_widget`
  · `set_widget_property` · `move_widget` · `bind_widget_event`

**Groom**
- `list_groom_bindings` · `duplicate_groom_binding` · `rebuild_groom_bindings` · `set_groom_binding_target_mesh`

**Levels / actors**
- `get_current_level` · `get_level_info` · `list_actors` · `get_selected_actors` · `get_actor_properties`
  · `spawn_actor` · `delete_actor` · `duplicate_actor` · `rename_actor` · `attach_actor` · `detach_actor`
  · `set_actor_transform` · `set_actor_property` · `set_actor_mobility` · `set_actor_visibility`
  · `set_actor_physics` · `set_actor_tags`
- `find_actors_by_class` · `find_actors_by_tag` · `find_actors_in_radius` · `get_actor_bounds`
  · `focus_actor` · `raycast`
- Sublevels: `list_sublevels` · `load_sublevel` · `unload_sublevel`
- Selection: `get_editor_selection` · `set_editor_selection` · `clear_selection`

**Editor / viewport**
- `server_status` · `rescan_assets` · `exec_command` · `shutdown_server` · `editor_notification`
  · `refresh_agent_config`
- `save_all` · `get_dirty_packages` · `undo` · `redo` · `begin_transaction` · `end_transaction`
  · `reset_transaction_buffer`
- `get_task_status` — long operations (e.g. `save_all`) can be started in the background with
  `async`; this polls one by task id and returns its result once done, and keeps answering while
  the editor's main thread is still busy with the task itself.
- Levels: `open_level` · `new_level` — switch to or create a level. Both refuse to run while
  packages are unsaved, because the underlying load runs under `GIsRunningUnattendedScript` and
  would discard them silently; pass `saveFirst` or `discardUnsaved` to say which you want.
- `navigate_content_browser` · `open_asset_editor`
- Camera: `get_viewport_camera` · `set_viewport_camera`
- View: `set_view_mode` · `set_show_flags` · `set_viewport_type` · `set_realtime_rendering` · `set_game_view`
- Screenshots: `take_screenshot` · `take_high_res_screenshot` (both write a PNG to `Saved/Screenshots`)
  · `capture_view` — render from a camera *you* choose (ad-hoc location + lookAt, or an existing
  `CameraActor` by label) with no dependence on any viewport or window, so it can see PIE gameplay
  from any vantage point
- Vision: `viewport_capture` · `vision_mode` · `scene_digest`
- Lighting: `list_lights` · `spawn_light` · `set_light_property` · `spawn_sky` · `validate_lighting`
- Rendering: `get_renderer_state` · `set_renderer_mode` · `configure_post_process`
- Output log: `get_output_log` · `clear_output_log`
- CVars: `get_cvar` · `set_cvar` · `list_cvars`
- Profiling: `get_frame_timing`

**Vision — seeing the editor without a file round-trip**
- `viewport_capture` — returns the image **inline in the tool result** as base64 PNG, not a file
  path, so looking costs zero extra tool calls. `target='level'` for the editor viewport,
  `'pie'` for a running PIE session, `'graph'` for a Blueprint node graph (far easier to verify
  wiring from than raw node/pin JSON). Capture is synchronous — `FViewport::ReadPixels` for
  viewports, `FWidgetRenderer` for graphs — so there is no deferred-file polling.
  Pass **`settle: true`** after anything involving sky, atmosphere, volumetric clouds, Lumen or a
  sky-light recapture: those converge over *seconds*, and because the request handler owns the game
  thread, a tight capture loop starves the editor of the very ticks it needs — so an immediate
  capture returns the pre-change frame and looks convincingly like a broken capture.
- `vision_mode` — always-on visual feedback. While enabled, every state-changing tool call gets a
  fresh frame appended automatically; read-only tools are skipped and visually-unchanged frames are
  suppressed. Suppression compares downsampled luma with a tolerance rather than hashing pixels
  exactly — TAA jitter and temporal accumulation mean two captures of a static scene are *never*
  bit-identical, so an exact hash would never once match. The capture target is inferred from each tool's own arguments, so
  graph edits show the graph and level edits show the level. Level frames default to 384px
  (~150 tokens); graph attachment is opt-in via `targets: ["level","graph"]` because a legible
  graph frame needs ~1024px and cannot be digest-suppressed.
- `scene_digest` — cheap change-detection fingerprint (level name, actor count, selection,
  unsaved packages, PIE state; or node/pin structure for a graph). Deliberately coarse. It does
  not hash actor transforms — compare `viewport_capture`'s `digest` field for that, which
  fingerprints the actual pixels.

> Requires a running editor. A headless commandlet is spawned with `-nullrhi` and has no render
> device at all, so all three capture targets report that explicitly rather than failing obscurely.
>
> Every viewport-touching tool — both captures, `get_viewport_camera`/`set_viewport_camera`,
> `set_view_mode`, `set_show_flags`, `set_realtime_rendering`, `set_game_view`, `set_viewport_type`
> and `take_high_res_screenshot` — resolves the viewport through one shared helper, so they always
> act on the same one. They previously each indexed `GetLevelViewportClients()[0]`, which is not
> reliably a realized, sized viewport: that could make a tool report success while acting on a
> viewport nobody was looking at, and on a different one from the capture, so `set_view_mode`
> appeared to do nothing.

**Lighting**
- `list_lights` — every light in the level with type, mobility, intensity, colour, temperature and
  type-specific settings. The entry point for assessing or fixing a lighting setup; `list_actors`
  only returns names and classes.
- `spawn_light` — create a directional / point / spot / rect / sky light and configure it in one
  call. Applies mobility first (a Static light rejects later writes) and recaptures sky lights.
- `set_light_property` — typed setters on an existing light by label, with per-type validation
  (`innerConeAngle` on a point light is an error, not a silent no-op).
- `spawn_sky` — a complete outdoor set (sun, sky light, SkyAtmosphere, height fog, volumetric
  clouds) with presets for daylight / sunset / overcast / night. Handles the two links people
  forget: flagging the directional light as the atmosphere sun, and enabling real-time sky-light
  capture.
- `validate_lighting` — flags the mistakes that produce a plausible-looking but wrong scene: an
  atmosphere with no sun assigned, a sky light needing recapture, zero-intensity lights, more than
  four overlapping stationary lights (which silently exhausts UE's shadow channels), and
  auto-exposure left unlocked so intensity edits appear to do nothing.
- `get_renderer_state` — GI method, reflection method, shadow-map method, and whether path tracing,
  Lumen hardware RT, MegaLights or auto-exposure are on. Reads live console variables, so it
  reflects what is actually in force rather than what the project `.ini` says.
- `set_renderer_mode` — switch between `lumen`, `pathtracer` and `baked` as a coherent set.
  "Use Lumen" is three settings, not one; a partial combination gives you Lumen GI with
  screen-space reflections and no indication anything is wrong. Reports any console variable
  missing from this build instead of silently doing nothing.
- `configure_post_process` — exposure, bloom and Lumen quality on a post-process volume.
  **Every field of `FPostProcessSettings` is inert unless its paired `bOverride_` flag is also
  set**, so writing one through `set_actor_property` stores the value and the renderer ignores it.
  This sets both and reports the override flags back. `lockExposure` pins auto-exposure so light
  intensity changes read directly instead of being re-normalised away.

> These write light properties directly rather than through the engine's `Set*` light functions,
> which are runtime APIs that silently no-op on Static lights — and, for attenuation radius and
> spot cone angles, on Stationary lights too, which is the default mobility for a newly placed
> light. Pairs well with `set_view_mode("LightingOnly")` and `viewport_capture`.

**Play In Editor (PIE)**
- `start_pie` · `stop_pie` · `pie_pause` · `is_pie_running`
- `pie_get_player_transform` · `pie_teleport_player` · `pie_query_actors`

## Credits

Forked from [mirno-ehf/ue5-mcp](https://github.com/mirno-ehf/ue5-mcp). This is an
independently maintained build with additional tools and fixes.

## License

[MIT](LICENSE)
