# Terminal Tab Close on Shell Exit

**Date:** 2026-03-19
**Status:** Approved

## Problem

When a user types `exit` (or presses Ctrl+D, or the shell crashes) in a terminal tab, the PTY process ends but the tab stays open showing a dead terminal. The tab must be closed automatically.

## Design

### Approach

Emit a `pty-exit:{sessionId}` Tauri event from Rust when the PTY reader thread detects EOF, listen for it in the frontend, display a message, then close the tab after a short delay.

### Changes

**`src-tauri/src/lib.rs`**

In the PTY reader thread, emit `pty-exit:{sessionId}` before breaking. Both `Ok(0)` (normal EOF) and `Err(_)` (e.g. macOS EIO on process death) indicate shell exit — both are handled together:

```rust
Ok(0) | Err(_) => {
    let _ = reader_app_handle.emit(&format!("pty-exit:{}", reader_session_id), ());
    break;
}
```

> Note: on macOS, `portable_pty` may emit `Err(EIO)` rather than `Ok(0)` when the child exits. This is normal and the two cases are intentionally treated identically. Transient EIO from `SIGWINCH` is unlikely in practice but would cause a spurious close; this is accepted as a low-risk edge case.

**`frontend/src/components/terminal/TerminalPane.tsx`**

- Add `onClose: () => void` to `TerminalPaneProps`
- Inside `initTerminal`, after the PTY is spawned, listen for `pty-exit:{sessionId}` and store the `unlisten` function
- On receipt:
  1. Write `\r\n\x1b[2m[Process completed]\x1b[0m\r\n` to xterm
  2. Schedule `onClose()` via `setTimeout` (1500ms), store the handle
- In the cleanup returned by `initTerminal`, call both `unlistenExit()` and `clearTimeout(exitTimeout)`
- Before calling `onClose()`, clear `sessionIdRef.current` to prevent the unmount `useEffect` from calling `close_pty` on an already-dead session

Cleanup ordering ensures:
- Manual close (Cmd+W) before shell exits → listener is unregistered, timeout is cancelled, `onClose` never fires again
- Shell exits while tab is still open → message shown, tab removed after delay, `close_pty` skipped via cleared `sessionIdRef`

**`frontend/src/App.tsx`**

Pass `onClose` to `TerminalPane` in `renderTabContent`. `tab.id` is stable for the lifetime of the tab, and `activeWorkspaceId` is captured fresh on each render of `renderTabContent`, so the closure is safe:

```tsx
<TerminalPane
  tab={tab as TerminalTab}
  onUpdateTab={(updates) => updateTab(activeWorkspaceId!, tab.id, updates as Partial<Tab>)}
  onClose={() => removeTab(activeWorkspaceId!, tab.id)}
/>
```

This wiring is identical for both the primary pane (`activeTab`) and the split pane (`splitTab`), since `removeTab` handles both cases correctly (promoting the split tab if the active one is removed, etc.).

### Behavior

- Covers all exit paths: `exit`, Ctrl+D, process crash
- Shows a dimmed `[Process completed]` message for 1.5s before closing
- No polling, no fragile input parsing
- All listeners and timers are cleaned up on manual close — no double-close or stale callbacks
- `close_pty` is not called twice: `sessionIdRef` is cleared before `onClose`, so the unmount path skips the Tauri call
