import {
  Show,
  Suspense,
  createEffect,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from "solid-js";
import { AppShell } from "@/components/layout/AppShell";
import { TitleBar } from "@/components/layout/TitleBar";
import { WindowFrame } from "@/components/layout/WindowFrame";
import { WorkspaceRail } from "@/components/layout/WorkspaceRail";
import { TerminalSidebar } from "@/components/layout/TerminalSidebar";
import { MainSurface } from "@/components/layout/MainSurface";
import { StatusBar } from "@/components/layout/StatusBar";
import { GitSidebar, GitSidebarCollapsed } from "@/components/git/GitSidebar";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AppStoreContext, useAppStore } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { isMac } from "@/api/platform";
import { isZen, toggleMaximizedGroup, toggleZen } from "@/store/focusMode";
import { CommandPalette } from "@/commands/CommandPalette";
import { FileFinder } from "@/commands/FileFinder";
import { ShortcutsCheatSheet } from "@/commands/ShortcutsCheatSheet";
import { ToastViewport } from "@/commands/ToastViewport";
import { PromptHost } from "@/commands/PromptHost";
import { textPrompt } from "@/commands/prompt";
import {
  closeCheatSheet,
  closeFileFinder,
  closePalette,
  getActions,
  isCheatSheetOpen,
  isFileFinderOpen,
  isPaletteOpen,
  openCheatSheet,
  openFileFinder,
  openPalette,
  registerActions,
  type Action,
} from "@/commands/registry";
import { keymapBindings, useKeybindings } from "@/commands/keybindings";
import { validateKeymap } from "@/commands/keymap";
import { WORKSPACE_SELECT_COUNT, workspaceSelectId } from "@/commands/actionIds";
import { repeatLastCommand } from "@/commands/terminalHistory";
import { pushToast } from "@/commands/toast";
import { requestAiCommitDraft } from "@/commands/aiCommit";
import { toggleAgentPanel } from "@/commands/agent";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { snapshotsFor, removeSnapshot } from "@/commands/snapshots";
import { newWorktreeRequest, requestNewWorktree } from "@/commands/worktree";
import { setOverlayOpen } from "@/commands/overlay";
import { agentPanelOpen } from "@/commands/agent";
import { browserApi } from "@/api/webview";
import { applyEditorRequest } from "@/store/editorRequests";
import {
  isStackedMode,
  setStackedView,
  stackedView,
  type StackedView,
} from "@/commands/environment";
import {
  bridgeGitRefsAcrossWindows,
  onEditorRequest,
  onEditorTabsRequest,
  onWindowContextRequest,
  onWorktreeWizardRequest,
  closeEditorWindow,
  closeGitWindow,
  openEditorWindow,
  openGitWindow,
  publishEditorTabs,
  publishWindowContext,
  setStackedViewRouter,
  showEditorWindow,
  type EditorReveal,
  type EditorTabsSnapshot,
} from "@/api/windows";
import { normalizeUrl } from "@/components/browser/BrowserPane";
import { NewWorktreeWizard } from "@/components/git/worktree/NewWorktreeWizard";
import type { ActiveItem } from "@/store/layout";

/// The other two surfaces, loaded only if stacked mode actually renders them.
/// Static imports would put the editor and git shells in the workbench's entry
/// chunk even for the detached user who will never see them here.
const EditorView = lazy(() =>
  import("@/EditorApp").then((m) => ({ default: m.EditorSurface })),
);
const GitView = lazy(() => import("@/GitApp").then((m) => ({ default: m.GitSurface })));

function AppInner(props: { onOpenSettings: () => void; settingsOpen: boolean }) {
  const { state, activeWorkspace, activeWorktree, activeRepoPath, focusedGroupId, actions } =
    useAppStore();

  // Hydrate the real worktree list for every repo-backed workspace once, on
  // boot. Persisted state only knows what we last saw; git is the truth, and
  // worktrees can be added or removed while the app is closed.
  onMount(() => {
    void actions.hydrateAllWorktrees();
    // A crash or hard reload can leave child webviews alive with no component
    // owning them — and a child webview paints above everything. Sweep ours.
    void browserApi.closeOrphans().catch(() => {});
  });

  // ── Standalone git window ────────────────────────────────────────────────
  // The workbench owns the "which repository" decision, so it publishes that
  // context and the git window consumes it. Publishing is unconditional: the
  // event is simply unheard when the window is closed, which is cheaper than
  // tracking whether it is open.
  const satelliteContext = () => ({
    repoPath: activeRepoPath(),
    worktreeId: state.activeWorktreeId,
    branch: activeWorktree()?.branch ?? null,
    workspaceName: activeWorkspace()?.name ?? "",
    worktreeLabel: activeWorktree()?.branch ?? activeWorktree()?.path ?? "",
  });
  createEffect(() => void publishWindowContext(satelliteContext()));

  // ── Standalone editor window ─────────────────────────────────────────────
  // The workbench owns the editor's four tab collections — it is the only
  // window that persists state — so it broadcasts them and applies the
  // mutations the editor window asks for. See `api/windows.ts` for the shape.

  /// A pending "jump to this line", carried in the next snapshot. Held as
  /// signal rather than emitted on its own channel so that a freshly-opened
  /// editor window, which re-requests the snapshot on mount, still gets it.
  const [reveal, setReveal] = createSignal<EditorReveal | null>(null);
  let revealSeq = 0;

  const editorTabs = (): EditorTabsSnapshot => {
    const wtId = state.activeWorktreeId;
    return {
      worktreeId: wtId,
      repoPath: activeRepoPath(),
      files: [...(state.openFilesByWorktree[wtId] ?? [])],
      diffs: [...(state.diffTabsByWorktree[wtId] ?? [])],
      conflicts: [...(state.conflictTabsByWorktree[wtId] ?? [])],
      previews: [...(state.previewTabsByWorktree[wtId] ?? [])],
      pinned: [...(state.pinnedTabsByWorktree[wtId] ?? [])],
      active: state.editorActiveItemByWorktree[wtId] ?? null,
      reveal: reveal(),
    };
  };
  createEffect(() => void publishEditorTabs(editorTabs()));

  /// Open `path` in the editor window: register the tab here (we own the tab
  /// list), attach an optional line to jump to, then make sure the window
  /// exists and is in front. Every "open a file" path in the workbench — the
  /// file finder, the tree, a terminal deep-link — funnels through this.
  async function openInEditorWindow(path: string, line?: number, column?: number) {
    actions.openFileTab(state.activeWorktreeId, path);
    revealSeq += 1;
    setReveal({ path, line, column, seq: revealSeq });
    try {
      await showEditorWindow();
    } catch (e) {
      pushToast(
        `Could not open the editor window: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  }

  onMount(() => {
    // A git window that opened after our last broadcast has no context yet
    // and asks for one.
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    const track = (p: Promise<() => void>) => {
      void p.then((fn) => {
        if (disposed) fn();
        else unlisteners.push(fn);
      });
    };

    track(
      onWindowContextRequest(() => {
        void publishWindowContext(untrack(satelliteContext));
      }),
    );

    // An editor window that opened after our last broadcast has no tabs yet.
    track(
      onEditorTabsRequest(() => {
        void publishEditorTabs(untrack(editorTabs));
      }),
    );

    // Tab mutations from the editor window. Applying them here — rather than
    // letting that window write its own store — is what keeps one copy of the
    // truth; the resulting state change re-broadcasts through the effect above.
    track(
      onEditorRequest((req) => {
        applyEditorRequest(state, actions, untrack(() => state.activeWorktreeId), req);
      }),
    );

    // Worktree creation is forwarded here from the git window, which has no
    // layout store to register it in and no terminal to run post-create in.
    track(
      onWorktreeWizardRequest((req) => {
        const ws = untrack(activeWorkspace);
        if (!ws) return;
        requestNewWorktree({
          workspaceId: ws.id,
          repoRoot: req.repoRoot,
          sourcePath: req.sourcePath,
        });
      }),
    );

    const disposeBridge = bridgeGitRefsAcrossWindows();
    onCleanup(() => {
      disposed = true;
      for (const fn of unlisteners) fn();
      disposeBridge();
    });
  });

  // ── Environment mode ─────────────────────────────────────────────────────
  // Stacked mode hosts the git client and the editor here as views instead of
  // as windows. Everything that wants to "show the editor" goes through
  // `api/windows.ts`, so installing a router there is all it takes to redirect
  // the whole app — the title bar, the git sidebar's file rows, the file tree,
  // the palette and the terminal deep-links included.
  const store = useAppStore();
  createEffect(() => {
    if (!isStackedMode()) {
      setStackedViewRouter(null);
      // Back to windows: leave the workbench showing, and open nothing. The
      // satellites reappear when the user next asks for one.
      setStackedView("workbench");
      return;
    }
    setStackedViewRouter({
      showWorkbench: () => setStackedView("workbench"),
      showEditor: () => setStackedView("editor"),
      showGit: () => setStackedView("git"),
    });
    // Any satellite still open would now be a second copy of a view we host —
    // two editors over one tab list, with only one of them in front of the user.
    void closeEditorWindow().catch(() => {});
    void closeGitWindow().catch(() => {});
  });
  onCleanup(() => setStackedViewRouter(null));

  /// Which view is on screen. Always "workbench" in detached mode, so the
  /// surfaces below can read this without checking the mode themselves.
  const currentView = (): StackedView => (isStackedMode() ? stackedView() : "workbench");

  // A view that isn't the workbench covers it with plain DOM — which a child
  // webview would paint straight through. Same mechanism the modals use.
  createEffect(() => setOverlayOpen("stacked-view", currentView() !== "workbench"));

  // Embedded browser tabs are child webviews that composite above the DOM, so
  // every modal surface has to actively push them out of the way while open.
  createEffect(() => setOverlayOpen("palette", isPaletteOpen()));
  createEffect(() => setOverlayOpen("file-finder", isFileFinderOpen()));
  createEffect(() => setOverlayOpen("worktree-wizard", !!newWorktreeRequest()));
  createEffect(() => setOverlayOpen("agent", agentPanelOpen()));
  createEffect(() => setOverlayOpen("settings", props.settingsOpen));


  // ── Register the global action catalog. Re-runs when relevant state shifts
  // so closures always reference the current active workspace.
  createEffect(() => {
    const wtId = state.activeWorktreeId;
    const repo = activeRepoPath();
    const list: Action[] = [
      {
        id: "palette.open",
        label: "Show all commands",
        group: "App",
        // Toggling lives in the action, not the binding, so ⌘K and the palette
        // row are the same code path. Picking this row *from* the palette is a
        // no-op by construction: the palette closes first, so `run` reopens it.
        run: () => (isPaletteOpen() ? closePalette() : openPalette()),
      },
      {
        id: "help.shortcuts",
        label: "Keyboard shortcuts",
        description: "Every binding, grouped and filterable",
        group: "App",
        run: () => (isCheatSheetOpen() ? closeCheatSheet() : openCheatSheet()),
      },
      {
        id: "file.open",
        label: "Open file…",
        description: "Fuzzy search tracked files in the active repo",
        group: "File",
        enabled: () => !!repo,
        run: () => {
          // The guard lives here rather than in the keybinding so pressing the
          // chord and picking the palette row behave identically.
          if (!repo) {
            pushToast("Select a repository first", "warning");
            return;
          }
          if (isFileFinderOpen()) closeFileFinder();
          else openFileFinder();
        },
      },
      {
        id: "terminal.new",
        label: "New terminal",
        group: "Terminal",
        enabled: () => !!repo,
        run: () => void actions.spawnTerminal(wtId),
      },
      {
        id: "terminal.repeat-last",
        label: "Repeat last terminal command",
        description: "Re-run the most recent command in the last-used terminal",
        group: "Terminal",
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
        id: "git.fetch",
        label: "Fetch from origin",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          window.dispatchEvent(new CustomEvent("voidlink:git-fetch"));
        },
      },
      {
        id: "git.pull",
        label: "Pull from origin",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          window.dispatchEvent(new CustomEvent("voidlink:git-pull"));
        },
      },
      {
        id: "git.remotes",
        label: "Manage remotes…",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          window.dispatchEvent(new CustomEvent("voidlink:git-remotes"));
        },
      },
      {
        id: "git.undo-last-commit",
        label: "Undo last commit (soft)",
        group: "Git",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { gitApi } = await import("@/api/git");
          await gitApi.undoLastCommit(repo);
          window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
        },
      },
      {
        id: "git.compare",
        label: "Compare branches…",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          actions.openCompareTab(wtId);
        },
      },
      {
        id: "editor.open-window",
        label: "Open editor window",
        description: "The code editor in its own window",
        group: "App",
        run: async () => {
          try {
            const created = await openEditorWindow();
            if (!created) pushToast("Editor window brought to front", "info", 2000);
          } catch (e) {
            pushToast(
              `Could not open the editor window: ${e instanceof Error ? e.message : String(e)}`,
              "error",
            );
          }
        },
      },
      {
        id: "git.open-window",
        label: "Open git window",
        description: "The full git client in its own window",
        group: "Git",
        run: async () => {
          try {
            const created = await openGitWindow();
            if (!created) pushToast("Git window brought to front", "info", 2000);
          } catch (e) {
            pushToast(
              `Could not open the git window: ${e instanceof Error ? e.message : String(e)}`,
              "error",
            );
          }
        },
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
            const name = await textPrompt({
              title: "New branch",
              label: `Create on top of ${parent}`,
              placeholder: "feature/my-branch",
              confirmLabel: "Create",
            });
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
            actions.openStackTab(wtId, { trunk: stack.trunk, topBranch: top });
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
        id: "ui.maximize-pane",
        label: "Maximize / restore the focused pane",
        description: "Fill the workbench with the focused pane group; press again to restore",
        group: "View",
        run: () => toggleMaximizedGroup(focusedGroupId()),
      },
      {
        id: "ui.zen",
        label: "Toggle zen mode",
        description: "Hide the rail, both sidebars and the tab strips; the status bar stays",
        group: "View",
        run: () => toggleZen(),
      },
      {
        id: "app.settings",
        label: "Open settings…",
        group: "App",
        run: () => props.onOpenSettings(),
      },
      {
        id: "git.ai-draft-commit",
        label: "Draft commit message with AI",
        description: "Pipe staged diff to your configured CLI",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          if (!repo) {
            pushToast("Open a repository first", "warning");
            return;
          }
          requestAiCommitDraft();
        },
      },
      {
        id: "agent.toggle",
        label: "Toggle repo agent",
        description: "Ask a CLI grounded in this workspace's git state",
        group: "AI",
        enabled: () => !!repo,
        run: () => {
          if (!repo) {
            pushToast("Open a repository first", "warning");
            return;
          }
          toggleAgentPanel();
        },
      },
      {
        id: "workspace.new",
        label: "New workspace",
        group: "Workspace",
        run: () => {
          actions.addWorkspace();
        },
      },
      {
        id: "workspace.next",
        label: "Next workspace",
        group: "Workspace",
        enabled: () => state.workspaces.length > 1,
        run: () => cycleWorkspace(1),
      },
      {
        id: "workspace.prev",
        label: "Previous workspace",
        group: "Workspace",
        enabled: () => state.workspaces.length > 1,
        run: () => cycleWorkspace(-1),
      },
      // ── Worktrees ────────────────────────────────────────────────────
      {
        id: "worktree.new",
        label: "New worktree…",
        description: "Create a linked worktree with env files and dependencies set up",
        group: "Workspace",
        enabled: () => !!activeWorkspace()?.isRepo,
        run: () => {
          const ws = activeWorkspace();
          if (!ws?.repoRoot) {
            pushToast("Select a repository for this workspace first", "warning");
            return;
          }
          if (!ws.isRepo) {
            pushToast("This folder isn't a git repository — worktrees need one", "warning");
            return;
          }
          requestNewWorktree({
            workspaceId: ws.id,
            repoRoot: ws.repoRoot,
            sourcePath: activeWorktree()?.path || ws.repoRoot,
          });
        },
      },
      {
        id: "worktree.next",
        label: "Next worktree",
        description: "Switch to the next worktree in this workspace",
        group: "Workspace",
        enabled: () => (activeWorkspace()?.worktrees.length ?? 0) > 1,
        run: () => cycleWorktree(1),
      },
      {
        id: "worktree.prev",
        label: "Previous worktree",
        description: "Switch to the previous worktree in this workspace",
        group: "Workspace",
        enabled: () => (activeWorkspace()?.worktrees.length ?? 0) > 1,
        run: () => cycleWorktree(-1),
      },
      {
        id: "worktree.remove",
        label: "Remove current worktree…",
        description: "Delete the active linked worktree's directory",
        group: "Workspace",
        enabled: () => activeWorktree()?.isMain === false,
        run: () => void removeActiveWorktree(),
      },
      {
        id: "browser.new",
        label: "New browser tab",
        description: "Open a page in an embedded webview beside your code",
        group: "View",
        run: () => {
          actions.openBrowserTab(wtId, normalizeUrl("example.com"));
        },
      },
      // ⌘1-⌘9 jump straight to a workspace. Registered so the keymap can bind
      // them, hidden so nine near-identical rows don't drown the palette.
      ...Array.from({ length: WORKSPACE_SELECT_COUNT }, (_, i): Action => ({
        id: workspaceSelectId(i + 1),
        label: `Go to workspace ${i + 1}`,
        group: "Workspace",
        hidden: true,
        enabled: () => !!state.workspaces[i],
        run: () => selectWorkspaceByIndex(i),
      })),
      {
        id: "tab.close",
        label: "Close tab",
        description: "With no tabs open, closes the workspace itself",
        group: "Tabs",
        run: () => closeActiveTab(),
      },
      {
        id: "tab.next",
        label: "Next tab",
        group: "Tabs",
        enabled: () => allItems().length > 1,
        run: () => cycleTab(1),
      },
      {
        id: "tab.prev",
        label: "Previous tab",
        group: "Tabs",
        enabled: () => allItems().length > 1,
        run: () => cycleTab(-1),
      },
      {
        id: "tab.reopen-last",
        label: "Reopen last closed tab",
        description: "File / diff / compare / stack — terminals can't be reopened",
        group: "Tabs",
        enabled: () => (state.closedTabsByWorktree[state.activeWorktreeId] ?? []).length > 0,
        run: () => void reopenLastClosed(),
      },
      // ── Workspace snapshots ──────────────────────────────────────────
      {
        id: "snapshot.save",
        label: "Snapshot: save current as…",
        description: "Save tabs + terminals + sidebar state under a name",
        group: "Workspace",
        run: async () => {
          const name = await textPrompt({
            title: "Save snapshot",
            label: "Name this snapshot of tabs, terminals, and sidebar state",
            placeholder: "before-refactor",
            confirmLabel: "Save",
          });
          if (!name) return;
          actions.saveWorkspaceSnapshot(state.activeWorktreeId, name);
          pushToast(`Snapshot "${name}" saved`, "success");
        },
      },
      // Dynamic entries — one restore + one delete per saved snapshot for
      // the active workspace. Re-registers each effect run.
      ...snapshotsFor(state.activeWorktreeId).flatMap<Action>((snap) => [
        {
          id: `snapshot.restore.${snap.name}`,
          label: `Snapshot: restore "${snap.name}"`,
          description: `${snap.files.length} files · ${snap.terminals.length} terminals · ${snap.compares.length} compares`,
          group: "Workspace",
          run: async () => {
            const ok = await actions.restoreWorkspaceSnapshot(state.activeWorktreeId, snap.name);
            if (!ok) pushToast(`Snapshot "${snap.name}" not found`, "error");
            else pushToast(`Restored "${snap.name}"`, "success");
          },
        },
        {
          id: `snapshot.delete.${snap.name}`,
          label: `Snapshot: delete "${snap.name}"`,
          group: "Workspace",
          run: () => {
            removeSnapshot(state.activeWorktreeId, snap.name);
            pushToast(`Deleted "${snap.name}"`, "info");
          },
        },
      ]),
    ];
    const dispose = registerActions(list);

    // Dev-time keymap audit. The unit test catches duplicate chords and ids
    // that aren't in the declared catalog; this catches the remaining case —
    // an id that is declared but never actually registered, which would show
    // up at runtime as a shortcut that quietly does nothing. `untrack` because
    // reading the registry inside the effect that writes it would loop.
    if (import.meta.env.DEV) {
      untrack(() => {
        // Stacked mode registers the editor's actions in this window too, so
        // the audit must not skip the entries the editor owns — they are ours.
        for (const problem of validateKeymap(getActions().map((a) => a.id),
          isStackedMode() ? {} : { window: "main" },
        )) {
          console.error(`[keymap] ${problem.kind}: ${problem.detail}`);
        }
      });
    }

    // Re-register on next change.
    return dispose;
  });

  /// Build the ordered list of tabs in the same order MainSurface renders
  /// them (terminals → compares → stacks → graph → brain → browser). Used by
  /// the Cmd+Alt+Arrow cycle shortcut so the wrap order matches what the user
  /// sees in the tab bar. Files, diffs, conflicts and previews are not here:
  /// they live in the editor window, which cycles its own.
  function allItems(): ActiveItem[] {
    const wtId = state.activeWorktreeId;
    const items: ActiveItem[] = [];
    for (const t of state.terminalsByWorktree[wtId] ?? [])
      items.push({ type: "terminal", id: t.id });
    for (const c of state.compareTabsByWorktree[wtId] ?? [])
      items.push({ type: "compare", id: c.id });
    for (const s of state.stackTabsByWorktree[wtId] ?? [])
      items.push({ type: "stack", id: s.id });
    for (const h of state.historyTabsByWorktree[wtId] ?? [])
      items.push({ type: "history", id: h.id });
    for (const b of state.brainTabsByWorktree[wtId] ?? [])
      items.push({ type: "brain", id: b.id });
    for (const b of state.browserTabsByWorktree[wtId] ?? [])
      items.push({ type: "browser", id: b.id });
    return items;
  }

  function activateItem(item: ActiveItem) {
    const wtId = state.activeWorktreeId;
    switch (item.type) {
      case "terminal":
        actions.selectTerminal(wtId, item.id);
        break;
      case "compare":
        actions.selectCompareTab(wtId, item.id);
        break;
      case "stack":
        actions.selectStackTab(wtId, item.id);
        break;
      case "history":
        actions.selectHistoryTab(wtId, item.id);
        break;
      case "brain":
        actions.selectBrainTab(wtId, item.id);
        break;
      case "browser":
        actions.selectBrowserTab(wtId, item.id);
        break;
    }
  }

  function cycleTab(direction: 1 | -1) {
    const items = allItems();
    if (items.length === 0) return;
    const cur = state.activeItemByWorktree[state.activeWorktreeId];
    const idx = cur ? items.findIndex((i) => i.type === cur.type && i.id === cur.id) : -1;
    // -1 → first ArrowRight starts at the head, ArrowLeft jumps to tail.
    const next = idx === -1
      ? direction === 1 ? 0 : items.length - 1
      : (idx + direction + items.length) % items.length;
    activateItem(items[next]);
  }

  /// Reopen the most-recently closed tab. Files and diffs land in the editor
  /// window, so we follow them there — reopening a tab into a window the user
  /// can't see would look like the command did nothing.
  async function reopenLastClosed() {
    const popped = actions.reopenLastClosedTab(state.activeWorktreeId);
    if (!popped) {
      pushToast("No recently closed tab", "warning");
      return;
    }
    if (popped.type === "file" || popped.type === "diff") {
      await showEditorWindow();
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

  /// Cycle within the active workspace's worktrees. Wraps, like the tab and
  /// workspace cycles, so repeated presses stay useful with two worktrees.
  function cycleWorktree(direction: 1 | -1) {
    const ws = activeWorkspace();
    if (!ws || ws.worktrees.length < 2) return;
    const idx = ws.worktrees.findIndex((wt) => wt.id === state.activeWorktreeId);
    if (idx === -1) return;
    const next = (idx + direction + ws.worktrees.length) % ws.worktrees.length;
    actions.selectWorktree(ws.worktrees[next].id);
  }

  /// Remove the active worktree from git and from the rail. Main worktrees are
  /// the workspace itself and are never removable this way.
  async function removeActiveWorktree() {
    const ws = activeWorkspace();
    const wt = activeWorktree();
    if (!ws?.repoRoot || !wt || wt.isMain) {
      pushToast("The main worktree can't be removed — close the workspace instead", "warning");
      return;
    }
    const { gitApi } = await import("@/api/git");
    try {
      await gitApi.removeWorktree(ws.repoRoot, wt.path, false);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      return;
    }
    actions.removeWorktree(ws.id, wt.id);
    pushToast(`Removed worktree ${wt.branch ?? wt.path}`, "info", 2500);
  }

  function closeActiveTab() {
    const wtId = state.activeWorktreeId;
    // Stacked mode: ⌘W has to close what the user is actually looking at, and
    // the editor view's tabs hang off the other pointer. The git view has no
    // tabs of its own, so it falls through to the workbench's behaviour.
    if (currentView() === "editor") {
      const editorItem = state.editorActiveItemByWorktree[wtId];
      if (
        !editorItem ||
        (editorItem.type !== "file" &&
          editorItem.type !== "diff" &&
          editorItem.type !== "conflict" &&
          editorItem.type !== "preview")
      ) {
        return;
      }
      if (actions.isTabPinned(wtId, editorItem.id)) {
        pushToast("Tab is pinned — right-click to unpin", "warning");
        return;
      }
      applyEditorRequest(state, actions, wtId, {
        kind: "close",
        tab: editorItem.type,
        id: editorItem.id,
      });
      return;
    }
    const item = state.activeItemByWorktree[wtId];
    if (!item) {
      // Nothing open in this worktree → ⌘W closes the container. On a linked
      // worktree that means detaching it from the rail (the directory on disk
      // stays; removing it for real is the rail's explicit action). On the
      // main worktree it means closing the whole workspace — removeWorkspace
      // handles the "this was the last one" edge case by creating a fresh Main.
      const ws = activeWorkspace();
      const wt = activeWorktree();
      if (ws && wt && !wt.isMain) actions.removeWorktree(ws.id, wt.id);
      else actions.removeWorkspace(state.activeWorkspaceId);
      return;
    }
    if (actions.isTabPinned(wtId, item.id)) {
      pushToast("Tab is pinned — right-click to unpin", "warning");
      return;
    }
    switch (item.type) {
      case "terminal":
        actions.removeTerminal(wtId, item.id);
        break;
      case "compare":
        actions.closeCompareTab(wtId, item.id);
        break;
      case "stack":
        actions.closeStackTab(wtId, item.id);
        break;
      case "history":
        actions.closeHistoryTab(wtId, item.id);
        break;
      case "brain":
        actions.closeBrainTab(wtId, item.id);
        break;
      case "browser":
        actions.closeBrowserTab(wtId, item.id);
        break;
    }
  }

  // Every global chord comes from `keymap.ts`; each one resolves its action
  // out of the registry at press time. Built once — the table is static, and
  // the action lookup is what needs to stay late-bound.
  const bindings = keymapBindings();
  useKeybindings(() => bindings);

  const leftPane = () =>
    state.leftSidebarCollapsed
      ? null
      : <TerminalSidebar onOpenFile={(path) => void openInEditorWindow(path)} />;

  const rightPane = () => (
    <Show when={activeRepoPath()}>
      {(repo) => (
        <Show
          when={!state.gitSidebarCollapsed}
          fallback={<GitSidebarCollapsed onExpand={actions.toggleGitSidebar} />}
        >
          <GitSidebar repoPath={repo()} worktreeId={state.activeWorktreeId} />
        </Show>
      )}
    </Show>
  );

  /// The workbench body. Note what is *not* conditional here: this tree is
  /// rendered exactly once, in both modes, because flipping the environment mode
  /// must not remount it — the terminals hanging off it own live PTYs that do
  /// not come back.
  const workbench = (
    <AppShell
      fill
      // The window's title bar is drawn above the view container in both modes,
      // so the shell itself never draws one.
      titleBar={null}
      // Zen removes the panels rather than sliding them away — a
      // keyboard-initiated geometry change never animates (MASTER §7.1), and
      // the pane tree underneath is untouched, so the way back is exact.
      rail={isZen() ? null : <WorkspaceRail />}
      sidebar={isZen() ? null : state.sidebarsSwapped ? rightPane() : leftPane()}
      main={
        <MainSurface
          onOpenFile={(path, line, column) => void openInEditorWindow(path, line, column)}
        />
      }
      rightSidebar={isZen() ? null : state.sidebarsSwapped ? leftPane() : rightPane()}
      statusBar={<StatusBar />}
    />
  );

  /// One stacked view. Hidden with `visibility`, not `display`, and never
  /// unmounted: `display: none` collapses xterm's measured size and would leave
  /// a terminal mis-fitted on the way back, quite apart from what unmounting
  /// would do to its PTY.
  const view = (id: StackedView, children: JSX.Element) => (
    <div
      class="absolute inset-0"
      style={{
        visibility: currentView() === id ? "visible" : "hidden",
        "pointer-events": currentView() === id ? "auto" : "none",
        "z-index": currentView() === id ? 1 : 0,
      }}
      aria-hidden={currentView() !== id}
    >
      {children}
    </div>
  );

  return (
    <>
      <div class="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar onOpenSettings={props.onOpenSettings} />
        <div class="relative flex-1 min-h-0">
          {view("workbench", workbench)}
          {/* Detached mode has these as separate windows, so nothing is
              rendered — and the lazy chunks above are never even fetched. */}
          <Show when={isStackedMode()}>
            {view(
              "editor",
              <Suspense>
                <EditorView
                  embedded
                  context={satelliteContext}
                  tabs={editorTabs}
                  send={(req) =>
                    applyEditorRequest(state, actions, state.activeWorktreeId, req)
                  }
                />
              </Suspense>,
            )}
            {view(
              "git",
              <Suspense>
                <GitView embedded store={store} context={satelliteContext} />
              </Suspense>,
            )}
          </Show>
        </div>
      </div>
      <CommandPalette />
      <ShortcutsCheatSheet />
      <FileFinder
        repoPath={activeRepoPath()}
        onOpenFile={(p) => void openInEditorWindow(p)}
      />
      <AgentPanel onOpenSettings={props.onOpenSettings} />
      <NewWorktreeWizard />
      <ToastViewport />
      <PromptHost />
      {/* macOS resizes through its own window frame; our strips would fight it. */}
      <Show when={!isMac()}>
        <WindowFrame />
      </Show>
    </>
  );
}

export default function App() {
  const store = createAppStore();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  return (
    <AppStoreContext.Provider value={store}>
      <AppInner onOpenSettings={() => setSettingsOpen(true)} settingsOpen={settingsOpen()} />
      <SettingsDialog open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </AppStoreContext.Provider>
  );
}
