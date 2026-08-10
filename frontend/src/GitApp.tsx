/// Root of the standalone git window.
///
/// Same bundle as the workbench, different root: `main.tsx` picks between this
/// and `App` on the Tauri window label. What you get here is the git surface
/// given the whole window instead of a 300px sidebar — the panes are the very
/// same components the sidebar renders, just laid out as nav + detail.
///
/// This window is a *consumer* of workbench state. It does not choose the
/// repository (the workbench rail does) and it does not persist layout — see
/// `createAppStore({ persist: false })` below for why that matters.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import {
  Archive,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitCompare,
  History,
  Layers,
  Tag,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import type { GitRepoInfo } from "@/types/git";
import { isMac } from "@/api/platform";
import {
  bridgeGitRefsAcrossWindows,
  onWindowContext,
  requestSidebarDockBack,
  requestWindowContext,
  type WindowContext,
} from "@/api/windows";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BranchesPane,
  ChangesPane,
  HistoryPane,
  RemotesDialog,
  StashesPane,
  TagsPane,
  WorktreesPane,
} from "@/components/git/GitSidebar";
import { GitSyncControls, createGitSync } from "@/components/git/GitSyncControls";
import { GitErrorBoundary } from "@/components/git/GitErrorBoundary";
import { StackSidebarSection } from "@/components/git/stack/StackSidebarSection";
import { CompareTab } from "@/components/git/compare/CompareTab";
import { DEV_CHROME_CLASS, DevBadge } from "@/components/layout/devChrome";
import { AttachHomeButton } from "@/components/layout/AttachHomeButton";
import { PromptHost } from "@/commands/PromptHost";
import { ToastViewport } from "@/commands/ToastViewport";
import { TooltipLayer } from "@/components/ui/Tooltip";
import { pushToast } from "@/commands/toast";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import type { AppStore } from "@/store/layout";

type SectionId =
  | "changes"
  | "branches"
  | "worktrees"
  | "stack"
  | "stashes"
  | "history"
  | "tags";

const SECTIONS: { id: SectionId; label: string; icon: () => JSX.Element }[] = [
  { id: "changes", label: "Changes", icon: () => <GitCommit class="w-4 h-4" /> },
  { id: "branches", label: "Branches", icon: () => <GitBranch class="w-4 h-4" /> },
  { id: "worktrees", label: "Worktrees", icon: () => <FolderGit2 class="w-4 h-4" /> },
  { id: "stack", label: "Stack", icon: () => <Layers class="w-4 h-4" /> },
  { id: "stashes", label: "Stashes", icon: () => <Archive class="w-4 h-4" /> },
  { id: "history", label: "History", icon: () => <History class="w-4 h-4" /> },
  { id: "tags", label: "Tags", icon: () => <Tag class="w-4 h-4" /> },
];

export default function GitApp() {
  // Hydrates from localStorage like the workbench, but never writes back:
  // two windows persisting the same keys would clobber each other's tabs.
  // The panes below need `useAppStore()`, which is the only reason a store
  // exists in this window at all.
  const store = createAppStore({ persist: false });
  const [context, setContext] = createSignal<WindowContext | null>(null);

  onMount(() => {
    // Mirror refs pulses in both directions, so a commit here refreshes the
    // workbench and a rebase there refreshes us.
    const disposeBridge = bridgeGitRefsAcrossWindows();
    let disposed = false;

    // This window is also where the git *sidebar* goes when it is detached —
    // there is one window that can hold the git panel, not two (see
    // `SIDEBAR_WINDOW_LABEL`). So closing it docks the panel back. The
    // workbench ignores the request when the sidebar was never detached, which
    // is what keeps "open the git client beside my sidebar" working unchanged.
    //
    // The handler awaits its emit rather than firing it off: Tauri's
    // `onCloseRequested` wrapper awaits the handler and *then* destroys the
    // webview, so a synchronous return posted the dock-back into a context
    // that was already being torn down. See `PanelApp` for the same note.
    let unlistenClose: (() => void) | null = null;
    try {
      void getCurrentWindow()
        .onCloseRequested(async () => {
          await requestSidebarDockBack("git");
        })
        .then((fn) => {
          if (disposed) void fn();
          else unlistenClose = fn;
        });
    } catch {
      // Not running under Tauri. Nothing to close, nothing to dock back.
    }

    let unlistenContext: (() => void) | null = null;
    void onWindowContext((ctx) => {
      setContext(ctx);
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlistenContext = fn;
      // We may have opened after the last broadcast, so ask for a fresh one
      // rather than waiting for the user to switch worktrees. Asked only once
      // the subscription is live, or the workbench's reply could beat it.
      void requestWindowContext();
    });

    onCleanup(() => {
      disposed = true;
      disposeBridge();
      if (unlistenContext) unlistenContext();
      if (unlistenClose) unlistenClose();
    });
  });

  return (
    <AppStoreContext.Provider value={store}>
      <GitSurface store={store} context={context} />
      {/* The panes ask for input through these two module-level hosts —
          stash messages, branch renames, tag names, remote URLs. Without
          them mounted here, every one of those prompts would hang forever
          waiting on a dialog that never renders. */}
      <PromptHost />
      <ToastViewport />
      {/* One tooltip surface per window. Without it `use:tooltip` is inert
          rather than broken, which is the right failure for a window that has
          not adopted it yet. */}
      <TooltipLayer />
    </AppStoreContext.Provider>
  );
}

/// The git client, minus any assumption about which window it is in.
///
/// `GitApp` above wires it to the cross-window context broadcast; in stacked
/// mode the workbench renders the same component with `embedded` and feeds it
/// its own store and active repository directly. Everything below is therefore
/// written against `props.context` rather than a subscription of its own — that
/// is the whole reason the two modes share this code instead of forking it.
export function GitSurface(props: {
  store: AppStore;
  context: () => WindowContext | null;
  /// True when this is a view inside the workbench window: drop the drag region
  /// and the macOS traffic-light inset, since the window's own title bar is
  /// already above us.
  embedded?: boolean;
}) {
  const context = () => props.context();
  const [section, setSection] = createSignal<SectionId>("changes");
  const [comparing, setComparing] = createSignal(false);

  const repoPath = createMemo(() => context()?.repoPath ?? null);
  const worktreeId = createMemo(() => context()?.worktreeId ?? "");
  const [remotesOpen, setRemotesOpen] = createSignal(false);

  // A repo change invalidates everything on screen.
  createEffect((prev: string | null | undefined) => {
    const path = repoPath();
    if (prev !== undefined && prev !== path) {
      setComparing(false);
      emitGitRefsChanged();
    }
    return path;
  });

  // ── Status, for the Changes pane ─────────────────────────────────────────
  const [status, setStatus] = createSignal<
    { path: string; status: string; staged: boolean }[] | undefined
  >(undefined);
  const [repoInfo, setRepoInfo] = createSignal<{
    currentBranch: string | null;
    isClean: boolean;
    /// Everything `GitSyncControls` needs to gate Pull. Carried here because
    /// this window renders the same three buttons the sidebar does, and Pull
    /// enabled on a detached HEAD or an upstream-less branch answers with a raw
    /// porcelain error rather than with the reason.
    headOid: string | null;
    upstream: string | null;
    behind: number;
    /// Carried so `BranchesPane` can disable the mutations a merge or rebase
    /// would corrupt. Without it this window left every branch's delete button
    /// live mid-rebase while the workbench disabled it — and the backend guard
    /// that now refuses those deletes is a wall to walk into, not a reason to
    /// keep offering the button.
    operation: GitRepoInfo["operation"];
    isDetached: boolean;
  } | null>(null);

  async function refreshAll() {
    const path = repoPath();
    if (!path) {
      setStatus(undefined);
      setRepoInfo(null);
      return;
    }
    try {
      const [s, info] = await Promise.all([
        gitApi.fileStatus(path),
        gitApi.repoInfo(path),
      ]);
      setStatus(s);
      setRepoInfo({
        currentBranch: info.currentBranch,
        isClean: info.isClean,
        operation: info.operation,
        isDetached: info.isDetached,
        headOid: info.headOid,
        upstream: info.upstream,
        behind: info.behind,
      });
    } catch (e) {
      // A repository that vanished under us needs no toast — but an index.lock
      // collision or a corrupt ref does, and the old bare `catch {}` made every
      // failure look like "this pane has nothing to show".
      setStatus(undefined);
      setRepoInfo(null);
      const message = e instanceof Error ? e.message : String(e);
      if (!/does not exist|not found|no such file/i.test(message)) {
        pushToast(`Could not read git state: ${message}`, "error", 6000);
      }
    }
  }

  createEffect(() => {
    // Track repoPath so switching worktrees refetches.
    repoPath();
    void refreshAll();
  });
  onMount(() => onCleanup(onGitRefsChanged(() => void refreshAll())));

  const sync = createGitSync({
    repoPath: () => repoPath() ?? "",
    worktreeId,
    info: repoInfo,
  });

  /// Open (or reuse) a compare tab in this window's local store, then show it.
  function openCompare() {
    const wt = worktreeId();
    if (!repoPath() || !wt) return;
    const existing = props.store.state.compareTabsByWorktree[wt] ?? [];
    if (existing.length === 0) props.store.actions.openCompareTab(wt);
    setComparing(true);
  }

  const activeCompare = createMemo(() => {
    const wt = worktreeId();
    if (!wt) return null;
    const tabs = props.store.state.compareTabsByWorktree[wt] ?? [];
    return tabs[tabs.length - 1] ?? null;
  });

  return (
    <div
      class="flex flex-col bg-canvas text-foreground overflow-hidden"
      classList={{ "h-screen w-screen": !props.embedded, "h-full w-full": props.embedded }}
    >
      {/* Title bar. macOS draws its own traffic lights over the left edge, so
          the drag region is inset to clear them — same geometry as the
          workbench's TitleBar. Embedded, the workbench's own title bar is above
          this one, so neither the inset nor the drag region applies. */}
      <div
        data-tauri-drag-region={props.embedded ? undefined : true}
        class={`h-9 shrink-0 flex items-center gap-2 px-3 text-body select-none ${props.embedded ? "" : DEV_CHROME_CLASS}`}
        classList={{ "pl-[78px]": isMac() && !props.embedded }}
      >
        <GitBranch class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <Show when={!props.embedded}>
          <DevBadge />
        </Show>
        <span class="font-medium truncate">
          {repoInfo()?.currentBranch ?? context()?.branch ?? "—"}
        </span>
        <Show when={repoInfo()?.isClean === false}>
          <span class="text-warning">• changes</span>
        </Show>
        <span class="ml-auto text-muted-foreground truncate max-w-[40%]">
          {context()
            ? `${context()!.workspaceName} · ${context()!.worktreeLabel}`
            : props.embedded
              ? ""
              : "Waiting for the workbench…"}
        </span>
        {/* This window had no fetch, no pull and no way to reach the remotes
            dialog at all — you could rebase and reset here but never find out
            that the branch you were about to rebase onto had moved. */}
        <Show when={repoPath()}>
          <div class="flex items-center gap-0.5 shrink-0">
            <GitSyncControls
              sync={sync}
              info={repoInfo}
              onManageRemotes={() => setRemotesOpen(true)}
            />
          </div>
        </Show>
        {/* The way home, in this window's own chrome. Absent when embedded:
            in stacked mode this surface is a *view* of the workbench, so
            there is no window to attach and nothing to attach it to. */}
        <Show when={!props.embedded}>
          <AttachHomeButton surface={{ kind: "git" }} class="shrink-0" />
        </Show>
      </div>
      <Show when={repoPath()}>
        {(path) => (
          <RemotesDialog
            repoPath={path()}
            open={remotesOpen()}
            onClose={() => setRemotesOpen(false)}
          />
        )}
      </Show>

      <Show
        when={repoPath()}
        fallback={
          <div
            class="island flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground bg-background"
            style={{ margin: "0 var(--island-inset) var(--island-inset)" }}
          >
            <GitBranch class="w-7 h-7 opacity-60" />
            <p class="text-ui">
              {props.embedded
                ? "Open a repository to see its git state."
                : "Open a repository in the main voidlink window."}
            </p>
            <Show when={!props.embedded}>
              <p class="text-label opacity-70">
                This window follows whichever worktree is active there.
              </p>
            </Show>
          </div>
        }
      >
        {(path) => (
          <div
            class="flex-1 flex min-h-0"
            style={{
              padding: "0 var(--island-inset) var(--island-inset)",
              gap: "var(--island-gap)",
            }}
          >
            {/* Nav */}
            <nav class="island w-44 shrink-0 bg-sidebar flex flex-col">
              <div class="flex-1 overflow-y-auto scrollbar-thin py-1">
                <For each={SECTIONS}>
                  {(s) => (
                    <button
                      onClick={() => {
                        setSection(s.id);
                        setComparing(false);
                      }}
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-ui text-left transition-colors"
                      classList={{
                        "bg-accent/60 text-foreground":
                          !comparing() && section() === s.id,
                        "text-muted-foreground hover:text-foreground hover:bg-accent/30":
                          comparing() || section() !== s.id,
                      }}
                      aria-current={!comparing() && section() === s.id}
                    >
                      {s.icon()}
                      {s.label}
                    </button>
                  )}
                </For>
              </div>

              {/* Compare lives at the bottom: it is a destination, not one of
                  the repo-state sections above it. */}
              <div class="shrink-0 border-t border-border/60 p-2">
                <button
                  onClick={openCompare}
                  class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed text-body transition-colors"
                  classList={{
                    "border-primary/60 bg-accent/40 text-foreground": comparing(),
                    "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40":
                      !comparing(),
                  }}
                  title="Compare two branches, tags, or commits"
                >
                  <GitCompare class="w-3.5 h-3.5 shrink-0" />
                  Compare branches
                </button>
              </div>
            </nav>

            {/* Detail */}
            <main class="island flex-1 min-w-0 flex flex-col bg-background">
              <Show
                when={comparing() && activeCompare()}
                fallback={
                  <div class="flex-1 overflow-y-auto scrollbar-thin">
                    {/* One boundary per section, not one around the lot.
                        These panes read resources straight inside JSX and
                        memos, and a resource rethrows on read — with nothing
                        above them this window went white on a repository that
                        moved, a corrupt ref, or the worktree enrichment
                        timeout, and offered no way back. Per-section means
                        switching away and back also clears the caught state,
                        so "Try again" is not the only escape. The workbench
                        sidebar has had this since its own white-screen bug;
                        this window never got it. */}
                    <Show when={section() === "changes"}>
                      <GitErrorBoundary surface="Changes" onRetry={refreshAll}>
                        <ChangesPane
                          repoPath={path()}
                          worktreeId={worktreeId()}
                          status={status()}
                          onRefresh={refreshAll}
                          selectedFile={null}
                        />
                      </GitErrorBoundary>
                    </Show>
                    <Show when={section() === "branches"}>
                      <GitErrorBoundary surface="Branches" onRetry={refreshAll}>
                        <BranchesPane
                          repoPath={path()}
                          worktreeId={worktreeId()}
                          onCheckout={refreshAll}
                          operation={repoInfo()?.operation ?? null}
                          detached={repoInfo()?.isDetached ?? false}
                          showTags={false}
                        />
                      </GitErrorBoundary>
                    </Show>
                    <Show when={section() === "worktrees"}>
                      <GitErrorBoundary surface="Worktrees" onRetry={refreshAll}>
                        <WorktreesPane repoPath={path()} />
                      </GitErrorBoundary>
                    </Show>
                    <Show when={section() === "stack"}>
                      <GitErrorBoundary surface="The stack" onRetry={refreshAll}>
                        <StackSidebarSection
                          repoPath={path()}
                          worktreeId={worktreeId()}
                        />
                      </GitErrorBoundary>
                    </Show>
                    <Show when={section() === "stashes"}>
                      <GitErrorBoundary surface="Stashes" onRetry={refreshAll}>
                        <StashesPane repoPath={path()} worktreeId={worktreeId()} />
                      </GitErrorBoundary>
                    </Show>
                    <Show when={section() === "history"}>
                      <GitErrorBoundary surface="History" onRetry={refreshAll}>
                        <HistoryPane repoPath={path()} worktreeId={worktreeId()} />
                      </GitErrorBoundary>
                    </Show>
                    <Show when={section() === "tags"}>
                      <GitErrorBoundary surface="Tags" onRetry={refreshAll}>
                        <TagsPane repoPath={path()} />
                      </GitErrorBoundary>
                    </Show>
                  </div>
                }
              >
                {(tab) => (
                  <GitErrorBoundary surface="This comparison">
                    <CompareTab
                      repoPath={path()}
                      tab={tab()}
                      worktreeId={worktreeId()}
                    />
                  </GitErrorBoundary>
                )}
              </Show>
            </main>
          </div>
        )}
      </Show>
    </div>
  );
}
