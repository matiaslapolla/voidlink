# Terminal Performance & UX — Session Changes

## Problem

The terminal tab had two critical issues:
1. **Extreme per-keystroke lag and stutter** while typing
2. **Shell prompt not visible** until pressing Enter after opening a terminal

## Root Causes

### 1. Sync Tauri commands blocking the IPC handler (main lag cause)

On Linux (WebKitGTK), synchronous `#[tauri::command]` functions run on the main IPC handler thread. Every PTY command (`write_pty`, `resize_pty`) and the `git_repo_info` polling command blocked this single thread.

The critical chain: `GitStatusBar` polled `git_repo_info` every 3 seconds, which internally calls `repo.statuses()` — a full working-tree scan that can take 100-500ms on large repos. While it ran, **all `write_pty` invocations queued up**, causing periodic keystroke lag bursts.

### 2. SolidJS `<For>` destroying terminal instances on CWD change

`handleCwdChange` in `TerminalView` replaced tab objects via `.map()`:
```ts
setTabs(prev => prev.map(t => t.id === id ? { ...t, title: dirname } : t))
```
SolidJS `<For>` tracks items by reference. Replacing the object caused it to **destroy the entire TerminalPane** (xterm disposal, PTY listener teardown) and recreate it from scratch on every command execution (via OSC 7 CWD report).

### 3. Race condition losing initial PTY output

The PTY was created in `TerminalView.addTerminal()` (spawning the shell immediately), but `TerminalPane` registered its event listener and Channel subscription asynchronously in `onMount`. By the time listeners were active, the initial prompt output had already been emitted and lost.

### 4. Unbounded git status polling

`GitStatusBar` ran `setInterval(refresh, 3000)` unconditionally — even while the terminal tab was active and git status was irrelevant.

### 5. ResizeObserver firing without coalescing or guards

The `ResizeObserver` callback called `fitAddon.fit()` + `invoke("resize_pty")` synchronously on every observation, with no deduplication of unchanged dimensions.

---

## Changes

### Rust — `src-tauri/src/lib.rs`

All PTY commands converted from sync to async with `spawn_blocking`:

| Command | Change |
|---------|--------|
| `create_pty` | `fn` → `async fn` + `spawn_blocking` |
| `write_pty` | `fn` → `async fn` + `spawn_blocking` |
| `resize_pty` | `fn` → `async fn` + `spawn_blocking` |
| `close_pty` | `fn` → `async fn` + `spawn_blocking` |
| `pty_subscribe` | `fn` → `async fn` (lightweight, no spawn_blocking needed) |

Pattern used:
```rust
#[tauri::command]
async fn write_pty(
    session_id: String,
    data: String,
    state: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = store.lock().map_err(|e| e.to_string())?;
        let session = s.get_mut(&session_id).ok_or("PTY session not found")?;
        std::io::Write::write_all(&mut *session.writer, data.as_bytes())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

This moves all blocking I/O (Mutex locks, PTY writes, process spawn/kill) off the main thread onto tokio's blocking thread pool.

### Rust — `src-tauri/src/git/mod.rs`

`git_repo_info` converted to async:
```rust
pub async fn git_repo_info(...) -> Result<GitRepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git_repo_info_impl(repo_path))
        .await.map_err(|e| e.to_string())?
}
```

### Frontend — `TerminalView.tsx`

Separated mutable title state from immutable tab identity:

```ts
// Before: title baked into tab object — mutating it triggers <For> recreation
const [tabs, setTabs] = createSignal<{ id; ptyId; title }[]>([]);

// After: titles tracked separately — tab objects are never replaced
const [tabs, setTabs] = createSignal<{ id; ptyId }[]>([]);
const [tabTitles, setTabTitles] = createSignal<Record<string, string>>({});
```

`handleCwdChange` now only updates `tabTitles`, so `<For>` never destroys TerminalPane instances.

### Frontend — `TerminalPane.tsx`

1. **ResizeObserver coalesced via `requestAnimationFrame`** with dimension tracking:
   ```ts
   let lastCols = 0, lastRows = 0;
   const ro = new ResizeObserver(() => {
     cancelAnimationFrame(resizeRaf);
     resizeRaf = requestAnimationFrame(() => {
       fitAddon.fit();
       if (term.cols !== lastCols || term.rows !== lastRows) {
         lastCols = term.cols; lastRows = term.rows;
         void invoke("resize_pty", { sessionId, cols: term.cols, rows: term.rows });
       }
     });
   });
   ```

2. **Ctrl+L sent after listeners are ready** to redraw the initial prompt:
   ```ts
   .finally(() => {
     replaying = false;
     for (const chunk of eventBuffer) term.write(chunk);
     eventBuffer.length = 0;
     void invoke("write_pty", { sessionId: props.ptyId, data: "\x0c" });
   });
   ```

### Frontend — `GitStatusBar.tsx`

Removed `setInterval(refresh, 3000)`. Replaced with a reactive effect that refreshes on tab switch:

```ts
createEffect(() => {
  if (!props.repoPath) return;
  void props.activeArea;  // track tab changes
  refresh();
});
```

### Frontend — `App.tsx`

Passes `activeArea` to `GitStatusBar`:
```tsx
<GitStatusBar repoPath={repoRoot()} activeArea={activeWorkspace()?.activeArea} ... />
```

---

## Files modified

| File | Type |
|------|------|
| `src-tauri/src/lib.rs` | PTY commands → async |
| `src-tauri/src/git/mod.rs` | git_repo_info → async |
| `frontend/src/components/terminal/TerminalView.tsx` | New file (tab manager) |
| `frontend/src/components/terminal/TerminalPane.tsx` | New file (xterm renderer) |
| `frontend/src/components/terminal/ShellIntegrationAddon.ts` | New file (OSC parser) |
| `frontend/src/components/git/GitStatusBar.tsx` | Remove polling, add activeArea prop |
| `frontend/src/App.tsx` | Pass activeArea to GitStatusBar |
