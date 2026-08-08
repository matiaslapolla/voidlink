# Stream B — detached parts have a way home

Branch: `feat/detach-lifecycle`, cut from `feat/five-sidebars`. Merge second.

```text
<context>
VoidLink runs several windows out of one bundle: `main` (the workbench), `git`,
`editor`, and `panel-*` windows that host a detached sidebar. `main.tsx` picks a
root by `getCurrentWindow().label`.

Detaching works. Everything after detaching does not:

  • Closing a detached window or a detached sidebar crashes the app.
  • A detached part that is closed vanishes rather than returning to the shell.
    The user's ask is explicit: closing it should put it back in the main
    window, collapsed.
  • There is no re-attach affordance beyond the sidebar header menu's "Dock
    back", and the editor and git windows have none at all.
  • Switching the environment mode from detached to stacked in Settings leaves
    the detached windows floating. Stacked mode means "everything is a view in
    one window", so it must pull them home.

The crash is the entry point. `close_satellite` calls `window.close()` while the
frontend's own `dockSidebarBack` may already have cleared the flag, and
`useSidebarWindows` listens for a dock-back event that the closing window emits
during its own teardown — a close initiated from either side can re-enter the
other. Diagnose it for real before changing behaviour; do not paper over it with
a try/catch.
</context>

<task>
1. Fix the crash. Find the actual failure (Rust panic, a webview torn down
   mid-IPC, a listener firing against a disposed Solid root, a re-entrant
   close) and fix that. State in a code comment what it was.

2. Make closing a detached part return it to the shell, **collapsed**:
   - a `panel-*` window → its sidebar reappears at its old edge and width, in
     the collapsed (icon-rail) state;
   - the `editor` window → the editor comes back as a tab in the workbench;
   - the `git` window → the git sidebar reappears, collapsed.
   Collapsed rather than expanded because a window the user just closed should
   not seize a column of the workbench they were using.

3. Give every detached part a re-attach affordance that does not require
   finding the original panel: a row in the detached window's own chrome
   ("Attach to main window"), and a command-palette action.

4. When `settings.ui.environmentMode` changes to stacked, close every open
   satellite and panel window and re-home its content. Switching back to
   detached must NOT reopen them — the user gets a workbench with everything
   inside it and reopens what they want.
</task>

<reuse>
- `frontend/src/commands/sidebarWindows.ts` — `canDetachSidebar`,
  `detachSidebar`, `dockSidebarBack`, `useSidebarWindows`. The whole
  flag-before-window ordering and its rationale is documented at the top of this
  file; keep it, and extend it rather than writing a second lifecycle.
- `frontend/src/api/windows.ts` — `SIDEBAR_WINDOW_LABEL`, `openSidebarWindow`,
  `closeSidebarWindow`, `isSidebarWindowOpen`, `onSidebarDockBack`,
  `openEditorWindow`, `openGitWindow`, and the cross-window event protocol
  documented in its header comment.
- `src-tauri/src/window.rs` — `open_satellite`, `close_satellite`,
  `focus_window`, `PANEL_SPECS` / `panel_spec`, `FILES_PANEL_WINDOW_LABEL`,
  `open_panel_window` / `close_panel_window` / `is_panel_window_open`. The
  allowlist exists so a free-form label cannot build a window with no
  capability entry — Stream A's new sidebars need entries here and in
  `src-tauri/capabilities/panel-windows.json`, not a relaxed allowlist.
- `frontend/src/commands/environment.ts` — `isStackedMode`.
- `frontend/src/store/layout/dock.ts` — `detachedSidebars` and its parser.
- `frontend/src/store/layout/prefs.ts` — the collapse flags each sidebar uses
  (`gitSidebarCollapsed`, `leftSidebarCollapsed`, `workspaceRailCollapsed`,
  `sidebarSections`). "Return collapsed" is setting the one that already exists,
  not inventing a new state.
- `frontend/src/commands/registry.ts` + `commands/actionIds.ts` — every new
  affordance registers an action so the button, the chord and the palette row
  are one code path. This repo is consistent about that; match it.
</reuse>

<constraints>
- Read `frontend/src/api/windows.ts`'s header before writing any cross-window
  message. The four things that cross the gap are enumerated there and the
  reason each is one-directional is stated. A re-attach that makes a satellite
  a second writer of layout state breaks that model.
- Query context7 for `@tauri-apps/api` v2 (`resolve-library-id` →
  `query-docs`) on window lifecycle before touching it: `onCloseRequested`
  versus the `destroyed` event, whether `close()` is preventable, and what a
  closing webview may still emit. Rust is pinned at `tauri = "=2.11.2"` and JS
  at `@tauri-apps/api ^2.10.1`. Your training data on Tauri v2 window events
  lags; do not guess this one.
- The crash fix must be a fix, not a swallow. A `catch {}` that hides a panic is
  not acceptable here even though `dockSidebarBack` legitimately has one for the
  already-gone case.
- The workbench body must never remount — live PTYs hang off it. Re-homing a
  panel changes a flag; it does not rebuild `AppShell`'s tree.
- Follow `frontend/design-system/MASTER.md` §7.6: the re-attach control states
  what it does, and any disabled variant states why.
- Solid, not React. No raw colour literals in `src/components/**`.
- Build exactly this stream. Do not touch `TabStrip.tsx`, the pane tree, the
  board, or the CSS background layer.
</constraints>

<assumptions>
- "Collapsed" means the existing icon-rail state, not hidden. The panel is
  visibly present at `SIDEBAR_RAIL_WIDTH` and one click expands it.
- The editor window returning "as a tab" means the workbench opens whatever the
  editor window had focused, using the existing `EditorTabsSnapshot` the
  workbench already owns. It does not mean embedding the editor window's root.
- Closing the last workbench window still quits the app; this stream does not
  change that.
</assumptions>

<out_of_scope>
- Adding new detachable surfaces beyond the five sidebars Stream A defines.
- Changing what the editor or git windows *contain*.
- Reworking stacked mode's own layout (`ViewSwitcher`); this stream only makes
  the transition into it correct.
- Persisting window position/size across a detach cycle.
- The `⌘\` mirror chord.
</out_of_scope>

<acceptance>
- Closing each of: a detached panel window, the editor window, the git window —
  no crash, and the content is back in the workbench collapsed. Test each.
- A detached sidebar's window closed by the OS (red traffic light) is
  indistinguishable in outcome from one closed by the in-app control.
- Re-attach is reachable from the detached window's own chrome and from the
  command palette, both running the same registered action.
- Switching to stacked mode with three things detached closes all three and
  homes all three. Switching back to detached reopens none.
- A persisted `detachedSidebars` naming a window this build cannot open results
  in the sidebar docked back, not a permanently collapsed empty slot — the
  existing boot behaviour in `useSidebarWindows`; keep its test.
- Unit tests for the state transitions in `sidebarWindows.ts` against the fake
  Tauri boundary (`frontend/src/test/tauri.ts` — `mockTauri`, `tauriCalls`,
  `emitTauriEvent`, `setTauriWindowLabel`). Do not add `vi.mock` factories for
  `@/api/windows`; the seam is `invoke`, and `setup.ts` installs it already.
- `cargo check` clean; `npm run test`, `npx vitest run --project browser`,
  `npx tsc --noEmit`, `npx eslint .` clean; `npm run build` succeeds.
</acceptance>
```
