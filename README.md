# UE5 MCP — Give AI agents full access to your UE5 assets

Vibe code your Blueprints, materials, and Anim Blueprints. This plugin lets Claude Code (or any MCP client) read, modify, and create Unreal Engine 5 Blueprints — just describe what you want in plain English.

> "Add a health component to my player character" · "Find everywhere I use GetActorLocation and replace it" · "What does my damage system do?"

https://github.com/user-attachments/assets/11b86d62-982b-42b3-bddb-aeeddc3e675c

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

Driven via the `exec_command` tool. The Voxel Sandbox → StaticMesh baker adds:

- `Voxel.BakeChunks [all|single] [cellSize] [outFolderNameOrPath]` — during PIE, bakes runtime voxel
  chunks (ProceduralMeshComponents) into saved `UStaticMesh` assets (preserving vertex colors +
  per-section materials). Optional output folder lets variants coexist.
- `Voxel.AssembleLevel [/Game/Path/LevelName]` — after stopping PIE, assembles the baked meshes into a
  fresh level and saves the `.umap`.

## Tools

The MCP server exposes **220+ tools**, grouped by area below. Every mutation tool supports a
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
- `navigate_content_browser` · `open_asset_editor`
- Camera: `get_viewport_camera` · `set_viewport_camera`
- View: `set_view_mode` · `set_show_flags` · `set_viewport_type` · `set_realtime_rendering` · `set_game_view`
- Screenshots: `take_screenshot` · `take_high_res_screenshot` (both write a PNG to `Saved/Screenshots`)
- Vision: `viewport_capture` · `vision_mode` · `scene_digest`
- Output log: `get_output_log` · `clear_output_log`
- CVars: `get_cvar` · `set_cvar` · `list_cvars`
- Profiling: `get_frame_timing`

**Vision — seeing the editor without a file round-trip**
- `viewport_capture` — returns the image **inline in the tool result** as base64 PNG, not a file
  path, so looking costs zero extra tool calls. `target='level'` for the editor viewport,
  `'pie'` for a running PIE session, `'graph'` for a Blueprint node graph (far easier to verify
  wiring from than raw node/pin JSON). Capture is synchronous — `FViewport::ReadPixels` for
  viewports, `FWidgetRenderer` for graphs — so there is no deferred-file polling.
- `vision_mode` — always-on visual feedback. While enabled, every state-changing tool call gets a
  fresh frame appended automatically; read-only tools are skipped and unchanged frames are
  suppressed by pixel digest. The capture target is inferred from each tool's own arguments, so
  graph edits show the graph and level edits show the level. Level frames default to 384px
  (~150 tokens); graph attachment is opt-in via `targets: ["level","graph"]` because a legible
  graph frame needs ~1024px and cannot be digest-suppressed.
- `scene_digest` — cheap change-detection fingerprint (level name, actor count, selection,
  unsaved packages, PIE state; or node/pin structure for a graph). Deliberately coarse. It does
  not hash actor transforms — compare `viewport_capture`'s `digest` field for that, which
  fingerprints the actual pixels.

> Requires a running editor. A headless commandlet is spawned with `-nullrhi` and has no render
> device at all, so all three capture targets report that explicitly rather than failing obscurely.

**Play In Editor (PIE)**
- `start_pie` · `stop_pie` · `pie_pause` · `is_pie_running`
- `pie_get_player_transform` · `pie_teleport_player` · `pie_query_actors`

## Credits

Forked from [mirno-ehf/ue5-mcp](https://github.com/mirno-ehf/ue5-mcp). This is an
independently maintained build with additional tools and fixes.

## License

[MIT](LICENSE)
