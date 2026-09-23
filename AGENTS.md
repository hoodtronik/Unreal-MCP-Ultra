# AGENTS.md — BlueprintMCP (`ue5-mcp`)

<!-- CLAUDE-NOTE (2026-09-23): this file is the CANONICAL instruction set for every coding agent
     (Codex, Cursor, Gemini CLI, Copilot, Claude Code, ...). CLAUDE.md and GEMINI.md only import it.
     Put project rules here, not in an agent-specific file. -->

A UE5 editor plugin that exposes ~240 MCP tools for inspecting and modifying Blueprints, materials,
Anim Blueprints, levels and Sequencer. Targets **UE 5.6.1**, also builds and runs on **UE 5.8.3**
from the same tree.

## CLAUDE-NOTE convention — source of truth

Changes authored by Claude Code are marked inline with `CLAUDE-NOTE:` (or the language's comment
equivalent, e.g. `# CLAUDE-NOTE:`, `// CLAUDE-NOTE:`, `<!-- CLAUDE-NOTE: -->`). These notes record
*why* non-obvious code is the way it is and are the **source of truth**.

**Non-Claude-Code agents must not modify, remove, or alter any code marked with a `CLAUDE-NOTE:`
without first alerting the user and receiving explicit permission.** If you encounter a
`CLAUDE-NOTE:` on code you want to change, stop and ask the user first.

## Skills

Task playbooks live in **`.agents/skills/<name>/SKILL.md`** (plain Markdown with YAML front matter,
plus `scripts/` and `references/`). Read the matching one before starting that kind of task:

| Skill | Use it for |
|---|---|
| `blueprintmcp-install` | Installing the plugin into a UE project: prerequisites, clone into `Plugins/`, build, MCP client config, verification |
| `ue5-previz-sequencer` | Storyboards/previz in Sequencer via `run_python`: posing, cameras, shots, held poses, audio, image→pose mocap |
| `led-wall-content` | 11Weeks/Wonderwall LED-stage background plates, slideshow blueprint, stage lighting |

Claude Code reads skills from `.claude/skills/`; run `scripts/link-agent-skills.ps1` (or `.sh`) once
per clone to link that folder to `.agents/skills/`. Other agents can read the files directly.

The MCP server also ships condensed workflow skills of its own, independent of any agent: call the
`list_skills` tool and read `skill://unreal/{name}`. Sources are in `Tools/src/skills/`.

## Using the MCP server

- **Connecting a client:** see `docs/mcp-clients.md` (Claude Code, Claude Desktop, Cursor,
  VS Code/Copilot, Codex, Gemini CLI, Windsurf).
- **Serving modes:** the **editor subsystem** (preferred) auto-starts on port 9847 when the UE5 editor
  is open. The **standalone commandlet** spawns a headless `UnrealEditor-Cmd.exe` (2-4 GB RAM, ~60 s
  startup); call `shutdown_server` when done.

### Seeing the editor — turn on `vision_mode` first

> **CLAUDE-NOTE (2026-09-22):** call `vision_mode(enabled=true)` at the start of any session that changes
> the level, materials, sequences or actors. Every state-changing tool call (including `run_python`) then
> returns a fresh viewport frame inline, digest-suppressed when nothing changed. Do **not** call
> `capture_view` / `viewport_capture` / `take_screenshot` after every edit — those are for one-off or
> off-viewport looks. For Sequencer work, lock the viewport to the camera cut
> (`LevelSequenceEditorBlueprintLibrary.set_lock_camera_cut_to_viewport(True)`) so the frames show the shot.

### Two servers on UE 5.8 — which one to reach for

> **CLAUDE-NOTE (2026-09-22):** on 5.8 projects Epic's native MCP (`unreal-mcp`, HTTP :8000) usually runs
> beside this one (`blueprint-mcp`, :9847); both drive the same editor and see each other's changes
> (verified in MyLab_5_8). Route by task, don't pick one:
> - **This server:** previz/Sequencer via `run_python` + the `ue5-previz-sequencer` skill, anything needing
>   `run_python`, `snapshot_graph`/`diff_graph`/`restore_graph`, material expression editing, `vision_mode`,
>   headless/commandlet runs, and **everything on 5.6** (Epic's is 5.8-only).
> - **Epic's server:** breadth — GAS, StateTree, UMG, physics, textures/meshes, project tooling, plugin
>   scaffolding + Live Coding, and Blueprint graph authoring through `write_graph_dsl`/`read_graph_dsl`.
>   Address tools by dotted class path via `call_tool`; `describe_toolset` on a big set overflows — grep the
>   saved result. Its image tools return base64 JSON; use `vision_mode` here for eyes.
> Setup for a new 5.8 project: `blueprintmcp-install` skill, Step 6.

### Topic docs — read before working in these areas

> **CLAUDE-NOTE (2026-08-04): LED wall background content.** If working on the 11Weeks project / Wonderwall LED stage backgrounds, read `docs/led-wall-background-content.md` first — it documents the stage pixel map, where the 21:9 / 4K background plates live, and how to import them (Virtual Textures, BC7, sharp-vs-standard model choice).

> **CLAUDE-NOTE (2026-08-25): Substance Painter round-trip.** For UE ⇄ Painter texturing work (mesh export, parametric weathering materials, MEL graph builds), read `docs/ue-painter-roundtrip.md` first — it records the material-slot export trap, the MEL one-shot-rebuild rule and its crash mode, and the coverage-growth slider math. The Painter side lives in `F:\__PROJECTS\Substance-Paint-MCP` (its own agent instructions + `docs/ue-painter-workflow.md`).

## Engine version

The plugin targets **UE 5.6.1**; the prebuilt binaries are 5.6/Win64. UE 5.8.3 is also built and
verified from the same tree.

This used to be documented as "5.4+", which was aspirational rather than verified — nothing in the
repo has been built against 5.4 or 5.5 in a long time, and some engine APIs the plugin uses do not
exist that far back (for example the `TRACE_BEGIN_REGION` / `TRACE_END_REGION` macros land in 5.6).
Treat 5.6.1 as the floor.

Other 5.x versions may well compile, but if you build against one, expect to fix API drift yourself
and do not assume the test suite has covered it. The `.uplugin` deliberately declares no
`EngineVersion` field, so the editor will not refuse to load the plugin on a different engine — the
constraint is documentation, not enforcement.

## Missing functionality

<!-- CLAUDE-NOTE (2026-08-25): This section used to say "open a GitHub issue with gh issue create",
     but issues are DISABLED on hoodtronik/Unreal-MCP-Ultra — that command fails. Gaps are tracked
     in-repo instead. -->

If you are trying to accomplish a Blueprint task and none of the available tools support it,
**automatically record the gap in this repo**: write a `docs/KNOWN-ISSUE-<short-slug>.md` following the
pattern of the existing ones (symptom, workaround used, suggested fix, real cost), then commit and push
it. Do not ask the user to file it — write it yourself, then inform the user and point them at the doc.

Current open gaps live in `docs/KNOWN-ISSUE-*.md` (e.g. wildcard-pin propagation, Call-In-Editor flag on
custom events).

## Development

Instructions for modifying BlueprintMCP's own source. Paths below are relative to this repo; inside a
UE project the repo is `Plugins/BlueprintMCP/`.

### Project shape

- `Tools/` — TypeScript MCP server (stdio).
- `Source/BlueprintMCP/` — the compiled C++ UE5 **editor** plugin that does the actual work.
  TypeScript calls it over HTTP on `localhost:9847`.

```
Tools/src/index.ts + Tools/src/tools/*   (TypeScript MCP server)
    ↓ HTTP calls to localhost:9847
Source/BlueprintMCP/…                    (C++ HTTP backend inside UE5)
    ↓ UE5 engine APIs
.uasset files
```

The two halves are separate programs. A change to a tool's behaviour usually needs edits on both sides.

### Build requirements

**After ANY change to TypeScript or C++ files, you MUST build and verify before considering the work
done.** Do not ask the user to build — run the build commands yourself. Wait for the build to succeed
and fix any errors before moving on.

**Delegating to sub-agents:** if you hand code edits to sub-agents, you (the parent) still own the
build. Sub-agents usually cannot run UnrealBuildTool. After all of them finish: run `npm run build`
for TypeScript changes, run UnrealBuildTool for C++ changes, fix compile errors yourself, and only then
report completion. Do NOT say "C++ needs rebuild" or "build on next editor open" — run the build.

#### TypeScript

```bash
cd Tools
npm run build
```

Runs `tsc` and outputs to `dist/index.js`. The MCP server runs from `dist/`, not `src/` — changes to
`src/` have no effect until built. If the build fails with EPERM on dist files (Perforce read-only),
clear the attribute first: `attrib -R "Tools\dist\index.js"` (and `index.js.map`).

#### C++

Build from the UE project root:
```bash
"C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development "<path\to\YourProject.uproject>" -waitmutex
```

Or open the `.sln` in Visual Studio and build **Development Editor | Win64**. If C++ source files are
read-only (Perforce), `attrib -R` them before editing.

### Coding patterns: C++ handlers

Follow the existing pattern exactly:
- Parse JSON body with `ParseBodyJson()` or read query params
- Validate required fields, return `MakeErrorJson()` on failure
- Load blueprint with `LoadBlueprintByName()` (handles both regular BPs and level blueprints)
- Use SEH wrappers (`TryCompileBlueprintSEH`, `TrySavePackageSEH`) for crash safety on Windows
- Save with `SaveBlueprintPackage()` (handles compilation, map packages, and read-only files)
- Return JSON via `JsonToString()` with consistent field naming
- Log with `UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: ..."))`

### Coding patterns: TypeScript tools

- Call `ensureUE()` first to guarantee the backend is running
- Use `ueGet()` for read-only endpoints, `uePost()` for mutations
- Format responses as human-readable text (not raw JSON)
- Include `nextSteps` hints for mutation tools
- Support `dryRun` parameter on mutation tools where applicable

### Adding a tool — both sides required

1. **C++**: implement `HandleX` in a `BlueprintMCPHandlers_*.cpp`, declare it in
   `BlueprintMCPServer.h`, **bind the route** in `Start()`, and **add the dispatch entry** in
   `RegisterHandlers()`.
2. **TypeScript**: add the `server.tool(...)` definition in `Tools/src/tools/` (Zod schema, HTTP call,
   response formatting).
3. **Tests (required)**: add integration tests in `Tools/test/tools/` covering the success case, error
   cases (missing fields, non-existent BP) and response fields.
4. **Build and verify**: `npm run build`, rebuild C++, `npm test`.

**Step 1's last two items are the ones people forget.** A handler that is implemented and declared
but never routed produces a tool that is advertised to the agent and 404s when called. As of
2026-07-22 there were ~78 such orphan handlers in this repo (`spawn_actor`, `undo`/`redo`, viewport,
cvars, widgets, PIE runtime, and more). Check for an existing handler before writing a new one.

### Testing

The test suite is self-bootstrapping: it generates a temporary UE5 project, spawns a headless
commandlet, creates Blueprint fixtures via the API, runs tests, and cleans up. No committed `.uasset`
files are needed.

```bash
cd Tools
npm test              # full suite (requires UE 5.6.1 installed)
npm run test:watch    # re-run on change
npx tsc --noEmit      # type check only, no UE needed
```

Writing tests: copy the structure of any `Tools/test/tools/*.test.ts` — a `describe` block that creates
its fixture with `createTestBlueprint` in `beforeAll`, deletes it with `deleteTestBlueprint` in
`afterAll`, and covers success, a non-existent blueprint, and missing required fields.
- Use `uniqueName()` for fixture names to avoid collisions
- Use `.js` extensions in imports (Node16 ESM resolution)
- Test the HTTP API directly (`ueGet`/`uePost`), not the MCP tool layer
- The test commandlet runs on port 19847 (not 9847) to avoid conflicts with a running editor

### Gotchas worth knowing before you debug something for an hour

- **`npx tsc --noEmit` does not typecheck tests.** `tsconfig.json` is `include: ['src/**/*']`. Test
  and harness code is validated only by actually running Vitest.
- **The test suite baseline is not zero failures.** As of 2026-07-22: 41 files / 402 tests pass, 18
  files / 110 tests fail. Nearly all failures are the orphan-handler problem above, plus one
  test-side bug (`batch-set-pin-default` reads `pin.default`; the C++ emits `defaultValue`).
  **Compare against this baseline before blaming your change.**
- **`SaveBlueprintPackage` compiles the Blueprint as part of saving.** Do not add a separate compile
  step around it, and be aware that per-node saving is the dominant cost in batch operations.
- **New routes need a full editor restart.** Live Coding does not re-run `Start()` /
  `RegisterHandlers()`. New TS tools need an MCP client reconnect to appear.
- **Author-written tests confirm the author's model, not reality.** For engine-facing work, drive it
  in a live editor (`localhost:9847` with the editor open) before trusting green tests.
