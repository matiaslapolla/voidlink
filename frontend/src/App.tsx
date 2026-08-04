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
import { TooltipLayer } from "@/components/ui/Tooltip";
import { PromptHost } from "@/commands/PromptHost";
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
  openBrain,
  openCheatSheet,
  openFileFinder,
  openPalette,
  openTabSwitcher,
  closeTabSwitcher,
  useActionSource,
  useActionSourceCatalog,
  type Action,
} from "@/commands/registry";
import { registerGitActions } from "@/commands/gitActions";
import { registerStackActions } from "@/commands/stackActions";
import { registerWorkspaceActions } from "@/commands/workspaceActions";
import { registerSnapshotActions } from "@/commands/snapshotActions";
import { registerLayoutPresetActions } from "@/commands/layoutPresetActions";
import { keymapBindings, useKeybindings, useModifierRelease } from "@/commands/keybindings";
import { validateKeymap } from "@/commands/keymap";
import { TAB_SELECT_COUNT, tabSelectId } from "@/commands/actionIds";
import { repeatLastCommand } from "@/commands/terminalHistory";
import { pushToast } from "@/commands/toast";
import { askAgent, registerAgentActions } from "@/commands/agent";
import { agentById, resolveAgentCommand, useSettings } from "@/store/settings";
import { AgentBoardBroadcast } from "@/components/agent/AgentBoardBroadcast";
import { FilesPanel } from "@/components/files/FilesPanel";
import { BrainOverlayHost } from "@/components/brain/BrainOverlay";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { createOverlay, setOverlayOpen } from "@/commands/overlay";
import { requestNewWorktree } from "@/commands/worktree";
import { browserApi } from "@/api/webview";
import { applyEditorRequest } from "@/store/editorRequests";
import { publishRepos, setJournalRepo } from "@/store/journal";
import { reconcileFanoutRuns } from "@/store/fanout";
import { armTriggers, setTriggerRunner } from "@/store/triggers";
import {
  currentStackedView,
  isStackedMode,
  setStackedView,
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
  publishEditorTabs,
  publishWindowContext,
  setStackedViewRouter,
  showEditorWindow,
  type EditorReveal,
  type EditorTabsSnapshot,
} from "@/api/windows";
import { watchRepos } from "@/api/watch";
import { normalizeUrl } from "@/components/browser/BrowserPane";
import { NewWorktreeWizard } from "@/components/git/worktree/NewWorktreeWizard";
import { samePath } from "@/store/layout/tabs";
import { resolveGroupTabs, type ActiveItem } from "@/store/layout";
import { browserTabLabel } from "@/components/browser/BrowserPane";

/// The other two surfaces, loaded only if stacked mode actually renders them.
/// Static imports would put the editor and git shells in the workbench's entry
/// chunk even for the detached user who will never see them here.
const EditorView = lazy(() =>
  import("@/EditorApp").then((m) => ({ default: m.EditorSurface })),
);
const GitView = lazy(() => import("@/GitApp").then((m) => ({ default: m.GitSurface })));

function AppInner(props: { onOpenSettings: () => void; onOpenSnapshots: () => void }) {
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
  const { settings } = useSettings();

  // ── Feature-owned palette entries ────────────────────────────────────────
  // Each of these registers its own slice of the catalog at the point the
  // feature already lives, instead of `App.tsx` importing from every one of
  // them to build one giant array — see PALETTE-SRC1 in
  // `commands/registry.ts`. Order here is not load-bearing: each call is a
  // `useActionSource(priority, …)`, and priority is what fixes a
  // source's place in the composed catalog.
  registerGitActions();
  registerStackActions();
  registerWorkspaceActions();
  registerSnapshotActions(props.onOpenSnapshots);
  registerLayoutPresetActions();
  registerAgentActions();

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

  // The reconnect half of fan-out outliving its window: whenever this window
  // shows a different repository (including the first time it shows one at
  // all — a reload lands here too), ask the supervisor what it is actually
  // still driving for it and reconcile. See `store/fanout.ts`'s module
  // comment and `reconcileFanoutRuns` for what this can and cannot recover.
  createEffect(() => {
    const repo = activeRepoPath();
    if (repo) void reconcileFanoutRuns(repo);
  });

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
  const currentView = currentStackedView;

  // A view that isn't the workbench covers it with plain DOM — which a child
  // webview would paint straight through. Same mechanism the modals use.
  //
  // This is the one overlay registration still living here rather than beside
  // the state it watches (see `commands/overlay.ts`): `currentView` is a
  // derived read of two signals owned by this component (`isStackedMode`,
  // `stackedView`), not a boolean a module can hand out a `createOverlay` for.
  // Every other surface — the palette, the switchers, the cheat sheet, the
  // agent panel, the worktree wizard, settings, snapshots — registers itself
  // at its own point of ownership; `App.tsx` no longer has to know the full
  // list to keep it correct.
  createEffect(() => setOverlayOpen("stacked-view", currentView() !== "workbench"));

  // ── The workbench's own palette entries ──────────────────────────────────
  // What is left after Git, Stack, Workspace/Worktree, Snapshots, Layout
  // presets and Agent moved to `registerActionSource` calls of their own (see
  // PALETTE-SRC1, `commands/registry.ts`): entries with no state to close
  // over beyond `props`, or ones that need the tab-cycling/navigation
  // closures below (`allItems`, `activateItem`, `focusedGroupTabIds`, …),
  // which stay here because those closures are the workbench's own, reused
  // by `workbenchTargets`/`useModifierRelease` and not worth extracting into
  // a module of their own.
  //
  // Priorities reproduce the original hand-written array's positions —
  // several groups (App, View, Tabs) were themselves split across multiple
  // non-adjacent spots in that array, which is why there is more than one
  // `registerActionSource` call per group below.
  useActionSource(10, (): Action[] => [
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
  ]);

  useActionSource(20, (): Action[] => {
    const repo = activeRepoPath();
    return [
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
    ];
  });

  useActionSource(30, (): Action[] => {
    const wtId = state.activeWorktreeId;
    return [
      {
        id: "view.timeline",
        label: "Open the timeline",
        description: "The event log: commits, agent turns and commands, newest first",
        group: "View",
        enabled: () => !!activeRepoPath(),
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
    ];
  });

  useActionSource(40, (): Action[] => {
    const repo = activeRepoPath();
    const wtId = state.activeWorktreeId;
    return [
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
    ];
  });

  useActionSource(60, (): Action[] => [
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
  ]);

  useActionSource(90, (): Action[] => [
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
  ]);

  useActionSource(100, (): Action[] => [
    {
      id: "app.settings",
      label: "Open settings…",
      group: "App",
      run: () => props.onOpenSettings(),
    },
  ]);

  useActionSource(140, (): Action[] => {
    const wtId = state.activeWorktreeId;
    return [
      {
        id: "brain.open",
        label: "Search brain…",
        description: "Browse, read and capture entries in this project's brain",
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
    ];
  });

  useActionSource(160, (): Action[] => [
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
  ]);

  useActionSource(170, (): Action[] => [
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
  ]);

  useActionSource(190, (): Action[] => {
    const wtId = state.activeWorktreeId;
    return [
      {
        id: "tab.reopen-last",
        label: "Reopen last closed tab",
        description: "File / diff / compare / stack — terminals can't be reopened",
        group: "Tabs",
        enabled: () => (state.closedTabsByWorktree[wtId] ?? []).length > 0,
        run: () => void reopenLastClosed(),
      },
    ];
  });

  // Wires every `registerActionSource` call above — and every one made by
  // the feature modules called at the top of this component — into the
  // registry's `actions` signal. One call, after every source for this
  // window has had the chance to register.
  useActionSourceCatalog();

  // Dev-time keymap audit. The unit test catches duplicate chords and ids
  // that aren't in the declared catalog; this catches the remaining case —
  // an id that is declared but never actually registered, which would show
  // up at runtime as a shortcut that quietly does nothing. Tracks
  // `getActions()` directly (rather than `untrack`ing it, as the single
  // hand-written effect used to) so it re-runs whenever the composed catalog
  // changes — now the only signal this diagnostic needs to depend on, since
  // registration is no longer one effect it shares with catalog-building.
  createEffect(() => {
    const ids = getActions().map((a) => a.id);
    if (!import.meta.env.DEV) return;
    untrack(() => {
      // Stacked mode registers the editor's actions in this window too, so
      // the audit must not skip the entries the editor owns — they are ours.
      for (const problem of validateKeymap(ids, isStackedMode() ? {} : { window: "main" })) {
        console.error(`[keymap] ${problem.kind}: ${problem.detail}`);
      }
    });
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

  // ── Where the file explorer lives ────────────────────────────────────────
  //
  // Under horizontal tabs, exactly where it always has: the first section of
  // the left sidebar, above the terminals list.
  //
  // Under **vertical** tabs it moves to the right column, above the git panel,
  // and the left sidebar goes away entirely. That is not decoration; it is the
  // consequence of the preference. A vertical tab strip is a third navigation
  // column at the left edge, behind the workspace rail and the file tree, and
  // three parallel vertical lists at one edge is one more than the eye scans.
  // Splitting them by *kind* is what the window has room for: the left edge
  // answers "which thing am I looking at" (workspaces, then tabs) and the
  // right edge answers "what is in this repo" (its files, then its changes).
  //
  // The left sidebar's other two sections survive the move because neither is
  // lost. The terminals list is a second rendering of the terminal *tabs*, and
  // a vertical strip shows those with their full labels — better than the list
  // it duplicates. "Compare branches" is a row in the "+" menu and an action
  // in the palette. The repo picker is on the workspace rail.
  //
  // `Mod+B` keeps meaning "show or hide the file explorer" in both layouts,
  // which is why `leftSidebarCollapsed` gates the right-column placement too:
  // the binding names an intent, not a screen edge.
  const verticalTabs = () => settings.ui.tabOrientation === "vertical";

  const leftPane = () =>
    verticalTabs() || state.leftSidebarCollapsed ? null : (
      <TerminalSidebar onOpenFile={(path) => void openInEditorWindow(path)} />
    );

  const gitPane = () => (
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

  const rightPane = () => (
    <Show when={verticalTabs()} fallback={gitPane()}>
      {/* One column, two stacked panels. It takes its width from whichever
          child declares one — `GitSidebar` does, off `panels.gitSidebar`, and
          its splitter therefore resizes the column as a whole. `FilesPanel`
          is `w-full` inside it rather than carrying a width of its own, so
          the two can never disagree about how wide the column is. */}
      <div class="flex flex-col min-h-0 bg-sidebar">
        <Show when={!state.leftSidebarCollapsed}>
          <div class="flex-1 min-h-0 flex flex-col border-b border-border/60 w-full">
            <FilesPanel onOpenFile={(path) => void openInEditorWindow(path)} />
          </div>
        </Show>
        {/* `flex` rather than `contents`: the git panel is an `<aside>` with
            its own width and expects to be laid out as a flex child. */}
        <div class="flex-1 min-h-0 flex">{gitPane()}</div>
      </div>
    </Show>
  );

  /// The workbench body. Note what is *not* conditional here: this tree is
  /// rendered exactly once, in both modes, because flipping the environment mode
  /// must not remount it — the terminals hanging off it own live PTYs that do
  /// not come back.
  const workbench = (
    <>
    {/* The agent board's one writer. Outside `AppShell` because it renders
        nothing and must survive zen, which passes `null` for every panel —
        a broadcaster that stops when a sidebar is hidden is the per-strip
        poll `terminalWatch.ts` was written to replace. Behind the flag
        fully: with it off this never mounts, so nothing polls. */}
    <Show when={settings.experimental.agentDashboard}>
      <AgentBoardBroadcast />
    </Show>
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
    </>
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
      {/* The workspace's repo root, not the active worktree's path: a brain
          belongs to the project, so every worktree of it reads and writes the
          same entries rather than one per checkout. */}
      <BrainOverlayHost
        open={isBrainOpen()}
        repoPath={activeWorkspace()?.repoRoot ?? ""}
        onClose={closeBrain}
      />
      <AgentPanel onOpenSettings={props.onOpenSettings} />
      <NewWorktreeWizard />
      <ToastViewport />
      {/* One tooltip surface per window. Without it `use:tooltip` is inert
          rather than broken, which is the right failure for a window that has
          not adopted it yet. */}
      <TooltipLayer />
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
  // `createOverlay`, not a bare `createSignal`: both dialogs are modal
  // surfaces the embedded browser has to hide behind (see
  // `commands/overlay.ts`). Snapshots was never wired into the old
  // hand-written effect list in `AppInner` — an unregistered overlay nobody
  // had hit yet, and exactly the failure mode BR-O1 describes.
  const settings = createOverlay("settings");
  const snapshots = createOverlay("snapshots");
  /// The palette's "Go to setting…" query. A signal rather than a one-shot
  /// call so asking twice for the same setting still re-focuses the filter —
  /// the wrapper object makes each request a distinct value even when the text
  /// is identical.
  const [gotoSetting, setGotoSetting] = createSignal<{ query: string } | null>(null);

  const onGotoSetting = (e: Event) => {
    const query = (e as CustomEvent<string>).detail;
    if (typeof query !== "string") return;
    setGotoSetting({ query });
    settings.open();
  };
  window.addEventListener("voidlink:goto-setting", onGotoSetting);
  onCleanup(() => window.removeEventListener("voidlink:goto-setting", onGotoSetting));

  return (
    <AppStoreContext.Provider value={store}>
      <AppInner onOpenSettings={settings.open} onOpenSnapshots={snapshots.open} />
      <SettingsDialog
        open={settings.isOpen()}
        onClose={() => {
          settings.close();
          setGotoSetting(null);
        }}
        gotoSetting={gotoSetting()?.query}
      />
      <SnapshotManager open={snapshots.isOpen()} onClose={snapshots.close} />
    </AppStoreContext.Provider>
  );
}
