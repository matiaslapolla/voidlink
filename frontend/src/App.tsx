import { Show, createEffect, createSignal } from "solid-js";
import { AppShell } from "@/components/layout/AppShell";
import { TitleBar } from "@/components/layout/TitleBar";
import { WindowFrame } from "@/components/layout/WindowFrame";
import { WorkspaceTabBar } from "@/components/layout/WorkspaceTabBar";
import { TerminalSidebar } from "@/components/layout/TerminalSidebar";
import { MainSurface } from "@/components/layout/MainSurface";
import { StatusBar } from "@/components/layout/StatusBar";
import { GitSidebar, GitSidebarCollapsed } from "@/components/git/GitSidebar";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AppStoreContext, useAppStore } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { editorController } from "@/components/editor/editorController";
import { CommandPalette } from "@/commands/CommandPalette";
import { FileFinder } from "@/commands/FileFinder";
import { ToastViewport } from "@/commands/ToastViewport";
import {
  closeFileFinder,
  closePalette,
  isFileFinderOpen,
  isPaletteOpen,
  openFileFinder,
  openPalette,
  registerActions,
  type Action,
} from "@/commands/registry";
import { useKeybindings } from "@/commands/keybindings";
import { repeatLastCommand } from "@/commands/terminalHistory";
import { pushToast } from "@/commands/toast";
import { requestAiCommitDraft } from "@/commands/aiCommit";
import { snapshotsFor, removeSnapshot } from "@/commands/snapshots";
import { blameEnabled, configureBlame, toggleBlame } from "@/components/editor/blameOverlay";
import type { ActiveItem } from "@/store/layout";

function AppInner(props: { onOpenSettings: () => void }) {
  const { state, activeWorkspace, actions } = useAppStore();

  // Tell the blame overlay how to find the repo for a given file path.
  // The overlay needs this any time the editor's active model changes
  // so it can refresh without going through MainSurface's effect.
  configureBlame((filePath) => {
    const ws = state.workspaces.find((w) => w.repoRoot && filePath.startsWith(w.repoRoot));
    return ws?.repoRoot ?? activeWorkspace()?.repoRoot ?? null;
  });

  async function handleOpenFile(path: string) {
    const wsId = state.activeWorkspaceId;
    actions.openFileTab(wsId, path);
    await editorController.openFile(path);
  }

  // ── Register the global action catalog. Re-runs when relevant state shifts
  // so closures always reference the current active workspace.
  createEffect(() => {
    const wsId = state.activeWorkspaceId;
    const repo = activeWorkspace()?.repoRoot ?? null;
    const list: Action[] = [
      {
        id: "palette.open",
        label: "Show all commands",
        group: "App",
        shortcutLabel: "⌘K",
        run: () => openPalette(),
      },
      {
        id: "file.open",
        label: "Open file…",
        description: "Fuzzy search tracked files in the active repo",
        group: "File",
        shortcutLabel: "⌘P",
        enabled: () => !!repo,
        run: () => openFileFinder(),
      },
      {
        id: "terminal.new",
        label: "New terminal",
        group: "Terminal",
        enabled: () => !!repo,
        run: () => void actions.spawnTerminal(wsId),
      },
      {
        id: "terminal.repeat-last",
        label: "Repeat last terminal command",
        description: "Re-run the most recent command in the last-used terminal",
        group: "Terminal",
        shortcutLabel: "⌘⇧R",
        run: async () => {
          const result = await repeatLastCommand();
          if (!result.ok) pushToast(result.reason ?? "Nothing to repeat", "warning");
        },
      },
      {
        id: "git.refresh",
        label: "Refresh git status",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          // The sidebar owns its own refetch; broadcasting via a window event
          // keeps the action decoupled from the component tree.
          window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
        },
      },
      {
        id: "git.compare",
        label: "Compare branches…",
        group: "Git",
        enabled: () => !!repo,
        run: () => actions.openCompareTab(wsId),
      },
      {
        id: "stack.branch-on-top",
        label: "Stack: Branch on top of current",
        description: "Create a child of the current branch and start a stack",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          const { gitApi } = await import("@/api/git");
          try {
            const info = await gitApi.repoInfo(repo);
            const parent = info.currentBranch;
            if (!parent) {
              pushToast("HEAD is detached — check out a branch first", "warning");
              return;
            }
            const name = window.prompt(`New branch on top of ${parent}:`)?.trim();
            if (!name) return;
            await stackApi.createBranch(repo, name, parent);
            pushToast(`Created ${name} on top of ${parent}`, "success");
            window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
          } catch (e) {
            pushToast(String(e), "error");
          }
        },
      },
      {
        id: "stack.restack-all",
        label: "Stack: Restack all",
        description: "Replay every branch in the current stack onto its parent's current tip",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          try {
            const stack = await stackApi.current(repo);
            if (!stack) {
              pushToast("Not on a stack", "warning");
              return;
            }
            const results = await stackApi.restackAll(
              repo,
              stack.branches.map((b) => b.name),
            );
            const conflict = results.find((r) => r.outcome.kind === "conflict");
            if (conflict && conflict.outcome.kind === "conflict") {
              pushToast(
                `Conflict on ${conflict.branch}: ${conflict.outcome.paths.join(", ")}`,
                "error",
                6000,
              );
            } else {
              const replayed = results.reduce(
                (n, r) => n + (r.outcome.kind === "restacked" ? r.outcome.commitsReplayed : 0),
                0,
              );
              pushToast(`Stack restacked clean (${replayed} commits replayed)`, "success");
            }
            window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
          } catch (e) {
            pushToast(String(e), "error");
          }
        },
      },
      {
        id: "stack.submit",
        label: "Stack: Submit to GitHub",
        description: "Create or update one PR per branch (requires GITHUB_TOKEN)",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          try {
            const stack = await stackApi.current(repo);
            if (!stack) {
              pushToast("Not on a stack", "warning");
              return;
            }
            const results = await stackApi.submit(
              repo,
              stack.branches.map((b) => b.name),
            );
            const failed = results.filter((r) => r.outcome.kind === "failed").length;
            if (failed === 0) {
              pushToast(`Submitted ${results.length} branch(es)`, "success");
            } else {
              pushToast(
                `Submit finished with ${failed} failure(s) — open the stack tab for details`,
                "warning",
                6000,
              );
            }
            window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
          } catch (e) {
            pushToast(String(e), "error", 6000);
          }
        },
      },
      {
        id: "stack.open-tab",
        label: "Stack: Open stack workspace",
        description: "Open a tab with the full stack graph for the current branch",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          try {
            const stack = await stackApi.current(repo);
            if (!stack) {
              pushToast("Not on a stack — use 'Branch on top' first", "warning");
              return;
            }
            const top = stack.branches.at(-1)?.name;
            if (!top) return;
            actions.openStackTab(wsId, { trunk: stack.trunk, topBranch: top });
          } catch (e) {
            pushToast(String(e), "error");
          }
        },
      },
      {
        id: "ui.toggle-git-sidebar",
        label: "Toggle git sidebar",
        group: "View",
        run: () => actions.toggleGitSidebar(),
      },
      {
        id: "ui.toggle-left-sidebar",
        label: "Toggle left sidebar",
        group: "View",
        run: () => actions.toggleLeftSidebar(),
      },
      {
        id: "ui.swap-sidebars",
        label: "Swap left/right sidebars",
        group: "View",
        run: () => actions.toggleSidebarsSwapped(),
      },
      {
        id: "ui.toggle-diff-mode",
        label: "Toggle inline / split diff",
        group: "View",
        run: () => actions.setDiffMode(state.diffMode === "inline" ? "split" : "inline"),
      },
      {
        id: "ui.toggle-ignore-ws",
        label: "Toggle ignore whitespace in diffs",
        group: "View",
        run: () => actions.toggleIgnoreWhitespace(),
      },
      {
        id: "app.settings",
        label: "Open settings…",
        group: "App",
        run: () => props.onOpenSettings(),
      },
      {
        id: "view.toggle-blame",
        label: blameEnabled() ? "Disable inline blame" : "Enable inline blame",
        description: "Show per-line author + commit summary in the editor",
        group: "View",
        shortcutLabel: "⌘⌥B",
        run: () => toggleBlame(),
      },
      {
        id: "git.ai-draft-commit",
        label: "Draft commit message with AI",
        description: "Pipe staged diff to your configured CLI",
        group: "Git",
        shortcutLabel: "⌘⇧M",
        enabled: () => !!repo,
        run: () => requestAiCommitDraft(),
      },
      {
        id: "workspace.new",
        label: "New workspace",
        group: "Workspace",
        shortcutLabel: "⌘T",
        run: () => actions.addWorkspace(),
      },
      {
        id: "workspace.next",
        label: "Next workspace",
        group: "Workspace",
        shortcutLabel: "⌘⇧→",
        enabled: () => state.workspaces.length > 1,
        run: () => cycleWorkspace(1),
      },
      {
        id: "workspace.prev",
        label: "Previous workspace",
        group: "Workspace",
        shortcutLabel: "⌘⇧←",
        enabled: () => state.workspaces.length > 1,
        run: () => cycleWorkspace(-1),
      },
      {
        id: "tab.next",
        label: "Next tab",
        group: "View",
        shortcutLabel: "⌘⌥→",
        enabled: () => allItems().length > 1,
        run: () => cycleTab(1),
      },
      {
        id: "tab.prev",
        label: "Previous tab",
        group: "View",
        shortcutLabel: "⌘⌥←",
        enabled: () => allItems().length > 1,
        run: () => cycleTab(-1),
      },
      {
        id: "tab.reopen-last",
        label: "Reopen last closed tab",
        description: "File / diff / compare / stack — terminals can't be reopened",
        group: "View",
        shortcutLabel: "⌘⇧T",
        enabled: () => (state.closedTabsByWorkspace[state.activeWorkspaceId] ?? []).length > 0,
        run: () => void reopenLastClosed(),
      },
      // ── Workspace snapshots ──────────────────────────────────────────
      {
        id: "snapshot.save",
        label: "Snapshot: save current as…",
        description: "Save tabs + terminals + sidebar state under a name",
        group: "Workspace",
        run: () => {
          const name = window.prompt("Snapshot name:")?.trim();
          if (!name) return;
          actions.saveWorkspaceSnapshot(state.activeWorkspaceId, name);
          pushToast(`Snapshot "${name}" saved`, "success");
        },
      },
      // Dynamic entries — one restore + one delete per saved snapshot for
      // the active workspace. Re-registers each effect run.
      ...snapshotsFor(state.activeWorkspaceId).flatMap<Action>((snap) => [
        {
          id: `snapshot.restore.${snap.name}`,
          label: `Snapshot: restore "${snap.name}"`,
          description: `${snap.files.length} files · ${snap.terminals.length} terminals · ${snap.compares.length} compares`,
          group: "Workspace",
          run: async () => {
            const ok = await actions.restoreWorkspaceSnapshot(state.activeWorkspaceId, snap.name);
            if (!ok) pushToast(`Snapshot "${snap.name}" not found`, "error");
            else pushToast(`Restored "${snap.name}"`, "success");
          },
        },
        {
          id: `snapshot.delete.${snap.name}`,
          label: `Snapshot: delete "${snap.name}"`,
          group: "Workspace",
          run: () => {
            removeSnapshot(state.activeWorkspaceId, snap.name);
            pushToast(`Deleted "${snap.name}"`, "info");
          },
        },
      ]),
    ];
    const dispose = registerActions(list);
    // Re-register on next change.
    return dispose;
  });

  /// Build the ordered list of tabs in the same order MainSurface renders
  /// them (files → terminals → diffs → compares → stacks). Used by the
  /// Cmd+Alt+Arrow cycle shortcut so the wrap order matches what the user
  /// sees in the unified tab bar.
  function allItems(): ActiveItem[] {
    const wsId = state.activeWorkspaceId;
    const items: ActiveItem[] = [];
    for (const f of state.openFilesByWorkspace[wsId] ?? [])
      items.push({ type: "file", id: f.id, path: f.path });
    for (const t of state.terminalsByWorkspace[wsId] ?? [])
      items.push({ type: "terminal", id: t.id });
    for (const d of state.diffTabsByWorkspace[wsId] ?? [])
      items.push({ type: "diff", id: d.id });
    for (const c of state.compareTabsByWorkspace[wsId] ?? [])
      items.push({ type: "compare", id: c.id });
    for (const s of state.stackTabsByWorkspace[wsId] ?? [])
      items.push({ type: "stack", id: s.id });
    for (const c of state.conflictTabsByWorkspace[wsId] ?? [])
      items.push({ type: "conflict", id: c.id });
    return items;
  }

  function activateItem(item: ActiveItem) {
    const wsId = state.activeWorkspaceId;
    switch (item.type) {
      case "file":
        actions.selectFileTab(wsId, item.id, item.path);
        void editorController.setActive(item.path);
        break;
      case "terminal":
        actions.selectTerminal(wsId, item.id);
        break;
      case "diff":
        actions.selectDiffTab(wsId, item.id);
        break;
      case "compare":
        actions.selectCompareTab(wsId, item.id);
        break;
      case "stack":
        actions.selectStackTab(wsId, item.id);
        break;
      case "conflict":
        actions.selectConflictTab(wsId, item.id);
        break;
    }
  }

  function cycleTab(direction: 1 | -1) {
    const items = allItems();
    if (items.length === 0) return;
    const cur = state.activeItemByWorkspace[state.activeWorkspaceId];
    const idx = cur ? items.findIndex((i) => i.type === cur.type && i.id === cur.id) : -1;
    // -1 → first ArrowRight starts at the head, ArrowLeft jumps to tail.
    const next = idx === -1
      ? direction === 1 ? 0 : items.length - 1
      : (idx + direction + items.length) % items.length;
    activateItem(items[next]);
  }

  /// Reopen the most-recently closed tab AND, when it's a file, kick
  /// the Monaco controller to load+activate the model. The store
  /// action alone only restores the tab record — without this, the
  /// reopened file tab appears but the editor stays parked on
  /// whatever model was active before.
  async function reopenLastClosed() {
    const popped = actions.reopenLastClosedTab(state.activeWorkspaceId);
    if (!popped) {
      pushToast("No recently closed tab", "warning");
      return;
    }
    if (popped.type === "file") {
      await editorController.openFile(popped.path);
    }
  }

  function cycleWorkspace(direction: 1 | -1) {
    const list = state.workspaces;
    if (list.length < 2) return;
    const idx = list.findIndex((w) => w.id === state.activeWorkspaceId);
    if (idx === -1) return;
    const next = (idx + direction + list.length) % list.length;
    actions.selectWorkspace(list[next].id);
  }

  function selectWorkspaceByIndex(i: number) {
    const ws = state.workspaces[i];
    if (ws) actions.selectWorkspace(ws.id);
  }

  function closeActiveTab() {
    const wsId = state.activeWorkspaceId;
    const item = state.activeItemByWorkspace[wsId];
    if (!item) {
      // No tabs open in this workspace → Cmd+W collapses the workspace
      // itself. removeWorkspace handles the "this is the last one"
      // edge case (creates a fresh empty Main).
      actions.removeWorkspace(wsId);
      return;
    }
    if (actions.isTabPinned(wsId, item.id)) {
      pushToast("Tab is pinned — right-click to unpin", "warning");
      return;
    }
    switch (item.type) {
      case "file": {
        editorController.closeFile(item.path);
        actions.closeFileTab(wsId, item.id);
        break;
      }
      case "terminal":
        actions.removeTerminal(wsId, item.id);
        break;
      case "diff":
        actions.closeDiffTab(wsId, item.id);
        break;
      case "compare":
        actions.closeCompareTab(wsId, item.id);
        break;
      case "stack":
        actions.closeStackTab(wsId, item.id);
        break;
      case "conflict":
        actions.closeConflictTab(wsId, item.id);
        break;
    }
  }

  useKeybindings(() => [
    {
      meta: true,
      key: "k",
      run: () => {
        if (isPaletteOpen()) closePalette();
        else openPalette();
      },
    },
    {
      meta: true,
      key: "p",
      run: () => {
        if (!activeWorkspace()?.repoRoot) {
          pushToast("Select a repository first", "warning");
          return;
        }
        if (isFileFinderOpen()) closeFileFinder();
        else openFileFinder();
      },
    },
    {
      meta: true,
      key: "w",
      run: () => closeActiveTab(),
    },
    {
      meta: true,
      shift: true,
      key: "t",
      run: () => void reopenLastClosed(),
    },
    {
      meta: true,
      shift: true,
      key: "r",
      run: async () => {
        const result = await repeatLastCommand();
        if (!result.ok) pushToast(result.reason ?? "Nothing to repeat", "warning");
      },
    },
    // ── Workspace navigation ────────────────────────────────────────────
    ...Array.from({ length: 9 }, (_, i) => ({
      meta: true,
      key: String(i + 1),
      run: () => selectWorkspaceByIndex(i),
    })),
    {
      meta: true,
      key: "t",
      run: () => actions.addWorkspace(),
    },
    {
      meta: true,
      shift: true,
      key: "ArrowRight",
      run: () => cycleWorkspace(1),
    },
    {
      meta: true,
      shift: true,
      key: "ArrowLeft",
      run: () => cycleWorkspace(-1),
    },
    // ── Tab navigation within the active workspace ──────────────────────
    {
      meta: true,
      alt: true,
      key: "ArrowRight",
      run: () => cycleTab(1),
    },
    {
      meta: true,
      alt: true,
      key: "ArrowLeft",
      run: () => cycleTab(-1),
    },
    // ── Sidebar toggles ─────────────────────────────────────────────────
    {
      meta: true,
      key: "b",
      run: () => actions.toggleLeftSidebar(),
    },
    {
      meta: true,
      key: "j",
      run: () => actions.toggleGitSidebar(),
    },
    {
      meta: true,
      key: "\\",
      run: () => actions.toggleSidebarsSwapped(),
    },
    // ── Editor overlays ─────────────────────────────────────────────────
    {
      meta: true,
      alt: true,
      key: "b",
      run: () => toggleBlame(),
    },
    // ── AI commit draft ─────────────────────────────────────────────────
    {
      meta: true,
      shift: true,
      key: "m",
      run: () => {
        if (!activeWorkspace()?.repoRoot) {
          pushToast("Open a repository first", "warning");
          return;
        }
        requestAiCommitDraft();
      },
    },
  ]);

  const leftPane = () =>
    state.leftSidebarCollapsed
      ? null
      : <TerminalSidebar onOpenFile={(path) => void handleOpenFile(path)} />;

  const rightPane = () => (
    <Show when={activeWorkspace()?.repoRoot}>
      {(repo) => (
        <Show
          when={!state.gitSidebarCollapsed}
          fallback={<GitSidebarCollapsed onExpand={actions.toggleGitSidebar} />}
        >
          <GitSidebar repoPath={repo()} workspaceId={state.activeWorkspaceId} />
        </Show>
      )}
    </Show>
  );

  return (
    <>
      <AppShell
        titleBar={<TitleBar onOpenSettings={props.onOpenSettings} />}
        tabBar={<WorkspaceTabBar />}
        sidebar={state.sidebarsSwapped ? rightPane() : leftPane()}
        main={<MainSurface />}
        rightSidebar={state.sidebarsSwapped ? leftPane() : rightPane()}
        statusBar={<StatusBar />}
      />
      <CommandPalette />
      <FileFinder
        repoPath={activeWorkspace()?.repoRoot ?? null}
        onOpenFile={(p) => void handleOpenFile(p)}
      />
      <ToastViewport />
      <WindowFrame />
    </>
  );
}

export default function App() {
  const store = createAppStore();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  return (
    <AppStoreContext.Provider value={store}>
      <AppInner onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </AppStoreContext.Provider>
  );
}
