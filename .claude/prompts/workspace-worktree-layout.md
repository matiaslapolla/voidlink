# Stream B — workspaces → worktrees → tabs

Branch: `feat/workspace-worktree-layout` · Worktree: `.worktrees/workspace-worktree-layout` · Merge order: **3rd** (largest diff)

---

<context>
voidlink is a local-first Tauri v2 + SolidJS git workbench. Today a "workspace" IS a repository: `Workspace { id, name, repoRoot }`, workspaces are horizontal tabs across the top (`WorkspaceTabBar.tsx`), and every tab collection in the store is a `Record<workspaceId, T[]>`. Git worktrees exist only as a list inside the git sidebar — opening one means creating a whole separate workspace, which loses the mental link between a repo and its worktrees.
The new model is a two-level hierarchy, like cmux: a vertical rail on the far left lists workspaces; each workspace is a repo (or a plain folder) and contains N worktrees; each worktree owns its own set of editor / terminal / browser tabs. A `+` inside the workspace's rail group creates a new worktree through a short wizard that handles the things that actually stop a fresh worktree from booting — gitignored env files and dependency directories.
This is the riskiest stream: it is a persisted-state migration across a 1464-line store. Everything else is cosmetic by comparison.
</context>

<task>
Restructure the app around workspaces → worktrees → tabs, in five phases, committing after each:

Phase 1 — Data model. Introduce `Worktree` and reshape `Workspace` to own a list of worktrees plus an active worktree id. A plain (non-repo) folder becomes a workspace with exactly one synthetic main worktree pointing at that folder.
Phase 2 — Store migration. Re-key every per-workspace tab collection in `frontend/src/store/layout.ts` to be per-worktree, with a versioned localStorage migration that preserves the user's currently open tabs.
Phase 3 — Vertical rail. Replace the horizontal `WorkspaceTabBar` with a vertical workspace rail on the far left; each workspace group lists its worktrees and carries a `+` button.
Phase 4 — New-worktree wizard. A small multi-step dialog driven by repository detection: which gitignored env files to copy, what to do about dependency directories, an optional post-create command, and per-repo saved defaults.
Phase 5 — Browser tab kind (separable; land phases 1–4 first and treat this as its own commit). Add a `browser` tab type backed by a real embedded Tauri child webview, cmux-style — not an iframe.
</task>

<reuse>
Frontend:
- `frontend/src/types/workspace.ts` — `Workspace`, `PersistedWorkspace`, `TerminalSession`, `makeWorkspace()`. This is where the new `Worktree` type belongs.
- `frontend/src/store/layout.ts` (1464 lines) — read it fully before editing. `AppStoreState` (line 108) holds `terminalsByWorkspace`, `diffTabsByWorkspace`, `openFilesByWorkspace`, `compareTabsByWorkspace`, `stackTabsByWorkspace`, `conflictTabsByWorkspace`, `historyTabsByWorkspace`, `previewTabsByWorkspace`, `brainTabsByWorkspace`, `closedTabsByWorkspace`, `pinnedTabsByWorkspace`, `activeItemByWorkspace` — all of these become per-worktree. `gitSidebarCollapsed`, `leftSidebarCollapsed`, `sidebarsSwapped`, `diffMode`, `gitTab`, `ignoreWhitespace`, `sidebarTab`, `gitSections`, `sidebarSections` are global UI prefs and stay global. The tab union is `ActiveItem` (line 28). Persistence keys: `WORKSPACES_KEY`/`ACTIVE_WS_KEY` (lines 16-17), `GIT_PREFS_KEY` (139), `COMPARE_TABS_KEY`/`STACK_TABS_KEY`/`PINNED_TABS_KEY` (200-202), with loaders `loadWorkspaces()` (299), `loadPinnedTabs()` (220), `loadStackTabs()` (238), `loadCompareTabs()` (264). `createAppStore()` (323) exposes the actions.
- `frontend/src/components/layout/WorkspaceTabBar.tsx` — port its double-click-rename and HTML5 drag-reorder logic (`onDragStart`/`onDragOverTab`/`onDropOnTab`/`resetDrag`, `actions.reorderWorkspace`) into the rail. Delete the file once the rail replaces it.
- `frontend/src/components/layout/AppShell.tsx` — 25-line layout frame with `titleBar` / `tabBar` / `sidebar` / `main` / `rightSidebar` / `statusBar` slots. Add a `rail` slot as the leftmost column; the `tabBar` slot goes away (the per-worktree tab strip already lives in `MainSurface`).
- `frontend/src/components/layout/MainSurface.tsx` (1593 lines) — already owns the tab strip, pinning (`pinnedFirst`, line 51), overflow (`recomputeOverflow`, 136), drag-reorder (346-372), context menu (`TabContextMenu`, 1417), the new-tab menu (`NewTabMenu`, 1096) and `onNewTerminal` (399) / `onNewCompare` (405). Extend these for the new tab kind; do not build a second tab system.
- `frontend/src/components/git/GitSidebar.tsx` — `WorktreesPane` (line 1153) already lists worktrees via `createResource` and has `addWorktree()` (1169) including the sibling-path convention `<repoParent>/<repoName>-<branch>` (1161) and remove-with-force fallback (1201). Reuse that path logic in the wizard; after the wizard exists, have this pane delegate to it rather than keeping its own `textPrompt` flow.
- `frontend/src/api/git.ts` — `listWorktrees` (305), `addWorktree` (309), `removeWorktree` (323). Add the new setup commands here.
- `frontend/src/api/terminal.ts` + `frontend/src/components/terminal/TerminalPane.tsx` — real PTY sessions. The wizard's post-create command must run through this (open a terminal tab in the new worktree and feed it the command) rather than inventing a new streaming channel.
- `frontend/src/commands/toast.ts` (`pushToast`), `frontend/src/commands/prompt.ts` + `PromptHost.tsx` (`textPrompt` — native `window.prompt` is a no-op in macOS WKWebView), `frontend/src/components/git/ContextMenu.tsx`.
- `frontend/src/commands/registry.ts` — `registerActions()` / `Action`. New workspace/worktree operations must be registered as actions so they appear in the ⌘K palette.
- `frontend/src/App.tsx` — `AppInner` composes `AppShell`; the action catalog is registered in a `createEffect` (~line 58) and keybindings ~563-680.

Rust:
- `src-tauri/src/git/worktree.rs` — `WorktreeInfo` (path, branch, head, isMain, isLocked, isDetached, isCurrent, isDirty, ahead, behind), `git_list_worktrees_impl`, `git_add_worktree_impl` (the three `git worktree add` shapes), `git_remove_worktree_impl`. The listing is already enriched with dirty/ahead/behind — the rail should render those badges from this, not recompute.
- `src-tauri/src/git/cmd.rs` — `run_git(path, args)`. Every new git call goes through it.
- `src-tauri/src/lib.rs` — `mod` declarations (lines 7-9) and `tauri::generate_handler![...]` (line 303, `git::git_add_worktree` at 335).
- `ignore = "0.4"` is already a dependency (used by the file tree) — use it for scanning, don't add a new walker.
- `.voidlink/` is already an established repo-local directory convention in this codebase (see `src-tauri/.voidlink/artifacts/`). Put per-repo wizard defaults at `<repoRoot>/.voidlink/worktree.json`.
</reuse>

<constraints>
- Query context7 before any Tauri API work, especially the multiwebview API for phase 5. Pinned: `tauri = "2.11"`, `@tauri-apps/api ^2.10.1`, `git2 = "0.19"`, Solid 1.9.7, Tailwind v4.2.1, TS 5.9.3, `@tanstack/solid-virtual ^3.13.32`.
- **Migration must not destroy open tabs.** Use this trick: give each migrated workspace exactly one main worktree whose id is *the old workspace id*. Every existing `Record<oldWorkspaceId, T[]>` then remains valid verbatim under the new per-worktree keying — no value re-keying needed. Gate it on a new `voidlink-layout-version` localStorage key, write the migration as a pure exported function, and make it idempotent.
- After migration, hydrate the real worktree list per workspace from `git_list_worktrees` on load, matching the main worktree by canonicalised path. Non-repo folders get a single synthetic worktree and a disabled `+` with an explanatory tooltip — never a silent no-op.
- Wizard behaviour (all four are in scope):
  1. Env files — scan the source worktree for gitignored `.env*` files and offer them as a checklist, checked by default. Detect gitignored-ness properly (the `ignore` crate or `git check-ignore`), never a hardcoded filename list alone.
  2. Dependency directories — detect the package manager from lockfiles (`package-lock.json`→npm, `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `bun.lockb`→bun, `uv.lock`/`requirements.txt`→python `.venv`, `Cargo.toml`→`target`) and offer: symlink, copy, run install, or skip. Default to symlink for `node_modules` and skip for `target`/`.venv`.
  3. Post-create command — free text, defaulted from the detected package manager, executed in a terminal tab opened in the new worktree so output streams.
  4. Per-repo defaults — persist the answers to `<repoRoot>/.voidlink/worktree.json` so the next worktree in the same repo is one confirm click. Warn (once) if `.voidlink/` is not gitignored.
- Wizard steps must be cancellable, and a failure at any step must leave a clear state: if `git worktree add` succeeded but setup failed, say exactly what succeeded and what didn't. No silent catch-and-continue.
- Separation of concerns: filesystem/git work lives in Rust commands; `frontend/src/api/*` holds the thin `invoke` wrappers; store holds state; components render. No `invoke` calls inside components. No fat command handlers — put scanning/copying logic in a new `src-tauri/src/git/worktree_setup.rs` with the Tauri command as a thin shell over pure functions.
- Phase 5 specifics: Tauri v2 multiwebview requires the `unstable` Cargo feature on the `tauri` crate — enabling it means pinning `tauri` to an exact version, since unstable APIs can break across minors. The child webview also needs `core:webview:*` permissions and a `webviews` entry in `src-tauri/capabilities/default.json` (currently scoped to `"windows": ["main"]`). Position/size the child webview from the content pane's bounding rect via a `ResizeObserver`, and hide it (move offscreen or zero-size) whenever its tab is not the active item — a child webview always paints above the DOM, so an un-hidden one will cover dialogs and menus. If after reading the current context7 docs this proves unworkable on Tauri 2.11, stop and report rather than silently substituting an iframe.
- Labels: sentence case only. No `uppercase` classes, no all-caps text in anything you add.
- The right-hand `GitSidebar` (~1400 lines) and the left `TerminalSidebar` stay as they are — they simply scope to the active worktree instead of the active workspace. Do not rewrite them.
- Keep `git blame`, compare, stack, conflict and brain tabs working — they resolve their repo from the active workspace today (see `configureBlame` in `App.tsx` ~line 42, which matches `filePath.startsWith(w.repoRoot)`); they must now resolve from the active worktree's path.
</constraints>

<assumptions>
- A workspace's "main" worktree is whatever `git worktree list` reports first (`isMain: true`); for a non-repo folder it is a synthetic entry with `branch: null`.
- The rail shows workspace name + its worktrees, with the existing dirty / ahead-behind badges from `WorktreeInfo`.
- Removing a worktree from the rail reuses `git_remove_worktree` including the force fallback already implemented in `WorktreesPane`.
- The frontend has no test runner today (`frontend/package.json` scripts are only `dev`/`build`/`lint`/`preview`). Adding `vitest` as a devDependency purely to test the pure migration function is acceptable and encouraged; do not retrofit tests onto components.
</assumptions>

<out_of_scope>
- Window chrome, app icon, native title bar — parallel stream `feat/macos-shell`.
- Settings view / AI key storage — parallel stream `feat/settings-ai-keys`.
- Keyboard shortcut expansion and feature docs — parallel stream `feat/shortcuts-and-docs`. Register new actions in the palette, but don't build the keymap system here.
- The global uppercase→sentence-case sweep across existing files (another stream owns it) — just don't add new uppercase.
- Rewriting GitSidebar or TerminalSidebar.
- Multi-window support.
</out_of_scope>

<acceptance>
- `cd frontend && npx tsc --noEmit` clean; `npm run lint` no new errors; `cargo check` and `cargo test` pass from `src-tauri/`.
- Rust unit tests for the new `worktree_setup` pure functions using the existing `tempfile` dev-dependency: gitignored `.env*` detection, package-manager detection per lockfile, and the copy/symlink apply step.
- A test for the store migration function: given a v0 localStorage snapshot with two workspaces and open tabs, it produces two workspaces each with one main worktree, all tabs still reachable, and running it twice changes nothing.
- Manual verification via the dev command, reported with what you actually observed: rail lists workspaces vertically; expanding one shows its worktrees; `+` opens the wizard; completing it creates the worktree, copies the selected env files, applies the chosen dependency strategy, and opens a terminal tab running the post-create command in the new directory; switching worktrees swaps the whole tab set; reloading the app restores workspaces, worktrees, active worktree and tabs.
- Upgrade check: launch once with a pre-existing `voidlink-workspaces` localStorage value and confirm previously-open tabs survive.
- If phase 5 lands: opening a browser tab loads a URL in an embedded webview, it tracks the content pane on window resize and sidebar toggles, and it disappears when another tab is active. If it does not land, say so explicitly and leave phases 1–4 complete and green.
</acceptance>
