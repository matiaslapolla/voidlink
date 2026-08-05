# hooks/

Local capture. These run on this Mac, not in the cloud, and that split is forced rather
than chosen: a Claude Code routine can reach GitHub over the network but can never see
this filesystem — not the repos, not the git activity, not a session that just ended. So
capture is local and thinking is a routine, and the raw log is the only channel between
them.

| File | Runs | Does |
|---|---|---|
| `session-start.sh` | `SessionStart` | Injects the project's brain slice into the session. |
| `session-end.sh` | `SessionEnd` | Appends one factual line to `vault/log/YYYY-MM-DD.md`. |
| `daily-push.sh` | launchd, 23:30 | Regenerates index notes, commits the day's log, pushes. |

Both hooks **fail open on every path** — no `brain` on `PATH`, no git repo, malformed
stdin, missing vault all exit 0 with no output. A capture system that can break session
startup gets uninstalled within the week.

## Install

Everything below assumes the CLI is built and linked, which is what makes `brain slice`
and `brain log-session` resolve:

```bash
cd ~/Developer/personal/voidlink/cli && npm run build && npm link
brain slice --project voidlink   # should print a slice, not a usage error
```

**1. The hooks.** Add to `~/Developer/personal/claudeconfig/settings.json` (it's symlinked
to `~/.claude-personal/settings.json`, so the repo copy is the real one):

```json
"hooks": {
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        {
          "type": "command",
          "command": "/Users/matiaslapolla/Developer/personal/voidlink/hooks/session-start.sh",
          "timeout": 10
        }
      ]
    }
  ],
  "SessionEnd": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "/Users/matiaslapolla/Developer/personal/voidlink/hooks/session-end.sh",
          "timeout": 10
        }
      ]
    }
  ]
}
```

`SessionStart` deliberately does **not** match `compact` — a slice re-injected on every
compaction is noise, and the original injection is already in the transcript.

**2. The nightly push.**

```bash
cp hooks/com.matias.braindaily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.matias.braindaily.plist
launchctl start com.matias.braindaily   # once, to prove it works
cat /tmp/braindaily.err.log
```

This replaces `com.matias.brainpull`, which pulled from a server that no longer exists.
Unload that one first: `launchctl unload ~/Library/LaunchAgents/com.matias.brainpull.plist`.

## What the log line contains

```
- 10:04 · voidlink · prompt_input_exit · fix/pane-drag · 2 unpushed · 1 dirty · HEAD: feat(layout): … · [abc123de]
```

Facts only — time, project, why the session ended, branch, unpushed/dirty counts, the
HEAD subject, and a short session id. **No summary**, because the hook has no model
behind it. Interpreting the day is the routine's job; this is its raw material.
