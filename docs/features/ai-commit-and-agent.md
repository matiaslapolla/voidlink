# AI commit drafting and the repo agent

## What it does

Two features over one mechanism: VoidLink builds a prompt, pipes it to **your**
CLI's stdin, and reads stdout back. No model is embedded, no API key is stored,
nothing is sent anywhere VoidLink chooses.

- **Commit drafting** — the staged diff goes to stdin, the message comes back.
- **Repo agent** — a prompt grounded in live workspace state goes to stdin, the
  answer comes back.

## When you'd use it

When you already have `claude`, `ollama`, `codex`, or similar on your `PATH` and
would rather not context-switch to a terminal for a commit message.

## Setup

**Settings → AI** has two rows, both plain command templates:

| Setting | Effect |
|---|---|
| `Commit messages` → `Command` | Used for commit drafting. |
| `Repo agent` → `Command` | Used for the agent. Blank falls back to the commit command. |

Preset buttons fill in working templates:

```
claude --no-tools -p "You are a senior engineer. Write a concise, imperative-mood git commit message (50-char title, optional body) for the following staged diff. Output ONLY the message."
ollama run llama3.2 "Write a concise imperative-mood git commit message for this diff. Output ONLY the message:"
codex exec -m gpt-5 "Write a concise imperative-mood git commit message (50-char title, optional body) for this staged diff. Output ONLY the message."
```

**All instruction wording lives in your template.** The backend adds none — for
commit drafting, stdin is *only* the rendered diff.

## How to use it

### Drafting a commit message

1. Stage something. With nothing staged you get `Stage some changes first`.
2. Press `Mod+Shift+M`, click the sparkles button in the commit form, or run
   `Draft commit message with AI` from the palette.
3. The status bar shows `Drafting commit…`, and the commit box placeholder
   becomes `Drafting commit message…`.
4. The result is **appended** to whatever is already in the commit box,
   separated by a blank line — it never overwrites what you typed.

The diff is rendered per file as:

```
--- <path> (<status>, +<additions> -<deletions>) ---
@@ hunk header @@
+added line
-removed line
 context line
```

Binary files are listed as `[binary file]` with no content.

### Asking the repo agent

1. `Mod+Shift+A`, or `Toggle repo agent` from the palette. Without a repo open
   you get `Open a repository first`.
2. A slide-over panel opens on the right.
3. Type a question. `Enter` sends, `Shift+Enter` inserts a newline.
4. Each answer has a collapsible `Context used (n)` disclosure listing which
   sources went into the prompt.

The prompt is assembled **in the frontend**, in this order:

1. A system preamble telling the CLI it is VoidLink's repository assistant and
   to cite file paths, branch names, and SHAs.
2. `## Repository` — branch, ahead/behind vs upstream, clean or dirty.
3. `## Changed files (n)` — capped at 50 rows, staged ones prefixed `●`.
4. `## Recent commits` — the last 12.
5. `## Staged diff` — truncated at 6000 characters with `… [diff truncated]`.
6. `## Open files` — paths from the layout store, active one marked.
7. `## Conversation so far` — every prior turn.
8. `## Question` — what you asked.

Each git-backed section is individually wrapped in a try/catch, so a failing
call silently drops that section rather than failing the turn.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+M` | Draft commit message with AI |
| `Mod+Shift+A` | Toggle the repo agent panel |
| `Enter` | Send (agent composer only) |
| `Shift+Enter` | Newline (agent composer only) |

## Gotchas and limits

- **No timeout, no cancel, no kill.** A hanging CLI leaves the UI in its
  drafting state indefinitely. There is a reset function in the source but
  nothing in the UI calls it. Kill the process from a terminal.
- **On Unix the command is re-wrapped in a login shell.** The parsed argv is
  discarded and re-run as `$SHELL -lc '<quoted argv>'`, because a Finder or Dock
  launch inherits a minimal `PATH`. Two consequences: your shell rc files run,
  and the friendly "not found on PATH" error is effectively unreachable — a
  missing binary makes the *shell* exit non-zero, so you see
  `AI command exited with 127: … command not found`.
- **The template splitter handles quotes only.** Single and double quotes work;
  there is no backslash escaping outside quotes and no variable expansion. An
  unterminated quote returns `invalid AI command template: unterminated quote`.
- **The sparkles button is not disabled when no command is configured.** You get
  a warning toast pointing at Settings → AI.
- **Agent conversations are in-memory only**, keyed by workspace. A reload loses
  them. That is deliberate — the panel is a scratch surface, not a document.
- **The agent is globally single-flight.** One turn at a time across all
  workspaces.
- **There is no streaming.** The panel shows `Thinking…` and then the whole
  answer at once; the Rust side blocks on the child process. A source comment in
  the panel mentions "streaming state" — it is misleading.
- **Conversation history is re-sent in full every turn with no cap.** Only the
  diff is truncated, so a long thread grows the prompt without bound.
- **The `Context used` list undercounts.** The conversation section is included
  in the prompt but produces no audit entry.
- **Every run occupies a blocking-pool thread** for the whole CLI invocation.
- **Assistant answers are markdown-rendered and sanitised**; errors render as
  raw monospace text.
