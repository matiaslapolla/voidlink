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
import { isMac } from "@/api/platform";
import {
  bridgeGitRefsAcrossWindows,
  onGitContext,
  requestGitContext,
  type GitWindowContext,
} from "@/api/gitWindow";
import {
  BranchesPane,
  ChangesPane,
  HistoryPane,
  StashesPane,
  TagsPane,
  WorktreesPane,
} from "@/components/git/GitSidebar";
import { StackSidebarSection } from "@/components/git/stack/StackSidebarSection";
import { CompareTab } from "@/components/git/compare/CompareTab";
import { PromptHost } from "@/commands/PromptHost";
import { ToastViewport } from "@/commands/ToastViewport";
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
  return (
    <AppStoreContext.Provider value={store}>
      <GitAppInner store={store} />
      {/* The panes ask for input through these two module-level hosts —
          stash messages, branch renames, tag names, remote URLs. Without
          them mounted here, every one of those prompts would hang forever
          waiting on a dialog that never renders. */}
      <PromptHost />
      <ToastViewport />
    </AppStoreContext.Provider>
  );
}

function GitAppInner(props: { store: AppStore }) {
  const [context, setContext] = createSignal<GitWindowContext | null>(null);
  const [section, setSection] = createSignal<SectionId>("changes");
  const [comparing, setComparing] = createSignal(false);

  const repoPath = createMemo(() => context()?.repoPath ?? null);
  const worktreeId = createMemo(() => context()?.worktreeId ?? "");

  onMount(() => {
    // Mirror refs pulses in both directions, so a commit here refreshes the
    // workbench and a rebase there refreshes us.
    const disposeBridge = bridgeGitRefsAcrossWindows();

    let unlistenContext: (() => void) | null = null;
    let disposed = false;
    void onGitContext((ctx) => {
      setContext(ctx);
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenContext = fn;
    });

    // We may have opened after the last broadcast, so ask for a fresh one
    // rather than waiting for the user to switch worktrees.
    void requestGitContext();

    onCleanup(() => {
      disposed = true;
      disposeBridge();
      if (unlistenContext) unlistenContext();
    });
  });

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
      setRepoInfo({ currentBranch: info.currentBranch, isClean: info.isClean });
    } catch {
      // A repo that vanished under us is not an error worth a toast here —
      // the panes render their own empty states.
      setStatus(undefined);
      setRepoInfo(null);
    }
  }

  createEffect(() => {
    // Track repoPath so switching worktrees refetches.
    repoPath();
    void refreshAll();
  });
  onMount(() => onCleanup(onGitRefsChanged(() => void refreshAll())));

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
    <div class="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Title bar. macOS draws its own traffic lights over the left edge, so
          the drag region is inset to clear them — same geometry as the
          workbench's TitleBar. */}
      <div
        data-tauri-drag-region
        class="h-9 shrink-0 flex items-center gap-2 border-b border-border px-3 text-xs select-none"
        classList={{ "pl-[78px]": isMac() }}
      >
        <GitBranch class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span class="font-medium truncate">
          {repoInfo()?.currentBranch ?? context()?.branch ?? "—"}
        </span>
        <Show when={repoInfo()?.isClean === false}>
          <span class="text-warning">• changes</span>
        </Show>
        <span class="ml-auto text-muted-foreground truncate max-w-[50%]">
          {context()
            ? `${context()!.workspaceName} · ${context()!.worktreeLabel}`
            : "Waiting for the workbench…"}
        </span>
      </div>

      <Show
        when={repoPath()}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <GitBranch class="w-7 h-7 opacity-60" />
            <p class="text-[13px]">
              Open a repository in the main voidlink window.
            </p>
            <p class="text-[11px] opacity-70">
              This window follows whichever worktree is active there.
            </p>
          </div>
        }
      >
        {(path) => (
          <div class="flex-1 flex min-h-0">
            {/* Nav */}
            <nav class="w-44 shrink-0 border-r border-border bg-sidebar flex flex-col">
              <div class="flex-1 overflow-y-auto scrollbar-thin py-1">
                <For each={SECTIONS}>
                  {(s) => (
                    <button
                      onClick={() => {
                        setSection(s.id);
                        setComparing(false);
                      }}
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors"
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
                  class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed text-[12px] transition-colors"
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
            <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
              <Show
                when={comparing() && activeCompare()}
                fallback={
                  <div class="flex-1 overflow-y-auto scrollbar-thin">
                    <Show when={section() === "changes"}>
                      <ChangesPane
                        repoPath={path()}
                        worktreeId={worktreeId()}
                        status={status()}
                        onRefresh={refreshAll}
                        selectedFile={null}
                      />
                    </Show>
                    <Show when={section() === "branches"}>
                      <BranchesPane
                        repoPath={path()}
                        worktreeId={worktreeId()}
                        onCheckout={refreshAll}
                      />
                    </Show>
                    <Show when={section() === "worktrees"}>
                      <WorktreesPane repoPath={path()} />
                    </Show>
                    <Show when={section() === "stack"}>
                      <StackSidebarSection
                        repoPath={path()}
                        worktreeId={worktreeId()}
                      />
                    </Show>
                    <Show when={section() === "stashes"}>
                      <StashesPane repoPath={path()} worktreeId={worktreeId()} />
                    </Show>
                    <Show when={section() === "history"}>
                      <HistoryPane repoPath={path()} worktreeId={worktreeId()} />
                    </Show>
                    <Show when={section() === "tags"}>
                      <TagsPane repoPath={path()} />
                    </Show>
                  </div>
                }
              >
                {(tab) => (
                  <CompareTab
                    repoPath={path()}
                    tab={tab()}
                    worktreeId={worktreeId()}
                  />
                )}
              </Show>
            </main>
          </div>
        )}
      </Show>
    </div>
  );
}
