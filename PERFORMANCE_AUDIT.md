# VoidLink Performance Audit

*Generated: 2026-04-12*

---

## Frontend (SolidJS / Vite / Tailwind)

### Critical — Likely to Cause Jank or Freezes

#### 1. No virtualization on CodeView (FileEditor)

**`frontend/src/components/editor/FileEditor.tsx:486–528`**

5000-line files render 15,000+ DOM nodes (gutter line numbers, change indicators, highlight overlays). `getBlameForLine` at line 325 does `blameData().find(...)` — a linear O(m) scan — called reactively inside `<Show>` for every line's hover check. With large files this compounds to O(lines × blame_hunks).

**Fix:** Virtualize with `@tanstack/solid-virtual`. Pre-index blame data into a `Map<lineNo, BlameInfo>` for O(1) lookup.

---

#### 2. No Vite chunk splitting

**`frontend/vite.config.ts`**

No `build.rollupOptions.output.manualChunks` configured. Heavy deps land in the initial bundle:
- `three.js` (~600KB) via `3d-force-graph`
- `xterm.js` + addons (~200KB)
- `shiki` (~400KB with grammars)
- `TipTap` + extensions (~180KB)
- `d3-force` / `force-graph` (~120KB)

**Fix:** Add manual chunks:
```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-three': ['three', '3d-force-graph'],
        'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-webgl'],
        'vendor-shiki': ['shiki'],
        'vendor-tiptap': ['@tiptap/core', '@tiptap/starter-kit', '@tiptap/pm'],
        'vendor-force': ['force-graph', 'd3-force'],
      }
    }
  }
}
```

---

#### 3. Resize handlers fire at display refresh rate

**`frontend/src/components/layout/ResizeHandle.tsx:24–30`**
**`frontend/src/components/layout/BottomPane.tsx:24–28`**

`pointermove` handler calls `props.onResize(delta)` → store mutation → `createEffect` → `localStorage.setItem(JSON.stringify(...))` on every pointer event (120–165hz on high-refresh displays).

**Fix:** Wrap the move handler in `requestAnimationFrame` coalescing:
```ts
let rafId = 0;
const onMove = (ev: PointerEvent) => {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    const delta = ...;
    if (delta !== 0) props.onResize(delta);
  });
};
```

---

### High — Architecture / Correctness Issues

#### 4. `<Show>` destroys GraphView on subtab switch

**`frontend/src/components/repository/RepositoryView.tsx:161–188`**

`GraphView` (containing a force-directed canvas and simulation) is wrapped in `<Show>`. Switching subtabs destroys the canvas and re-runs the full simulation warmup (200 ticks). 

**Fix:** Use `display:none` toggling or `MountOnce` pattern (already used in `BottomPane.tsx`).

---

#### 5. Layout persistence has no debounce

**`frontend/src/store/layout.ts:221–235`**

`createEffect` serializes the entire layout state via `JSON.stringify` on every store mutation, including rapid tab switching and drag reorder.

**Fix:** Debounce with `setTimeout`:
```ts
let persistTimer: number;
createEffect(() => {
  const snapshot = { /* ... */ };
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(snapshot));
  }, 300);
});
```

---

#### 6. LSP listener leak

**`frontend/src/store/lsp-state.ts:84`**

`listen()` on LSP diagnostic events returns an unlisten function that is never stored or called. Every `ensureLspServer` call accumulates listeners.

**Fix:** Store the unlisten promise and call it before re-registering or on cleanup.

---

#### 7. Git fetch effect has no cleanup (data race)

**`frontend/src/components/layout/RightSidebar.tsx:86–93`**

```ts
createEffect(() => {
  const repo = props.repoPath;
  if (!repo) { setGitInfo(null); return; }
  gitApi.repoInfo(repo).then(setGitInfo).catch(() => setGitInfo(null));
});
```

If `repoPath` changes before the previous promise resolves, both are in flight and the last to resolve wins (not necessarily the latest).

**Fix:** Use an abort flag:
```ts
createEffect(() => {
  const repo = props.repoPath;
  if (!repo) { setGitInfo(null); return; }
  let cancelled = false;
  gitApi.repoInfo(repo).then(info => { if (!cancelled) setGitInfo(info); });
  onCleanup(() => { cancelled = true; });
});
```

---

### Medium — Optimization Opportunities

#### 8. Missing `batch()` in terminal state updates

**`frontend/src/components/terminal/TerminalView.tsx:29–56`**

`addTerminal` and `closeTab` each make 2–3 unguarded signal updates that fire separate reactive flushes.

**Fix:** Wrap in `batch()`.

---

#### 9. FileExplorer `dirHasChanges` is O(n) per directory node

**`frontend/src/components/layout/FileExplorer.tsx:148`**

```ts
for (const key of props.gitStatusMap.keys()) {
  if (key.startsWith(prefix)) return true;
}
```

Called per directory node per render. With many expanded dirs and many changed files, this is O(dirs × changedFiles).

**Fix:** Pre-compute a `Set<string>` of changed parent paths via `createMemo` on `gitStatusMap` change, then do O(1) lookup per node.

---

#### 10. `tabState()` creates new fallback object on every call

**`frontend/src/components/layout/CenterTabBar.tsx:36–40`**

Plain function (not `createMemo`) returns `{ tabs: [], activeTabId: "" }` when workspace isn't found — a new object reference every call, preventing `<For>` from short-circuiting.

**Fix:** Convert to `createMemo` with a stable fallback.

---

#### 11. Graph2D is eagerly imported

**`frontend/src/components/repository/GraphView.tsx:4`**

`Graph2D` (importing `force-graph` + `d3-force`) is statically imported despite being behind a sub-tab. `Graph3D` is correctly `lazy()`.

**Fix:** `const Graph2D = lazy(() => import("@/components/repository/Graph2D"));`

---

#### 12. `createEffect` used as `onMount` for keyboard listeners

**`LeftSidebar.tsx:153`, `BottomBar.tsx:28`, `BottomPanel.tsx:36`, `FileEditor.tsx:715`**

Effects that register keyboard listeners but read no reactive signals — should use `onMount` + `onCleanup`.

---

#### 13. Module-level signals outside reactive owners

**`FileExplorer.tsx:55–56`, `store/theme.ts:115`, `store/terminal-bridge.ts:4`, `store/editor-settings.ts:25`, `store/lsp-state.ts:14–17`**

Signals created at module evaluation time without a reactive root. Won't be garbage collected and produces dev-mode warnings.

**Fix:** Wrap in `createRoot` or move to store-level state.

---

## Backend (Rust / Tauri)

### Critical

#### 1. Sync git commands block async executor

**`src-tauri/src/git/mod.rs:173–344`**

All git commands except `git_repo_info` are synchronous `fn`, not `async fn`. `git_push` does real network I/O on Tokio's runtime thread. If git operations are slow, the UI freezes.

**Fix:** Wrap all git commands with `tauri::async_runtime::spawn_blocking`, or convert to `async fn` with `spawn_blocking` internally.

---

#### 2. Full chunk table scan on every search

**`src-tauri/src/migration/search.rs:26–35`**

```sql
SELECT ... FROM chunks c INNER JOIN files f ON f.id = c.file_id WHERE f.repo_id = ?1
```

Returns every chunk in the repo to Rust for in-memory filtering. No FTS index.

**Fix:** Add a SQLite FTS5 virtual table on `chunks.content`. Use `WHERE rowid IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?)`.

---

#### 3. SQLite connection opened per operation

**`src-tauri/src/migration/db.rs:116–123`**

`SqliteStore::open()` creates a new `Connection` and sets 2 PRAGMAs on every call. Called hundreds of times during a repo scan.

**Fix:** Keep a persistent connection (behind `Mutex` or use `r2d2-sqlite`). Batch PRAGMA setup into `execute_batch`.

---

### High

#### 4. GitState.path_cache is dead code

**`src-tauri/src/git/mod.rs:32–40`**

`path_cache: Arc<Mutex<HashMap<String, PathBuf>>>` is never read or written. `_state: tauri::State<GitState>` is passed to every git command but never accessed. `Repository::discover()` walks the directory tree on every invocation.

**Fix:** Implement the cache (store discovered repo paths) or at minimum use `Repository::open()` with a known path.

---

#### 5. Blocking reqwest inside sync Tauri commands

**`src-tauri/src/migration/provider.rs:1`, `src-tauri/src/git/diff.rs:86`**

`reqwest::blocking::Client` used for LLM calls inside synchronous commands. Each call uses `tokio::task::block_in_place` which can starve the Tokio runtime under concurrent load.

**Fix:** Switch to `reqwest`'s async API. Make the migration commands `async fn`.

---

#### 6. `git_repo_info` runs full status scan for a boolean

**`src-tauri/src/git/repo.rs:21–27`**

`repo.statuses()` with `recurse_untracked_dirs(false)` just to check `statuses.is_empty()` for the `is_clean` field. Triggers a full working-tree diff.

**Fix:** Use a cheaper check or make `is_clean` opt-in / lazy.

---

### Medium

#### 7. No release profile in Cargo.toml

**`src-tauri/Cargo.toml`**

Missing `[profile.release]`. Defaults are `lto = false`, `codegen-units = 16`.

**Fix:**
```toml
[profile.release]
lto = "thin"
codegen-units = 1
strip = true
```

---

#### 8. `agent_get_scrollback` copies 512KB while holding mutex

**`src-tauri/src/agent_runner/session.rs:131–144`**

Entire `VecDeque<u8>` scrollback copied to `Vec<u8>` while blocking all scrollback writes.

**Fix:** Use `Arc<RwLock<VecDeque<u8>>>` so reads don't block the writer, or return only a delta since last read.

---

#### 9. `upsert_repo` has TOCTOU race

**`src-tauri/src/migration/db.rs:126–158`**

Read-then-write without a transaction across two separate connections.

**Fix:** Use `INSERT ... ON CONFLICT DO UPDATE` in a single statement (already used for file upserts in `scan.rs:138`).

---

#### 10. Full embeddings table scan

**`src-tauri/src/migration/search.rs:159–190`**

`load_chunk_embeddings` scans all embeddings filtered only by `model`, then does `HashSet` lookup to keep wanted ones.

**Fix:** Add an index on `embeddings(owner_type, model, owner_id)`.

---

#### 11. Unbounded agent events cloned on every status poll

**`src-tauri/src/git_agent/mod.rs:53`**

`AgentTaskState.events: Vec<AgentEvent>` grows unbounded. `git_agent_status` clones the entire struct including all events.

**Fix:** Return only events since last poll (cursor-based), or cap the vec.

---

#### 12. LSP `send_request` blocks 5s on sync command thread

**`src-tauri/src/lsp/server.rs:174–194`**

`rx.recv_timeout(Duration::from_secs(5))` blocks the Tauri command thread.

**Fix:** Make the LSP commands async and use `tokio::sync::oneshot`.

---

#### 13. PTY reader allocates on every read

**`src-tauri/src/lib.rs:233`, `src-tauri/src/agent_runner/session.rs:107`**

`buf[..n].to_vec()` on every PTY read (up to 64KB each). Then a second traversal to copy into scrollback `VecDeque`.

**Fix:** Use `bytes::Bytes` for zero-copy sharing between channel send and scrollback append.

---

#### 14. `commit_sha` double-formats OID in blame loop

**`src-tauri/src/git/blame.rs:51–58`**

```rust
let commit_sha = format!("{}", commit_oid)[..8.min(format!("{}", commit_oid).len())].to_string();
```

Formats the OID twice. Also, `repo.find_commit(commit_oid)` is called per hunk with no dedup.

**Fix:** Format once: `commit_oid.to_string()[..8].to_string()`. Cache commit lookups in a `HashMap<Oid, CommitInfo>`.

---

## Recommended Priority

### Phase 1 — Quick Wins
1. Add `[profile.release]` to Cargo.toml
2. Add `manualChunks` to vite.config.ts
3. Wrap git commands with `spawn_blocking`
4. Debounce localStorage persistence
5. Add rAF throttle to resize handlers
6. Lazy-load `Graph2D`

### Phase 2 — Medium Effort
7. Keep GraphView alive (MountOnce / display:none)
8. Cache Repository handles in GitState
9. Pool SQLite connections
10. Fix LSP listener leak
11. Add `batch()` to terminal state updates

### Phase 3 — Larger Refactors
12. Virtualize CodeView for large files
13. Add FTS5 index for search
14. Migrate blocking reqwest to async
15. Pre-compute changed parent paths in FileExplorer
16. Convert workspace state to `createStore`
