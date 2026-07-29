import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  GitBranch,
  GitCommit,
  History,
  Plus,
  Minus,
  Check,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Search,
  Upload,
  RefreshCw,
  GitCompare,
  Sparkles,
  Layers,
  X,
  FolderGit2,
  FolderOpen,
  Lock,
  DownloadCloud,
  ArrowDownToLine,
  Undo2,
  Trash2,
  Archive,
  Cloud,
  Tag,
  Pencil,
  GitBranchPlus,
  PanelRightOpen,
} from "lucide-solid";
import { promptWithToggles } from "@/commands/prompt";
import type { CommitIdentity, StashEntry, RemoteInfo } from "@/types/git";
import { StackSidebarSection } from "@/components/git/stack/StackSidebarSection";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import { StatusBadge } from "@/components/git/shared/StatusBadge";
import { OperationBanner } from "@/components/git/OperationBanner";
import { gitApi } from "@/api/git";
import { openEditorTab, openGitWindow } from "@/api/windows";
import { openMerge } from "@/components/git/openMerge";
import { Splitter } from "@/components/layout/Splitter";
import { EmptyState, EmptyStateAction } from "@/components/layout/EmptyState";
import {
  createFreshnessClock,
  freshnessClass,
  freshnessOf,
  freshnessTitle,
} from "@/components/layout/freshness";
import {
  actionForKey,
  flattenChanges,
  moveFocus,
  reconcileFocus,
  rowsIn,
  type ChangeRow,
} from "@/components/git/changesNav";
import { FuzzyText } from "@/commands/QuickPick";
import type { MatchRange } from "@/commands/fuzzy";
import { PANEL_BOUNDS } from "@/store/layout";

import { useAppStore } from "@/store/LayoutContext";
import { samePath, type AppStore, type GitSectionKey } from "@/store/layout";

import { requestNewWorktree } from "@/commands/worktree";
import { useSettings } from "@/store/settings";
import { scanStagedDiff, type SecretFinding } from "@/commands/secretScan";
import { SecretScanDialog } from "@/commands/SecretScanDialog";
import { pushToast } from "@/commands/toast";
import { shortcutLabel } from "@/commands/shortcuts";
import { textPrompt } from "@/commands/prompt";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { createInFlight, dedupeConcurrent } from "@/commands/inflight";
import { GitErrorBoundary } from "@/components/git/GitErrorBoundary";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import {
  aiCommitState,
  draftCommitMessage,
  onAiCommitRequest,
} from "@/commands/aiCommit";
import { recordBranchUse, sortBranchesByMru } from "@/commands/branchMru";
import type { GitCommitInfo } from "@/types/git";

type LucideIcon = Component<{ class?: string }>;

/// A header icon button. `disabled` exists because Fetch (and every Remotes
/// action) sat next to a Pull button that had one, with nothing stopping a second
/// click while the first request was still out.
function IconBtn(props: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
  class?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.title ?? props.label}
      class={`p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  );
}

/// Section labels and icons, keyed the way `prefs.gitSectionOrder` keys them.
/// One list rather than seven inline `<Section label=… icon=…>` props, because
/// the sections are now rendered from a persisted order rather than written
/// out in source order.
const SECTION_LABELS: Record<GitSectionKey, string> = {
  changes: "Changes",
  branches: "Branches",
  worktrees: "Worktrees",
  stack: "Stack",
  stashes: "Stashes",
  history: "History",
  openedDiffs: "Opened Diffs",
};

function sectionIcon(key: GitSectionKey): JSX.Element {
  switch (key) {
    case "changes": return <GitCommit class="w-3 h-3" />;
    case "branches": return <GitBranch class="w-3 h-3" />;
    case "worktrees": return <FolderGit2 class="w-3 h-3" />;
    case "stack": return <Layers class="w-3 h-3" />;
    case "stashes": return <Archive class="w-3 h-3" />;
    case "history": return <History class="w-3 h-3" />;
    case "openedDiffs": return <GitCompare class="w-3 h-3" />;
  }
}

interface GitSidebarProps {
  repoPath: string;
  worktreeId: string;
}

/// One collapsible section of the git sidebar.
///
/// The header carries three things beyond its label: the collapse toggle, the
/// section's own actions, and — on hover or keyboard focus — the two arrows
/// that move it in the sidebar's order. Reorder is arrows rather than drag
/// because the sections are a seven-item list in a 320px column: a drag needs
/// a pointer, a drop target and a preview, and two buttons need none of them
/// and work from the keyboard for free.
///
/// The whole header is `sticky`, so a long section scrolled halfway still says
/// what it is.
function Section(props: {
  label: string;
  icon: JSX.Element;
  open: boolean;
  isLast: boolean;
  onToggle: () => void;
  actions?: JSX.Element;
  children: JSX.Element;
  contentHeight: number;
  onResizeStart: (e: MouseEvent) => void;
  onMove?: (delta: number) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  return (
    <div
      class={`group/section flex flex-col border-b border-border/50 last:border-b-0 ${props.isLast && props.open ? "flex-1 min-h-0" : "shrink-0"}`}
    >
      <div class="flex items-center sticky top-0 z-20 bg-sidebar shrink-0">
      <button
        onClick={props.onToggle}
        aria-expanded={props.open}
        class="flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span class="w-3 h-3 shrink-0">
          {props.open ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
        </span>
        {props.icon}
        <span class="flex-1 tracking-wide text-xs truncate">{props.label}</span>
      </button>
      {/* Reserved at rest: the arrows fade in but the box they sit in is
          always there, so a hover never nudges the label (§7.6). */}
      <span class="flex items-center shrink-0 opacity-0 group-hover/section:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          onClick={() => props.onMove?.(-1)}
          disabled={!props.canMoveUp}
          aria-label={`Move ${props.label} section up`}
          title={props.canMoveUp ? `Move ${props.label} up` : `${props.label} is already first`}
          aria-disabled={!props.canMoveUp}
          class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronUp class="w-3 h-3" />
        </button>
        <button
          onClick={() => props.onMove?.(1)}
          disabled={!props.canMoveDown}
          aria-label={`Move ${props.label} section down`}
          title={props.canMoveDown ? `Move ${props.label} down` : `${props.label} is already last`}
          aria-disabled={!props.canMoveDown}
          class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown class="w-3 h-3" />
        </button>
      </span>
      <span class="shrink-0 pr-1">{props.actions}</span>
      </div>
      <Show when={props.open}>
        <div
          class={`overflow-y-auto scrollbar-thin ${props.isLast ? "flex-1 min-h-0" : "shrink-0"}`}
          style={!props.isLast ? { height: `${props.contentHeight}px` } : undefined}
        >
          {props.children}
        </div>
        <Show when={!props.isLast}>
          <div
            class="h-1.5 cursor-row-resize shrink-0 hover:bg-primary/30 transition-colors"
            onMouseDown={props.onResizeStart}
          />
        </Show>
      </Show>
    </div>
  );
}

export function GitSidebar(props: GitSidebarProps) {
  const { state, activeDiffTabs, editorActiveItem, actions } = useAppStore();

  const [sectionHeights, setSectionHeights] = createSignal({ changes: 200, branches: 140, worktrees: 120, stack: 160, stashes: 120, history: 200, openedDiffs: 140 });

  function startSectionResize(key: keyof ReturnType<typeof sectionHeights>) {
    return (e: MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = sectionHeights()[key];
      function onMove(mv: MouseEvent) {
        setSectionHeights(h => ({ ...h, [key]: Math.max(60, startH + mv.clientY - startY) }));
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
  }

  const [repoInfo, { refetch: refetchInfo }] = createResource(
    () => props.repoPath,
    (p) => gitApi.repoInfo(p),
  );
  const [status, { refetch: refetchStatus }] = createResource(
    () => props.repoPath,
    (p) => gitApi.fileStatus(p),
  );

  /// Which changed file's diff is currently open, so the list can highlight it.
  /// Diffs render in the editor window now, so this reads that window's pointer
  /// rather than the workbench's.
  const activeFilePath = createMemo(() => {
    const item = editorActiveItem();
    if (item?.type !== "diff") return null;
    return activeDiffTabs().find((t) => t.id === item.id)?.filePath ?? null;
  });

  const activeDiffId = () => {
    const a = editorActiveItem();
    return a?.type === "diff" ? a.id : null;
  };

  const isRefreshing = () => repoInfo.loading || status.loading;

  /// `repoInfo()` rethrows when the resource errored, and this component reads it
  /// straight inside JSX — the header, the ahead/behind button, the operation
  /// banner's `<Show>`. One failing read there took the whole aside down, so the
  /// header goes through accessors that turn an error into "no data plus a
  /// message" instead. The sections get a real ErrorBoundary; the header cannot,
  /// because losing the header means losing the refresh button that fixes it.
  const info = () => (repoInfo.error ? null : (repoInfo() ?? null));
  const infoError = () => {
    const e: unknown = repoInfo.error;
    if (!e) return "";
    return e instanceof Error ? e.message : String(e);
  };

  // ── The freshness contract (§7.5.4) ──────────────────────────────────────
  // Ahead/behind, the dirty marker and the branch state are the numbers most
  // likely to go stale: nothing local has to happen for the remote to move
  // under them. A stale ahead/behind rendered as if it were live is the exact
  // failure the contract exists to prevent, so the header states which of the
  // three it is — live, refreshing (pulse on the value, old value still
  // underneath), or stale (60% and a reason on hover).
  const clock = createFreshnessClock();
  const [readAt, setReadAt] = createSignal<number | null>(null);
  createEffect(() => {
    if (!isRefreshing() && info() !== null) setReadAt(Date.now());
  });
  const freshness = () =>
    freshnessOf({ loading: isRefreshing(), readAt: readAt(), now: clock() });
  const freshTitle = () => freshnessTitle(freshness(), readAt(), clock());

  /// Refetch this pane's two resources, sharing one round-trip between callers
  /// that ask while a refresh is already in flight — a mutation typically calls
  /// `props.onRefresh()` *and* emits the shared pulse this same handler answers.
  const refreshAll = dedupeConcurrent(async () => {
    await Promise.all([refetchStatus(), refetchInfo()]);
  });

  // Palette action "Refresh git status" / cross-pane refreshes (e.g. after
  // hunk staging) fan out through a window event so callers don't need a
  // direct reference to this component.
  onMount(() => {
    const handler = () => void refreshAll();
    window.addEventListener("voidlink:refresh-git", handler);
    const fetchHandler = () => void doFetch();
    const pullHandler = () => void doPull();
    const remotesHandler = () => setRemotesOpen(true);
    window.addEventListener("voidlink:git-fetch", fetchHandler);
    window.addEventListener("voidlink:git-pull", pullHandler);
    window.addEventListener("voidlink:git-remotes", remotesHandler);
    onCleanup(() => {
      window.removeEventListener("voidlink:refresh-git", handler);
      window.removeEventListener("voidlink:git-fetch", fetchHandler);
      window.removeEventListener("voidlink:git-pull", pullHandler);
      window.removeEventListener("voidlink:git-remotes", remotesHandler);
    });
  });

  /// Compare the current branch against its upstream.
  ///
  /// No upstream means there is nothing to compare *against* — falling back to
  /// "main" invented a ref that may not exist in this repo (and is the wrong
  /// answer even when it does), so the compare tab opened onto an error.
  function openUpstreamCompare() {
    const current = info();
    if (!current?.currentBranch) return;
    if (!current.upstream) {
      pushToast(
        `${current.currentBranch} has no upstream — push it first, or use Compare branches.`,
        "info",
        4000,
      );
      return;
    }
    actions.openCompareTab(props.worktreeId, {
      baseRef: current.upstream,
      headRef: current.currentBranch,
      useMergeBase: false,
    });
  }

  const [syncing, setSyncing] = createSignal(false);
  const [remotesOpen, setRemotesOpen] = createSignal(false);

  /// Why Pull cannot run right now, or `null` when it can.
  ///
  /// Enabled-in-every-state meant clicking it on a detached HEAD, an unborn
  /// branch or a branch with no upstream produced a raw porcelain error string in
  /// a toast. The button now says the reason before you press it.
  const pullBlockedReason = (): string | null => {
    const current = info();
    if (!current) return null;
    if (current.operation) return `Finish or abort the ${current.operation} first`;
    if (current.isDetached) return "HEAD is detached — check out a branch to pull";
    if (!current.headOid) return "This branch has no commits yet — nothing to pull into";
    if (!current.upstream) return "No upstream is set for this branch";
    return null;
  };

  async function doFetch() {
    setSyncing(true);
    try {
      await gitApi.fetch(props.repoPath);
      pushToast("Fetched from origin", "success", 2000);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    } finally {
      setSyncing(false);
      emitGitRefsChanged();
    }
  }

  async function doPull(mode: "ff-only" | "merge" | "rebase" = "ff-only") {
    setSyncing(true);
    try {
      const res = await gitApi.pull(props.repoPath, mode);
      if (res.conflicted) {
        const conflicts = await gitApi.listConflicts(props.repoPath);
        await Promise.all(
          conflicts.map((c) => openMerge(actions, props.worktreeId, `${props.repoPath}/${c}`)),
        );
        pushToast("Pull stopped on conflicts — resolve them, then continue.", "warning", 6000);
      } else if (res.ok) {
        pushToast("Pulled from origin", "success", 2000);
      } else {
        pushToast(res.message || "Pull failed", "error", 7000);
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    } finally {
      setSyncing(false);
      emitGitRefsChanged();
    }
  }

  // The last *open* section in the user's order is the one that grows to fill
  // the leftover height; everything above it keeps its own resized height.
  const lastOpenSection = createMemo(() => {
    const openKeys = state.gitSectionOrder.filter((k) => state.gitSections[k]);
    return openKeys[openKeys.length - 1] ?? null;
  });

  /// One section's body. A function rather than a `Record` of elements so each
  /// body is only built when its section actually renders — `HistoryPane` and
  /// `CommitGraph` are not cheap to construct.
  function renderSection(key: GitSectionKey): JSX.Element {
    switch (key) {
      case "changes":
        return (
          <ChangesPane
            repoPath={props.repoPath}
            worktreeId={props.worktreeId}
            status={status()}
            onRefresh={() => void refreshAll()}
            selectedFile={activeFilePath()}
          />
        );
      case "branches":
        return (
          <BranchesPane
            repoPath={props.repoPath}
            worktreeId={props.worktreeId}
            onCheckout={() => void refreshAll()}
            operation={info()?.operation ?? null}
          />
        );
      case "worktrees":
        return <WorktreesPane repoPath={props.repoPath} />;
      case "stack":
        return (
          <StackSidebarSection
            repoPath={props.repoPath}
            worktreeId={props.worktreeId}
            currentBranch={info()?.currentBranch ?? null}
          />
        );
      case "stashes":
        return <StashesPane repoPath={props.repoPath} worktreeId={props.worktreeId} />;
      case "history":
        return <HistoryPane repoPath={props.repoPath} worktreeId={props.worktreeId} />;
      case "openedDiffs":
        return (
          <OpenedDiffsPane
            worktreeId={props.worktreeId}
            tabs={activeDiffTabs()}
            activeDiffId={activeDiffId()}
            onSelect={(id) => actions.selectDiffTab(props.worktreeId, id)}
            onClose={(id) => actions.closeDiffTab(props.worktreeId, id)}
          />
        );
    }
  }

  return (
    <aside
      /* Island (D1): no border — the canvas gap around it is the separator. */
      class="flex flex-col bg-sidebar overflow-hidden relative"
      style={{ width: `${state.panels.gitSidebar}px` }}
    >
      <Splitter
        side="start"
        label="Git sidebar width"
        value={state.panels.gitSidebar}
        min={PANEL_BOUNDS.gitSidebar.min}
        max={PANEL_BOUNDS.gitSidebar.max}
        defaultValue={PANEL_BOUNDS.gitSidebar.default}
        onResize={(w) => actions.setPanelWidth("gitSidebar", w)}
      />

      {/* Header */}
      <div class="px-3 h-9 border-b border-border flex items-center gap-2 text-xs shrink-0">
        <GitBranch class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span
          class={`font-medium truncate ${freshnessClass(freshness())}`}
          title={infoError() || freshTitle() || (info()?.upstream ?? "no upstream")}
        >
          {info()?.currentBranch ?? "—"}
        </span>
        {/* The repo state failed to read. Said out loud rather than rendered as
            a dash that looks like "no branch". */}
        <Show when={infoError()}>
          <span class="text-destructive truncate" title={infoError()}>
            git state unavailable
          </span>
        </Show>
        <Show when={(info()?.ahead ?? 0) > 0 || (info()?.behind ?? 0) > 0}>
          <button
            onClick={openUpstreamCompare}
            title={
              info()?.aheadBehindUnknown
                ? "Ahead/behind could not be computed here (shallow clone?)"
                : info()?.upstream
                  ? `Compare with ${info()!.upstream}`
                  : "No upstream to compare with"
            }
            aria-label="Compare with upstream"
            class="flex items-center gap-1 px-1 rounded hover:bg-accent/60 transition-colors tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* The freshness class goes on the value, never on the container
                (§7.5.4) — the number is what the reader is trusting. */}
            <span class={`flex items-center gap-1 ${freshnessClass(freshness())}`}>
              <Show when={(info()?.ahead ?? 0) > 0}>
                <span class="text-success">↑{info()!.ahead}</span>
              </Show>
              <Show when={(info()?.behind ?? 0) > 0}>
                <span class="text-destructive">↓{info()!.behind}</span>
              </Show>
            </span>
          </button>
        </Show>
        <Show when={info()?.isClean === false}>
          <span class={`text-warning text-xs ${freshnessClass(freshness())}`} title={freshTitle()}>
            • changes
          </span>
        </Show>
        {/* The refresh affordance §7.5.4 requires beside a stale value. It is
            the same `refreshAll` the toolbar button calls; what makes it
            worth its own control is that it appears exactly where the number
            the user just stopped trusting is. */}
        <Show when={freshness() === "stale"}>
          <button
            onClick={() => void refreshAll()}
            title={freshTitle()}
            aria-label={`Refresh — ${freshTitle()}`}
            class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw class="w-3 h-3" />
          </button>
        </Show>
        <div class="ml-auto flex items-center gap-0.5">
          <IconBtn
            label="Fetch from origin"
            onClick={() => void doFetch()}
            disabled={syncing()}
          >
            <DownloadCloud class={`w-3 h-3 ${syncing() ? "animate-pulse" : ""}`} />
          </IconBtn>
          <button
            onClick={() => void doPull()}
            disabled={syncing() || pullBlockedReason() !== null}
            aria-label="Pull from origin"
            title={
              pullBlockedReason() ??
              ((info()?.behind ?? 0) > 0
                ? `Pull ${info()!.behind} commit(s) from upstream`
                : "Pull from origin")
            }
            class="flex items-center gap-0.5 px-1 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-40 tabular-nums"
          >
            <ArrowDownToLine class="w-3 h-3" />
            <Show when={(info()?.behind ?? 0) > 0}>
              <span class="text-[10px] text-destructive">{info()!.behind}</span>
            </Show>
          </button>
          <IconBtn label="Manage remotes" onClick={() => setRemotesOpen(true)}>
            <Cloud class="w-3 h-3" />
          </IconBtn>
          <IconBtn
            label="Open git window"
            onClick={() => {
              void openGitWindow().catch((e) =>
                pushToast(
                  `Could not open the git window: ${e instanceof Error ? e.message : String(e)}`,
                  "error",
                ),
              );
            }}
          >
            <PanelRightOpen class="w-3 h-3" />
          </IconBtn>
          <IconBtn label="Refresh" onClick={() => void refreshAll()}>
            <RefreshCw class={`w-3 h-3 ${isRefreshing() ? "animate-spin" : ""}`} />
          </IconBtn>
          <IconBtn label="Collapse git panel" onClick={() => actions.toggleGitSidebar()}>
            <ChevronRight class="w-3.5 h-3.5" />
          </IconBtn>
        </div>
      </div>
      <RemotesDialog repoPath={props.repoPath} open={remotesOpen()} onClose={() => setRemotesOpen(false)} />

      {/* Operation-in-progress banner (merge/rebase/cherry-pick/revert) */}
      <Show when={info()?.operation}>
        {(op) => (
          <OperationBanner
            repoPath={props.repoPath}
            worktreeId={props.worktreeId}
            operation={op()}
            hasConflicts={info()?.hasConflicts ?? false}
          />
        )}
      </Show>

      {/* Collapsible sections, in the user's own order.
          The order is a preference (`prefs.gitSectionOrder`) rather than a
          constant because the sidebar is seven sections tall in a 320px
          column: whichever two you actually use should be reachable without
          scrolling past the five you don't. */}
      <div class="flex-1 flex flex-col overflow-y-auto scrollbar-thin">
        <For each={state.gitSectionOrder}>
          {(key, i) => (
            <Section
              label={SECTION_LABELS[key]}
              icon={sectionIcon(key)}
              open={state.gitSections[key]}
              isLast={lastOpenSection() === key}
              onToggle={() => actions.toggleGitSection(key)}
              contentHeight={sectionHeights()[key]}
              onResizeStart={startSectionResize(key)}
              onMove={(delta) => actions.moveGitSection(key, delta)}
              canMoveUp={i() > 0}
              canMoveDown={i() < state.gitSectionOrder.length - 1}
            >
              {/* Per-section rather than one boundary around the lot: a repo
                  state that breaks History should not take Changes with it. */}
              <GitErrorBoundary surface={SECTION_LABELS[key]} onRetry={() => void refreshAll()}>
                {renderSection(key)}
              </GitErrorBoundary>
            </Section>
          )}
        </For>
      </div>

      {/* Pinned footer. Compare is a destination rather than a view of repo
          state, so it sits below the collapsible sections instead of
          competing with them for vertical space. */}
      <div class="shrink-0 border-t border-border p-2">
        <button
          onClick={() => actions.openCompareTab(props.worktreeId)}
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent/40 hover:border-border/80 transition-colors"
          title="Compare two branches, tags, or commits"
        >
          <GitCompare class="w-3.5 h-3.5 shrink-0" />
          Compare branches
        </button>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Changes
// ─────────────────────────────────────────────────────────────────────────────

export function ChangesPane(props: {
  repoPath: string;
  worktreeId: string;
  status: { path: string; status: string; staged: boolean }[] | undefined;
  selectedFile: string | null;
  onRefresh: () => void;
}) {
  const { actions } = useAppStore();
  const { settings, setRepoIdentity } = useSettings();
  // One gate for every mutating action this pane offers. See commands/inflight.
  const { busy, run } = createInFlight();
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [commitError, setCommitError] = createSignal("");
  const [commitOk, setCommitOk] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);

  // ── Commit identity ──────────────────────────────────────────────────────
  // Three layers, narrowest first: a one-off override typed into the box, the
  // repo's saved default, and finally git config (represented by `null`, which
  // tells Rust to call `repo.signature()` itself). We only ever *send* the
  // first two — git config stays git's business.
  const [authorOpen, setAuthorOpen] = createSignal(false);
  const [overrideOnce, setOverrideOnce] = createSignal(false);
  const [draftName, setDraftName] = createSignal("");
  const [draftEmail, setDraftEmail] = createSignal("");

  const savedIdentity = () => settings.git.identityByRepo[props.repoPath] ?? null;

  /// What git config would use, fetched lazily so the fields can show the real
  /// default instead of an empty form. Refetches when the repo changes.
  /// A failed read is not the same fact as "no identity configured", and the old
  /// `.catch(() => null)` collapsed the two — so a transient failure told the user
  /// their commits would fail until they set an author.
  const [identityError, setIdentityError] = createSignal("");
  const [configIdentity] = createResource(
    () => props.repoPath,
    (path) =>
      gitApi
        .configIdentity(path)
        .then((id) => {
          setIdentityError("");
          return id;
        })
        .catch((e: unknown) => {
          setIdentityError(e instanceof Error ? e.message : String(e));
          return null;
        }),
  );

  /// The identity the next commit will carry, as displayed.
  const shownIdentity = () =>
    savedIdentity() ?? configIdentity() ?? null;

  /// The identity actually sent to Rust. `null` means "let git config decide".
  const effectiveIdentity = (): CommitIdentity | null => {
    if (overrideOnce()) {
      const name = draftName().trim();
      const email = draftEmail().trim();
      if (name && email) return { name, email };
    }
    return savedIdentity();
  };

  /// Seed the draft fields from whatever is currently in effect, so opening
  /// the override starts from the right values rather than blank.
  function beginOverride() {
    const base = shownIdentity();
    setDraftName(base?.name ?? "");
    setDraftEmail(base?.email ?? "");
    setOverrideOnce(true);
  }
  const [pushOk, setPushOk] = createSignal(false);
  const [pushError, setPushError] = createSignal("");
  const [pendingFindings, setPendingFindings] = createSignal<SecretFinding[]>([]);
  /// Findings the user explicitly chose to commit anyway, by key.
  const [acknowledged, setAcknowledged] = createSignal<Set<string>>(new Set());
  const [amendMode, setAmendMode] = createSignal(false);

  /// True while *this* sidebar's repo is the one being drafted. We scope
  /// off the global state so switching workspaces mid-draft doesn't
  /// confuse the visual indicator on the new repo's sidebar.
  const drafting = () => {
    const s = aiCommitState();
    return s.kind === "drafting" && s.repoPath === props.repoPath;
  };
  /// Show the "Regenerate" affordance only briefly after a successful
  /// draft so the button doesn't clutter the steady state.
  const recentDraftMs = () => {
    const s = aiCommitState();
    if (s.kind !== "success" || s.repoPath !== props.repoPath) return null;
    return s.ms;
  };

  const staged = () => (props.status ?? []).filter((f) => f.staged && f.status !== "conflicted");
  const unstaged = () => (props.status ?? []).filter((f) => !f.staged && f.status !== "conflicted");
  const conflicted = () => (props.status ?? []).filter((f) => f.status === "conflicted");

  // ── Filter and keyboard cursor ───────────────────────────────────────────
  // The three lists behave as one keyboard surface: arrows walk from the last
  // staged file into the first unstaged one, and Space acts on whichever row
  // has the cursor. The ordering, the fuzzy filter and the movement all live
  // in `changesNav.ts` — see its header for why they are not inline here.
  let filterRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  const [filter, setFilter] = createSignal("");
  const [focusPath, setFocusPath] = createSignal<string | null>(null);

  const rows = createMemo(() => flattenChanges(props.status ?? [], filter()));
  const conflictRows = () => rowsIn(rows(), "conflicted");
  const stagedRows = () => rowsIn(rows(), "staged");
  const unstagedRows = () => rowsIn(rows(), "unstaged");

  const rowDomId = (path: string) => `change-row-${path.replace(/[^\w-]/g, "_")}`;

  /// Keep the cursor on something real. Staging a file moves it between
  /// sections and typing into the filter can remove it entirely; in both cases
  /// the cursor lands near where it was so the user can keep pressing the same
  /// key rather than reaching for the mouse to find it again.
  createEffect(() => {
    const list = rows();
    const current = untrack(focusPath);
    if (!current) return;
    const previousIndex = untrack(() => lastIndex);
    const next = reconcileFocus(list, current, previousIndex);
    if (next !== current) setFocusPath(next);
  });
  let lastIndex = 0;
  createEffect(() => {
    const idx = rows().findIndex((r) => r.entry.path === focusPath());
    if (idx !== -1) lastIndex = idx;
  });

  function onListKeyDown(e: KeyboardEvent) {
    const list = rows();
    const current = focusPath();
    const row = list.find((r) => r.entry.path === current);
    const action = actionForKey(e.key, row?.section ?? "unstaged");
    if (action.kind === "none") return;
    e.preventDefault();
    switch (action.kind) {
      case "move":
        setFocusPath(moveFocus(list, current, action.delta));
        break;
      case "open":
        if (row) selectFile(row.entry.path);
        break;
      case "resolve":
        if (row) openConflict(`${props.repoPath}/${row.entry.path}`);
        break;
      case "stage":
        if (row) void stageFile(row.entry.path);
        break;
      case "unstage":
        if (row) void unstageFile(row.entry.path);
        break;
      case "discard":
        // Irreversible, so it keeps its confirm (§7.5.5) even from the
        // keyboard — this is the one action here that cannot be undone.
        if (row) void discardFile(row.entry.path, row.entry.status);
        break;
    }
  }

  function openConflict(path: string) {
    void openMerge(actions, props.worktreeId, path).catch((e: unknown) =>
      pushToast(
        `Could not open the merge editor: ${e instanceof Error ? e.message : String(e)}`,
        "error",
        6000,
      ),
    );
  }

  /// Staging is the most-clicked mutation here and had no error handling at all:
  /// an `index.lock` collision or a vanished file made the row silently not move
  /// *and* produced an unhandled promise rejection. It also refreshed only this
  /// pane, so the detached git window and every other pane kept showing the old
  /// index until something else happened to broadcast.
  async function withStaging(what: string, action: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      pushToast(`${what} failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
    } finally {
      emitGitRefsChanged();
      props.onRefresh();
    }
  }

  async function stageFile(path: string) {
    await withStaging(`Staging ${path}`, () => gitApi.stageFiles(props.repoPath, [path]));
  }
  async function unstageFile(path: string) {
    await withStaging(`Unstaging ${path}`, () => gitApi.unstageFiles(props.repoPath, [path]));
  }
  async function stageAll() {
    await withStaging("Staging all changes", () => gitApi.stageAll(props.repoPath));
  }
  async function discardFile(path: string, status: string) {
    const verb = status === "untracked" ? "Delete untracked file" : "Discard changes to";
    const ok = await dialogConfirm(`${verb} ${path}? This cannot be undone.`, {
      title: "Discard changes",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await gitApi.discardFile(props.repoPath, path);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }
  /// Discard everything, saying what "everything" actually covers.
  ///
  /// The old copy said "ALL changes … Tracked files revert to HEAD" while sitting
  /// in the *unstaged* header, which was wrong twice: `checkout_head` discards
  /// staged work too (so the wording undersold what was about to happen), and it
  /// passed `includeUntracked: false` (so on an untracked-only tree the user
  /// confirmed a destructive action and nothing happened at all). Untracked files
  /// are now their own explicit question, because deleting files git does not
  /// know about is a different decision from reverting tracked ones.
  async function discardAllChanges() {
    const all = props.status ?? [];
    const untracked = all.filter((f) => f.status === "untracked");
    const tracked = all.filter((f) => f.status !== "untracked");

    if (all.length === 0) {
      pushToast("Nothing to discard — the working tree is clean.", "info", 2500);
      return;
    }

    let includeUntracked = false;
    if (tracked.length > 0) {
      const ok = await dialogConfirm(
        `Discard all changes to ${tracked.length} tracked file(s)? Staged and unstaged edits both revert to HEAD. This cannot be undone.`,
        { title: "Discard tracked changes", kind: "warning" },
      );
      if (!ok) return;
    }
    if (untracked.length > 0) {
      includeUntracked = await dialogConfirm(
        `Also delete ${untracked.length} untracked file(s) from disk? They are not in git, so this cannot be undone.`,
        { title: "Delete untracked files", kind: "warning" },
      );
      // Nothing at all was confirmed — don't run a no-op that reports success.
      if (!includeUntracked && tracked.length === 0) return;
    }

    await run(async () => {
      try {
        await gitApi.discardAll(props.repoPath, includeUntracked);
        pushToast(
          includeUntracked
            ? "Discarded tracked changes and deleted untracked files"
            : "Discarded changes to tracked files",
          "info",
          2500,
        );
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
        props.onRefresh();
      }
    });
  }
  async function stashChanges() {
    const res = await promptWithToggles({
      title: "Stash changes",
      label: "Stash message",
      initialValue: "WIP",
      confirmLabel: "Stash",
      toggles: [
        { key: "keepIndex", label: "Keep staged changes in the index", default: false },
        { key: "includeUntracked", label: "Include untracked files", default: true },
      ],
    });
    // Empty input resolves null (treated as cancel) — the default "WIP" keeps a
    // one-click confirm working while still letting the user type a message.
    if (res === null) return;
    await run(async () => {
      try {
        await gitApi.stashSave(
          props.repoPath,
          res.value || undefined,
          res.toggles.keepIndex,
          res.toggles.includeUntracked,
        );
        pushToast("Stashed changes", "success", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
        props.onRefresh();
      }
    });
  }
  /// A stable identity for a finding, so "I already reviewed this one" survives
  /// the pause between the scan and the commit.
  function findingKey(f: SecretFinding): string {
    return `${f.file}:${f.line}:${f.rule}`;
  }

  /// Scan the staged diff and return the findings the user has not already
  /// accepted. Called immediately before the commit itself — the previous flow
  /// scanned, then awaited a dialog, then committed, and anything staged during
  /// that window went out unscanned. "Commit anyway" re-scans too: it acknowledges
  /// the findings it was shown, not everything that might appear later.
  async function unacknowledgedFindings(): Promise<SecretFinding[] | null> {
    try {
      const diff = await gitApi.diffWorking(props.repoPath, true);
      const acked = acknowledged();
      return scanStagedDiff(diff).filter((f) => !acked.has(findingKey(f)));
    } catch (e) {
      // A scanner glitch must not block committing; say so rather than pretend
      // the tree was clean.
      pushToast(
        `Secret scan skipped: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
        5000,
      );
      return null;
    }
  }

  async function performCommit(msg: string) {
    // Rescan against the index as it is *now*.
    const findings = await unacknowledgedFindings();
    if (findings && findings.length > 0) {
      setPendingFindings(findings);
      return;
    }
    setCommitting(true);
    setCommitError("");
    setCommitOk(false);
    try {
      // Precedence: this commit's override → the repo's saved identity →
      // `null`, which lets Rust fall back to git config. Only an explicitly
      // chosen identity is ever sent.
      const identity = effectiveIdentity();
      if (amendMode()) {
        await gitApi.amend(props.repoPath, msg || undefined, identity);
        setAmendMode(false);
      } else {
        await gitApi.commit(props.repoPath, msg, identity);
      }
      setCommitMsg("");
      setCommitOk(true);
      setTimeout(() => setCommitOk(false), 2000);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  /// Toggle amend mode. Turning it on pre-fills the textarea with the last
  /// commit's summary so the user edits rather than retypes.
  async function toggleAmend() {
    const next = !amendMode();
    setAmendMode(next);
    if (!next || commitMsg().trim()) return;
    try {
      const recent = await gitApi.log(props.repoPath, undefined, 1);
      // Toggling off and on again while this was in flight would otherwise land
      // the old HEAD's summary in a box the user has since changed their mind
      // about — check we are still the pending prefill before writing.
      if (!amendMode() || commitMsg().trim()) return;
      if (recent[0]) setCommitMsg(recent[0].summary);
      else pushToast("Nothing to amend — this branch has no commits yet.", "warning", 4000);
    } catch (e) {
      // Not fatal (an amend can keep the existing message), but silence made it
      // look like the prefill simply did not work.
      pushToast(
        `Could not read the last commit message: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
        5000,
      );
    }
  }

  async function undoLastCommit() {
    const ok = await dialogConfirm(
      "Undo the last commit? Its changes are kept and re-staged (soft reset to HEAD~1).",
      { title: "Undo last commit", kind: "warning" },
    );
    if (!ok) return;
    // Guarded in the handler, not just on the button: a second click landing
     // before the first returned soft-reset to HEAD~2.
    await run(async () => {
      try {
        await gitApi.undoLastCommit(props.repoPath);
        pushToast("Undid last commit — changes re-staged", "info", 3000);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
        props.onRefresh();
      }
    });
  }
  async function commit() {
    // The guard lives here rather than only in the button's `disabled`, because
    // ⌘/Ctrl+Enter calls this directly: two fast presses made two commits.
    if (committing()) return;
    const msg = commitMsg().trim();
    // Amend can proceed with no staged files (message-only) and no message
    // (keeps the original); a normal commit needs both.
    if (!amendMode() && (!msg || staged().length === 0)) return;
    // The scan lives inside `performCommit`, immediately before the commit, so
    // there is no window between "looks clean" and "committed".
    await performCommit(msg);
  }
  async function draftAiCommit() {
    if (staged().length === 0) {
      pushToast("Stage some changes first", "warning");
      return;
    }
    if (drafting()) return;
    const result = await draftCommitMessage(
      props.repoPath,
      settings.ai.commitCommand,
    );
    if (result.ok && result.message) {
      const current = commitMsg().trim();
      // Preserve any in-progress message by appending — drafts are
      // suggestions, not blunt overwrites.
      setCommitMsg(current ? `${current}\n\n${result.message}` : result.message);
    }
  }

  // Listen for global "draft commit" requests (palette / shortcut). The
  // sidebar is the only component that owns the textarea, so it's the
  // natural home for the actual work.
  // Single-dispatch: in stacked mode two ChangesPanes are mounted at once and
  // both used to answer, so the draft landed in the hidden one while the
  // `drafting()` guard made the visible one bail — "Draft with AI" looked dead.
  onMount(() => onCleanup(onAiCommitRequest(() => void draftAiCommit())));
  /// Push failures get their own channel. They used to be written into
  /// `commitError`, which labelled a rejected push as a commit problem and
  /// clobbered a real commit error that was still on screen.
  async function push() {
    if (pushing()) return;
    setPushing(true);
    setPushOk(false);
    setPushError("");
    try {
      await gitApi.push(props.repoPath);
      setPushOk(true);
      setTimeout(() => setPushOk(false), 2000);
    } catch (e) {
      setPushError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(false);
      // A push moves the upstream, so ahead/behind everywhere is now stale.
      emitGitRefsChanged();
    }
  }

  /// Diffs render in the editor window now, so clicking a changed file hands
  /// it over there rather than opening a tab in whichever window this sidebar
  /// happens to be mounted in.
  const selectFile = (path: string) => {
    void openEditorTab({ kind: "open-diff", filePath: path }, () =>
      actions.openDiffTab(props.worktreeId, path),
    );
  };

  return (
    <div class="flex flex-col">
      {/* Commit form */}
      <div class="p-2 border-b border-border/50 space-y-1.5">
        <label class="sr-only" for="commit-msg">Commit message</label>
        <textarea
          id="commit-msg"
          placeholder={drafting() ? "Drafting commit message…" : "Commit message"}
          value={commitMsg()}
          onInput={(e) => setCommitMsg(e.currentTarget.value)}
          rows={3}
          class={`w-full rounded-md bg-muted/50 border border-border/60 px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring transition-colors ${
            drafting() ? "border-primary/40 placeholder:animate-pulse" : ""
          }`}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div class="flex items-center gap-1.5">
          <button
            disabled={committing() || (!amendMode() && (staged().length === 0 || !commitMsg().trim()))}
            onClick={() => void commit()}
            aria-label={amendMode() ? "Amend last commit" : "Commit staged changes"}
            class="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.96] transition-[background-color,color,transform,opacity]"
          >
            <Show
              when={commitOk()}
              fallback={
                committing()
                  ? amendMode() ? "Amending…" : "Committing…"
                  : amendMode()
                    ? "Amend"
                    : <>Commit (<span class="tabular-nums">{staged().length}</span>)</>
              }
            >
              <Check class="w-3 h-3" /> Done
            </Show>
          </button>
          <button
            onClick={() => void draftAiCommit()}
            disabled={drafting() || staged().length === 0}
            aria-label={recentDraftMs() !== null ? "Regenerate commit message" : "Draft commit message with AI"}
            title={
              !settings.ai.commitCommand.trim()
                ? "Configure AI command in Settings → AI"
                : recentDraftMs() !== null
                  ? `Regenerate (last draft: ${recentDraftMs()}ms)`
                  : `Draft commit message with AI (${shortcutLabel("git.ai-draft-commit")})`
            }
            class={`px-2 py-1 rounded-md text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              recentDraftMs() !== null
                ? "text-primary hover:text-primary hover:bg-primary/10"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <Sparkles class={`w-3 h-3 ${drafting() ? "animate-pulse" : ""}`} />
          </button>
          <button
            onClick={() => void stageAll()}
            disabled={busy()}
            aria-label="Stage all changes"
            title="Stage all"
            class="px-2 py-1 rounded-md text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus class="w-3 h-3" />
          </button>
          <button
            onClick={() => void stashChanges()}
            disabled={busy()}
            aria-label="Stash changes"
            title="Stash changes"
            class="px-2 py-1 rounded-md text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Archive class="w-3 h-3" />
          </button>
          <button
            onClick={() => void push()}
            disabled={pushing()}
            aria-label="Push to remote"
            title="Push"
            class={`px-2 py-1 rounded-md text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              pushOk()
                ? "text-success"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <Show when={pushOk()} fallback={<Upload class="w-3 h-3" />}>
              <Check class="w-3 h-3" />
            </Show>
          </button>
        </div>
        <Show when={commitError()}>
          <p class="text-xs text-destructive truncate" title={commitError()}>{commitError()}</p>
        </Show>
        <Show when={pushError()}>
          <p class="text-xs text-destructive truncate" title={pushError()}>
            Push failed: {pushError()}
          </p>
        </Show>
        <div class="flex items-center gap-2 text-[11px]">
          <label class="flex items-center gap-1 cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors">
            <input
              type="checkbox"
              checked={amendMode()}
              onChange={() => void toggleAmend()}
              class="accent-primary"
            />
            Amend last commit
          </label>
          <button
            onClick={() => void undoLastCommit()}
            disabled={busy()}
            title="Undo last commit (soft reset HEAD~1)"
            class="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Undo2 class="w-3 h-3" /> Undo commit
          </button>
        </div>

        {/* Commit identity. Collapsed to one line until you need it — the
            common case is that git config is already right. */}
        <div class="mt-1.5 text-[11px]">
          <button
            onClick={() => setAuthorOpen((v) => !v)}
            class="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={authorOpen()}
          >
            <ChevronRight
              class="w-3 h-3 transition-transform"
              classList={{ "rotate-90": authorOpen() }}
            />
            <span class="truncate">
              {shownIdentity()
                ? `Commit as ${overrideOnce() && draftName().trim() ? draftName().trim() : shownIdentity()!.name}`
                : "Commit author not configured"}
            </span>
            <Show when={savedIdentity() && !overrideOnce()}>
              <span class="text-primary/80">· repo default</span>
            </Show>
            <Show when={overrideOnce()}>
              <span class="text-warning">· this commit only</span>
            </Show>
          </button>

          <Show when={authorOpen()}>
            <div class="mt-1.5 pl-4 flex flex-col gap-1.5">
              <Show
                when={overrideOnce()}
                fallback={
                  <>
                    <p class="text-muted-foreground">
                      {savedIdentity()
                        ? "Saved for this repository."
                        : configIdentity()
                          ? "From this repository's git config."
                          : identityError()
                            ? `Could not read git config: ${identityError()}`
                            : "No user.name / user.email is set. Commits will fail until you set one here or with git config."}
                    </p>
                    <Show when={shownIdentity()}>
                      <p class="font-mono text-muted-foreground truncate">
                        {shownIdentity()!.email}
                      </p>
                    </Show>
                    <button
                      onClick={beginOverride}
                      class="self-start underline underline-offset-2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Change author…
                    </button>
                  </>
                }
              >
                <label class="text-muted-foreground">Name</label>
                <input
                  value={draftName()}
                  onInput={(e) => setDraftName(e.currentTarget.value)}
                  placeholder="Ada Lovelace"
                  class="rounded border border-border bg-muted/40 px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <label class="text-muted-foreground">Email</label>
                <input
                  value={draftEmail()}
                  onInput={(e) => setDraftEmail(e.currentTarget.value)}
                  placeholder="ada@example.com"
                  class="rounded border border-border bg-muted/40 px-1.5 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <div class="flex items-center gap-2 pt-0.5">
                  <button
                    onClick={() => {
                      setRepoIdentity(props.repoPath, {
                        name: draftName(),
                        email: draftEmail(),
                      });
                      setOverrideOnce(false);
                      pushToast("Saved as this repository's commit author", "success", 2500);
                    }}
                    disabled={!draftName().trim() || !draftEmail().trim()}
                    class="px-1.5 py-0.5 rounded border border-border hover:bg-accent/40 hover:text-foreground transition-colors disabled:opacity-40"
                    title="Use this author for every commit in this repository"
                  >
                    Save for this repo
                  </button>
                  <button
                    onClick={() => setOverrideOnce(false)}
                    class="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <Show when={savedIdentity()}>
                    <button
                      onClick={() => {
                        setRepoIdentity(props.repoPath, null);
                        setOverrideOnce(false);
                        pushToast("Reverted to git config", "info", 2500);
                      }}
                      class="ml-auto text-muted-foreground hover:text-destructive transition-colors"
                      title="Delete the saved override and use git config again"
                    >
                      Clear
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* ── The change list ────────────────────────────────────────────────
          Three sections, one keyboard surface. `changesNav.ts` owns the
          ordering, the filter and the cursor movement; this only renders what
          it returns and performs the action it names. */}
      <div class="px-2 pt-2 pb-1 border-b border-border/50">
        <div class="relative">
          <Search class="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            ref={filterRef}
            type="text"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Down out of the box moves into the list — the box and the list
              // are one surface, and reaching for the mouse to cross between
              // them would defeat the point of having a filter.
              if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                setFocusPath(moveFocus(rows(), null, 1));
                listRef?.focus();
              } else if (e.key === "Escape" && filter()) {
                e.preventDefault();
                setFilter("");
              }
            }}
            placeholder="Filter changed files"
            aria-label="Filter changed files"
            class="w-full rounded-md bg-muted/40 border border-border/60 pl-7 pr-2 py-1 text-[12px] outline-2 outline-transparent focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div
        ref={(el) => (listRef = el)}
        tabIndex={0}
        role="listbox"
        aria-label="Changed files"
        aria-activedescendant={focusPath() ? rowDomId(focusPath()!) : undefined}
        onKeyDown={onListKeyDown}
        class="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Show when={conflicted().length > 0}>
          <div class="border-b border-border/50">
            <SectionLabel class="text-warning/90">
              <GitCompare class="w-3 h-3" />
              Conflicts (<span class="tabular-nums">{conflictRows().length}</span>)
            </SectionLabel>
            <For each={conflictRows()}>
              {(row) => (
                <button
                  id={rowDomId(row.entry.path)}
                  role="option"
                  aria-selected={focusPath() === row.entry.path}
                  onClick={() => {
                    setFocusPath(row.entry.path);
                    openConflict(`${props.repoPath}/${row.entry.path}`);
                  }}
                  title={`Resolve conflict in ${row.entry.path}`}
                  class={`w-full flex items-center gap-2 px-2.5 h-6 text-[13px] text-left text-warning hover:bg-warning/10 transition-colors ${
                    focusPath() === row.entry.path ? "bg-warning/15" : ""
                  }`}
                >
                  <StatusBadge status={row.entry.status} />
                  <span class="flex-1 truncate font-mono">
                    <FuzzyText text={row.entry.path} ranges={row.ranges} />
                  </span>
                  <span class="text-[10px] tracking-wide opacity-70">Resolve</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={stagedRows().length > 0}>
          <div class="border-b border-border/50">
            <SectionLabel class="text-success/80">
              Staged (<span class="tabular-nums">{stagedRows().length}</span>)
            </SectionLabel>
            <VirtualFileList
              rows={stagedRows()}
              focusPath={focusPath()}
              selectedFile={props.selectedFile}
              rowId={rowDomId}
              onFocusRow={setFocusPath}
              onSelect={(path) => selectFile(path)}
              actionIcon={Minus}
              actionTitle="Unstage"
              onAction={(path) => void unstageFile(path)}
            />
          </div>
        </Show>

        <SectionLabel>
          <span class="flex-1">
            Changes (<span class="tabular-nums">{unstagedRows().length}</span>)
          </span>
          {/* Shown whenever there is anything to discard, not only when the
              unstaged list is non-empty: this reverts staged work too, and on an
              untracked-only tree there was previously no way to reach it. */}
          <Show when={(props.status ?? []).length > 0}>
            <button
              onClick={() => void discardAllChanges()}
              disabled={busy()}
              title="Discard changes in the working tree"
              aria-label="Discard changes in the working tree"
              class="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 class="w-3 h-3" />
            </button>
          </Show>
        </SectionLabel>

        <Show
          when={rows().length > 0}
          fallback={
            // Two different emptinesses, and telling them apart is the whole
            // point of §9.7's no-shared-sentence rule: a clean tree is good
            // news, a filter that matched nothing is a typo.
            <Show
              when={(props.status ?? []).length > 0}
              fallback={<EmptyState id="changesClean" />}
            >
              <EmptyState
                id="changesNoMatch"
                action={
                  <EmptyStateAction onClick={() => { setFilter(""); filterRef?.focus(); }}>
                    Clear the filter
                  </EmptyStateAction>
                }
              />
            </Show>
          }
        >
          <VirtualFileList
            rows={unstagedRows()}
            focusPath={focusPath()}
            selectedFile={props.selectedFile}
            rowId={rowDomId}
            onFocusRow={setFocusPath}
            onSelect={(path) => selectFile(path)}
            actionIcon={Plus}
            actionTitle="Stage"
            onAction={(path) => void stageFile(path)}
            secondaryFor={(row) => (row.entry.status === "untracked" ? "delete" : "discard")}
            onSecondary={(path, status) => void discardFile(path, status)}
          />
        </Show>
      </div>


      <SecretScanDialog
        findings={pendingFindings()}
        onCancel={() => setPendingFindings([])}
        onCommitAnyway={() => {
          // Acknowledge exactly what was on screen. performCommit rescans, so a
          // secret staged during the pause still stops the commit.
          const shown = pendingFindings().map(findingKey);
          setAcknowledged((prev) => new Set([...prev, ...shown]));
          setPendingFindings([]);
          void performCommit(commitMsg().trim());
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branches
// ─────────────────────────────────────────────────────────────────────────────

export function BranchesPane(props: {
  repoPath: string;
  worktreeId: string;
  onCheckout: () => void;
  /// The multi-step operation in progress, when there is one. Every mutation here
  /// moves HEAD or a ref out from under it — Rust refuses them, and refusing in
  /// the UI first means the user reads the reason on the button instead of in a
  /// toast after the click.
  operation?: string | null;
}) {
  const { actions } = useAppStore();
  const { busy, run } = createInFlight();
  /// Why every branch mutation is unavailable right now, or null.
  const blocked = (): string | null =>
    props.operation ? `Finish or abort the ${props.operation} first` : null;
  const locked = () => busy() || blocked() !== null;
  const [branches, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listBranches(p, true),
  );
  const [error, setError] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [menu, setMenu] = createSignal<{ x: number; y: number; branch: string } | null>(null);

  async function routeOpResult(res: { ok: boolean; conflicted: boolean; message: string }, label: string) {
    try {
      if (res.conflicted) {
        const conflicts = await gitApi.listConflicts(props.repoPath);
        await Promise.all(
          conflicts.map((c) => openMerge(actions, props.worktreeId, `${props.repoPath}/${c}`)),
        );
        pushToast(`${label} stopped on conflicts — resolve them, then continue.`, "warning", 6000);
      } else if (res.ok) {
        pushToast(`${label} complete`, "success", 2500);
      } else {
        pushToast(res.message || `${label} failed`, "error", 7000);
      }
    } finally {
      // In a `finally`, because listing the conflicts is the step most likely to
      // throw and the refresh is what makes the operation banner appear. Losing
      // the refresh meant a conflicted merge showed no banner at all — the exact
      // state where the user most needs one.
      emitGitRefsChanged();
    }
  }

  async function mergeBranch(name: string, noFf: boolean) {
    await run(async () => {
      try {
        const res = await gitApi.merge(props.repoPath, name, noFf);
        await routeOpResult(res, `Merge ${name}`);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
        emitGitRefsChanged();
      }
    });
  }

  async function rebaseOnto(name: string) {
    await run(async () => {
      try {
        const res = await gitApi.rebase(props.repoPath, name);
        await routeOpResult(res, `Rebase onto ${name}`);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
        emitGitRefsChanged();
      }
    });
  }

  function branchMenuItems(name: string): ContextMenuItem[] {
    const why = blocked();
    if (why) return [{ label: why, onSelect: () => {}, disabled: true }];
    return [
      { label: `Merge ${name} into current`, onSelect: () => void mergeBranch(name, false) },
      { label: `Merge ${name} (--no-ff)`, onSelect: () => void mergeBranch(name, true) },
      { label: `Rebase current onto ${name}`, onSelect: () => void rebaseOnto(name), separatorBefore: true },
    ];
  }

  // Branch ahead/behind and HEAD move on most git mutations; refetch on the
  // shared ref-change pulse so the list never lags after a merge/reset/etc.
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  async function checkout(name: string) {
    setError("");
    await run(async () => {
      try {
        const result = await gitApi.safeCheckout(props.repoPath, name);
        recordBranchUse(props.repoPath, result.branch);
        if (result.branch !== name) {
          pushToast(`Created local branch ${result.branch} tracking ${name}`, "success", 4000);
        }
        if (result.autoStashed) {
          pushToast(
            `Switched to ${result.branch}. Auto-stashed your changes — restore with \`git stash pop\`.`,
            "info",
            5000,
          );
        }
        props.onCheckout();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        // HEAD moved: every other pane and the detached git window are stale.
        emitGitRefsChanged();
      }
    });
  }

  async function newBranch() {
    const name = await textPrompt({
      title: "New branch",
      label: "Branch name (created at HEAD, no switch)",
      placeholder: "feature/my-branch",
      confirmLabel: "Create",
    });
    if (!name) return;
    await run(async () => {
      try {
        await gitApi.createBranch(props.repoPath, name);
        pushToast(`Created branch ${name}`, "success", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  async function renameBranch(name: string) {
    const next = await textPrompt({
      title: "Rename branch",
      label: `New name for ${name}`,
      initialValue: name,
      confirmLabel: "Rename",
    });
    if (!next || next === name) return;
    await run(async () => {
      try {
        await gitApi.renameBranch(props.repoPath, name, next);
        pushToast(`Renamed to ${next}`, "success", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  async function deleteBranch(name: string) {
    const ok = await dialogConfirm(`Delete branch ${name}?`, { title: "Delete branch", kind: "warning" });
    if (!ok) return;
    try {
      await gitApi.deleteBranch(props.repoPath, name, false);
      pushToast(`Deleted branch ${name}`, "info", 2500);
      emitGitRefsChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The backend flags the unmerged case with a stable marker rather than a
      // sentence: matching on English prose broke the moment libgit2 or the
      // user's locale reworded it, and every other failure then fell through to
      // "force-delete anyway?".
      if (msg.includes("[not-fully-merged]")) {
        const force = await dialogConfirm(`${msg}\n\nForce-delete anyway?`, {
          title: "Force-delete branch",
          kind: "warning",
        });
        if (!force) return;
        try {
          await gitApi.deleteBranch(props.repoPath, name, true);
          pushToast(`Deleted branch ${name}`, "info", 2500);
          emitGitRefsChanged();
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        }
      } else {
        pushToast(msg, "error", 6000);
      }
    }
  }

  /// Fuzzy match: substring first (preferred), then in-order character
  /// subsequence as a fallback. Matches the spirit of the file/command
  /// pickers already in the app.
  function fuzzy(name: string, query: string): boolean {
    if (!query) return true;
    const n = name.toLowerCase();
    const q = query.toLowerCase();
    if (n.includes(q)) return true;
    let i = 0;
    for (const ch of q) {
      const idx = n.indexOf(ch, i);
      if (idx === -1) return false;
      i = idx + 1;
    }
    return true;
  }

  const filtered = createMemo(() => {
    const all = branches() ?? [];
    const sorted = sortBranchesByMru(all, props.repoPath);
    const q = filter().trim();
    return q ? sorted.filter((b) => fuzzy(b.name, q)) : sorted;
  });

  return (
    <div class="p-2 space-y-1">
      <div class="flex items-center gap-1">
        <input
          type="text"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter branches…"
          class="flex-1 min-w-0 px-2 py-1 text-[12px] bg-muted/50 border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
          aria-label="Filter branches"
        />
        <button
          onClick={() => void newBranch()}
          disabled={locked()}
          title="New branch"
          aria-label="New branch"
          class="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
        >
          <GitBranchPlus class="w-3.5 h-3.5" />
        </button>
      </div>
      <Show when={error()}>
        <p class="text-xs text-destructive px-1">{error()}</p>
      </Show>
      <For each={filtered()}>
        {(b) => (
          <div
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, branch: b.name });
            }}
            class={`group flex items-center gap-2 rounded-md px-2 density-row text-[13px] transition-colors ${
              b.isHead
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <button
              onClick={() => void checkout(b.name)}
              disabled={b.isHead || locked()}
              aria-label={b.isHead ? `${b.name} (current branch)` : `Checkout ${b.name}`}
              title={
                blocked() ??
                (b.isHead
                  ? `${b.name} is the current branch`
                  : b.isRemote
                    ? `Check out ${b.name} (creates a local branch tracking it)`
                    : `Checkout ${b.name}`)
              }
              class="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-foreground disabled:cursor-default disabled:hover:text-primary"
            >
              <GitBranch class="w-3 h-3 shrink-0" />
              <span class="truncate flex-1">{b.name}</span>
            </button>
            <Show when={b.ahead > 0}>
              <span class="text-success tabular-nums">↑{b.ahead}</span>
            </Show>
            <Show when={b.behind > 0}>
              <span class="text-destructive tabular-nums">↓{b.behind}</span>
            </Show>
            <Show when={b.aheadBehindUnknown}>
              <span
                class="text-muted-foreground/70"
                title="Ahead/behind could not be computed for this branch (shallow clone?)"
              >
                ?
              </span>
            </Show>
            <Show when={b.isHead}>
              <span class="text-xs tracking-wide text-primary/80">HEAD</span>
            </Show>
            <Show when={!b.isRemote}>
              <button
                onClick={() => void renameBranch(b.name)}
                disabled={locked()}
                title="Rename branch"
                aria-label={`Rename ${b.name}`}
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
              >
                <Pencil class="w-3 h-3" />
              </button>
              <Show when={!b.isHead}>
                <button
                  onClick={() => void deleteBranch(b.name)}
                  disabled={locked()}
                  title="Delete branch"
                  aria-label={`Delete ${b.name}`}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
                >
                  <X class="w-3 h-3" />
                </button>
              </Show>
            </Show>
          </div>
        )}
      </For>
      <Show when={(branches()?.length ?? 0) > 0 && filtered().length === 0}>
        <p class="text-[11px] text-muted-foreground px-1 py-1">No matches.</p>
      </Show>

      <TagsPane repoPath={props.repoPath} />

      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={branchMenuItems(m().branch)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Worktrees
// ─────────────────────────────────────────────────────────────────────────────

/// Linked worktrees for the repo. This pane is now a *view* onto the same
/// worktrees the workspace rail lists: "open" focuses one in the rail rather
/// than spawning a parallel workspace, and "new" delegates to the wizard so
/// there is exactly one place that knows how to set a worktree up.
export function WorktreesPane(props: { repoPath: string }) {
  const { activeWorkspace, actions } = useAppStore();
  const { busy, run } = createInFlight();
  const [worktrees, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listWorktrees(p),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  function addWorktree() {
    const ws = activeWorkspace();
    if (!ws?.repoRoot) {
      pushToast("Select a repository for this workspace first", "warning");
      return;
    }
    requestNewWorktree({
      workspaceId: ws.id,
      repoRoot: ws.repoRoot,
      sourcePath: props.repoPath,
    });
  }

  /// Focus a worktree in the rail. It is registered on demand so a worktree
  /// created outside voidlink (plain `git worktree add`) still opens without
  /// waiting for the next hydration pass.
  function openWorktree(path: string, branch: string | null) {
    const ws = activeWorkspace();
    if (!ws) return;
    const existing = ws.worktrees.find((wt) => samePath(wt.path, path));
    const id = existing?.id ?? actions.addWorktree(ws.id, { path, branch });
    if (id) actions.selectWorktree(id);
  }

  /// `git worktree remove` fails for several unrelated reasons, and `--force`
  /// only answers one of them. Offering force on *every* failure meant a lock, a
  /// missing directory or a permissions error led the user straight to a button
  /// whose whole job is discarding changes.
  function isDirtyRefusal(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes("contains modified or untracked files") ||
      m.includes("is dirty") ||
      m.includes("use --force") ||
      m.includes("use 'remove -f'")
    );
  }

  async function remove(path: string, label: string) {
    const ok = await dialogConfirm(`Remove worktree "${label}"? Its directory will be deleted.`, {
      title: "Remove worktree",
      kind: "warning",
    });
    if (!ok) return;
    await run(async () => {
      try {
        const warning = await gitApi.removeWorktree(props.repoPath, path, false);
        pushToast(`Removed worktree ${label}`, "info", 2500);
        if (warning) pushToast(warning, "warning", 6000);
        emitGitRefsChanged();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!isDirtyRefusal(msg)) {
          pushToast(msg, "error", 7000);
          emitGitRefsChanged();
          return;
        }
        const force = await dialogConfirm(
          `${msg}\n\nForce-remove anyway (discards uncommitted changes in that worktree)?`,
          { title: "Force-remove worktree", kind: "warning" },
        );
        if (!force) return;
        try {
          const warning = await gitApi.removeWorktree(props.repoPath, path, true);
          pushToast(`Removed worktree ${label}`, "info", 2500);
          if (warning) pushToast(warning, "warning", 6000);
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        } finally {
          emitGitRefsChanged();
        }
      }
    });
  }

  return (
    <div class="p-1">
      <button
        onClick={() => void addWorktree()}
        class="w-full flex items-center justify-center gap-1.5 px-2 py-1 mb-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-accent/50 transition-colors"
      >
        <Plus class="w-3 h-3" /> New worktree
      </button>
      {/* "Only the main worktree" rather than "no worktrees": a repository
          always has one, so a list showing a single entry — or, before the
          first list lands, none — means the user has not branched out yet. */}
      <Show when={(worktrees()?.length ?? 0) <= 1}>
        <EmptyState
          id="worktreesSingle"
          action={
            <EmptyStateAction onClick={() => void addWorktree()}>
              Create a worktree
            </EmptyStateAction>
          }
        />
      </Show>
      <For each={worktrees() ?? []}>
        {(wt) => {
          const label = () => wt.branch ?? (wt.isDetached ? "(detached)" : wt.path);
          return (
            <div
              class={`group w-full flex items-center gap-2 rounded-md px-2 density-row text-[13px] hover:bg-accent/30 ${
                wt.isCurrent ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <Show
                when={wt.isCurrent}
                fallback={<FolderGit2 class="w-3 h-3 shrink-0 opacity-70" />}
              >
                <span
                  class="w-1.5 h-1.5 rounded-full bg-primary shrink-0"
                  title="Current worktree"
                  aria-label="current worktree"
                />
              </Show>
              <span class="truncate flex-1" title={wt.path}>
                {label()}
              </span>
              <Show when={wt.isDirty}>
                <span
                  class="text-warning shrink-0"
                  title="Uncommitted changes"
                  aria-label="uncommitted changes"
                >
                  ●
                </span>
              </Show>
              {/* A worktree whose status could not be read must not render as
                  clean — the absence of a dot would be a claim we cannot make. */}
              <Show when={wt.statusUnknown}>
                <span
                  class="text-muted-foreground/70 shrink-0"
                  title="Could not read this worktree's status — it may be missing or unreachable"
                  aria-label="status unknown"
                >
                  ?
                </span>
              </Show>
              <Show when={wt.ahead > 0}>
                <span
                  class="text-success tabular-nums shrink-0"
                  title={`${wt.ahead} commit(s) ahead of upstream`}
                  aria-label={`${wt.ahead} ahead`}
                >
                  ↑{wt.ahead}
                </span>
              </Show>
              <Show when={wt.behind > 0}>
                <span
                  class="text-destructive tabular-nums shrink-0"
                  title={`${wt.behind} commit(s) behind upstream`}
                  aria-label={`${wt.behind} behind`}
                >
                  ↓{wt.behind}
                </span>
              </Show>
              <Show when={wt.isLocked}>
                <Lock class="w-3 h-3 text-muted-foreground/70" aria-label="locked" />
              </Show>
              <Show when={wt.isMain}>
                <span class="text-[10px] tracking-wide text-primary/70">Main</span>
              </Show>
              <Show when={!wt.isMain}>
                <button
                  onClick={() => openWorktree(wt.path, wt.branch)}
                  title="Open this worktree"
                  aria-label={`Open worktree ${label()}`}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
                >
                  <FolderOpen class="w-3 h-3" />
                </button>
                <button
                  onClick={() => void remove(wt.path, label())}
                  disabled={busy()}
                  title="Remove worktree"
                  aria-label={`Remove worktree ${label()}`}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <X class="w-3 h-3" />
                </button>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tags
// ─────────────────────────────────────────────────────────────────────────────

/// Tags sub-section, rendered under the branch list. Create (lightweight or
/// annotated), delete, and push individual tags. Listing reuses git_list_refs.
export function TagsPane(props: { repoPath: string }) {
  const { busy, run } = createInFlight();
  const [refs, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listRefs(p),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  async function createTag() {
    const res = await promptWithToggles({
      title: "Create tag",
      label: "Tag name (created at HEAD)",
      placeholder: "v1.2.0",
      confirmLabel: "Create",
      toggles: [{ key: "annotated", label: "Annotated tag (with message)", default: false }],
    });
    if (!res) return;
    let message: string | undefined;
    if (res.toggles.annotated) {
      message =
        (await textPrompt({
          title: "Tag message",
          label: `Annotation for ${res.value}`,
          confirmLabel: "Create tag",
        })) ?? undefined;
      // Cancelling the message used to fall through and create a *lightweight*
      // tag — a different kind of object than the one the user asked for, with no
      // mention of the substitution. An annotated tag without an annotation is
      // not a thing, so this is a cancel.
      if (!message) {
        pushToast("Tag not created — an annotated tag needs a message.", "info", 4000);
        return;
      }
    }
    await createTagOrOfferForce(res.value, undefined, message);
  }

  /// Create a tag, and when the name is taken, offer to move it.
  ///
  /// `force` was hardcoded false in Rust, so retagging a release always failed
  /// with libgit2's "tag already exists" and the UI had no way to say "yes, move
  /// it" short of deleting the tag first.
  async function createTagOrOfferForce(name: string, target?: string, message?: string) {
    await run(async () => {
      try {
        await gitApi.createTag(props.repoPath, name, target, message);
        pushToast(`Created tag ${name}`, "success", 2500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/exists/i.test(msg)) {
          pushToast(msg, "error", 6000);
          return;
        }
        const move = await dialogConfirm(
          `A tag named ${name} already exists. Move it to this commit?`,
          { title: "Overwrite tag", kind: "warning" },
        );
        if (!move) return;
        try {
          await gitApi.createTag(props.repoPath, name, target, message, true);
          pushToast(`Moved tag ${name}`, "success", 2500);
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        }
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  async function deleteTag(name: string) {
    const ok = await dialogConfirm(`Delete tag ${name} from this repository?`, {
      title: "Delete tag",
      kind: "warning",
    });
    if (!ok) return;
    await run(async () => {
      try {
        await gitApi.deleteTag(props.repoPath, name);
        pushToast(`Deleted tag ${name} locally`, "info", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
        return;
      } finally {
        emitGitRefsChanged();
      }

      // The remote copy is the one everyone else fetches, and deleting locally
      // said nothing about it — the next fetch would quietly bring it back.
      const alsoRemote = await dialogConfirm(
        `Also delete ${name} on origin? Anyone who has fetched it keeps their copy.`,
        { title: "Delete remote tag", kind: "warning" },
      );
      if (!alsoRemote) return;
      try {
        await gitApi.deleteRemoteTag(props.repoPath, name);
        pushToast(`Deleted tag ${name} on origin`, "info", 2500);
      } catch (e) {
        pushToast(
          `Deleted locally, but origin still has ${name}: ${e instanceof Error ? e.message : String(e)}`,
          "error",
          7000,
        );
      }
    });
  }

  async function pushTag(name: string) {
    await run(async () => {
      try {
        await gitApi.pushTag(props.repoPath, name);
        pushToast(`Pushed tag ${name}`, "success", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        // The remote now has a ref it did not have; other panes should know.
        emitGitRefsChanged();
      }
    });
  }

  return (
    <div class="pt-2 mt-1 border-t border-border/50">
      <div class="flex items-center gap-1.5 px-1 pb-1">
        <Tag class="w-3 h-3 text-muted-foreground" />
        <span class="flex-1 tracking-wide text-[10px] text-muted-foreground font-semibold">
          Tags
        </span>
        <button
          onClick={() => void createTag()}
          disabled={busy()}
          title="Create tag"
          aria-label="Create tag"
          class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
        >
          <Plus class="w-3 h-3" />
        </button>
      </div>
      <Show when={(refs()?.tags.length ?? 0) === 0}>
        <EmptyState id="tagsEmpty" />
      </Show>
      <For each={refs()?.tags ?? []}>
        {(t) => (
          <div class="group flex items-center gap-2 rounded-md px-2 density-row text-[13px] text-muted-foreground hover:bg-accent/30">
            <Tag class="w-3 h-3 shrink-0 opacity-70" />
            <span class="truncate flex-1" title={t}>{t}</span>
            <button
              onClick={() => void pushTag(t)}
              disabled={busy()}
              title="Push tag to origin"
              aria-label={`Push tag ${t}`}
              class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
            >
              <Upload class="w-3 h-3" />
            </button>
            <button
              onClick={() => void deleteTag(t)}
              disabled={busy()}
              title="Delete tag"
              aria-label={`Delete tag ${t}`}
              class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stashes
// ─────────────────────────────────────────────────────────────────────────────

export function StashesPane(props: { repoPath: string; worktreeId: string }) {
  const { actions } = useAppStore();
  const { busy, run } = createInFlight();
  const [stashes, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.stashList(p),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  /// Stash actions carry the entry's `oid`, not just its position: the stash is
  /// a stack, and anything that pushes onto it (this pane's own Stash button, an
  /// auto-stash on branch switch, `git stash` in the app's terminal) shifts every
  /// index. Rust refuses when the oid at that position is not the one we saw, so
  /// a stale list errors instead of dropping someone else's work.
  async function apply(entry: StashEntry, pop: boolean) {
    await run(async () => {
      try {
        if (pop) await gitApi.stashPop(props.repoPath, entry.index, entry.oid);
        else await gitApi.stashApply(props.repoPath, entry.index, entry.oid);
        pushToast(pop ? "Popped stash" : "Applied stash", "success", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  async function drop(entry: StashEntry) {
    const ok = await dialogConfirm(`Drop stash "${entry.message}"? This cannot be undone.`, {
      title: "Drop stash",
      kind: "warning",
    });
    if (!ok) return;
    await run(async () => {
      try {
        await gitApi.stashDrop(props.repoPath, entry.index, entry.oid);
        pushToast("Dropped stash", "info", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  function showDiff(index: number) {
    actions.openCompareTab(props.worktreeId, {
      baseRef: `stash@{${index}}^1`,
      headRef: `stash@{${index}}`,
      useMergeBase: false,
    });
  }

  return (
    <div class="p-1">
      <Show
        when={(stashes()?.length ?? 0) > 0}
        fallback={<EmptyState id="stashesEmpty" />}
      >
        <For each={stashes() ?? []}>
          {(s: StashEntry) => (
            <div class="group flex items-center gap-2 rounded-md px-2 density-row text-[13px] text-muted-foreground hover:bg-accent/30">
              <Archive class="w-3 h-3 shrink-0 opacity-70" />
              <button
                onClick={() => showDiff(s.index)}
                class="truncate flex-1 text-left hover:text-foreground"
                title={`Show diff for ${s.message}`}
              >
                <span class="text-[10px] text-muted-foreground/70 tabular-nums mr-1">{`{${s.index}}`}</span>
                {s.message}
              </button>
              <button
                onClick={() => void apply(s, false)}
                disabled={busy()}
                title="Apply (keep stash)"
                aria-label="Apply stash"
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus class="w-3 h-3" />
              </button>
              <button
                onClick={() => void apply(s, true)}
                disabled={busy()}
                title="Pop (apply and remove)"
                aria-label="Pop stash"
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowDownToLine class="w-3 h-3" />
              </button>
              <button
                onClick={() => void drop(s)}
                disabled={busy()}
                title="Drop stash"
                aria-label="Drop stash"
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <X class="w-3 h-3" />
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Remotes (modal)
// ─────────────────────────────────────────────────────────────────────────────

function RemotesDialog(props: { repoPath: string; open: boolean; onClose: () => void }) {
  const { busy, run } = createInFlight();
  const [remotes, { refetch }] = createResource(
    () => (props.open ? props.repoPath : null),
    (p) => gitApi.listRemotes(p),
  );

  async function addRemote() {
    const name = await textPrompt({ title: "Add remote", label: "Remote name", placeholder: "origin", confirmLabel: "Next" });
    if (!name) return;
    const url = await textPrompt({ title: "Add remote", label: `URL for ${name}`, placeholder: "git@github.com:user/repo.git", confirmLabel: "Add" });
    if (!url) return;
    await run(async () => {
      try {
        await gitApi.addRemote(props.repoPath, name, url);
        pushToast(`Added remote ${name}`, "success", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        refetch();
        // Remote-tracking refs feed ahead/behind and the branch list.
        emitGitRefsChanged();
      }
    });
  }

  async function editUrl(r: RemoteInfo) {
    const url = await textPrompt({ title: "Set remote URL", label: r.name, initialValue: r.url ?? "", confirmLabel: "Save" });
    if (!url) return;
    await run(async () => {
      try {
        await gitApi.setRemoteUrl(props.repoPath, r.name, url);
        pushToast(`Updated ${r.name}`, "success", 2500);
        if (r.pushUrl) {
          pushToast(
            `${r.name} also had a separate push URL — it now points at the new URL too.`,
            "info",
            5000,
          );
        }
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        refetch();
        emitGitRefsChanged();
      }
    });
  }

  async function renameRemote(r: RemoteInfo) {
    const next = await textPrompt({ title: "Rename remote", label: `New name for ${r.name}`, initialValue: r.name, confirmLabel: "Rename" });
    if (!next || next === r.name) return;
    await run(async () => {
      try {
        const stranded = await gitApi.renameRemote(props.repoPath, r.name, next);
        pushToast(`Renamed to ${next}`, "success", 2500);
        // libgit2 rewrites the default refspecs and hands back the ones it could
        // not: those still name the old remote, which is a silent
        // fetch-from-nowhere until someone says so.
        if (stranded.length > 0) {
          pushToast(
            `These refspecs still reference "${r.name}" and need editing by hand: ${stranded.join(", ")}`,
            "warning",
            9000,
          );
        }
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        refetch();
        emitGitRefsChanged();
      }
    });
  }

  async function removeRemote(r: RemoteInfo) {
    const ok = await dialogConfirm(`Remove remote "${r.name}"?`, { title: "Remove remote", kind: "warning" });
    if (!ok) return;
    await run(async () => {
      try {
        await gitApi.removeRemote(props.repoPath, r.name);
        pushToast(`Removed ${r.name}`, "info", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        refetch();
        emitGitRefsChanged();
      }
    });
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-[var(--z-prompt)] flex items-start justify-center bg-black/40 pt-[18vh]" onClick={props.onClose}>
          <div class="w-[min(520px,92vw)] bg-popover border border-border rounded-lg shadow-xl p-4" onClick={(e) => e.stopPropagation()}>
            <div class="flex items-center mb-3">
              <h2 class="text-sm font-semibold flex-1">Remotes</h2>
              <button onClick={() => void addRemote()} disabled={busy()} class="flex items-center gap-1 px-2 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Plus class="w-3 h-3" /> Add
              </button>
            </div>
            <Show when={(remotes()?.length ?? 0) > 0} fallback={<p class="text-xs text-muted-foreground py-2">No remotes configured.</p>}>
              <div class="space-y-1.5">
                <For each={remotes() ?? []}>
                  {(r) => (
                    <div class="group flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-foreground">{r.name}</div>
                        <div class="truncate text-muted-foreground font-mono text-[11px]" title={r.url ?? ""}>{r.url ?? "—"}</div>
                      </div>
                      <button onClick={() => void editUrl(r)} disabled={busy()} title="Set URL" aria-label={`Set URL for ${r.name}`} class="p-1 rounded hover:bg-accent/60 hover:text-foreground text-muted-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <Pencil class="w-3 h-3" />
                      </button>
                      <button onClick={() => void renameRemote(r)} disabled={busy()} title="Rename" aria-label={`Rename ${r.name}`} class="p-1 rounded hover:bg-accent/60 hover:text-foreground text-muted-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <Tag class="w-3 h-3" />
                      </button>
                      <button onClick={() => void removeRemote(r)} disabled={busy()} title="Remove" aria-label={`Remove ${r.name}`} class="p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex justify-end mt-4">
              <button onClick={props.onClose} class="px-3 py-1.5 rounded text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors">Close</button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

function CommitHoverPopover(props: { commit: GitCommitInfo; x: number; y: number }) {
  let popRef: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.x + 14, top: props.y - 8 });

  // After mount and on every move, clamp to viewport and flip horizontally
  // if there isn't room on the right. Without this, hovering near the
  // window's right/bottom edge clips the popover under the chrome.
  createEffect(() => {
    const x = props.x;
    const y = props.y;
    const el = popRef;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + 14;
    let top = y - 8;
    if (left + rect.width + pad > vw) left = x - rect.width - 14;
    if (left < pad) left = pad;
    if (top + rect.height + pad > vh) top = vh - rect.height - pad;
    if (top < pad) top = pad;
    setPos({ left, top });
  });

  return (
    <Portal>
      <div
        ref={popRef}
        class="fixed z-[var(--z-menu)] bg-popover border border-border rounded-lg shadow-xl p-3 text-xs max-w-xs pointer-events-none"
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
      >
        <div class="font-mono text-muted-foreground mb-1 text-[10px] tracking-wide">{props.commit.oid.slice(0, 12)}</div>
        <div class="font-medium text-foreground mb-1.5 leading-snug">{props.commit.summary}</div>
        <Show when={props.commit.body}>
          {(body) => (
            <div class="text-muted-foreground mb-2 whitespace-pre-wrap text-[11px] leading-relaxed line-clamp-4">{body()}</div>
          )}
        </Show>
        <div class="space-y-0.5 text-muted-foreground/80 border-t border-border/50 pt-1.5 mt-1.5">
          <div><span class="text-muted-foreground">Author:</span> {props.commit.authorName}</div>
          <div class="truncate"><span class="text-muted-foreground">Email:</span> {props.commit.authorEmail}</div>
          <div><span class="text-muted-foreground">Date:</span> {new Date(props.commit.time * 1000).toLocaleString()}</div>
        </div>
      </div>
    </Portal>
  );
}

/// A commit + lane assignment used to render the DAG column. `preLanes`
/// is the set of "expected next commit" OIDs that exist BEFORE this
/// commit is processed; `postLanes` is the same after. `laneIndex` is
/// the column slot this commit's circle should be drawn in.
interface PositionedCommit {
  commit: GitCommitInfo;
  laneIndex: number;
  preLanes: (string | null)[];
  postLanes: (string | null)[];
}

/// Compute lane positions for a chronological commit list (newest first).
/// Algorithm: walk top-down, each lane carries the OID it's expecting
/// next. When we see a commit, we find which lane was expecting it
/// (creating one if none), then replace that lane's expectation with
/// the commit's first parent. Additional parents either reuse an
/// existing lane that was already waiting on that parent (merge) or
/// open a new lane to the right.
function layoutDag(commits: GitCommitInfo[]): {
  rows: PositionedCommit[];
  maxLanes: number;
} {
  let lanes: (string | null)[] = [];
  const rows: PositionedCommit[] = [];
  let maxLanes = 0;
  for (const c of commits) {
    const preLanes = [...lanes];

    let laneIdx = lanes.findIndex((l) => l === c.oid);
    if (laneIdx === -1) {
      laneIdx = lanes.length;
      lanes.push(c.oid);
    }

    const parents = c.parentOids;
    lanes = lanes.map((l, i) => {
      if (i === laneIdx) return parents[0] ?? null;
      // Another lane was also expecting this commit → collapse it
      // (a merge with multiple converging paths).
      if (l === c.oid) return null;
      return l;
    });

    // Additional parents land in the first available null slot or
    // open a fresh lane on the right.
    for (let i = 1; i < parents.length; i++) {
      const existing = lanes.findIndex((l) => l === parents[i]);
      if (existing !== -1) continue;
      const empty = lanes.findIndex((l) => l === null);
      if (empty !== -1) lanes[empty] = parents[i];
      else lanes.push(parents[i]);
    }

    // Trim trailing nulls to keep the column compact.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const postLanes = [...lanes];
    maxLanes = Math.max(maxLanes, preLanes.length, postLanes.length);
    rows.push({ commit: c, laneIndex: laneIdx, preLanes, postLanes });
  }
  return { rows, maxLanes };
}

const LANE_WIDTH = 12;
const LANE_X_OFFSET = 8;
/// The DAG gutter is drawn as one fixed-height SVG per row, so a row's laid-out
/// height MUST equal ROW_HEIGHT exactly — any slack leaves an unpainted band
/// between rows and the lane lines read as dashed. The row body is pinned to
/// this height below rather than sized by its text.
const ROW_HEIGHT = 46;
const COMMIT_RADIUS = 3;

/// Colour cycled per lane index. Keeps adjacent branches visually distinct
/// without needing a per-branch colour map.
///
/// These were seven hardcoded hexes, which meant the commit graph looked
/// identical in `solarized-light` and `dracula` while everything around it
/// changed — MASTER §2.4, and §11.5's point that identity has to survive a
/// theme swap. They are now the five chart hues plus `--primary` and `--info`:
/// seven tokens every theme already defines, ordered so no two neighbours land
/// on adjacent hues. SVG presentation attributes resolve `var()` like any
/// other CSS value.
const LANE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--primary)",
  "var(--info)",
];

function laneX(i: number): number {
  return LANE_X_OFFSET + i * LANE_WIDTH;
}

function laneColor(i: number): string {
  return LANE_COLORS[i % LANE_COLORS.length];
}

export function HistoryPane(props: { repoPath: string; worktreeId: string }) {
  const { actions } = useAppStore();
  const { busy, run } = createInFlight();
  const [log, { refetch: refetchLog }] = createResource(
    () => props.repoPath,
    (p) => gitApi.log(p, undefined, 80),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetchLog())));

  /// `log()` rethrows when the resource errored and this memo is read straight
  /// into JSX. The section's ErrorBoundary would catch it, but an empty graph plus
  /// the pane's own one-line message keeps the rest of the pane usable.
  const layout = createMemo(() => layoutDag(log.error ? [] : (log() ?? [])));
  const logError = () => {
    const e: unknown = log.error;
    if (!e) return "";
    return e instanceof Error ? e.message : String(e);
  };

  /// The empty tree. A root commit has no parent to diff against, and using the
  /// commit itself as the base produced an empty diff — "this commit changed
  /// nothing", the opposite of true for the commit that created the repository.
  const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  const [hoveredCommit, setHoveredCommit] = createSignal<GitCommitInfo | null>(null);
  const [hoverPos, setHoverPos] = createSignal({ x: 0, y: 0 });
  const [menu, setMenu] = createSignal<{ x: number; y: number; commit: GitCommitInfo } | null>(null);

  function openCommitCompare(c: GitCommitInfo) {
    const base = c.parentOids[0] ?? EMPTY_TREE_OID;
    actions.openCompareTab(props.worktreeId, {
      baseRef: base,
      headRef: c.oid,
      useMergeBase: false,
    });
  }

  async function routeOpResult(res: { ok: boolean; conflicted: boolean; message: string }, label: string) {
    try {
      if (res.conflicted) {
        const conflicts = await gitApi.listConflicts(props.repoPath);
        await Promise.all(
          conflicts.map((c) => openMerge(actions, props.worktreeId, `${props.repoPath}/${c}`)),
        );
        pushToast(`${label} stopped on conflicts — resolve them, then continue.`, "warning", 6000);
      } else if (res.ok) {
        pushToast(`${label} complete`, "success", 2500);
      } else {
        pushToast(res.message || `${label} failed`, "error", 7000);
      }
    } finally {
      // See BranchesPane.routeOpResult: the refresh is what raises the banner.
      emitGitRefsChanged();
    }
  }

  async function cherryPick(c: GitCommitInfo) {
    await run(async () => {
      try {
        await routeOpResult(await gitApi.cherryPick(props.repoPath, c.oid), `Cherry-pick ${c.oid.slice(0, 7)}`);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
        emitGitRefsChanged();
      }
    });
  }

  async function revert(c: GitCommitInfo) {
    await run(async () => {
      try {
        await routeOpResult(await gitApi.revert(props.repoPath, c.oid), `Revert ${c.oid.slice(0, 7)}`);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
        emitGitRefsChanged();
      }
    });
  }

  async function resetTo(c: GitCommitInfo, mode: "soft" | "mixed" | "hard") {
    const short = c.oid.slice(0, 7);
    const warn =
      mode === "hard"
        ? `Hard reset to ${short}? This DISCARDS all uncommitted changes and cannot be undone.`
        : `${mode === "soft" ? "Soft" : "Mixed"} reset to ${short}?`;
    const ok = await dialogConfirm(warn, { title: `Reset (${mode})`, kind: "warning" });
    if (!ok) return;
    // Double-confirm the destructive variant.
    if (mode === "hard") {
      const sure = await dialogConfirm("Really discard all uncommitted work? Last chance.", {
        title: "Confirm hard reset",
        kind: "warning",
      });
      if (!sure) return;
    }
    await run(async () => {
      try {
        await gitApi.reset(props.repoPath, c.oid, mode);
        pushToast(`Reset (${mode}) to ${short}`, "info", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  async function tagHere(c: GitCommitInfo) {
    const name = await textPrompt({ title: "Create tag", label: `Tag at ${c.oid.slice(0, 7)}`, placeholder: "v1.2.0", confirmLabel: "Create" });
    if (!name) return;
    await run(async () => {
      try {
        await gitApi.createTag(props.repoPath, name, c.oid);
        pushToast(`Created tag ${name}`, "success", 2500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/exists/i.test(msg)) {
          pushToast(msg, "error", 6000);
          return;
        }
        const move = await dialogConfirm(
          `A tag named ${name} already exists. Move it to ${c.oid.slice(0, 7)}?`,
          { title: "Overwrite tag", kind: "warning" },
        );
        if (!move) return;
        try {
          await gitApi.createTag(props.repoPath, name, c.oid, undefined, true);
          pushToast(`Moved tag ${name}`, "success", 2500);
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        }
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  function commitMenuItems(c: GitCommitInfo): ContextMenuItem[] {
    return [
      { label: "Cherry-pick onto current", onSelect: () => void cherryPick(c) },
      { label: "Revert commit", onSelect: () => void revert(c) },
      { label: "Create tag here…", onSelect: () => void tagHere(c) },
      { label: "Reset (soft) to here", onSelect: () => void resetTo(c, "soft"), separatorBefore: true },
      { label: "Reset (mixed) to here", onSelect: () => void resetTo(c, "mixed") },
      { label: "Reset (hard) to here", onSelect: () => void resetTo(c, "hard"), danger: true },
    ];
  }

  return (
    <div class="h-full relative">
      <Show when={logError()}>
        <p class="px-2 py-1.5 text-[11px] text-destructive" title={logError()}>
          History unavailable: {logError()}
        </p>
      </Show>
      <div class="p-1" aria-busy={busy()}>
        <For each={layout().rows}>
          {(row) => (
            <div
              class="flex items-stretch rounded-md hover:bg-accent/40 transition-colors cursor-pointer select-none"
              style={{ height: `${ROW_HEIGHT}px` }}
              onClick={() => openCommitCompare(row.commit)}
              onContextMenu={(e) => {
                e.preventDefault();
                setHoveredCommit(null);
                setMenu({ x: e.clientX, y: e.clientY, commit: row.commit });
              }}
              onMouseEnter={(e) => {
                setHoveredCommit(row.commit);
                setHoverPos({ x: e.clientX, y: e.clientY });
              }}
              onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredCommit(null)}
              title="Open commit diff (right-click for actions)"
            >
              <DagColumn row={row} maxLanes={layout().maxLanes} />
              {/* Leading is pinned (18px + 16px + 12px padding = ROW_HEIGHT) so the
                  body never outgrows the gutter SVG next to it. */}
              <div class="flex-1 min-w-0 px-2 py-1.5 text-[13px] flex flex-col justify-center">
                <div class="flex items-center gap-2 h-[18px]">
                  <span class="font-mono text-muted-foreground text-xs tabular-nums shrink-0">
                    {row.commit.oid.slice(0, 7)}
                  </span>
                  <span class="truncate flex-1 text-foreground">{row.commit.summary}</span>
                </div>
                <div class="text-xs leading-4 text-muted-foreground/80 truncate tabular-nums">
                  {row.commit.authorName} · {new Date(row.commit.time * 1000).toLocaleString()}
                </div>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={hoveredCommit()}>
        {(commit) => (
          <CommitHoverPopover commit={commit()} x={hoverPos().x} y={hoverPos().y} />
        )}
      </Show>

      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={commitMenuItems(m().commit)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </div>
  );
}

/// Per-row DAG cell. Renders an SVG with:
///   - vertical lines for every pre-lane that continues into post-lanes
///   - diagonals from pre-lanes that converged into THIS commit (merges)
///   - diagonals from this commit out to NEW lanes (branches)
///   - a circle at this commit's lane index
function DagColumn(props: { row: PositionedCommit; maxLanes: number }) {
  const width = () => Math.max(1, props.maxLanes) * LANE_WIDTH + LANE_X_OFFSET;
  const mid = ROW_HEIGHT / 2;
  const r = props.row;

  /// Pre-lane top-half lines: each pre-lane that survives into the post
  /// set (and isn't the lane being landed by this commit) is a straight
  /// vertical line from top to mid. Pre-lanes that *converge* on this
  /// commit are diagonals from their x to the commit's x.
  const topSegments = () => {
    const segs: Array<{ from: number; to: number; color: string }> = [];
    r.preLanes.forEach((oid, i) => {
      if (oid === null) return;
      if (oid === r.commit.oid) {
        // Merging into this commit — line slopes toward the commit lane.
        segs.push({ from: i, to: r.laneIndex, color: laneColor(i) });
      } else {
        segs.push({ from: i, to: i, color: laneColor(i) });
      }
    });
    return segs;
  };

  /// Bottom-half lines: for each post-lane that's non-null, draw from
  /// (post lane x, mid) down to (post lane x, bottom). New parent lanes
  /// (not present in preLanes at the same index OR with a different OID)
  /// slope out from this commit's circle.
  const bottomSegments = () => {
    const segs: Array<{ from: number; to: number; color: string }> = [];
    r.postLanes.forEach((oid, i) => {
      if (oid === null) return;
      const wasInPre = r.preLanes[i] === oid;
      if (wasInPre) {
        segs.push({ from: i, to: i, color: laneColor(i) });
      } else {
        // New lane created by this commit — slope out from its circle.
        segs.push({ from: r.laneIndex, to: i, color: laneColor(i) });
      }
    });
    return segs;
  };

  return (
    <svg
      width={width()}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width()} ${ROW_HEIGHT}`}
      class="shrink-0"
    >
      <For each={topSegments()}>
        {(seg) => (
          <line
            x1={laneX(seg.from)}
            y1={0}
            x2={laneX(seg.to)}
            y2={mid}
            stroke={seg.color}
            stroke-width="1.5"
            stroke-linecap="round"
          />
        )}
      </For>
      <For each={bottomSegments()}>
        {(seg) => (
          <line
            x1={laneX(seg.from)}
            y1={mid}
            x2={laneX(seg.to)}
            y2={ROW_HEIGHT}
            stroke={seg.color}
            stroke-width="1.5"
            stroke-linecap="round"
          />
        )}
      </For>
      <circle
        cx={laneX(r.laneIndex)}
        cy={mid}
        r={COMMIT_RADIUS}
        fill={laneColor(r.laneIndex)}
        stroke="var(--background)"
        stroke-width="1.5"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Opened Diffs
// ─────────────────────────────────────────────────────────────────────────────

function OpenedDiffsPane(props: {
  worktreeId: string;
  tabs: { id: string; filePath: string }[];
  activeDiffId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div class="p-1">
      <Show
        when={props.tabs.length > 0}
        fallback={
          <div class="px-2.5 py-3 text-[13px] text-muted-foreground">
            <GitCompare class="w-4 h-4 mx-auto mb-1.5 opacity-60" />
            <p class="text-center">No diffs open.</p>
          </div>
        }
      >
        <For each={props.tabs}>
          {(tab) => {
            const isActive = () => tab.id === props.activeDiffId;
            const fileName = () => tab.filePath.split("/").pop() ?? tab.filePath;
            return (
              <div
                class={`group flex items-center rounded-md border transition-colors ${
                  isActive()
                    ? "bg-accent/60 border-border text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30"
                }`}
              >
                <button
                  onClick={() => props.onSelect(tab.id)}
                  title={tab.filePath}
                  class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left text-[13px] cursor-pointer focus-visible:outline-none"
                >
                  <GitCompare class="w-3.5 h-3.5 shrink-0 text-info" />
                  <span class="flex-1 min-w-0 truncate">
                    <span class="text-muted-foreground text-[11px]">diff · </span>{fileName()}
                  </span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); props.onClose(tab.id); }}
                  aria-label={`Close diff ${fileName()}`}
                  title="Close diff"
                  class="p-0.5 mr-1 rounded opacity-60 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// File row
// ─────────────────────────────────────────────────────────────────────────────

/// A sub-heading inside a section's scroll area — "Staged (3)", "Changes (12)".
///
/// `sticky` because these live *inside* the scrolling list, unlike the section
/// headers above them: scroll a hundred changed files and the heading telling
/// you whether you are looking at staged or unstaged is the first thing to go.
function SectionLabel(props: { children: JSX.Element; class?: string }) {
  return (
    <div
      class={`sticky top-0 z-10 bg-sidebar px-2.5 density-section ui-section-label flex items-center gap-1.5 ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

/// A windowed file list.
///
/// The changed-file count is unbounded — a rebase or a generated-code commit
/// produces thousands — so the rows are virtualized with
/// `@tanstack/solid-virtual`, the same pattern `FileTree` uses.
///
/// **The row height is fixed at 24px and does *not* respond to the density
/// preference.** That is deliberate and it is the one thing here that must not
/// be "fixed": the virtualizer's `estimateSize` is what decides which rows
/// exist at a given scroll offset, and a height that changes with a setting
/// desyncs the estimate from reality. `index.css` documents the same exclusion
/// for `FileTree`. Density still reaches everything around the list.
function VirtualFileList(props: {
  rows: ChangeRow[];
  focusPath: string | null;
  selectedFile: string | null;
  rowId: (path: string) => string;
  onFocusRow: (path: string) => void;
  onSelect: (path: string) => void;
  actionIcon: LucideIcon;
  actionTitle: string;
  onAction: (path: string) => void;
  secondaryFor?: (row: ChangeRow) => "discard" | "delete";
  onSecondary?: (path: string, status: string) => void;
}) {
  const ROW_HEIGHT = 24;
  /// Below this the list is shorter than its own viewport and windowing costs
  /// more than it saves — an absolutely-positioned row layer for eleven files
  /// is pure overhead.
  const VIRTUALIZE_ABOVE = 40;
  let scrollRef: HTMLDivElement | undefined;

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.rows.length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  /// Keep the keyboard cursor on screen. The whole point of arrow-key
  /// navigation through a windowed list is that the row you moved to exists;
  /// without this the cursor walks off the bottom into unrendered rows.
  createEffect(() => {
    const path = props.focusPath;
    if (!path) return;
    const idx = props.rows.findIndex((r) => r.entry.path === path);
    if (idx === -1) return;
    if (props.rows.length > VIRTUALIZE_ABOVE) virtualizer.scrollToIndex(idx);
    else scrollRef?.querySelector(`#${CSS.escape(props.rowId(path))}`)?.scrollIntoView({ block: "nearest" });
  });

  const row = (r: ChangeRow) => (
    <FileRow
      id={props.rowId(r.entry.path)}
      file={r.entry.path}
      ranges={r.ranges}
      status={r.entry.status}
      selected={props.selectedFile === r.entry.path}
      cursor={props.focusPath === r.entry.path}
      onSelect={() => {
        props.onFocusRow(r.entry.path);
        props.onSelect(r.entry.path);
      }}
      actionIcon={props.actionIcon}
      onAction={() => props.onAction(r.entry.path)}
      actionTitle={props.actionTitle}
      secondaryIcon={
        props.secondaryFor
          ? props.secondaryFor(r) === "delete"
            ? Trash2
            : Undo2
          : undefined
      }
      onSecondary={() => props.onSecondary?.(r.entry.path, r.entry.status)}
      secondaryTitle={
        props.secondaryFor
          ? props.secondaryFor(r) === "delete"
            ? "Delete untracked file"
            : "Discard changes"
          : undefined
      }
    />
  );

  return (
    <div
      ref={(el) => (scrollRef = el)}
      class="overflow-y-auto scrollbar-thin"
      style={{ "max-height": `${ROW_HEIGHT * 16}px` }}
    >
      <Show when={props.rows.length > VIRTUALIZE_ABOVE} fallback={<For each={props.rows}>{row}</For>}>
        <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => (
              <div
                class="absolute top-0 left-0 w-full"
                style={{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }}
              >
                {row(props.rows[item.index])}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function FileRow(props: {
  id?: string;
  file: string;
  status: string;
  /// Which characters the changes filter matched, for the one highlight
  /// treatment the palette and file finder already use.
  ranges?: MatchRange[];
  selected: boolean;
  /// The keyboard cursor is on this row. Distinct from `selected`, which means
  /// "this file's diff is the one open in the editor window" — the two move
  /// independently, and conflating them would make arrowing through the list
  /// open a diff per keypress.
  cursor?: boolean;
  onSelect: () => void;
  actionIcon: LucideIcon;
  onAction: () => void;
  actionTitle: string;
  secondaryIcon?: LucideIcon;
  onSecondary?: () => void;
  secondaryTitle?: string;
}) {
  const Icon = props.actionIcon;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={!!props.cursor}
      // `h-6` rather than `density-row`: this row is the virtualizer's
      // `estimateSize`, and a height that moves with a setting desyncs it.
      class={`group flex items-center h-6 text-xs transition-colors focus-within:bg-accent/40 ${
        props.selected ? "bg-accent/70 text-foreground" : "hover:bg-accent/40"
      } ${props.cursor ? "ring-1 ring-inset ring-ring" : ""}`}
    >
      <button
        onClick={props.onSelect}
        aria-label={`Open diff for ${props.file}`}
        aria-pressed={props.selected}
        class="flex-1 flex items-center gap-1.5 pl-2.5 h-full min-w-0 text-left cursor-pointer focus-visible:outline-none"
      >
        <StatusBadge status={props.status} />
        <span class="flex-1 truncate">
          <FuzzyText text={props.file} ranges={props.ranges ?? []} />
        </span>
      </button>
      <Show when={props.secondaryIcon}>
        {(SecondaryIcon) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onSecondary?.();
            }}
            aria-label={`${props.secondaryTitle} ${props.file}`}
            title={props.secondaryTitle}
            class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 transition-[opacity,background-color,color]"
          >
            {(() => {
              const I = SecondaryIcon();
              return <I class="w-3 h-3 text-muted-foreground" />;
            })()}
          </button>
        )}
      </Show>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onAction();
        }}
        aria-label={`${props.actionTitle} ${props.file}`}
        title={props.actionTitle}
        class="p-0.5 mr-2 rounded opacity-60 group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100"
      >
        <Icon class="w-3 h-3 text-muted-foreground" />
      </button>
    </div>
  );
}

/** Collapsed rail */
export function GitSidebarCollapsed(props: { onExpand: () => void }) {
  return (
    <div class="flex flex-col items-center w-8 bg-sidebar py-2 gap-2 h-full">
      <button
        onClick={props.onExpand}
        aria-label="Expand git panel"
        class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        title="Expand git panel"
      >
        <ChevronLeft class="w-3.5 h-3.5" />
      </button>
      <GitBranch class="w-4 h-4 text-muted-foreground" />
    </div>
  );
}
