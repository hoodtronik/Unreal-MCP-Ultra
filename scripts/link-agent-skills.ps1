# Link this repo's agent skills (.agents/skills/) into the folders individual agents read.
#
# CLAUDE-NOTE (2026-09-23): .agents/skills/ is the single tracked copy. Claude Code only reads
# .claude/skills/, and git on Windows (core.symlinks=false) cannot carry a symlink, so the link is
# created locally by this script and .claude/skills is gitignored. Junctions need no admin rights.
#
#   .\scripts\link-agent-skills.ps1          # repo-local: .claude/skills -> .agents/skills
#   .\scripts\link-agent-skills.ps1 -User    # also link each skill into ~/.claude/skills and ~/.agents/skills
#
# Re-running is safe. An existing link is replaced; a real folder is never touched.
param([switch]$User)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo '.agents\skills'

function Set-Junction([string]$link, [string]$target) {
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Warning "skip: $link is a real folder, not a link - move it aside yourself"
            return
        }
        # Removing a junction with .Delete() removes the link only, never the target's contents.
        $item.Delete()
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link) | Out-Null
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Output "linked $link -> $target"
}

Set-Junction (Join-Path $repo '.claude\skills') $src

if ($User) {
    foreach ($root in @("$HOME\.claude\skills", "$HOME\.agents\skills")) {
        Get-ChildItem -LiteralPath $src -Directory | ForEach-Object {
            Set-Junction (Join-Path $root $_.Name) $_.FullName
        }
    }
}
