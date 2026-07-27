import { Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
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
import { editorController } from "@/components/editor/editorController";
import { isMac } from "@/api/platform";
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
import { blameEnabled, configureBlame, toggleBlame } from "@/components/editor/blameOverlay";
import { newWorktreeRequest, requestNewWorktree } from "@/commands/worktree";
import { setOverlayOpen } from "@/commands/overlay";
import { agentPanelOpen } from "@/commands/agent";
import { browserApi } from "@/api/webview";
import {
  bridgeGitRefsAcrossWindows,
  onGitContextRequest,
  onWorktreeWizardRequest,
  openGitWindow,
  publishGitContext,
} from "@/api/gitWindow";
import { normalizeUrl } from "@/components/browser/BrowserPane";
import { NewWorktreeWizard } from "@/components/git/worktree/NewWorktreeWizard";
import type { ActiveItem } from "@/store/layout";

function AppInner(props: { onOpenSettings: () => void; settingsOpen: boolean }) {
  const { state, activeWorkspace, activeWorktree, activeRepoPath, actions } = useAppStore();

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
  const gitWindowContext = () => ({
    repoPath: activeRepoPath(),
    worktreeId: state.activeWorktreeId,
    branch: activeWorktree()?.branch ?? null,
    workspaceName: activeWorkspace()?.name ?? "",
    worktreeLabel: activeWorktree()?.branch ?? activeWorktree()?.path ?? "",
  });
  createEffect(() => void publishGitContext(gitWindowContext()));

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
      onGitContextRequest(() => {
        void publishGitContext(untrack(gitWindowContext));
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

  // Embedded browser tabs are child webviews that composite above the DOM, so
  // every modal surface has to actively push them out of the way while open.
  createEffect(() => setOverlayOpen("palette", isPaletteOpen()));
  createEffect(() => setOverlayOpen("file-finder", isFileFinderOpen()));
  createEffect(() => setOverlayOpen("worktree-wizard", !!newWorktreeRequest()));
  createEffect(() => setOverlayOpen("agent", agentPanelOpen()));
  createEffect(() => setOverlayOpen("settings", props.settingsOpen));

  // Tell the blame overlay how to find the repo for a given file path.
  // The overlay needs this any time the editor's active model changes
  // so it can refresh without going through MainSurface's effect.
  //
  // Resolution is per *worktree* now, and longest-prefix wins: a linked
  // worktree at `/repo-feature` and its main repo at `/repo` are different
  // checkouts of the same file, and blaming against the wrong one silently
  // shows the wrong authors.
  configureBlame((filePath) => {
    let best: string | null = null;
    for (const ws of state.workspaces) {
      for (const wt of ws.worktrees) {
        if (!wt.path || !filePath.startsWith(wt.path)) continue;
        if (!best || wt.path.length > best.length) best = wt.path;
      }
    }
    return best ?? activeRepoPath();
  });

  async function handleOpenFile(path: string) {
    actions.openFileTab(state.activeWorktreeId, path);
    await editorController.openFile(path);
  }

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
        id: "file.save",
        label: "Save file",
        description: "Write the active editor tab to disk",
        group: "File",
        enabled: () => !!editorController.getActivePath(),
        run: () => void editorController.saveActive(),
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
        run: () => toggleBlame(),
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
        for (const problem of validateKeymap(getActions().map((a) => a.id))) {
          console.error(`[keymap] ${problem.kind}: ${problem.detail}`);
        }
      });
    }

    // Re-register on next change.
    return dispose;
  });

  /// Build the ordered list of tabs in the same order MainSurface renders
  /// them (files → terminals → diffs → compares → stacks). Used by the
  /// Cmd+Alt+Arrow cycle shortcut so the wrap order matches what the user
  /// sees in the unified tab bar.
  function allItems(): ActiveItem[] {
    const wtId = state.activeWorktreeId;
    const items: ActiveItem[] = [];
    for (const f of state.openFilesByWorktree[wtId] ?? [])
      items.push({ type: "file", id: f.id, path: f.path });
    for (const t of state.terminalsByWorktree[wtId] ?? [])
      items.push({ type: "terminal", id: t.id });
    for (const d of state.diffTabsByWorktree[wtId] ?? [])
      items.push({ type: "diff", id: d.id });
    for (const c of state.compareTabsByWorktree[wtId] ?? [])
      items.push({ type: "compare", id: c.id });
    for (const s of state.stackTabsByWorktree[wtId] ?? [])
      items.push({ type: "stack", id: s.id });
    for (const c of state.conflictTabsByWorktree[wtId] ?? [])
      items.push({ type: "conflict", id: c.id });
    for (const b of state.browserTabsByWorktree[wtId] ?? [])
      items.push({ type: "browser", id: b.id });
    return items;
  }

  function activateItem(item: ActiveItem) {
    const wtId = state.activeWorktreeId;
    switch (item.type) {
      case "file":
        actions.selectFileTab(wtId, item.id, item.path);
        void editorController.setActive(item.path);
        break;
      case "terminal":
        actions.selectTerminal(wtId, item.id);
        break;
      case "diff":
        actions.selectDiffTab(wtId, item.id);
        break;
      case "compare":
        actions.selectCompareTab(wtId, item.id);
        break;
      case "stack":
        actions.selectStackTab(wtId, item.id);
        break;
      case "conflict":
        actions.selectConflictTab(wtId, item.id);
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

  /// Reopen the most-recently closed tab AND, when it's a file, kick
  /// the Monaco controller to load+activate the model. The store
  /// action alone only restores the tab record — without this, the
  /// reopened file tab appears but the editor stays parked on
  /// whatever model was active before.
  async function reopenLastClosed() {
    const popped = actions.reopenLastClosedTab(state.activeWorktreeId);
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
      case "file": {
        editorController.closeFile(item.path);
        actions.closeFileTab(wtId, item.id);
        break;
      }
      case "terminal":
        actions.removeTerminal(wtId, item.id);
        break;
      case "diff":
        actions.closeDiffTab(wtId, item.id);
        break;
      case "compare":
        actions.closeCompareTab(wtId, item.id);
        break;
      case "stack":
        actions.closeStackTab(wtId, item.id);
        break;
      case "conflict":
        actions.closeConflictTab(wtId, item.id);
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
      : <TerminalSidebar onOpenFile={(path) => void handleOpenFile(path)} />;

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

  return (
    <>
      <AppShell
        titleBar={<TitleBar onOpenSettings={props.onOpenSettings} />}
        rail={<WorkspaceRail />}
        sidebar={state.sidebarsSwapped ? rightPane() : leftPane()}
        main={<MainSurface />}
        rightSidebar={state.sidebarsSwapped ? leftPane() : rightPane()}
        statusBar={<StatusBar />}
      />
      <CommandPalette />
      <ShortcutsCheatSheet />
      <FileFinder
        repoPath={activeRepoPath()}
        onOpenFile={(p) => void handleOpenFile(p)}
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
