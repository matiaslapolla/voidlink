#!/bin/bash
# SessionEnd hook — append one factual line to today's raw log.
#
# This is the routine's only window onto local work. A cloud routine can reach
# GitHub but never this filesystem, so anything not written here is invisible
# to it: which repo, which branch, what landed, what was left dirty.
#
# Deliberately NOT a summary. The hook has no model behind it; it records facts
# and lets the routine do the thinking. Append-only and commit-free, because
# several sessions can end at the same moment and a commit here would race.
#
# Fails open, always — exit 0 on every path.

set -uo pipefail

input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
reason=$(printf '%s' "$input" | jq -r '.reason // "other"')
session=$(printf '%s' "$input" | jq -r '.session_id // empty' | cut -c1-8)

[ -n "$cwd" ] || exit 0
[ -d "$cwd" ] || exit 0
command -v brain >/dev/null 2>&1 || exit 0

project=$(git -C "$cwd" remote get-url origin 2>/dev/null | sed -E 's#.*/##; s#\.git$##')
[ -n "$project" ] || project=$(basename "$cwd")

stamp=$(date +%H:%M)
line="- ${stamp} · ${project} · ${reason}"

if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || echo detached)
  line="${line} · ${branch}"

  # Commits authored during this session are the highest-signal thing available
  # without a model. Fall back silently if the branch has no upstream.
  unpushed=$(git -C "$cwd" rev-list --count '@{u}..HEAD' 2>/dev/null || echo "")
  [ -n "$unpushed" ] && [ "$unpushed" != "0" ] && line="${line} · ${unpushed} unpushed"

  dirty=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$dirty" != "0" ] && line="${line} · ${dirty} dirty"

  subject=$(git -C "$cwd" log -1 --format=%s 2>/dev/null)
  [ -n "$subject" ] && line="${line} · HEAD: ${subject}"
fi

[ -n "$session" ] && line="${line} · [${session}]"

brain log-session --body "$line" >/dev/null 2>&1 || exit 0
exit 0
