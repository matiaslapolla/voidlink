import { Show, createEffect, createSignal } from "solid-js";
import { AppShell } from "@/components/layout/AppShell";
import { TitleBar } from "@/components/layout/TitleBar";
import { WindowFrame } from "@/components/layout/WindowFrame";
import { WorkspaceTabBar } from "@/components/layout/WorkspaceTabBar";
import { TerminalSidebar } from "@/components/layout/TerminalSidebar";
import { MainSurface } from "@/components/layout/MainSurface";
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

function AppInner(props: { onOpenSettings: () => void }) {
  const { state, activeWorkspace, actions } = useAppStore();

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
    ];
    const dispose = registerActions(list);
    // Re-register on next change.
    return dispose;
  });

  function closeActiveTab() {
    const wsId = state.activeWorkspaceId;
    const item = state.activeItemByWorkspace[wsId];
    if (!item) return;
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
      key: "r",
      run: async () => {
        const result = await repeatLastCommand();
        if (!result.ok) pushToast(result.reason ?? "Nothing to repeat", "warning");
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
