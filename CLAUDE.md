# BlueprintMCP — Claude Code Instructions

A UE5 editor plugin that exposes 241 MCP tools for inspecting and modifying Blueprint assets. Targets **UE 5.6.1** — this is the version the plugin is built and tested against.

> **CLAUDE-NOTE (2026-08-04): LED wall background content.** If working on the 11Weeks project / Wonderwall LED stage backgrounds, read `docs/led-wall-background-content.md` first — it documents the stage pixel map, where the 21:9 / 4K background plates live, and how to import them (Virtual Textures, BC7, sharp-vs-standard model choice).

Two serving modes:
- **Editor subsystem** (preferred): Auto-starts on port 9847 when the UE5 editor is open. Zero overhead.
- **Standalone commandlet**: Spawns a headless `UnrealEditor-Cmd.exe` process (2-4 GB RAM, ~60s startup). Call `shutdown_server` when done.

---

## Setup

<!-- CLAUDE-NOTE (2026-08-06): The step-by-step install guide (prerequisites, clone, npm build, .mcp.json, verify) was moved to .claude/skills/blueprintmcp-install/SKILL.md during a /doctor context cleanup — it now loads only when actually installing. -->

To install BlueprintMCP into a UE5 project for the first time, invoke the **`blueprintmcp-install`** skill (`.claude/skills/blueprintmcp-install/SKILL.md`). It covers prerequisites, cloning into `Plugins/`, building the TypeScript server, `.mcp.json` configuration (Node 18+, port 9847), and end-to-end verification.

### Engine version

The plugin targets **UE 5.6.1**. That is the only version it is built and tested against, and the
prebuilt binaries are 5.6/Win64.

This used to be documented as "5.4+", which was aspirational rather than verified — nothing in the
repo has been built against 5.4 or 5.5 in a long time, and some engine APIs the plugin uses do not
exist that far back (for example the `TRACE_BEGIN_REGION` / `TRACE_END_REGION` macros land in 5.6).
Treat 5.6.1 as the floor.

Other 5.x versions may well compile, but if you build against one, expect to fix API drift yourself
and do not assume the test suite has covered it. The `.uplugin` deliberately declares no
`EngineVersion` field, so the editor will not refuse to load the plugin on a different engine — the
constraint is documentation, not enforcement.

---

## Missing functionality

If you are trying to accomplish a Blueprint task and none of the available tools support it, **automatically open a GitHub issue** requesting the feature:

```bash
gh issue create --repo hoodtronik/Unreal-MCP-Ultra \
  --title "Feature request: <short description>" \
  --body "## What I was trying to do
<describe the user's goal>

## What's missing
<describe what tool or capability would be needed>

## Workaround attempted
<any partial approach you tried, or 'None'>

---
*Opened automatically by Claude Code*"
```

Do not ask the user to open the issue — open it yourself using `gh issue create` as shown above. Then inform the user that you've filed the request and share the issue URL.

---

## Development

Instructions for modifying BlueprintMCP's own source code (TypeScript or C++).

### Build requirements

**After ANY change to TypeScript or C++ files, you MUST build and verify before considering the work done.** Do not ask the user to build — run the build commands yourself. For C++ use UnrealBuildTool directly from the command line (see below). For TypeScript use `npm run build`. Wait for the build to succeed and fix any errors before moving on.

**CRITICAL — Sub-agent delegation:** When you use the Task tool to delegate code edits to sub-agents, YOU (the parent) are still responsible for building. Sub-agents cannot run UnrealBuildTool. After ALL sub-agents finish writing code, you MUST:
1. Run `npm run build` for TypeScript changes
2. Run UnrealBuildTool for C++ changes
3. Fix any compile errors yourself
4. Only THEN report completion to the user

Do NOT say "C++ needs rebuild" or "build on next editor open" — run the build command.

#### TypeScript

```bash
cd Plugins/BlueprintMCP/Tools
npm run build
```

Runs `tsc` and outputs to `dist/index.js`. The MCP server runs from `dist/`, not `src/` — changes to `src/index.ts` have no effect until built.

If the build fails with EPERM on dist files (Perforce read-only), clear the attribute first:
```bash
attrib -R "Plugins\BlueprintMCP\Tools\dist\index.js"
attrib -R "Plugins\BlueprintMCP\Tools\dist\index.js.map"
```

#### C++

Build from the project root:
```bash
"C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development "<path\to\YourProject.uproject>" -waitmutex
```

Or open the `.sln` in Visual Studio and build **Development Editor | Win64** (Ctrl+Shift+B).

If C++ source files are read-only (Perforce), clear the attribute before editing:
```bash
attrib -R "Plugins\BlueprintMCP\Source\BlueprintMCP\Private\BlueprintMCPServer.cpp"
attrib -R "Plugins\BlueprintMCP\Source\BlueprintMCP\Public\BlueprintMCPServer.h"
```

### Architecture

```
src/index.ts (TypeScript MCP server)
    ↓ HTTP calls to localhost:9847
BlueprintMCPServer.cpp (C++ HTTP backend inside UE5)
    ↓ UE5 engine APIs
.uasset files
```

- **TypeScript** (`src/index.ts`): MCP tool definitions, response formatting, UE5 process lifecycle. Changes here affect tool schemas, descriptions, and the workflow recipes resource.
- **C++** (`BlueprintMCPServer.cpp`): Blueprint manipulation via UE5 APIs. Changes here affect what operations are possible and what data is returned.

### Key files

| File | Purpose |
|------|---------|
| `Tools/src/index.ts` | MCP server: tool definitions, response formatting, process management |
| `Source/BlueprintMCP/Public/BlueprintMCPServer.h` | C++ handler declarations |
| `Source/BlueprintMCP/Private/BlueprintMCPServer.cpp` | C++ HTTP endpoint implementations (~3700 lines) |
| `Source/BlueprintMCP/BlueprintMCP.Build.cs` | UE5 module dependencies |
| `Source/BlueprintMCP/Public/BlueprintMCPEditorSubsystem.h` | Editor subsystem header |
| `Source/BlueprintMCP/Private/BlueprintMCPEditorSubsystem.cpp` | Editor subsystem that hosts the server |
| `Source/BlueprintMCP/Public/BlueprintMCPCommandlet.h` | Standalone commandlet header |
| `Source/BlueprintMCP/Private/BlueprintMCPCommandlet.cpp` | Standalone commandlet for headless mode |

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

Follow the existing pattern:
- Call `ensureUE()` first to guarantee the backend is running
- Use `ueGet()` for read-only endpoints, `uePost()` for mutations
- Format responses as human-readable text (not raw JSON)
- Include `nextSteps` hints for mutation tools
- Support `dryRun` parameter on mutation tools where applicable

### Adding a new tool

1. **C++ side:**
   - Declare handler method in `BlueprintMCPServer.h`
   - Implement in `BlueprintMCPServer.cpp` following the patterns above
   - Bind route in `Start()` method
   - Add dispatch case in `ProcessOneRequest()`

2. **TypeScript side:**
   - Add `server.tool(...)` definition in `src/index.ts` with Zod schema, HTTP call, and response formatting

3. **Integration tests (REQUIRED):**
   - Add tests in `Tools/test/tools/` — either a new file or an existing one
   - Tests must cover: success case, error cases (missing fields, non-existent BP), and response field validation
   - Follow the existing test pattern (see below)

4. **Build and verify:**
   - `cd Plugins/BlueprintMCP/Tools && npm run build`
   - Rebuild C++ via editor or build tool
   - `cd Plugins/BlueprintMCP/Tools && npm test` (requires UE5 installed)

### Testing

The test suite is self-bootstrapping: it generates a temporary UE5 project, spawns a headless commandlet, creates Blueprint fixtures via the API, runs tests, and cleans up. No committed `.uasset` files are needed.

#### Commands

```bash
cd Plugins/BlueprintMCP/Tools

# Run full test suite (requires UE 5.6.1 installed)
npm test

# Watch mode (re-runs on file changes)
npm run test:watch

# Type check only (fast, no UE5 needed)
npx tsc --noEmit
```

#### Test infrastructure

| File | Purpose |
|------|---------|
| `Tools/vitest.config.ts` | Vitest configuration (sequential execution, globalSetup) |
| `Tools/test/bootstrap.ts` | Temp project generation, commandlet lifecycle, cleanup |
| `Tools/test/helpers.ts` | HTTP helpers (`ueGet`/`uePost`), fixture create/delete wrappers |
| `Tools/test/setup.ts` | Vitest globalSetup — boots commandlet before tests, tears down after |
| `Tools/test/tools/*.test.ts` | Per-tool integration tests |

#### Writing new tests

Copy the structure of any existing test in `Tools/test/tools/*.test.ts`: a `describe` block that creates its Blueprint fixture with `createTestBlueprint` in `beforeAll`, deletes it with `deleteTestBlueprint` in `afterAll`, and covers the success case, a non-existent blueprint, and missing required fields.

Key patterns:
- Use `uniqueName()` for fixture names to avoid collisions
- Always clean up fixtures in `afterAll` with `deleteTestBlueprint()`
- Use `.js` extensions in imports (Node16 ESM resolution)
- Test the HTTP API directly (`ueGet`/`uePost`), not the MCP tool layer
- The test commandlet runs on port 19847 (not 9847) to avoid conflicts with a running editor
