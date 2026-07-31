import { emitGitRefsChanged } from "@/commands/gitEvents";
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
import { SnapshotManager } from "@/components/layout/SnapshotManager";
import { AppStoreContext, useAppStore } from "@/store/LayoutContext";
import {
  createAppStore,
  setCorruptKeyHandler,
  setPersistenceErrorHandler,
} from "@/store/layout";
import { isMac } from "@/api/platform";
import { isZen, toggleMaximizedGroup, toggleZen } from "@/store/focusMode";
import { CommandPalette } from "@/commands/CommandPalette";
import { FileFinder } from "@/commands/FileFinder";
import { TabCycleOverlay } from "@/commands/TabCycleOverlay";
import { TabSwitcher } from "@/commands/TabSwitcher";
import { WorktreeSwitcher } from "@/commands/WorktreeSwitcher";
import { abortCycle, commitCycle, stepCycle } from "@/commands/tabCycle";
import type { OpenTabTarget, RecentFileTarget } from "@/commands/targets";
import { ShortcutsCheatSheet } from "@/commands/ShortcutsCheatSheet";
import { ToastViewport } from "@/commands/ToastViewport";
import { PromptHost } from "@/commands/PromptHost";
import { textPrompt } from "@/commands/prompt";
import {
  closeCheatSheet,
  closeBrain,
  closeFileFinder,
  closePalette,
  getActions,
  isCheatSheetOpen,
  isBrainOpen,
  isFileFinderOpen,
  isPaletteOpen,
  isTabSwitcherOpen,
  isWorktreeSwitcherOpen,
  openBrain,
  openCheatSheet,
  openFileFinder,
  openPalette,
  openTabSwitcher,
  openWorktreeSwitcher,
  closeTabSwitcher,
  closeWorktreeSwitcher,
  registerActions,
  type Action,
} from "@/commands/registry";
import { keymapBindings, useKeybindings, useModifierRelease } from "@/commands/keybindings";
import { validateKeymap } from "@/commands/keymap";
import {
  TAB_SELECT_COUNT,
  WORKSPACE_SELECT_COUNT,
  tabSelectId,
  workspaceSelectId,
} from "@/commands/actionIds";
import { repeatLastCommand } from "@/commands/terminalHistory";
import { pushToast } from "@/commands/toast";
import { requestAiCommitDraft } from "@/commands/aiCommit";
import { askAgent, toggleAgentPanel } from "@/commands/agent";
import { agentById, defaultAgentId, resolveAgentCommand, useSettings } from "@/store/settings";
import { BrainOverlayHost } from "@/components/brain/BrainOverlay";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { snapshotsFor, snapshotTabCount } from "@/commands/snapshots";
import { newWorktreeRequest, requestNewWorktree } from "@/commands/worktree";
import { setOverlayOpen } from "@/commands/overlay";
import { agentPanelOpen } from "@/commands/agent";
import { browserApi } from "@/api/webview";
import { applyEditorRequest } from "@/store/editorRequests";
import { publishRepos, setJournalRepo } from "@/store/journal";
import { armTriggers, setTriggerRunner } from "@/store/triggers";
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
  onOpenWorktreeRequest,
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
import { watchRepos } from "@/api/watch";
import {
  requestGitSidebarAction,
  type GitSidebarAction,
} from "@/commands/gitSidebarActions";
import { normalizeUrl } from "@/components/browser/BrowserPane";
import { NewWorktreeWizard } from "@/components/git/worktree/NewWorktreeWizard";
import { samePath } from "@/store/layout/tabs";
import {
  AUTO_GROUP_MODES,
  removePreset,
  renamePreset,
  resolveGroupTabs,
  type ActiveItem,
} from "@/store/layout";
import { browserTabLabel } from "@/components/browser/BrowserPane";

/// The other two surfaces, loaded only if stacked mode actually renders them.
/// Static imports would put the editor and git shells in the workbench's entry
/// chunk even for the detached user who will never see them here.
const EditorView = lazy(() =>
  import("@/EditorApp").then((m) => ({ default: m.EditorSurface })),
);
const GitView = lazy(() => import("@/GitApp").then((m) => ({ default: m.GitSurface })));

function AppInner(props: {
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onOpenSnapshots: () => void;
}) {
  const {
    state,
    activeWorkspace,
    activeWorktree,
    activeRepoPath,
    focusedGroupId,
    focusedGroupMru,
    paneLayout,
    workbenchTabIds,
    canGoBack,
    canGoForward,
    actions,
  } = useAppStore();

  /// Run a sidebar-owned git action, revealing the panel if it is not mounted.
  ///
  /// The request is held by `gitSidebarActions` and replayed when the sidebar
  /// registers, so expanding here completes it rather than merely making the
  /// next attempt work. Previously this dispatched a window event into a
  /// collapsed — and therefore unmounted — sidebar and did nothing at all.
  function runGitSidebarAction(action: GitSidebarAction): void {
    if (requestGitSidebarAction(action)) return;
    if (state.gitSidebarCollapsed) actions.toggleGitSidebar();
  }

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

  // The repository events default to when the recorder has no better idea —
  // `store/journal.ts` explains why an ambient value is accurate here rather
  // than a guess. Same source as the satellite context above, deliberately: a
  // recorded event and the git window must never disagree about which repo the
  // workbench is showing.
  createEffect(() => setJournalRepo(activeRepoPath() || null));

  // ── Triggers ────────────────────────────────────────────────────────────
  // Armed from the workbench and from nowhere else: three windows each
  // listening to the same broadcast would run every firing three times, which
  // is the same argument that put the event log in Rust.
  //
  // The runner opens a real agent tab rather than running a turn invisibly. A
  // process started on the user's behalf that leaves no window behind is one
  // they cannot read, cancel, or learn from.
  onMount(() => {
    setTriggerRunner((firing) => {
      const wtId = state.activeWorktreeId;
      const agent = agentById(firing.rule.agentId);
      const tabId = actions.openAgentTab(wtId, firing.rule.agentId, agent?.name);
      if (!tabId) return;
      void askAgent({
        wtId,
        tabId,
        repoPath: firing.rule.repo,
        commandTemplate: resolveAgentCommand(agent),
        agentName: agent?.name,
        question: firing.prompt,
        openFiles: [],
        activePath: null,
        // The lineage the re-entrancy cutoff reads next time round. Without it
        // a rule that reacts to its own work has nothing to recognise.
        eventData: {
          triggeredBy: firing.lineage.ruleId,
          triggerDepth: firing.lineage.depth,
        },
      });
    });
    onCleanup(armTriggers());
    onCleanup(() => setTriggerRunner(null));
  });

  // Publish the workspace/worktree map so Rust can stamp `workspace` onto the
  // events it derives itself and answer cross-repo queries. From the workbench
  // only: it is the window that owns the workspace model, and having all three
  // publish would mean the satellites' narrower views racing to overwrite it.
  createEffect(() => publishRepos(state.workspaces));

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
    const id = actions.openFileTab(state.activeWorktreeId, path);
    // Editor targets never move the workbench's active item, so the store's
    // activation effect cannot see them. Record the visit — with the line, which
    // is the whole reason back is useful inside a file — explicitly.
    actions.recordNavVisit(state.activeWorktreeId, {
      groupId: null,
      item: { type: "file", id, path },
      ...(line === undefined ? {} : { line }),
    });
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

    // Same reason: "open this worktree" from the git window has no rail to
    // select into there, so it forwards the path and the workbench does it.
    track(
      onOpenWorktreeRequest((req) => {
        const ws = untrack(activeWorkspace);
        if (!ws) return;
        const existing = ws.worktrees.find((wt) => samePath(wt.path, req.path));
        // Registered on demand, so a worktree created outside voidlink still
        // opens without waiting for the next hydration pass.
        const id = existing?.id ?? actions.addWorktree(ws.id, { path: req.path, branch: req.branch });
        if (id) actions.selectWorktree(id);
      }),
    );

    const disposeBridge = bridgeGitRefsAcrossWindows();
    onCleanup(() => {
      disposed = true;
      for (const fn of unlisteners) fn();
      disposeBridge();
    });
  });

  // ── Filesystem watching ──────────────────────────────────────────────────
  // Every worktree of every workspace, re-sent whenever that set changes.
  //
  // Worktrees rather than just `repoRoot`: each has its own working tree that
  // can be edited independently, and a linked worktree's refs live in a git
  // dir outside it that Rust adds as a second watch root.
  //
  // Only this window does it. `watchRepos` replaces the whole watched set, so
  // the editor or git window sending its own idea of it would unwatch
  // everything the workbench asked for.
  createEffect(() => {
    const paths = Array.from(
      new Set(
        useAppStore()
          .state.workspaces.flatMap((ws) => ws.worktrees.map((wt) => wt.path))
          .filter((p) => p.length > 0),
      ),
    ).sort();
    void watchRepos(paths).then((failures) => {
      // Reported, not surfaced: a folder that is not a repository is an
      // ordinary thing to have open, and a toast per non-repo workspace at
      // startup would be noise. The surfaces still refresh on their own
      // actions either way.
      for (const failure of failures) console.warn("[watch]", failure);
    });
  });

  // ── Environment mode ─────────────────────────────────────────────────────
  // Stacked mode hosts the git client and the editor here as views instead of
  // as windows. Everything that wants to "show the editor" goes through
  // `api/windows.ts`, so installing a router there is all it takes to redirect
  // the whole app — the title bar, the git sidebar's file rows, the file tree,
  // the palette and the terminal deep-links included.
  const store = useAppStore();
  const { settings } = useSettings();
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
  createEffect(() => setOverlayOpen("worktree-switcher", isWorktreeSwitcherOpen()));
  createEffect(() => setOverlayOpen("tab-switcher", isTabSwitcherOpen()));
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
            pushToast("Open a folder first", "warning");
            return;
          }
          if (isFileFinderOpen()) closeFileFinder();
          else openFileFinder();
        },
      },
      {
        id: "view.timeline",
        label: "Open the timeline",
        description: "The event log: commits, agent turns and commands, newest first",
        group: "View",
        enabled: () => !!repo,
        run: () => void actions.openTimelineTab(wtId),
      },
      {
        id: "view.mission",
        label: "Open Mission Control",
        description: "Every workspace at once: what is running, what happened, and where it stands",
        group: "View",
        // Deliberately not gated on `repo`: the whole point is that it answers
        // for workspaces other than the one you are standing in, and a
        // workspace pointed at a plain folder still has a row.
        run: () => void actions.openMissionTab(wtId),
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
          emitGitRefsChanged();
        },
      },
      {
        id: "git.fetch",
        label: "Fetch from origin",
        group: "Git",
        enabled: () => !!repo,
        run: () => runGitSidebarAction("fetch"),
      },
      {
        id: "git.pull",
        label: "Pull from origin",
        group: "Git",
        enabled: () => !!repo,
        run: () => runGitSidebarAction("pull"),
      },
      {
        id: "git.remotes",
        label: "Manage remotes…",
        group: "Git",
        enabled: () => !!repo,
        run: () => runGitSidebarAction("remotes"),
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
          emitGitRefsChanged();
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
            emitGitRefsChanged();
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
            emitGitRefsChanged();
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
            emitGitRefsChanged();
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
        id: "agent.newTab",
        label: "New agent thread",
        description: "Open an agent as a pane you can split, drag and come back to",
        group: "AI",
        enabled: () => !!repo,
        run: () => {
          if (!repo) {
            pushToast("Open a repository first", "warning");
            return;
          }
          const agentId = defaultAgentId();
          actions.openAgentTab(state.activeWorktreeId, agentId, agentById(agentId)?.name);
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
            pushToast("Open a folder in this workspace first", "warning");
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
        id: "brain.open",
        label: "Search brain…",
        description: "Browse, read and capture entries in your second-brain vault",
        group: "View",
        run: () => openBrain(),
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
        id: "tab.mru-next",
        label: "Cycle tabs by most recently used",
        description: "Hold Ctrl and press Tab; releasing Ctrl switches to the highlighted tab",
        group: "Tabs",
        enabled: () => focusedGroupMru().length > 1,
        run: () => cycleMru(1),
      },
      {
        id: "tab.mru-prev",
        label: "Cycle tabs backwards by most recently used",
        group: "Tabs",
        hidden: true,
        enabled: () => focusedGroupMru().length > 1,
        run: () => cycleMru(-1),
      },
      {
        id: "tab.switch",
        label: "Go to open tab…",
        description: "Fuzzy search every tab open in this worktree",
        group: "Tabs",
        enabled: () => allItems().length > 0,
        run: () => (isTabSwitcherOpen() ? closeTabSwitcher() : openTabSwitcher()),
      },
      // ⌘⌥1-⌘⌥9 jump to a tab in the focused group. Registered so the keymap
      // can bind them, hidden so nine near-identical rows don't drown the
      // palette — the same bargain the nine workspace slots make.
      ...Array.from({ length: TAB_SELECT_COUNT }, (_, i): Action => ({
        id: tabSelectId(i + 1),
        label: `Go to tab ${i + 1}`,
        group: "Tabs",
        hidden: true,
        enabled: () => focusedGroupTabIds().length > i,
        run: () => selectTabAt(i + 1),
      })),
      {
        id: "tab.select.last",
        label: "Go to last tab",
        group: "Tabs",
        hidden: true,
        enabled: () => focusedGroupTabIds().length > 0,
        run: () => selectTabAt("last"),
      },
      {
        id: "ui.navigate-back",
        label: "Go back",
        description: "The previous tab, pane and line you were looking at",
        group: "View",
        enabled: () => canGoBack(),
        run: () => navigateHistory(-1),
      },
      {
        id: "ui.navigate-forward",
        label: "Go forward",
        group: "View",
        enabled: () => canGoForward(),
        run: () => navigateHistory(1),
      },
      {
        id: "workspace.switch",
        label: "Go to worktree…",
        description: "Every worktree across every workspace, with its dirty and ahead/behind state",
        group: "Workspace",
        run: () =>
          isWorktreeSwitcherOpen() ? closeWorktreeSwitcher() : openWorktreeSwitcher(),
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
      {
        id: "snapshot.manage",
        label: "Snapshot: manage saved snapshots…",
        description: "Restore, rename or delete a saved session",
        group: "Workspace",
        run: () => props.onOpenSnapshots(),
      },
      // Dynamic entries — one restore per saved snapshot for the active
      // worktree, re-registered on each effect run. Delete and rename live in
      // the snapshot manager: they are destructive and need to be seen next to
      // what they act on, which a palette row cannot show.
      // ── Layout presets ─────────────────────────────────────────────────
      // An *arrangement*, recalled by name: the pane tree, the tab groups,
      // each pane's front tab and the three panel widths. Distinct from a
      // snapshot, which is a whole session — applying a preset opens and
      // closes nothing, it rearranges whatever is already there.
      {
        id: "layout.preset.save",
        label: "Layout: save arrangement as…",
        description: "Panes, tab groups and panel widths — no tab contents",
        group: "Workspace",
        run: async () => {
          const name = await textPrompt({
            title: "Save layout preset",
            label: "Name this arrangement of panes, tab groups and panel widths",
            placeholder: "review",
            confirmLabel: "Save",
          });
          if (!name) return;
          if (actions.saveLayoutPreset(state.activeWorktreeId, name)) {
            pushToast(`Layout "${name}" saved`, "success");
          }
        },
      },
      // Three rows per preset, generated from user data. Apply is the common
      // one; rename and delete sit beside it rather than in a manager of their
      // own, because a preset has nothing to show next to itself the way a
      // snapshot's tab list does.
      ...actions.layoutPresets().flatMap<Action>((preset) => [
        {
          id: `layout.preset.apply.${preset.name}`,
          label: `Layout: apply "${preset.name}"`,
          description: "Rearrange the open tabs into this arrangement",
          group: "Workspace",
          run: () => {
            if (actions.applyLayoutPreset(state.activeWorktreeId, preset.name)) {
              pushToast(`Applied "${preset.name}"`, "success");
            } else {
              pushToast(`Layout "${preset.name}" not found`, "error");
            }
          },
        },
        {
          id: `layout.preset.rename.${preset.name}`,
          label: `Layout: rename "${preset.name}"…`,
          group: "Workspace",
          run: async () => {
            const next = await textPrompt({
              title: "Rename layout preset",
              label: `New name for "${preset.name}"`,
              initialValue: preset.name,
              confirmLabel: "Rename",
            });
            if (!next) return;
            const result = renamePreset(state.activeWorkspaceId, preset.name, next);
            if (result === "ok") pushToast(`Renamed to "${next.trim()}"`, "success");
            else if (result === "duplicate") pushToast("A layout with that name exists", "error");
            else if (result === "empty-name") pushToast("A layout needs a name", "error");
            else pushToast(`Layout "${preset.name}" not found`, "error");
          },
        },
        {
          id: `layout.preset.delete.${preset.name}`,
          label: `Layout: delete "${preset.name}"`,
          group: "Workspace",
          run: () => {
            removePreset(state.activeWorkspaceId, preset.name);
            pushToast(`Deleted "${preset.name}"`, "info");
          },
        },
      ]),
      // ── Auto-grouping ──────────────────────────────────────────────────
      // Derived tab groups. Read-only by construction: the first hand-edit of
      // one materialises the derivation and drops the worktree back to `off`,
      // so the rule never undoes the user.
      ...AUTO_GROUP_MODES.map<Action>((mode) => ({
        id: `layout.autogroup.${mode}`,
        label:
          mode === "off"
            ? "Tab groups: manual"
            : `Tab groups: group by ${mode === "kind" ? "kind" : "worktree"}`,
        description:
          mode === "off"
            ? "Group tabs by hand"
            : "Derive tab groups automatically; editing one switches back to manual",
        group: "View",
        enabled: () => actions.autoGroupMode(state.activeWorktreeId) !== mode,
        run: () => actions.setAutoGroupMode(state.activeWorktreeId, mode),
      })),
      ...snapshotsFor(state.activeWorktreeId).map<Action>((snap) => ({
        id: `snapshot.restore.${snap.name}`,
        label: `Snapshot: restore "${snap.name}"`,
        description: `${snapshotTabCount(snap)} tabs`,
        group: "Workspace",
        run: async () => {
          const ok = await actions.restoreWorkspaceSnapshot(state.activeWorktreeId, snap.name);
          if (!ok) pushToast(`Snapshot "${snap.name}" not found`, "error");
          else pushToast(`Restored "${snap.name}"`, "success");
        },
      })),
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
  /// them (terminals → compares → stacks → graph → timeline → browser). Used by
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
    for (const t of state.timelineTabsByWorktree[wtId] ?? [])
      items.push({ type: "timeline", id: t.id });
    for (const m of state.missionTabsByWorktree[wtId] ?? [])
      items.push({ type: "mission", id: m.id });
    for (const b of state.browserTabsByWorktree[wtId] ?? [])
      items.push({ type: "browser", id: b.id });
    return items;
  }

  /// Every open workbench tab as something a picker can send you to. One
  /// builder for the palette's default mode, the "go to open tab" switcher and
  /// the `Ctrl+Tab` overlay — three surfaces that must agree about what a tab
  /// is called.
  function workbenchTargets(): OpenTabTarget[] {
    const wtId = state.activeWorktreeId;
    const go = (item: ActiveItem) => () => activateItem(item);
    const out: OpenTabTarget[] = [];
    for (const t of state.terminalsByWorktree[wtId] ?? []) {
      out.push({
        id: t.id,
        label: t.label,
        kind: "terminal",
        detail: t.cwd,
        open: go({ type: "terminal", id: t.id }),
      });
    }
    for (const c of state.compareTabsByWorktree[wtId] ?? []) {
      out.push({
        id: c.id,
        label: `${c.baseRef || "?"}..${c.headRef || "?"}`,
        kind: "compare",
        detail: "compare",
        open: go({ type: "compare", id: c.id }),
      });
    }
    for (const s of state.stackTabsByWorktree[wtId] ?? []) {
      out.push({
        id: s.id,
        label: s.topBranch,
        kind: "stack",
        detail: `stack → ${s.trunk}`,
        open: go({ type: "stack", id: s.id }),
      });
    }
    for (const h of state.historyTabsByWorktree[wtId] ?? []) {
      out.push({
        id: h.id,
        label: "Commit graph",
        kind: "history",
        open: go({ type: "history", id: h.id }),
      });
    }
    for (const t of state.timelineTabsByWorktree[wtId] ?? []) {
      out.push({
        id: t.id,
        label: "Timeline",
        kind: "timeline",
        open: go({ type: "timeline", id: t.id }),
      });
    }
    for (const m of state.missionTabsByWorktree[wtId] ?? []) {
      out.push({
        id: m.id,
        label: "Mission Control",
        kind: "mission",
        open: go({ type: "mission", id: m.id }),
      });
    }
    for (const b of state.browserTabsByWorktree[wtId] ?? []) {
      out.push({
        id: b.id,
        label: browserTabLabel(b),
        kind: "browser",
        detail: b.url,
        open: go({ type: "browser", id: b.id }),
      });
    }
    return out;
  }

  /// Files worth offering back: what the editor window has open, then what was
  /// recently closed. No new tracking — the store already keeps both, and a
  /// third "recent files" list would be a third thing that can go stale.
  function recentFileTargets(): RecentFileTarget[] {
    const wtId = state.activeWorktreeId;
    const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
    const seen = new Set<string>();
    const out: RecentFileTarget[] = [];
    const add = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      out.push({
        path,
        label: basename(path),
        open: () => void openInEditorWindow(path),
      });
    };
    for (const f of state.openFilesByWorktree[wtId] ?? []) add(f.path);
    // The LIFO is oldest-first, and "recent" means the other way round.
    for (const closed of [...(state.closedTabsByWorktree[wtId] ?? [])].reverse()) {
      if (closed.type === "file") add(closed.path);
    }
    return out;
  }

  /// The focused group's tabs in strip order — what jump-to-tab-N counts. MRU
  /// order is a different question and has its own chord.
  function focusedGroupTabIds(): string[] {
    const groupId = focusedGroupId();
    if (!groupId) return workbenchTabIds();
    return resolveGroupTabs(paneLayout(), workbenchTabIds()).get(groupId) ?? [];
  }

  function itemForTabId(tabId: string): ActiveItem | null {
    return allItems().find((i) => i.id === tabId) ?? null;
  }

  /// `⌘⌥1`…`⌘⌥9`, and `⌘⌥0` for the last tab in the group.
  function selectTabAt(position: number | "last") {
    const ids = focusedGroupTabIds();
    const id = position === "last" ? ids[ids.length - 1] : ids[position - 1];
    if (!id) return;
    const item = itemForTabId(id);
    if (item) activateItem(item);
  }

  /// One press of `Ctrl+Tab`. The candidate list is the focused group's MRU;
  /// nothing is activated until `useModifierRelease` below sees the modifier
  /// come up.
  function cycleMru(delta: 1 | -1) {
    const byId = new Map(workbenchTargets().map((t) => [t.id, t]));
    const candidates = focusedGroupMru()
      .map((id) => byId.get(id))
      .filter((t): t is OpenTabTarget => !!t)
      .map((t) => ({ id: t.id, label: t.label, kind: t.kind }));
    stepCycle(candidates, delta);
  }

  useModifierRelease({
    onRelease: () => {
      const selected = commitCycle();
      if (!selected) return;
      const item = itemForTabId(selected.id);
      if (item) activateItem(item);
    },
    onCancel: abortCycle,
  });

  /// Walk the per-worktree navigation history. Editor targets are re-opened in
  /// the editor window at the recorded line; workbench targets are activated in
  /// their own group, which `navigateHistory` has already focused.
  function navigateHistory(direction: -1 | 1) {
    const wtId = state.activeWorktreeId;
    const entry = actions.navigateHistory(wtId, direction);
    if (!entry) return;
    switch (entry.item.type) {
      case "file":
        void openInEditorWindow(entry.item.path, entry.line);
        break;
      case "diff":
        actions.selectDiffTab(wtId, entry.item.id);
        void showEditorWindow();
        break;
      case "conflict":
        actions.selectConflictTab(wtId, entry.item.id);
        void showEditorWindow();
        break;
      case "preview":
        actions.selectPreviewTab(wtId, entry.item.id);
        void showEditorWindow();
        break;
      default:
        activateItem(entry.item);
    }
  }

  function activateItem(item: ActiveItem) {
    const wtId = state.activeWorktreeId;
    // Jumping to a tab focuses the pane holding it and brings it to the front
    // there. Without this, `Ctrl+Tab` into a background group would change the
    // active item while leaving the user's focus — and the group's own front
    // tab — somewhere else.
    const groupId = actions.paneGroupOwning(wtId, item.id);
    if (groupId) {
      actions.focusPaneGroup(wtId, groupId);
      actions.setPaneGroupActiveTab(wtId, groupId, item.id);
    }
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
      case "timeline":
        actions.selectTimelineTab(wtId, item.id);
        break;
      case "mission":
        actions.selectMissionTab(wtId, item.id);
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
  /// The palette's "Remove current worktree…".
  ///
  /// The `…` used to be a lie: this deleted the directory with no confirmation
  /// at all, offered no force path when git refused, and emitted no refresh
  /// pulse. It now runs the same flow as the rail and the sidebar.
  async function removeActiveWorktree() {
    const ws = activeWorkspace();
    const wt = activeWorktree();
    if (!ws?.repoRoot || !wt || wt.isMain) {
      pushToast("The main worktree can't be removed — close the workspace instead", "warning");
      return;
    }
    const { removeWorktreeWithConfirm } = await import("@/commands/worktreeRemove");
    const { worktreeLabel } = await import("@/types/workspace");
    const removed = await removeWorktreeWithConfirm({
      repoRoot: ws.repoRoot,
      path: wt.path,
      label: worktreeLabel(wt),
    });
    if (removed) actions.removeWorktree(ws.id, wt.id);
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
      case "timeline":
        actions.closeTimelineTab(wtId, item.id);
        break;
      case "mission":
        actions.closeMissionTab(wtId, item.id);
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
          onOpenSettings={props.onOpenSettings}
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
      {/* The window surface is the canvas (D1). Every view drawn into it
          composes its own islands on top. */}
      <div class="flex flex-col h-screen w-screen overflow-hidden bg-canvas text-foreground">
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
            {/* The git view is mounted only while it is on screen. Unlike the
                editor (Monaco) and the workbench (xterm), nothing here holds
                measured layout or a PTY — and leaving it mounted meant every git
                pane existed twice, doubling the command fan-out of every
                refresh pulse and registering a second commit-draft listener. */}
            {view(
              "git",
              <Show when={currentView() === "git"}>
                <Suspense>
                  <GitView embedded store={store} context={satelliteContext} />
                </Suspense>
              </Show>,
            )}
          </Show>
        </div>
      </div>
      <CommandPalette openTabs={workbenchTargets} recentFiles={recentFileTargets} />
      <ShortcutsCheatSheet />
      <FileFinder
        repoPath={activeRepoPath()}
        onOpenFile={(p) => void openInEditorWindow(p)}
      />
      <WorktreeSwitcher />
      <TabSwitcher tabs={workbenchTargets} />
      {/* Held-modifier UI: no scrim, no transition, gone on the keyup. */}
      <TabCycleOverlay />
      <BrainOverlayHost
        open={isBrainOpen()}
        vaultPath={settings.brain.vaultPath}
        onClose={closeBrain}
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

/// The two things the layout store cannot fix by itself, wired before the
/// store is created so the very first read can report.
///
/// A quarantined blob is a *failure* the user did not ask for and cannot see
/// otherwise — their panes are back to defaults and nothing on screen says
/// why — so it is `assertive` (MASTER §10.10). A failed write is a warning:
/// the session in front of them is still correct, only its durability is lost.
setCorruptKeyHandler((key) =>
  pushToast(
    `Saved layout state in "${key}" was unreadable and has been reset to defaults. Everything else was kept.`,
    "error",
    8000,
  ),
);
setPersistenceErrorHandler((key) =>
  pushToast(
    `Couldn't save layout state ("${key}") — storage is full or unavailable. This session still works; it may not come back after a reload.`,
    "warning",
    8000,
  ),
);

export default function App() {
  const store = createAppStore();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [snapshotsOpen, setSnapshotsOpen] = createSignal(false);
  /// The palette's "Go to setting…" query. A signal rather than a one-shot
  /// call so asking twice for the same setting still re-focuses the filter —
  /// the wrapper object makes each request a distinct value even when the text
  /// is identical.
  const [gotoSetting, setGotoSetting] = createSignal<{ query: string } | null>(null);

  const onGotoSetting = (e: Event) => {
    const query = (e as CustomEvent<string>).detail;
    if (typeof query !== "string") return;
    setGotoSetting({ query });
    setSettingsOpen(true);
  };
  window.addEventListener("voidlink:goto-setting", onGotoSetting);
  onCleanup(() => window.removeEventListener("voidlink:goto-setting", onGotoSetting));

  return (
    <AppStoreContext.Provider value={store}>
      <AppInner
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen()}
        onOpenSnapshots={() => setSnapshotsOpen(true)}
      />
      <SettingsDialog
        open={settingsOpen()}
        onClose={() => {
          setSettingsOpen(false);
          setGotoSetting(null);
        }}
        gotoSetting={gotoSetting()?.query}
      />
      <SnapshotManager open={snapshotsOpen()} onClose={() => setSnapshotsOpen(false)} />
    </AppStoreContext.Provider>
  );
}
