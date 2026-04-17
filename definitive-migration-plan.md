# VoidLink Migration Plan — Snappiness First

Staged plan to close the perceived-latency gap vs. Cursor's agents app, ordered by snappiness impact, not by blueprint order. See `cursor-agents-replication.md` for the full architectural target.

## Ground rules

- **No LLM SDKs initially.** Agents run as **CLI subprocesses in PTYs** (`claude`, `codex`, `opencode`) — leveraging the existing `voidlink-core/src/agent_runner/` module. We stream their stdout into column B.
- **Subscription path (future):** if we find a Cursor-compatible way to use an Anthropic subscription and a Codex subscription directly from the app while staying within their ToS, we swap the CLI backend for a direct API adapter. Until then, CLI-only.
- **Ollama stays** as the only direct-HTTP provider (local, zero-auth, zero-ToS-risk) for non-agent features (prompt studio, embeddings later).
- **Target branch:** cut `feat/agent-snappiness` off `main` before Phase 1 begins. This file lives on the archive branch for now; move it to the feat branch when work starts.

---

## Phase 0 — Baseline measurement (optional)

Lightweight instrumentation so we know whether each phase actually moved the needle.

- [ ] Add `tracing` spans on every Tauri command invocation (duration + payload size).
- [ ] Add a frontend event-cadence counter (events/sec, p50/p99 render time) surfaced in dev-only status bar.
- [ ] Record 3 real sessions (git diff view, agent chat, file browse) — save numbers in `docs/perf-baseline.md`.

**Exit criteria:** we have before-numbers to compare against.

---

## Phase 1 — Typed IPC + per-session channels

Biggest snappiness win per line of code. Replace global `emit` for session traffic with scoped `Channel<T>` so tearing down a session stops waking every listener.

- [ ] Add `ts-rs` to `voidlink-core` and `src-tauri` as a dev-dep; generate TS types into `frontend/src/api/generated/`.
- [ ] Derive `TS` on all command input/output structs (start with agent + git command surfaces).
- [ ] Replace `TauriEmitter::emit` (src-tauri/src/lib.rs:23) usage for per-session streams with Tauri v2 `Channel<T>`.
- [ ] Introduce `SessionEvent` tagged union: `TextDelta | ToolCallStart | ToolCallArgsDelta | ToolCallEnd | ToolResult | Approval | Error | Done`.
- [ ] Frontend: typed subscription helper `subscribeSession(id, onEvent)` that closes cleanly on unmount.
- [ ] Keep global `emit` only for app-level broadcasts (settings changed, theme, etc.).

**Exit criteria:** agent session teardown no longer wakes unrelated listeners; TS types regenerate on `cargo check`.

---

## Phase 2 — CLI-driven agent streaming

Agents run as **PTY subprocesses**. Output streams into column B token-by-token. No SDK, no SSE.

- [ ] Generalize `voidlink-core/src/agent_runner/` into a provider abstraction:
  ```rust
  pub trait AgentProvider: Send + Sync {
      async fn start(&self, cfg: AgentConfig, tx: Channel<SessionEvent>) -> Result<SessionHandle>;
      async fn send(&self, h: &SessionHandle, input: UserInput) -> Result<()>;
      async fn cancel(&self, h: &SessionHandle) -> Result<()>;
  }
  ```
- [ ] First impl: `CliAgentProvider` — spawns `claude`/`codex`/`opencode` via `portable-pty`, parses stdout into `SessionEvent`.
- [ ] Define a minimal stdout parser for each CLI (text deltas vs. tool-call markers vs. diffs). Start permissive — treat unrecognized lines as `TextDelta`.
- [ ] Wire into Tauri commands: `agent.start`, `agent.send`, `agent.cancel`, `agent.list`.
- [ ] Column B UI: `MessageStream` that renders events live; `Composer` that sends input; cancel button.
- [ ] Session persistence: SQLite table for message history (re-use `rusqlite` already in workspace).

**Exit criteria:** typing into column B launches `claude` (or `codex`), its output streams progressively, session survives app reload.

---

## Phase 3 — Generic `Tool` trait (non-agent)

Extract the pattern from `git_agent/pipeline.rs` so column C tools can be invoked independently of an agent turn (user-driven) and later reused by an agent.

- [ ] Define `Tool` trait: `name`, `schema`, `async fn run(input) -> Output`.
- [ ] Registry: `ToolRegistry` keyed by name; policy gate (`allow | prompt | deny`).
- [ ] Port first tools: `fs.read`, `fs.search` (grep), `fs.write`, `git.diff`, `git.status`.
- [ ] Frontend: generic `ToolCallCard` component; reuse from agent stream later.

**Exit criteria:** tools callable from UI without an agent loop; schemas queryable.

---

## Phase 4 — 3-column tileable shell

Replace the fixed 5-panel `AppShell` with an agent-centric tileable layout.

- [ ] New `TileManager` store: tree of tiles with split H/V + remove-from-tileset.
- [ ] Column A: agents list + workspaces + settings (migrate from `LeftSidebar`).
- [ ] Column B: agent conversation (from Phase 2) — focal.
- [ ] Column C: tabbed tools (files, terminal, git, logs) — migrate existing right-sidebar cards.
- [ ] Persist tile layout per workspace.
- [ ] Keep bottom bar as status-only; retire `BottomPane` (terminal moves into column C).

**Exit criteria:** user can split any tile H/V, remove tiles, and layout survives reload.

---

## Phase 5 — Command palette

Global fuzzy finder — every nav becomes `⌘K`.

- [ ] Add `nucleo` to `voidlink-core`.
- [ ] Expose commands via `palette.search(query)` returning ranked entries.
- [ ] Sources: open files, git branches, workspace sessions, all Tauri commands (by category), recent files.
- [ ] Frontend: `CommandBar` overlay bound to `⌘K` / `Ctrl+K`.

**Exit criteria:** palette opens in <50ms, returns results as you type.

---

## Phase 6 — Async git (gix) alongside git2

Remove blocking-on-tokio. Port behind a feature flag so we can flip and revert.

- [ ] Add `gix` to `voidlink-core` with `async` feature.
- [ ] New `git_service_gix` module parallel to existing `git` module.
- [ ] Port read paths first: `status`, `log`, `diff`, `blame`, `list_branches`.
- [ ] Feature-flag `VOIDLINK_GIT_BACKEND=gix|git2` — default git2 until gix has parity.
- [ ] Port writes last (commit, push) — use CLI `git` fallback for anything gix can't do.
- [ ] Retire git2 once gix is stable.

**Exit criteria:** no blocking git calls on tokio worker threads under `gix` flag.

---

## Phase 7 — Codebase index (tantivy + merkle)

Give agents fast context.

- [ ] New crate `voidlink-core/crates/merkle-tree`: content-hash tree over workspace files.
- [ ] New crate `voidlink-core/crates/codebase-snapshot`: point-in-time indexed state, diffs between snapshots.
- [ ] Add `tantivy` — per-workspace fulltext index, incremental update on file save.
- [ ] Add `notify` — file watcher driving incremental reindex.
- [ ] New tools: `fs.symbol_search`, `fs.semantic_search` (later, once embeddings wired).

**Exit criteria:** repo-wide search returns in <100ms on a 10k-file repo; reindex on save is debounced.

---

## Phase 8+ — Deferred blueprint items

Only after the core loop feels right. Order TBD.

- [ ] Web browser tab (Tauri multi-webview).
- [ ] Canvas / live TSX artifacts (swc_core or esbuild sidecar).
- [ ] Sandbox helper binary (bubblewrap + landlock + seccomp).
- [ ] Vector store (lancedb embedded) for hybrid search.
- [ ] Subscription-based agent providers (Anthropic / Codex) — **only if** we find a ToS-compatible path.
- [ ] Voice dictation (whisper.cpp).

---

## Open decisions

1. **How aggressive should the Phase 2 CLI parser be?** Permissive (everything is a text delta, tool calls appear as special JSON lines the CLI emits) vs. structured (teach it every CLI's output format). Start permissive.
2. **Do we keep the FastAPI `backend/` sidecar** during the migration, or retire it? It's vestigial today. Suggest retire after Phase 4.
3. **Session persistence schema** — reuse prompt-studio's SQLite DB or separate file? Lean separate (`~/.voidlink/sessions.db`).

---

*Start at Phase 1.*
