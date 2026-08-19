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
/// `snapshot.restore.<name>` entries are generated at runtime from user data
/// and are never bound to a key.

export const WORKSPACE_SELECT_COUNT = 9;

/// `workspace.select.1` … `workspace.select.9`. Shared by the catalog in
/// `App.tsx` and the keymap so the two can never drift.
export function workspaceSelectId(oneBasedIndex: number): string {
  return `workspace.select.${oneBasedIndex}`;
}

/// Jump-to-tab-N in the focused pane group. Nine, for the same reason the
/// workspace slots are nine: that is how many chords a digit row has.
export const TAB_SELECT_COUNT = 9;

/// `tab.select.1` … `tab.select.9`, generated the way `workspaceSelectId` is so
/// the catalog in `App.tsx` and the keymap cannot drift. `tab.select.last` is
/// spelled out in `ACTION_IDS` rather than generated — it is one id, not a
/// family.
export function tabSelectId(oneBasedIndex: number): string {
  return `tab.select.${oneBasedIndex}`;
}

export const ACTION_IDS = [
  // App
  "palette.open",
  "app.settings",
  "help.shortcuts",
  // File
  "file.open",
  "file.new",
  "file.save",
  // Editor
  "editor.format-document",
  "editor.find-in-files",
  "editor.split-right",
  "editor.split-down",
  "editor.close-group",
  "editor.focus-next-group",
  "editor.go-to-symbol",
  "editor.go-to-definition",
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
  // The ⌘\ mirror. Kept its id through the dock rework: from the user's side
  // the gesture is unchanged — every panel moves to the opposite edge — and a
  // rename would take the chord away from everyone who already has it.
  "ui.swap-sidebars",
  "ui.toggle-workspace-rail",
  // Detach, per sidebar. Palette-only: which panel you want in a window is a
  // choice, and more chords for rare choices is how a keymap stops being
  // learnable. `ui.detach-workspaces` and `ui.detach-terminals` are
  // deliberately absent — neither is detachable (see `SIDEBAR_WINDOW_LABEL`),
  // and these ids are generated from that same table in `App.tsx`, so this
  // list has to name exactly what it can produce.
  //
  // `ui.detach-files` became `ui.detach-explorer` with the sidebar's rename.
  // Unlike `ui.swap-sidebars`, which kept its id to keep its chord, nothing was
  // ever bound to this one — so there is no chord to protect and no reason to
  // keep a name that no longer matches the panel.
  "ui.detach-explorer",
  "ui.detach-git",
  "ui.detach-agents",
  // The editor window's way home. The sidebars get theirs from the
  // `ui.detach-*` rows above, which toggle; the editor has no detach of its
  // own — it is opened by whatever puts a file in it — so re-attaching is the
  // only half of that pair it needs.
  "ui.attach-editor",
  "ui.toggle-diff-mode",
  "ui.toggle-ignore-ws",
  "ui.maximize-pane",
  // Panes. Splitting used to be reachable only by dragging a tab onto a pane
  // edge, and closing a pane or undoing a split was reachable by nothing at
  // all — `closePaneGroup` and `resetPaneLayout` existed in the store with no
  // caller, so the only way out of a split was Settings → Reset layout, which
  // also throws away every open tab.
  "ui.split-pane-right",
  "ui.split-pane-down",
  "ui.close-pane",
  "ui.focus-next-pane",
  "ui.reset-pane-layout",
  "ui.toggle-tab-group",
  "ui.zen",
  "ui.navigate-back",
  "ui.navigate-forward",
  "view.toggle-blame",
  // The two surfaces you open rather than toggle. Declared here — with no
  // keymap entry — because ⌘P now reaches commands as well as files, and these
  // are two of the "open a thing" answers a user types into it: without a
  // declaration a typo in a future binding for either would be a shortcut that
  // silently does nothing, which is the whole reason this list exists.
  //
  // Deliberately chordless. Both are rare enough that a chord would cost more
  // than it buys — the same call `ui.detach-*` and `stack.restack-all` already
  // make — and `primaryChordFor` returning `undefined` renders as a palette row
  // with no accelerator, which is a supported state.
  "board.open",
  "browser.new",
  // Remote roots. Chordless for the same reason `board.open` is: connecting to
  // a machine is a once-a-session act, and the picker behind it is where the
  // choice actually gets made. The per-session ids the disconnect flow works
  // over are runtime data (like `snapshot.restore.<name>`) and stay out of here.
  "remote.connect",
  "remote.disconnect",
  // AI
  "agent.toggle",
  "agent.newTab",
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
  "workspace.switch",
  "snapshot.save",
  "snapshot.manage",
  // Layout — named arrangements, and how tab groups are decided. The
  // per-preset apply/rename/delete ids are generated at runtime from user data
  // (like `snapshot.restore.<name>`) and are deliberately not declared here.
  "layout.preset.save",
  "layout.autogroup.off",
  "layout.autogroup.kind",
  "layout.autogroup.worktree",
  // Tabs
  "tab.close",
  "tab.next",
  "tab.prev",
  "tab.reopen-last",
  "tab.mru-next",
  "tab.mru-prev",
  "tab.switch",
  "tab.select.1",
  "tab.select.2",
  "tab.select.3",
  "tab.select.4",
  "tab.select.5",
  "tab.select.6",
  "tab.select.7",
  "tab.select.8",
  "tab.select.9",
  "tab.select.last",
  // Settings
  "settings.goto",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];
