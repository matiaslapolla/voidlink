#!/bin/bash
# Nightly: commit and push the day's raw log, and refresh the index notes.
#
# The SessionEnd hook only appends — committing there would race concurrent
# sessions. This runs once, from a launchd agent, and is the step that makes
# local capture visible to the cloud routine: a routine can reach GitHub but
# never this filesystem, so an uncommitted log may as well not exist.
#
# Scoped to vault/log/ and the index folders by pathspec, so it can never sweep
# up a hand-edit in progress elsewhere in the vault.

set -uo pipefail

VAULT="${BRAIN_VAULT_PATH:-$HOME/Developer/personal/brain-kb}"
[ -d "$VAULT/.git" ] || { echo "No vault at $VAULT" >&2; exit 1; }

cd "$VAULT" || exit 1

# Regenerate index notes first so the day's captures are reflected in
# projects/, labels/ and tickets/. `brain index` commits its own changes.
if command -v brain >/dev/null 2>&1; then
  brain index --yes || echo "brain index failed, continuing" >&2
fi

if [ -n "$(git status --porcelain -- vault/log/)" ]; then
  git add -- vault/log/
  git commit -m "log: $(date +%Y-%m-%d) session records" -- vault/log/ \
    || echo "nothing to commit in vault/log/" >&2
fi

# Push whatever is now ahead — the log commit, the index commit, and any
# entries `brain add` committed locally during the day.
if [ "$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)" != "0" ]; then
  git push || { echo "push failed — vault is ahead of origin" >&2; exit 1; }
fi
