/// The catalog of statically-known action ids.
///
/// Two things depend on this list existing separately from the action objects
/// themselves. First, `keymap.ts` types its `actionId` field against it, so a
/// typo in a binding is a compile error rather than a shortcut that silently
/// does nothing. Second, the keymap unit test can assert every binding points
/// at a declared action without importing `App.tsx` (whose catalog is built
/// inside a component, closed over the layout store).
///
/// Dynamic ids are deliberately *not* here: the per-snapshot
/// `snapshot.restore.<name>` / `snapshot.delete.<name>` entries are generated
/// at runtime from user data and are never bound to a key.

export const WORKSPACE_SELECT_COUNT = 9;

/// `workspace.select.1` … `workspace.select.9`. Shared by the catalog in
/// `App.tsx` and the keymap so the two can never drift.
export function workspaceSelectId(oneBasedIndex: number): string {
  return `workspace.select.${oneBasedIndex}`;
}

export const ACTION_IDS = [
  // App
  "palette.open",
  "app.settings",
  "help.shortcuts",
  // File
  "file.open",
  "file.save",
  // Editor
  "editor.format-document",
  "editor.find-in-files",
  // Terminal
  "terminal.new",
  "terminal.repeat-last",
  // Git
  "git.refresh",
  "git.fetch",
  "git.pull",
  "git.remotes",
  "git.undo-last-commit",
  "git.compare",
  "git.open-window",
  "git.commit-graph",
  "git.ai-draft-commit",
  // Stack
  "stack.branch-on-top",
  "stack.restack-all",
  "stack.submit",
  "stack.open-tab",
  // View
  "ui.toggle-git-sidebar",
  "ui.toggle-left-sidebar",
  "ui.swap-sidebars",
  "ui.toggle-diff-mode",
  "ui.toggle-ignore-ws",
  "view.toggle-blame",
  // AI
  "agent.toggle",
  // Workspace
  "workspace.new",
  "workspace.next",
  "workspace.prev",
  "workspace.select.1",
  "workspace.select.2",
  "workspace.select.3",
  "workspace.select.4",
  "workspace.select.5",
  "workspace.select.6",
  "workspace.select.7",
  "workspace.select.8",
  "workspace.select.9",
  "snapshot.save",
  // Tabs
  "tab.close",
  "tab.next",
  "tab.prev",
  "tab.reopen-last",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];
