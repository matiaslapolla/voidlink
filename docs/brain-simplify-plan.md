# Simplify: from platform to living wiki

Audit + migration plan, 2026-08-05.

---

## START HERE

Triggered by: *"start SIMPLIFY.md"*. This document is the complete brief — execute it, don't
re-plan it. Read the whole file first, then work **Order of work** in order.

**Settled decisions — do not reopen or re-ask:**

| Question | Answer |
|---|---|
| Scope | Full teardown. `apps/web`, Neon, Vercel, Auth.js, GitHub PAT + webhook, HTTP MCP all die. |
| mdevpc | Discarded. Becomes server/gaming only. Not a host for anything here. |
| Assistant | A minimal custom Telegram bot we own (~300 LOC). **Not** OpenClaw or any framework. |
| Initiative | Proposes everything, writes nothing. Enforced by PR merge, not bot logic. |
| Soul bootstrap | Wizard interview now, passive refinement after. |
| Approval surface | Pull requests against `brain-kb`. Telegram is the nudge layer only. |
| Search | ripgrep. No Postgres, no index. |
| Reading UI | Obsidian now (zero work); Quartz later if wanted. Not in scope for the build. |

**Blocking prerequisites — only Matias can do these. Ask for them when the step is reached;
do not attempt to work around them:**

1. Create the bot via Telegram `@BotFather` → hand over the bot token and his chat id.
2. On `claude.ai/code/routines`, set the routine environment's **Network access → Custom**,
   add `api.telegram.org`, tick "also include default list", and add the bot token as an
   environment variable.
3. Confirm before any destructive teardown in step 8 — deleting the Vercel project, Neon DB,
   OAuth app, PAT, or either `second-brain` clone.

**Guardrails:**

- Nothing in step 8 (teardown) happens until its replacement is working and verified.
- Never let a UI or a service own state. Markdown in git is the only source of truth.
- Do not push to `brain-kb` `main` on the bot's behalf — the bot opens PRs, full stop.

---

## Why

The platform is ~8.4k LOC and 0% of current usage. Evidence:

- `brain-kb` has **no entries since 2026-07-19** (49 in June, 23 in July, then nothing).
- `~/.config/brain/config.json` contains only `{"vaultPath": ...}` — no `apiUrl`, no token.
- `packages/cli/src/local-register.ts` exists **uncommitted**; `api.ts` deleted. The CLI already
  writes markdown + git-commits straight into the vault.
- Two decisions dated 2026-07-19 record exactly this pivot.
- The registered MCP server at `https://sborch.matiaslapolla.com/api/mcp` **fails with 401**.
  The Vercel deployment and Neon DB are still live and orphaned.
- `brain-kb` is **3 commits ahead of origin**, including the vault migration. That data exists
  only on this laptop, which violates the repo's own "nothing is local-only" invariant.

The half-finished pivot is the plan. This document finishes it.

**Root cause of abandonment:** the system was write-only. Capture went in, nothing ever read
back. The canvas needed a browser and an OAuth login — a destination competing with the
terminal. Two producers (this Mac, mdevpc), zero consumers.

## End state

### Repos

| Repo | Fate |
|---|---|
| `brain-kb` | **Keep.** The wiki. Markdown + git, single source of truth. Gains `soul/` and `inbox/`. |
| `brain` | **Slim.** Keep `packages/core` + `packages/cli`, add `bot/` + `hooks/`. Delete `apps/web`. |
| `personal/second-brain` | **Delete.** Stale clone; its `notes/` already live in `brain-kb/vault/`. |
| `Developer/second-brain` | **Delete.** mdevpc's memory mirror; mdevpc is being retired to server/gaming. |

### Infrastructure

Deleted: Vercel project (`prj_jZfjcXtdnkDDKlqvcXSEcTHOwv6W`), Neon database, Auth.js + GitHub
OAuth app, GitHub PAT + push webhook, `PLATFORM_TOKEN`, the HTTP MCP server, the launchd agent
`com.matias.brainpull`.

Added: a Telegram bot token. That is the entire infrastructure footprint.

Search becomes `ripgrep`. For 146 files, Postgres FTS with a GIN index was never justified.
Index pages (`projects/`, `labels/`, `tickets/`) become generated markdown committed into the
repo, so they stay readable from GitHub, Obsidian, the terminal, and by Claude.

### The split

Routines run in Anthropic's cloud. They can reach `brain-kb` over GitHub but **cannot see this
Mac's filesystem or local git activity**. So:

**Local — capture** (Claude Code hooks + launchd on the Mac; free, runs while you work)
- `SessionStart` hook: inject the relevant brain slice — open tickets for this project, last 3
  decisions, unresolved notes.
- `SessionEnd` hook: append a one-line session record to `vault/log/YYYY-MM-DD.md`.
- launchd nightly: commit + push the day's raw log.

**Cloud — think and talk** (Claude Code Routine, 3×/day; subscription quota, no extra cost)
1. Pull `brain-kb`.
2. Read `soul/`, recent entries, yesterday's raw log.
3. Poll Telegram `getUpdates` — process replies since the last run.
4. Apply **approved** proposals → write markdown → commit → push.
5. Think: what changed, what's stale, what does it still not know about you.
6. Send one Telegram message: proposals as inline-keyboard buttons, plus at most one
   getting-to-know-you question.
7. Persist pending proposals to `inbox/` so state survives between runs.

Long polling is what removes the always-on requirement. Nothing listens; the scheduled run
collects.

## The soul

`brain-kb/soul/` — plain markdown, versioned in git alongside everything else:

- `SOUL.md` — its persona, tone, how pushy, when to stay quiet.
- `USER.md` — who you are, how you work, what you're building, what you want nagged about.
- `MEMORY.md` — accumulated observations about you and your projects.

**Bootstrap:** a one-time `/brain-wizard` skill runs a structured interview and seeds
`USER.md` + `SOUL.md`.

**Then passive:** each run, the bot may propose *one* refinement to its own soul files. You
approve it like any other proposal. It writes its own soul, one approved diff at a time.

## Approval without the bottleneck

You chose proposes-everything-writes-nothing. The failure mode is that you become the
bottleneck again — which is how the dashboard died. The mitigation is friction, not policy:

Proposals arrive as a Telegram message with inline-keyboard buttons — ✅ approve / ✏️ edit /
❌ drop. One tap on your phone, applied on the next run. Batched: one message per run, not one
per proposal. That is roughly five seconds a day, versus opening a browser and logging in.

If a proposal goes unanswered for three runs, it expires to `inbox/expired/` rather than
accumulating.

## Cost

| Item | Cost |
|---|---|
| Routine runs (3/day ≈ 90/month) | Subscription quota. Routines bill like a normal Claude Code session — no separate charge. |
| Claude Code hooks + local scheduled task | Free. |
| Telegram Bot API | Free. |
| Hosting, database, auth | None. |

**Proposals-only + PR approval + 3×/day removes the need for a host entirely.** There is no
persistent process: the routine wakes, thinks, opens a PR, sends one message, dies. Long
polling means nothing has to be listening.

Infra only becomes a question if instant replies are wanted instead of next-run processing:

| Option | Free tier | Fit |
|---|---|---|
| **Cloudflare Workers** | 100k req/day, Cron Triggers, KV/D1, no card | Best. Telegram webhook → instant reply, scales to zero. ~40 LOC. |
| **GitHub Actions** | 2,000 min/mo private repos | Already hosts `brain-kb`, full egress, native commit rights. Scheduled workflows auto-disable after 60 days of repo inactivity; jobs cap at 6h. |
| **Oracle Cloud Always Free** | Always-on VM, up to 4 ARM cores / 24GB RAM, $0 forever | Only option big enough for a full agent **plus local Ollama**. ARM capacity is hard to get; Oracle reclaims idle instances. |

Free inference that doesn't touch the Claude quota, if ever needed: Gemini, Groq, Cerebras
free tiers; OpenRouter free models.

## Prior art to read before writing the bot

Adopting a framework was rejected in favour of a minimal bot, so these are references:

- **NanoClaw** — TypeScript on Claude's Agent SDK, Docker/Apple Container isolation per
  session, agent swarms. Closest sibling; Agent-SDK-based, so it draws the included credit pool.
- **Nanobot** — Python, most readable. Best structural reference.
- **ZeroClaw** — tiny Rust runtime; the minimal end of the design space.
- **PicoClaw** — documented running on Oracle Always Free + Tailscale + Telegram, i.e. the
  exact $0 always-on shape.
- **LibreChat / Open WebUI / Dify** — chat interfaces, not proactive agents. Wrong category.

The idea worth stealing outright is OpenClaw's `SOUL.md` / `IDENTITY.md` / `USER.md` /
`MEMORY.md` workspace convention — it is just markdown, so adopting it costs nothing.

Note the billing distinction: **scheduled Routines** draw from your claude.ai subscription
quota, but **programmatic usage** (Agent SDK, headless `claude -p`, GitHub Actions) has since
2026-06-15 drawn from a separate monthly Agent SDK credit pool sized to your plan price, which
does not roll over. Keep the loop in Routines, not headless.

## Network access — resolved, not a risk

Routine environments carry a **Network access** level. The **Default** environment is
`Trusted`: only a fixed allowlist (package registries, cloud provider APIs, container
registries, common dev domains) passes. Anything else fails with `403` and
`x-deny-reason: host_not_allowed`.

To reach Telegram: edit the routine's environment, set **Network access → Custom**, and add
`api.telegram.org` to **Allowed domains** (tick "also include default list" to keep the
standard allowlist). **Full** is also available for unrestricted access. The bot token goes in
the environment's variables. One config step, no relay, no Vercel function.

Note: **connector** traffic routes through Anthropic's servers and bypasses the allowlist
entirely. Anything reachable via an existing connector (Gmail, Notion, Google Calendar) needs
no network config at all.

## Approval surface: pull requests, not bot logic

Routines have native GitHub repo access and push to `claude/`-prefixed branches by default. So
the proposal mechanism is a **pull request against `brain-kb`**:

- The routine opens a PR containing its proposed entries and soul-file refinements.
- You review the markdown diff in the GitHub mobile app and merge or close it.
- Nothing enters the vault without an explicit merge — "writes nothing without asking" becomes
  a property of git rather than a promise from a bot.
- Rejected PRs are a permanent record of what it proposed and what you turned down, which is
  itself signal for `soul/MEMORY.md`.

Telegram then degrades to the *nudge* layer: one message per run saying what's open, plus at
most one getting-to-know-you question. Taps, not approvals.

## Capture must run locally

`/schedule` offers **Local** (Desktop scheduled task) as well as **Cloud**. Local tasks run on
this Mac with real filesystem access — every repo under `~/Developer`, actual git activity,
session logs — and have no egress restrictions. Cloud routines can reach GitHub and allowed
domains but never the local filesystem.

So capture is a local task, thinking is a cloud routine. That split is forced by the sandbox
boundary, not a preference.

## Limits worth knowing

- Routine schedules have a **one-hour minimum interval**; sub-hourly cron expressions are
  rejected.
- Routines have a **daily run cap per account** on top of normal subscription usage. 3/day is
  well inside it.
- GitHub triggers fire only on **pull request** and **release** events — not issues. A merged
  proposal PR can kick off a follow-up run; an issue cannot.
- Routine runs show green if the session exited without infrastructure error — *not* if the
  task succeeded. Blocked network requests surface in the transcript, not the status.

## Order of work

Each step is independently shippable. Verify before moving on. Steps 1–2 are safety work and
run first regardless of anything else.

**1. Replicate unpushed data.** `git -C ~/Developer/personal/brain-kb push` (3 commits ahead,
including the whole vault migration — currently laptop-only). Confirm with Matias first, since
it's an outward push.

**2. Land the in-flight CLI pivot.** In `brain`: `local-register.ts` is untracked, `api.ts` is
deleted, `args.ts`/`cli.ts`/`config.ts` are modified. Run `pnpm -r typecheck && pnpm -r test`,
then commit. This is the working local writer — it must not stay uncommitted.

**3. Soul scaffolding + wizard.** *Do this before any plumbing.* Create `brain-kb/soul/` with
`SOUL.md`, `USER.md`, `MEMORY.md`. Build `/brain-wizard` as a Claude skill: a structured
interview that seeds `USER.md` (how he works, what he's building, what "done" means, what he
wants nagged about) and `SOUL.md` (tone, pushiness, when to stay quiet). Run it with him and
get his sign-off on the output quality — **proposal quality is entirely downstream of these
files.** If they're vague, everything after is generic and the system dies the same death as
the dashboard.

**4. `brain index` + `brain review`.** Pure functions in `packages/core`, wired into the CLI.
`index` regenerates `projects/`, `labels/`, `tickets/` from frontmatter. `review` reports
staleness: entries untouched 90d, tickets open >30d, decisions with no follow-up `shipped`.
Both are needed by step 6 and are testable without any network. Vitest alongside the existing
`packages/core` tests.

**5. Telegram bot + egress check.** Get the token (prerequisite 1), configure the environment
(prerequisite 2), then a throwaway routine that sends one message. Confirms the allowlist is
right before anything depends on it. Remember: a green run status only means no infrastructure
error — read the transcript to confirm the send actually landed.

**6. The routine loop.** Saved prompt in `brain/routine/PROMPT.md`. Per run: pull `brain-kb` →
read `soul/` + recent entries + yesterday's raw log → poll `getUpdates` for replies since last
run → open **one PR** with proposed entries and at most one `soul/` refinement → send **one**
Telegram message (what's open + at most one getting-to-know-you question) → write pending state
to `inbox/pending/`. Expire proposals unanswered after 3 runs to `inbox/expired/`. Schedule
3×/day (one-hour minimum interval applies).

**7. Local capture.** `SessionStart` hook injects the project's brain slice (open tickets, last
3 decisions, unresolved notes). `SessionEnd` hook appends one line to `vault/log/YYYY-MM-DD.md`.
A local scheduled task commits and pushes the day's log. These must run locally — cloud routines
cannot see the filesystem.

**8. Teardown.** Only after 3–7 are verified working, and only with explicit confirmation per
prerequisite 3. Delete `apps/web`; the Vercel project (`prj_jZfjcXtdnkDDKlqvcXSEcTHOwv6W`); the
Neon database; the Auth.js GitHub OAuth app; the `GITHUB_TOKEN` PAT and the push webhook on
`brain-kb`; the `brain` MCP registration (`claude mcp remove brain`); the launchd agent
`com.matias.brainpull` (unload, then delete the plist); and both clones —
`~/Developer/personal/second-brain` and `~/Developer/second-brain`. Prune the now-dead env vars
from `.env.example` and the README.

**9. Rewrite `brain/README.md`** to describe what actually exists afterwards. The current one
documents the torn-down architecture in detail and will badly mislead a future session.

## Reading surfaces — all additive, none required

Because the vault is plain markdown with frontmatter and wikilinks, every reader is optional
and disposable. Any number can run at once; deleting one costs nothing.

| Surface | Work | Gives you |
|---|---|---|
| **Obsidian** | none — open `brain-kb` as a vault | wikilinks, backlinks, graph view, search, offline, mobile. Opens `canvases/*.canvas` natively (JSON Canvas). |
| **Quartz** → GitHub Pages | one Action, ~an afternoon | published static site: wikilinks, backlinks, graph, client-side search. No server, no DB, no auth. |
| **`glow` / `frogmouth`** | none | terminal reading, in flow. |
| Custom reader | high | only if the above genuinely fail. This is how the current mess started. |

**The invariant that keeps this true: no UI may own state.** Layout, positions and ordering are
written back as files in the repo (as JSON Canvas already does). The moment state lives only in
a UI's database, the teardown has been undone.

## Accepted losses

The kanban board is app-native Postgres state with no markdown equivalent. Tickets become
markdown with a `status:` field — adequate for 6 cards, greppable by `brain tickets`.

The canvas is **not** a loss after all: `canvases/` already exports JSON Canvas, which Obsidian
opens natively, and new layouts save as files in the repo rather than database rows. Spatial
thinking survives the teardown and becomes version-controlled in the process.
