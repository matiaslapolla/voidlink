#!/bin/bash
# SessionStart hook — inject this project's brain slice.
#
# The old system was write-only: capture worked, recall lived behind an OAuth
# login nobody visited. This puts recall where the work already is, at zero
# cost to the person doing it.
#
# Fails open, always. A brain that breaks session startup gets uninstalled by
# the end of the week, so every failure path here exits 0 with no output.

set -uo pipefail

input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$cwd" ] || exit 0
[ -d "$cwd" ] || exit 0

# Project name: the git remote's basename, else the directory name — the same
# derivation /log and /standup use, so a session, a capture and a slice all
# agree on what the project is called.
project=$(git -C "$cwd" remote get-url origin 2>/dev/null | sed -E 's#.*/##; s#\.git$##')
[ -n "$project" ] || project=$(basename "$cwd")
[ -n "$project" ] || exit 0

command -v brain >/dev/null 2>&1 || exit 0

slice=$(brain slice --project "$project" 2>/dev/null) || exit 0
[ -n "$slice" ] || exit 0

jq -n --arg ctx "$slice" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
