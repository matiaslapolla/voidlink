# Inline Rename — Workspaces & Tabs

**Date:** 2026-03-19
**Status:** Approved

## Overview

Allow users to rename workspaces and tabs inline — double-click the name to edit it in place, the same way a Notion page title is edited. No modals, no extra buttons.

## Surfaces

| Surface | Component | What gets renamed |
|---|---|---|
| Global sidebar | `WorkspaceSidebar` | Workspace name |
| Top bar chips | `WorkspaceTopBar` | Workspace name |
| Tab strip | `WorkspaceTabStrip` | Notion tab title or Terminal tab title |

## Interaction Model

1. **Double-click** the name → replace label with a focused `<input>` pre-filled with the current name, selected all.
2. **Enter** or **blur** → confirm. Trim whitespace; fall back to the previous name if the result is empty.
3. **Escape** → cancel, restore original name without saving.
4. Only one item can be in edit mode at a time per component (tracked via local `editingId: string | null` state).

## State & Callbacks

### Workspaces

Add `renameWorkspace(id: string, name: string)` to `App.tsx`:

```ts
const renameWorkspace = useCallback((id: string, name: string) => {
  updateWsState((prev) => ({
    ...prev,
    workspaces: prev.workspaces.map((w) =>
      w.id === id ? { ...w, name } : w,
    ),
  }));
}, [updateWsState]);
```

Pass `onRenameWorkspace` prop to both `WorkspaceSidebar` and `WorkspaceTopBar`.

### Tabs

`updateTab(wsId, tabId, { title: newName })` already exists in `App.tsx`. Pass `onRenameTab` (wrapping `updateTab`) down to `WorkspaceTabStrip`.

## Component Changes

### `WorkspaceSidebar`

- Add prop: `onRenameWorkspace: (id: string, name: string) => void`
- Add local state: `editingId: string | null`, `editValue: string`
- On double-click of workspace row: set `editingId = ws.id`, `editValue = ws.name`
- Render an `<input>` in place of the `<span>` when `editingId === ws.id`

### `WorkspaceTopBar`

- Same prop and local state as above
- On double-click of workspace chip span: enter edit mode

### `WorkspaceTabStrip`

- Add prop: `onRenameTab: (id: string, title: string) => void`
- Add local state: `editingId: string | null`, `editValue: string`
- On double-click of tab title span: enter edit mode
- Works identically for both `notion` and `terminal` tab types

## Out of Scope

- Drag-and-drop reordering
- Rename via context menu or dedicated button
- Persistence beyond what `updateWsState` / `updateTab` already handle (localStorage write is automatic)
