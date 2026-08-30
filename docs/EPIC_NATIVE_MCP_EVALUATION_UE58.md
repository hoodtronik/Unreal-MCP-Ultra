# Unreal MCP Ultra vs Epic native Unreal MCP (UE 5.8.1)

Status: evaluation branch document. Do not treat this as a reason to delete or replace UltraMCP.

## Executive finding

Epic's native Unreal MCP in UE 5.8 is much larger than expected, but its architecture and strengths are different from UltraMCP.

The earlier live source enumeration in `hoodtronik/Unreal-MCP-Ultra-5.8` measured approximately 890 underlying Epic tool calls in the installed UE 5.8.1 tree on 2026-07-30: about 596 Python `@toolset_registry.tool_call` functions and 294 C++ `UFUNCTION(meta=(AICallable))` functions.

Current Epic UE 5.8 documentation confirms the native MCP is experimental, runs an MCP server inside Unreal, uses `ToolsetRegistry`, supports reflected Python and C++ toolsets, and defaults to tool-search mode rather than advertising every underlying tool schema at once.

Public docs:
- https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor
- https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes

## Important clarification about the ~890 number

`~890` is an approximate count of underlying callable tool functions found in the shipped toolset plugins, not the number of schemas a normal client necessarily receives at connection time.

Epic's current UE 5.8 documentation says `Enable Tool Search` defaults to true. In that mode, `tools/list` returns three meta-tools:

- `list_toolsets`
- `describe_toolset`
- `call_tool`

The client discovers a relevant toolset and only then requests/executes the underlying tool. This solves the context-explosion problem that a flat 890-tool registration would create.

This architecture should be studied for UltraMCP discovery even if UltraMCP remains a separate server.

## Current UltraMCP position

Current `hoodtronik/Unreal-MCP-Ultra/main` targets UE 5.6.1 and advertises 242 stable tools in its README. It also has a built-in MCP Resource skill system (`skill://unreal/{name}`), structured Blueprint graph mutation, material-expression graph authoring, animation Blueprint state-machine authoring, graph snapshot/diff/restore, validation, transactions, headless/commandlet operation, runtime/PIE support, vision/capture workflows, and project-specific extensions.

The old 5.8 comparison used 252 UltraMCP tools at that historical snapshot. Current main and the old 5.8 fork have diverged, so future comparisons must use current-main capability semantics rather than the old raw count.

## Areas where Epic is materially ahead

Based on the live UE 5.8.1 enumeration recorded in the old 5.8 repo and current public docs, Epic has broad first-party toolset coverage in domains where UltraMCP currently has little or no dedicated surface:

1. Sequencer/cinematics
2. Control Rig
3. Gameplay Ability System
4. Behavior Tree / StateTree authoring and inspection
5. broader skeletal/static mesh and texture tooling
6. physics / Chaos Cloth
7. Gameplay Tags / GameFeatures / DataRegistry / config / plugin-level tooling
8. Slate/MVVM inspection
9. additional Blueprint details and graph operations

This is especially relevant to Ascent Ultimate because GAS, AI, Contextual Animation, animation tooling, and project-level systems are central to the framework.

## Areas where UltraMCP is materially ahead or differentiated

1. Graph snapshot / diff / restore and rebuild-impact analysis
2. Expression-level material graph mutation with its own safety/validation workflows
3. Animation Blueprint state-machine authoring
4. explicit transaction / undo / recovery workflows
5. headless/commandlet automation and CI-oriented operation
6. project-specific guided skills and workflow resources
7. current custom runtime/vision/capture workflows
8. a public, modifiable codebase under the repository's own license, rather than depending solely on experimental UE toolsets

Epic also has screenshots/capture tools, so visual access is overlapping rather than unique.

## Architectural difference that matters most

Epic derives schemas from reflected Python/C++ functions. UltraMCP generally hand-registers typed MCP tools and pairs them with custom C++ HTTP handlers, TypeScript wrappers, validation, tests, and safety behavior.

That makes UltraMCP slower to expand by raw tool count, but it also explains why a direct 'copy all Epic coverage' strategy is unattractive. Epic's toolsets are engine code under the Unreal license and some are NoRedist. UltraMCP should not copy their implementation into the public repo.

## Recommended product strategy

Do not try to beat Epic by cloning every native tool.

Use a layered strategy:

### A. Run both during UE 5.8 evaluation

Epic native MCP and UltraMCP use separate endpoints and can coexist. Measure which native toolsets the agents actually use in real Streets of Sheol / Ascent work.

### B. Investigate aggregation/proxying

UltraMCP can potentially connect to Epic's local MCP endpoint and selectively surface native toolsets under a namespace or discovery layer without redistributing Epic code. This requires an engineering/licensing review of the interaction surface, but is far preferable to copying engine implementation.

### C. Reimplement only proven high-value gaps

If a native Epic tool is unreliable, missing from 5.6, awkward for agent workflows, or needs UltraMCP's safety semantics, clean-room the small capability that real use proves valuable.

### D. Keep UltraMCP's strongest identity

UltraMCP should optimize for:

- safe mutation
- inspection before modification
- recoverability
- diff/validation evidence
- agent-friendly workflow skills
- cross-version operation where practical
- runtime proof
- project automation

rather than raw tool-count supremacy.

## Ascent Ultimate test implication

For UE 5.8 Ascent archaeology, test the agent with both servers available before adding ACF-specific UltraMCP tools.

Decision loop:

1. Can UltraMCP already do the operation safely?
2. If not, can Epic's native UE 5.8 MCP do it reliably?
3. If yes, use Epic and keep UltraMCP focused.
4. If no, identify the smallest missing UltraMCP capability.
5. Add a dedicated tool only after runtime proof shows the gap matters repeatedly.

Key Ascent domains to benchmark:

- GAS abilities/effects/attributes/cues
- Gameplay Tags
- Behavior Trees / StateTree
- animation montages and animation assets
- Control Rig
- IK Retargeting
- Chooser
- Motion Warping / Contextual Animation
- Sequencer/cutscenes
- Data Assets
- inventory/progression assets
- PIE/runtime state inspection

## Next measurement task

On a real UE 5.8.1 machine with Epic's relevant experimental toolset plugins enabled:

1. capture `list_toolsets`
2. capture `describe_toolset` for GAS, AI, animation, Sequencer, Control Rig, Blueprint, PCG and UMG
3. capture UltraMCP `list_skills` and stable tool registry
4. run matched tasks through each server
5. score success, number of calls, recovery from mistakes, runtime proof, and agent comprehension

The winner should be selected per workflow, not by total tool count.
