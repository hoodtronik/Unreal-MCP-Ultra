# BlueprintMCP — Claude Code

<!-- CLAUDE-NOTE (2026-09-23): project instructions live in AGENTS.md so every agent reads the same rules.
     Keep this file to the import plus anything that is genuinely Claude-Code-only. -->

@AGENTS.md

## Claude Code only

- Skills: `.claude/skills` is a local junction to `.agents/skills` (gitignored). If it is missing after a
  fresh clone, run `scripts/link-agent-skills.ps1` (or `.sh`).
