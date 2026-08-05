# The brain

A second brain that is markdown in git, and nothing else.

There is no server, no database, no auth, and no hosting bill. The entire infrastructure
footprint is one Telegram bot token. Search is `ripgrep`. For 146 files, the Postgres
full-text index this replaced was never justified.

## Why it looks like this

The previous version was a Next.js app on Vercel with a Neon database, Auth.js, a GitHub
OAuth app, a push webhook and an authenticated MCP server. It reached ~8.4k LOC and 0% of
current usage — 49 entries in June, 23 in July, then nothing.

It failed because it was **write-only**. Capture worked fine; recall lived behind a
browser and an OAuth login, which is a destination competing with the terminal rather than
something that meets you where you already are. Two producers, zero consumers.

So the rule that governs everything here: **no UI may own state.** Layout, ordering and
position are written back as files in the repo — as `canvases/*.canvas` already does with
JSON Canvas. The moment state lives only in some app's database, this teardown has been
undone and the clock starts again.

## The pieces

| Piece | Where | What |
|---|---|---|
| The vault | `brain-kb` (private repo) | Markdown + frontmatter. The single source of truth. |
| The CLI | `cli/` | The only writer. Writes markdown, commits locally, never pushes. |
| Capture hooks | `hooks/` | SessionStart injects recall; SessionEnd records the session. |
| The routine | `routine/PROMPT.md` | Runs 3×/day in the cloud. Proposes, never writes. |
| The soul | `brain-kb/soul/` | Who the assistant is and who it's for. |

### The vault

Typed entries in `decisions/`, `shipped/`, `notes/`, `discoveries/`, `content/`,
`training/`. Freeform notes in `vault/`. Generated index notes in `projects/`, `labels/`,
`tickets/`. Ids are `YYYY-MM-DD-slug`, and they are a global key — `brain add` suffixes
collisions rather than overwriting.

### The CLI

```
brain add --type <t> --title "..."    capture an entry (via /log, normally)
brain search <query>                  substring scan over raw markdown
brain index                           regenerate projects/ labels/ tickets/
brain review                          what did I start and not finish?
brain slice --project <name>          a project's history, for session injection
brain log-session --body "<line>"     append to today's raw log
```

`core/` is pure — no IO and no clock, `review` takes `now` as an argument — and all
filesystem and git access lives in `vault.ts`. That split is what makes the interesting
logic testable without a fixture tree, and it is worth preserving.

`brain index` materialises backlinks into the index notes instead of assembling them in a
dashboard, so the same file reads correctly from GitHub, Obsidian, the terminal, and by an
agent holding nothing but a checkout. It writes only what changed and never deletes
orphans.

### The local / cloud split

This split is **forced by the sandbox boundary**, not chosen. A Claude Code Routine runs
in Anthropic's cloud: it can reach GitHub and allowlisted domains, but it can never see
this filesystem — not the repos, not git activity, not a session that just ended.

So **capture is local** (hooks + a launchd agent on this Mac, free, runs while you work)
and **thinking is a cloud routine** (3×/day, subscription quota). The pushed raw log in
`vault/log/` is the only channel between them. Anything not committed and pushed is
invisible to the routine.

### Approval

The routine **proposes everything and writes nothing**, and that is enforced by pull
request rather than by bot logic. It opens one PR per run against `brain-kb`; you merge or
close it from the GitHub mobile app. Nothing enters the vault without an explicit merge,
so "asks before writing" is a property of git, not a promise.

Rejected PRs are a permanent record of what it proposed and what you turned down, which is
itself signal — the routine folds that back into `soul/MEMORY.md`.

Telegram is only the nudge layer: one message per run saying what's open, plus at most one
getting-to-know-you question. Taps, not approvals. Proposals unanswered for 3 runs expire
to `inbox/expired/` rather than accumulating, because a growing pile of open PRs recreates
the exact bottleneck that killed the dashboard.

## Reading surfaces

All additive, all disposable, because the vault is plain markdown with wikilinks:

- **Obsidian** — open `brain-kb` as a vault. Zero work. Opens `canvases/*.canvas` natively.
- **`BrainOverlay`** — voidlink's built-in vault browser.
- **`glow` / `frogmouth`** — terminal reading, in flow.
- **Quartz → GitHub Pages** — a published static site, if ever wanted. One Action.

Deleting any of them costs nothing. Building a custom one with its own database is how the
last mess started.

## Setup

```bash
cd cli && npm run build && npm link       # puts `brain` on PATH
echo '{"vaultPath": "'"$HOME"'/Developer/personal/brain-kb"}' > ~/.config/brain/config.json
```

Config resolves `--vault-path` > `BRAIN_VAULT_PATH` > `~/.config/brain/config.json`, with
no default — a missing or wrong vault path fails loudly rather than silently creating a
phantom vault somewhere else.

Then see `hooks/README.md` to install capture, and `routine/PROMPT.md` for the loop.
