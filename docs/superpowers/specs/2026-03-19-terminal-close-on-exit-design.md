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
In the PTY reader thread, emit a `pty-exit:{sessionId}` event before breaking on `Ok(0)` or `Err(_)`:

```rust
Ok(0) | Err(_) => {
    let _ = reader_app_handle.emit(&format!("pty-exit:{}", reader_session_id), ());
    break;
}
```

**`frontend/src/components/terminal/TerminalPane.tsx`**
- Add `onClose: () => void` to `TerminalPaneProps`
- After PTY is spawned, listen for `pty-exit:{sessionId}`
- On receipt: write `\r\n\x1b[2m[Process completed]\x1b[0m\r\n` to xterm, then call `onClose()` after 1500ms

**`frontend/src/App.tsx`**
Pass `onClose` to `TerminalPane` in `renderTabContent`:

```tsx
onClose={() => removeTab(activeWorkspaceId!, tab.id)}
```

### Behavior

- Covers all exit paths: `exit`, Ctrl+D, process crash
- Shows a dimmed `[Process completed]` message for 1.5s before closing
- No polling, no fragile input parsing
