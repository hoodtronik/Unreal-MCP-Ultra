# Connecting an MCP client to BlueprintMCP

BlueprintMCP is a standard **stdio** MCP server. Every client launches the same thing:

| | |
|---|---|
| command | `node` (18+) |
| args | `<YourProject>/Plugins/BlueprintMCP/Tools/dist/index.js` |
| env | `UE_PROJECT_DIR=<YourProject>` — the folder holding the `.uproject` |

The server then talks to the plugin inside the editor on `localhost:9847` (or spawns a headless
commandlet if no editor is open). Build `Tools/` first (`npm install && npm run build`); the
`blueprintmcp-install` skill in `.agents/skills/` walks the whole install.

Replace `<YourProject>` below with your project folder. Where a client resolves relative paths from
the workspace, the relative form is shown; otherwise use an absolute path.

**Timeouts.** A first call can take ~60 s when the server has to start a headless commandlet, and
`run_python` jobs can run for minutes. Raise the client's per-tool timeout where it has one (shown
below); a client that times out aborts the *call*, not the work in the editor.

## Claude Code

Project-level `.mcp.json` at the UE project root (Claude Code searches the working directory and its
parents, not subdirectories):

```json
{
  "mcpServers": {
    "blueprint-mcp": {
      "command": "node",
      "args": ["Plugins/BlueprintMCP/Tools/dist/index.js"],
      "env": { "UE_PROJECT_DIR": "." }
    }
  }
}
```

Or from a shell in the project root:
`claude mcp add blueprint-mcp -s project -e UE_PROJECT_DIR=. -- node Plugins/BlueprintMCP/Tools/dist/index.js`

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config). Absolute paths only:

```json
{
  "mcpServers": {
    "blueprint-mcp": {
      "command": "node",
      "args": ["<YourProject>/Plugins/BlueprintMCP/Tools/dist/index.js"],
      "env": { "UE_PROJECT_DIR": "<YourProject>" }
    }
  }
}
```

## Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects) — same shape as Claude
Desktop, absolute paths.

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in the project. Note the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "blueprint-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/Plugins/BlueprintMCP/Tools/dist/index.js"],
      "env": { "UE_PROJECT_DIR": "${workspaceFolder}" }
    }
  }
}
```

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.blueprint-mcp]
command = "node"
args = ["<YourProject>/Plugins/BlueprintMCP/Tools/dist/index.js"]
env = { UE_PROJECT_DIR = "<YourProject>" }
startup_timeout_sec = 120
tool_timeout_sec = 600
```

## Gemini CLI

`.gemini/settings.json` in the project (or `~/.gemini/settings.json`); `timeout` is in milliseconds:

```json
{
  "mcpServers": {
    "blueprint-mcp": {
      "command": "node",
      "args": ["<YourProject>/Plugins/BlueprintMCP/Tools/dist/index.js"],
      "env": { "UE_PROJECT_DIR": "<YourProject>" },
      "timeout": 600000
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Claude Desktop, absolute paths.

## Any other client

Anything that speaks MCP over stdio works: point it at `node …/Tools/dist/index.js` with
`UE_PROJECT_DIR` set. If a client rejects a key shown here, its own docs win — config formats change
faster than this page.

## Verify

With the editor open, call the `server_status` tool. It should report editor mode and name the
project on port 9847. If it names a *different* project, another editor owns the port — close one.
