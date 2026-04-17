# Replicating Cursor's Agents App — Rust-Focused Blueprint

An investigation-style build plan for a desktop agent development environment equivalent to Cursor's agent side (not the VSCode editor fork). Targets a **Tauri v2 + Rust backend + SolidJS frontend** stack, matching the existing `voidlink` project layout.

---

## 1. What we're replicating

Cursor ships two apps bundled in one AppImage:

- **The editor** — fork of VSCode (Electron + Monaco + TS extensions).
- **The agents app** — a TypeScript orchestrator embedding Anthropic's `@anthropic-ai/claude-agent-sdk`, delegating heavy work to **Rust native modules + a Rust sandbox helper**.

Your target is the **agents app**. Screens show:

- Top title bar (File/Edit/View/Help).
- 3-column layout `A | B | C` with tile management (split H/V, remove from tileset).
- Column **A** — agent list + workspace list + command bar + settings/account.
- Column **B** — agent conversation (tool calls, diffs with live preview, chat input + voice + attachments + model picker). Mode picker: Plan/Ask/Debug.
- Column **C** — tabbed tools: file explorer, terminals, web browser, canvas (live TSX artifact), git (diff, tree, commit, branch, PR). Agents in B drive C tools with human validation.

---

## 2. Tech stack decisions

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri v2** | Native + Rust-first; small binary; webview is OS-native. Cursor uses Electron; you don't need to. |
| Backend language | **Rust** | The learning goal. Matches `src-tauri/`. |
| Frontend | **SolidJS + TS** | Already in use (`frontend/`). Fine-grained reactivity fits live diff/tool-stream UIs. |
| Editor widget | **CodeMirror 6** | Already used. For file viewer + diff gutter in column C. |
| Rich editor (canvas/notes) | **Tiptap** (ProseMirror) | Already used for the Notion-like doc. |
| Terminal | **xterm.js** + **portable-pty** (Rust) | Matches Cursor's `node-pty` role, but in Rust. |
| Web browser tab | **Tauri multi-webview** or embedded `wry` child webview | Cursor embeds via Chromium. With Tauri v2 you create additional WebviewWindows / child webviews. |
| Git ops | **`gix`** (gitoxide) | Cursor uses `gix` internally (seen in their `.node`). Pure-Rust, async. |
| Repo search | **`ignore`**, **`grep-searcher`**, **`aho-corasick`** | Same crates Cursor ships. |
| Code index | custom Merkle tree of file hashes + **`tantivy`** (lexical) + optional vector store | Cursor has `merkle_tree`, `codebase-snapshot`, `gix-snapshot` crates; Tantivy is the idiomatic Rust fulltext. |
| Embeddings/vectors | **`qdrant-client`** (remote) or **`lancedb`** (embedded) | For hybrid search. |
| RPC internal | **Tokio + tonic/prost (gRPC)** or **ts-rs + Tauri commands** | Cursor uses tonic+prost; for learning Tauri, stay with Tauri IPC (serde_json over invoke/emit) and add tonic only if you want to split into services. |
| Agent sandbox | custom Rust binary using **bubblewrap + landlock + seccompiler** | Direct 1:1 with Cursor's `cursorsandbox`. |
| SOCKS proxy | **`hyper` + policy matcher** (see `socks.rs`, `matcher.rs`, `policy.rs`) | Per-agent network allowlist. |
| LLM transport | **`reqwest`** + SSE parser | Anthropic/OpenAI/Ollama streaming. |
| LLM providers | Anthropic Messages API, OpenAI Responses API, **Ollama** (already configured in `.env`) | |
| Agent loop | Reimplement the tool-use loop in Rust, OR embed `@anthropic-ai/claude-agent-sdk` via a Node sidecar | If the point is Rust learning, **build the loop in Rust**. |
| DB | **SQLite via `sqlx`** | Agent sessions, message history, tool logs. Matches Cursor's `vscode-sqlite3`. Postgres in `.env` is fine for backend service. |
| State store | **`rocksdb`** or plain SQLite | Snapshot cache, merkle nodes. |
| File watching | **`notify`** | Column C file explorer live updates. |
| Voice dictation | **whisper.cpp** via Rust bindings or cloud Whisper | Voice input button. |
| Global search | **nucleo** (the fuzzy finder used by Helix) | Command bar — matches the palette screenshot. |

---

## 3. Workspace layout

```
voidlink/
├── src-tauri/                   # Rust backend (Tauri v2)
│   ├── Cargo.toml               # workspace root
│   ├── src/
│   │   ├── main.rs              # Tauri setup, command registry
│   │   ├── ipc/                 # Tauri commands + event channels (typed)
│   │   ├── agents/              # agent loop, tool dispatch
│   │   ├── llm/                 # provider adapters (Anthropic/OpenAI/Ollama)
│   │   ├── tools/               # tool implementations (fs, shell, browser, git…)
│   │   ├── sessions/            # message history, turns, resumable runs
│   │   ├── workspace/           # current repo, cwd, config
│   │   └── events.rs            # broadcast bus → UI
│   └── crates/                  # internal library crates
│       ├── file-service/        # retrieval, cursorignore, search
│       ├── codebase-snapshot/   # merkle-tree snapshots of repos
│       ├── merkle-tree/         # content-addressed tree
│       ├── gix-snapshot/        # git-aware snapshot diffs
│       ├── sandbox-helper/      # standalone binary (bubblewrap/landlock/seccomp)
│       ├── pty-service/         # portable-pty wrapper per terminal tab
│       ├── browser-service/     # CDP driver for the web tab
│       ├── git-service/         # gix-backed git ops
│       └── proto/               # shared types (prost if you go gRPC; otherwise serde)
├── frontend/                    # SolidJS
│   └── src/
│       ├── app/
│       │   ├── layout/          # 3-column tiling, split H/V, remove from tileset
│       │   ├── titlebar/
│       │   └── command-bar/     # global palette (nucleo-backed)
│       ├── column-a/            # agents list, workspaces, settings
│       ├── column-b/            # agent conversation + chat input + mode picker
│       │   ├── MessageStream.tsx
│       │   ├── ToolCallCard.tsx
│       │   ├── DiffPreview.tsx
│       │   └── Composer.tsx
│       ├── column-c/            # tabs: files, terminal, browser, canvas, git
│       │   ├── FileExplorer.tsx
│       │   ├── Terminal.tsx     # xterm.js
│       │   ├── Browser.tsx      # webview tab
│       │   ├── Canvas.tsx       # live TSX artifact host
│       │   └── Git.tsx          # diff + tree + PR
│       ├── api/                 # Tauri invoke wrappers, event subscriptions
│       └── state/               # Solid stores
└── backend/                     # optional FastAPI sidecar (kept from current repo)
```

---

## 4. Core architecture — the agent loop

Single Rust state machine per active agent session.

```rust
// src-tauri/src/agents/loop.rs (sketch)
pub async fn run_agent(session: SessionId, user_msg: String, ctx: AgentCtx) -> Result<()> {
    let mut msgs = ctx.sessions.load(session).await?;
    msgs.push(Message::user(user_msg));

    loop {
        // Stream model response (SSE / chunked).
        let stream = ctx.llm.chat_stream(&msgs, &ctx.tools.schemas()).await?;
        let (assistant_msg, tool_calls) = ctx.events.pipe(session, stream).await?;
        msgs.push(assistant_msg);

        if tool_calls.is_empty() { break; }

        // Dispatch each tool call in parallel where safe; awaiting human approval
        // for gated tools (git push, shell with side effects, network).
        for call in tool_calls {
            let approval = ctx.gate.check(&call).await?;
            if approval.requires_user { ctx.events.ask_user(session, &call).await?; }
            let result = ctx.tools.dispatch(call, &ctx).await?;
            msgs.push(Message::tool_result(result));
        }
    }
    ctx.sessions.persist(session, &msgs).await?;
    Ok(())
}
```

Key invariants:

- **All model/tool events flow over one typed Tauri event channel** so column B can render deterministically.
- **Tool dispatch is a trait** (`Tool`) with JSON-schema declared inputs/outputs; a registry maps name → impl.
- **Gating** is a first-class concept: per-tool policy (allow / prompt / deny) matches the "human validation" requirement for git ops in column C.

---

## 5. Tool catalog (minimum viable set)

Mirrors Cursor's `cursor-*` extensions translated to Rust tools:

| Tool | Cursor analogue | Impl crate |
|---|---|---|
| `fs.read` / `fs.write` / `fs.edit` | cursor-file-service | `file-service` |
| `fs.search` (ripgrep) | cursor-retrieval | `grep-searcher`, `ignore` |
| `fs.symbol_search` | cursor-retrieval | `tree-sitter` + `tantivy` |
| `shell.exec` | cursor-agent-exec | `pty-service` + `sandbox-helper` |
| `git.diff` / `git.commit` / `git.branch` / `git.pr` | cursor-checkout, cursor-commits | `git-service` (gix) |
| `git.worktree` | cursor-shadow-workspace | gix worktree support |
| `browser.navigate` / `browser.click` / `browser.read` | cursor-browser-automation | `browser-service` (chromiumoxide / CDP) |
| `web.fetch` | — | reqwest |
| `canvas.render` | cursor-agent-exec canvas-runtime | dynamic TSX in a sandboxed webview |
| `mcp.*` | cursor-mcp | rmcp (Rust MCP SDK) |

---

## 6. Column C features → Rust services

- **File explorer** — `notify` watcher + lazy directory scan. IPC: `fs.list`, `fs.watch` (stream).
- **Terminal** — one `portable-pty` per tab; stream stdout/stderr as events; input via command.
- **Web browser** — additional Tauri `WebviewWindow` anchored inside the tab; expose navigate/back/reload/star via IPC. For automation, spawn headless Chromium via `chromiumoxide` or control the embedded webview through its own debug protocol.
- **Canvas** — a sandboxed child webview loading agent-authored TSX bundled on the fly (esbuild binary or SWC via `swc_core`). Expose a narrow API surface (`ui-primitives`, `chart-primitives`, `diff-view`, `todo-list`) as Cursor does.
- **Git** — all reads via `gix`; writes (commit/push) through the CLI `git` fallback or `gix`'s experimental write paths. Live diff renders in the right pane via CodeMirror 6 merge addon. PR creation uses the `gh` CLI or the GitHub REST API via `octocrab`.

---

## 7. Sandbox (direct port of `cursorsandbox`)

Sub-binary under `crates/sandbox-helper` (standalone, not a library). Rebuilds the same topology:

```
sandbox/src/
├── main.rs                 # clap CLI: --profile, --cwd, --cmd, --proxy-port
├── linux/
│   ├── mod.rs
│   ├── planning.rs         # resolve profile → concrete rules
│   ├── mount.rs            # bind mounts, tmpfs for writable roots
│   ├── bubblewrap.rs       # spawn via `bwrap` or reimplement the clone+unshare dance
│   ├── landlock.rs         # landlock_ruleset for FS access
│   └── discover.rs         # detect kernel features, distro quirks
├── network/
│   ├── proxy.rs            # hyper-based HTTP+SOCKS proxy, stdout = logs
│   ├── socks.rs            # SOCKS5 handshake
│   ├── matcher.rs          # domain/CIDR allow/deny
│   ├── policy.rs           # load policy from agent config
│   ├── forwarder.rs        # upstream connection pool
│   ├── env.rs              # inject HTTP_PROXY/NO_PROXY
│   ├── util.rs
│   └── logging.rs
```

Crates to pull in (verbatim with Cursor): `tokio`, `hyper`, `clap`, `seccompiler`, `nix`, `ignore`, `chrono`, `serde_json`. Profiles encode: read-roots, write-roots, allowed syscalls, network allowlist. Agent's `shell.exec` always goes through this binary.

---

## 8. Retrieval / code understanding (direct port of `@anysphere/file-service`)

Crate plan:

- `crates/merkle-tree` — content hash tree over workspace files; detect changed subtrees O(log n) on save.
- `crates/codebase-snapshot` — point-in-time indexed state; diffs between snapshots power "what did the agent change".
- `crates/gix-snapshot` — git-aware snapshot that understands HEAD/index/worktree.
- `crates/cursorignore` — extend `.gitignore` semantics with custom rules (`.cursorignore` analogue).
- `crates/file-service` — napi-like facade: `index(workspace)`, `search(q, mode=lexical|semantic|hybrid)`, `symbols(path)`, `watch(workspace) -> stream<FsEvent>`. But expose it as a Tauri command set, not via N-API.

Search modes:
- **Lexical** — tantivy index per workspace.
- **Grep** — direct `grep-searcher`.
- **Semantic** — embed file chunks (Ollama `nomic-embed-text` already in your `.env`), store in LanceDB.
- **Hybrid** — score-fuse lexical + semantic (RRF).

---

## 9. LLM provider abstraction

```rust
// src-tauri/src/llm/mod.rs
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat_stream(
        &self,
        msgs: &[Message],
        tools: &[ToolSchema],
        opts: ChatOpts,
    ) -> Result<BoxStream<'static, LlmEvent>>;
}

pub enum LlmEvent {
    TextDelta(String),
    ToolCallStart { id: String, name: String },
    ToolCallArgsDelta { id: String, delta: String },
    ToolCallEnd { id: String },
    UsageDelta(Usage),
    Done { stop_reason: StopReason },
}
```

Implementations: `AnthropicProvider`, `OpenAiProvider`, `OllamaProvider`. All SSE-parsed with a shared `reqwest` + `eventsource-stream`.

Prompt caching (Anthropic): mark system prompt + tool schemas with `cache_control: { type: "ephemeral" }` on every call — 90% cost reduction on loops is non-optional for this class of app.

---

## 10. Agent modes (Plan / Ask / Debug) — from the palette

Mode = preset that changes the system prompt + tool gating:

- **Plan** — read-only tools; produces a structured plan doc in the canvas tab, no writes.
- **Ask** — Q&A, `fs.read` + `fs.search` only, no execution.
- **Debug** — full toolset + extra logging, stack traces surfaced to the UI, ephemeral branch for edits.

Config lives in `~/.voidlink/modes/*.toml`. Custom agents in column A (codex / claude-code / custom) = mode + system prompt + tool allowlist + default model.

---

## 11. IPC contract (Tauri v2)

One typed bridge:

- `ts-rs` derives TS types from Rust structs → checked in under `frontend/src/api/generated/`.
- Commands: `agents.start`, `agents.cancel`, `agents.list`, `sessions.get`, `tools.approve`, `workspace.open`, `fs.list`, `fs.search`, `terminal.spawn`, `terminal.write`, `git.status`, `git.diff`, `git.commit_pr`, etc.
- Events (server → client): `session.event` (one channel, tagged union: `TextDelta | ToolCall | ToolResult | Approval | Error | Done`).
- Use **Tauri channels** (`Channel<T>`) per session, not global emit, so tearing down a session is trivial.

---

## 12. Build order (suggested)

A staged plan you can actually finish:

1. **Tauri skeleton + 3-column layout + tile manager.** Command palette with nucleo. No backend yet.
2. **LLM provider (Ollama first, since it's local and zero-auth).** Chat in column B, no tools. Streams text.
3. **Tool trait + first two tools: `fs.read`, `fs.search`.** Render tool cards in column B.
4. **File explorer in column C** on top of the same `fs.*` tool set.
5. **Terminal tab** via `portable-pty`. Separate command: `shell.exec` (tool) vs. interactive terminal (user).
6. **Git service with gix** — status + diff viewer. Then branch/commit/PR with human validation gate.
7. **Sandbox helper binary.** Route `shell.exec` through it.
8. **Retrieval crates** — merkle + tantivy + hybrid search. Adds `fs.symbol_search`.
9. **Browser tab** — start with manual navigation; add `browser.*` tools after.
10. **Canvas** — last; needs a TSX bundler + sandboxed webview + a restricted component library.
11. **Anthropic provider + tool-use streaming + prompt caching.** Now you have Cursor parity (minus the editor).
12. **Marketplace / custom agents / modes** — configuration UX.

Each step is independently runnable and teaches one concrete Rust subsystem.

---

## 13. Things to steal verbatim

From the Cursor extraction:

- Crate versions and choices — use the same (`gix`, `tokio`, `hyper`, `seccompiler`, `grep-searcher`, `aho-corasick`, `reqwest`, `tonic/prost` if you do gRPC).
- `@anthropic-ai/claude-agent-sdk` source inside the AppImage is readable JS — useful as a reference for the loop + tool schemas, even if you rewrite in Rust.
- The `packages/sandbox-helper/native/sandbox/src/` module layout.
- Internal crate split: `merkle_tree`, `codebase-snapshot`, `gix-snapshot`, `cursorignore`.
- Tool namespace conventions (`cursor.*` → `voidlink.*`).

## 14. Things NOT to copy

- Electron. You have Tauri; that's the point.
- The VSCode fork. You're building the agents app, not an editor.
- N-API bindings. Tauri IPC replaces that role entirely.
- gRPC between local components (tonic/prost) — useful only if you split into separate processes for a reason (e.g., running the sandbox helper remotely). Otherwise overkill.

---

## 15. Open questions to decide before coding

1. **In-process vs. out-of-process agent runner.** In-process (tokio task inside Tauri) is simpler. Out-of-process (separate `voidlink-agentd` binary over Unix socket) is closer to Cursor and survives UI restarts. Recommend starting in-process, extracting later if needed.
2. **Web browser tab implementation.** Tauri multi-webview is the cheap path; a real Chromium via CEF or chromiumoxide is the powerful path. Start multi-webview.
3. **Canvas TSX runtime.** Pre-compiled via `swc_core` in Rust (advanced) vs. shipping a minimal esbuild binary. The latter is simpler to prototype.
4. **How much of the UI ships as SolidJS components vs. configurable TSX agents render themselves.** Cursor lets agents render — this is a large API surface; defer to phase 2.

---

## 16. Reference files inside the extracted AppImage

For looking things up later:

- `squashfs-root/usr/share/cursor/resources/app/extensions/cursor-agent/dist/claude-agent-sdk/` — full SDK source, readable.
- `squashfs-root/usr/share/cursor/resources/app/resources/helpers/cursorsandbox` — Rust sandbox binary (strings give you the full module tree + crate versions).
- `squashfs-root/usr/share/cursor/resources/app/extensions/cursor-retrieval/node_modules/@anysphere/file-service/file_service.linux-x64-gnu.node` — Rust retrieval module (strings reveal crate list + internal names).
- `squashfs-root/usr/share/cursor/resources/app/product.json` — endpoints, feature flags, marketplace URLs (useful for discovering what backend services exist).
- `squashfs-root/usr/share/cursor/resources/app/extensions/cursor-agent-exec/dist/agent-sdk/cursor/canvas/*.d.ts` — the full typed surface of the canvas API (todo-list, chart-primitives, ui-primitives, diff-view, dag-layout, form-primitives, theme).

---

*End of blueprint. Start at step 1.*
