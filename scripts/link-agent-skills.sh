#!/usr/bin/env sh
# Link this repo's agent skills (.agents/skills/) into the folders individual agents read.
# macOS/Linux counterpart of link-agent-skills.ps1 — see that file for the why.
#
#   ./scripts/link-agent-skills.sh          # repo-local: .claude/skills -> .agents/skills
#   ./scripts/link-agent-skills.sh --user   # also link each skill into ~/.claude/skills and ~/.agents/skills
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
src="$repo/.agents/skills"

link() {  # link <path> <target>; replaces an existing symlink, never a real directory
  if [ -e "$1" ] && [ ! -L "$1" ]; then echo "skip: $1 is a real directory" >&2; return; fi
  mkdir -p "$(dirname "$1")"
  ln -sfn "$2" "$1"
  echo "linked $1 -> $2"
}

link "$repo/.claude/skills" "$src"
if [ "${1:-}" = "--user" ]; then
  for root in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    for d in "$src"/*/; do link "$root/$(basename "$d")" "${d%/}"; done
  done
fi
