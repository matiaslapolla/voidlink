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
  ArrowDownToLine,
  Undo2,
  Trash2,
  Archive,
  Tag,
  Pencil,
  GitBranchPlus,
  PanelRightOpen,
} from "lucide-solid";
import { promptWithToggles } from "@/commands/prompt";
import type { CommitIdentity, PushOutcome, StashEntry, RemoteInfo } from "@/types/git";
import { StackSidebarSection } from "@/components/git/stack/StackSidebarSection";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import { Button } from "@/components/ui/Button";
// Referenced so the compiler keeps the import: Solid erases a `use:` directive
// whose symbol is otherwise unused, and TypeScript cannot see a JSX attribute
// as a use.
import { tooltip } from "@/components/ui/Tooltip";
void tooltip;
import { StatusBadge } from "@/components/git/shared/StatusBadge";
import { OperationBanner } from "@/components/git/OperationBanner";
import { gitApi } from "@/api/git";
import {
  isGitWindow,
  openEditorTab,
  openGitWindow,
  requestOpenWorktreeOnMain,
} from "@/api/windows";
import { openMerge } from "@/components/git/openMerge";
import { GitSyncControls, createGitSync } from "@/components/git/GitSyncControls";
import { PushRecovery } from "@/components/git/PushRecovery";
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
import { fuzzyMatch, type FuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { createRowIdentity } from "@/store/stableRows";
import { PANEL_BOUNDS } from "@/store/layout";

import { useAppStore } from "@/store/LayoutContext";
import { samePath, type GitSectionKey } from "@/store/layout";

import { requestNewWorktree } from "@/commands/worktree";
import {
  isValidRemoteName,
  isValidRemoteUrl,
  normalizeRemoteName,
} from "@/commands/remoteUrl";
import { removeWorktreeWithConfirm } from "@/commands/worktreeRemove";
import { resolveCommitCommand, useSettings } from "@/store/settings";
import { scanStagedDiff, type SecretFinding } from "@/commands/secretScan";
import { SecretScanDialog } from "@/commands/SecretScanDialog";
import { pushToast } from "@/commands/toast";
import { shortcutLabel } from "@/commands/shortcuts";
import { textPrompt } from "@/commands/prompt";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { registerGitSidebarActions } from "@/commands/gitSidebarActions";
import { commitDiffBase } from "@/commands/commitDiff";
import { createInFlight, dedupeConcurrent } from "@/commands/inflight";
import { GitErrorBoundary } from "@/components/git/GitErrorBoundary";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import {
  aiCommitState,
  draftCommitMessage,
  onAiCommitRequest,
} from "@/commands/aiCommit";
import { recordBranchUse, sortBranchesByMru } from "@/commands/branchMru";
import type { AheadBehind, GitBranchInfo, GitCommitInfo } from "@/types/git";

type LucideIcon = Component<{ class?: string }>;

/// A header icon button. `disabled` exists because Fetch (and every Remotes
/// action) sat next to a Pull button that had one, with nothing stopping a second
/// click while the first request was still out.
/// The git sidebar's icon button, now over `components/ui/Button`.
///
/// Its `chrome` variant is exactly what this was hand-rolling — the same tint,
/// the same disabled treatment — and it brings the two states this did not
/// have: a press treatment (MOTION-PLAN F19; this was one of the 275 controls
/// with none) and a real tooltip rather than the OS's `title` (F3).
///
/// `disabled` stays a boolean here rather than becoming `disabledReason`,
/// because the ~30 call sites pass it as one. Where a caller already knows the
/// reason it passes `title`, and that is what the button states — which is
/// §7.6's requirement met at the sites that can meet it, rather than a
/// mandatory field the other sites would fill with a placeholder.
function IconBtn(props: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
  class?: string;
  disabled?: boolean;
  title?: string;
  /// Work is in flight. Swaps the icon for a spinner; the button stays
  /// focusable and in the tab order (§7.6 — pending is not disabled).
  pending?: boolean;
  /// Set only when the button toggles something's disclosure, and then to the
  /// state that thing is in *now*. An icon button whose whole meaning is a
  /// chevron reports nothing to a screen reader without it.
  expanded?: boolean;
}) {
  return (
    <Button
      variant="chrome"
      size="sm"
      onClick={props.onClick}
      disabledReason={props.disabled ? (props.title ?? `${props.label} is unavailable`) : undefined}
      pending={props.pending}
      icon={props.children}
      aria-label={props.label}
      aria-expanded={props.expanded}
      title={props.title ?? props.label}
      use:tooltip={props.title ?? props.label}
      class={props.class}
    />
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
  /// Whether the pane is in the DOM. Trails `open` by the length of the
  /// collapse — see `useCollapseMount`.
  mounted: boolean;
  isLast: boolean;
  onToggle: () => void;
  /// Shown beside the label. Its only job so far is saying that a *collapsed*
  /// section has something in it — a collapsed Stashes section unmounts its
  /// pane, so twelve stashes looked exactly like zero and stashed work is
  /// precisely the kind that gets forgotten.
  badge?: JSX.Element;
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
        class="flex items-center gap-1.5 px-2.5 py-1.5 text-ui font-medium text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {/* One glyph that rotates, not two that swap. A swap cannot
            interpolate, so it reads as a flicker beside a track that is
            taking `--dur-short` to open. */}
        <span class="w-3 h-3 shrink-0">
          <ChevronRight
            class="w-3 h-3 transition-transform duration-[var(--dur-short)] ease-in-out"
            classList={{ "rotate-90": props.open }}
          />
        </span>
        {props.icon}
        <span class="flex-1 tracking-wide text-body truncate">{props.label}</span>
        <Show when={!props.open && props.badge}>
          <span class="shrink-0 text-micro tabular-nums text-muted-foreground/80 px-1 rounded bg-muted/60">
            {props.badge}
          </span>
        </Show>
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
      {/* The collapse (MOTION-PLAN F11).
       *
       * `grid-template-rows: 0fr → 1fr` is §7.3.2's named technique and the
       * only one that animates a region to its *content's* height without
       * measuring it, without a `max-height` guess, and without touching
       * layout on the main thread every frame the way an animated `height`
       * does. §7.1 budgets a sidebar collapse at `--dur-short`.
       *
       * **The last section is deliberately instant**, and that is a geometry
       * fact rather than an oversight: an open last section is `flex-1`, so
       * its height comes from the flex container and not from the grid track,
       * and collapsing it changes which flex rule applies. There is nothing
       * for the track to interpolate. Animating it would mean animating a flex
       * basis, which §7.3.2 forbids for the reason it forbids `height`.
       *
       * The pane still *unmounts* when closed — a collapsed Stashes section
       * that kept polling would be a background cost nobody asked for — and
       * `mounted` is what holds it in the DOM for the length of the exit so
       * there is something to collapse. */}
      <div
        data-motion="git-section"
        class={[
          "grid",
          props.isLast && props.open ? "flex-1 min-h-0" : "shrink-0",
          props.isLast ? "" : "transition-[grid-template-rows] duration-[var(--dur-short)] ease-in-out",
        ].join(" ")}
        style={{ "grid-template-rows": props.open ? "1fr" : "0fr" }}
      >
        <div class="min-h-0 overflow-hidden flex flex-col">
          <Show when={props.mounted}>
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
      </div>
    </div>
  );
}

/// `props.open`, held true for the length of the collapse.
///
/// A section unmounts its pane when it closes, and a pane that has already
/// unmounted cannot animate away. This is the same shape as the toast
/// viewport's departing rows: the truth (`open`) flips immediately and the DOM
/// trails it by one exit.
///
/// Opening is *not* delayed — the content has to be in the DOM before the track
/// can grow to it, or the section expands to nothing and then pops.
export function useCollapseMount(open: () => boolean): () => boolean {
  const [mounted, setMounted] = createSignal(open());
  let handle: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (handle !== undefined) {
      clearTimeout(handle);
      handle = undefined;
    }
    if (open()) {
      setMounted(true);
      return;
    }
    handle = setTimeout(() => setMounted(false), COLLAPSE_EXIT_MS);
  });
  onCleanup(() => {
    if (handle !== undefined) clearTimeout(handle);
  });
  return mounted;
}

/// Must not be shorter than `--dur-short`; a little longer so the unmount never
/// truncates the last frames of the collapse.
const COLLAPSE_EXIT_MS = 220;

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
  /// Its `staged` flag comes along because the same file can have both a
  /// staged and an unstaged diff tab, and only one of them is open.
  const activeFilePath = createMemo(() => {
    const item = editorActiveItem();
    if (item?.type !== "diff") return null;
    const tab = activeDiffTabs().find((t) => t.id === item.id);
    return tab ? { path: tab.filePath, staged: !!tab.staged } : null;
  });

  const activeDiffId = () => {
    const a = editorActiveItem();
    return a?.type === "diff" ? a.id : null;
  };

  /// How many stashes exist, but only while the Stashes section is collapsed.
  ///
  /// Open, the pane lists them and this would be a second identical call on
  /// every pulse. Collapsed, the pane is unmounted and nothing else knows —
  /// which is the case worth paying one cheap `stash_foreach` for.
  const [stashTick, setStashTick] = createSignal(0);
  const [stashCount] = createResource(
    () => (state.gitSections.stashes ? null : { path: props.repoPath, tick: stashTick() }),
    (k) => gitApi.stashList(k.path).then((l) => l.length),
  );
  const collapsedStashCount = () => {
    const n = stashCount.state === "errored" ? undefined : stashCount();
    return n && n > 0 ? String(n) : undefined;
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
    // The collapsed-stash badge re-reads on the same pulse, via its own tick
    // rather than a refetch handle, so it stays inert while the section is open.
    setStashTick((t) => t + 1);
    await Promise.all([refetchStatus(), refetchInfo()]);
  });

  // Palette action "Refresh git status" / cross-pane refreshes (e.g. after
  // hunk staging) fan out through a window event so callers don't need a
  // direct reference to this component.
  onMount(() => {
    const handler = () => void refreshAll();
    window.addEventListener("voidlink:refresh-git", handler);
    // Fetch / pull / remotes go through a registry rather than window events:
    // this component is unmounted while the panel is collapsed, and an event
    // dispatched then was simply lost. Registering also replays a request made
    // while we were away, so the shortcut that reveals the panel performs the
    // action too.
    const unregister = registerGitSidebarActions({
      fetch: () => void doFetch(),
      pull: () => void doPull(),
      remotes: () => setRemotesOpen(true),
    });
    onCleanup(() => {
      window.removeEventListener("voidlink:refresh-git", handler);
      unregister();
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
    // Merge-base, because the pill this opens shows the **symmetric**
    // difference: at ↑1 ↓12 you click "↑1" expecting one commit and a two-dot
    // diff gave you thirteen, with upstream's twelve commits rendered as
    // deletions of your colleagues' work. Three-dot answers the question the
    // arrow actually asked — "what is on my branch that upstream does not
    // have".
    actions.openCompareTab(props.worktreeId, {
      baseRef: current.upstream,
      headRef: current.currentBranch,
      useMergeBase: true,
    });
  }

  const [remotesOpen, setRemotesOpen] = createSignal(false);

  // Fetch / pull / remotes live in `GitSyncControls` now, shared with the
  // standalone git window — which had none of the three, so the window you open
  // *because* you want the git surface at full size could not fetch.
  const sync = createGitSync({
    repoPath: () => props.repoPath,
    worktreeId: () => props.worktreeId,
    info,
  });
  const doFetch = sync.doFetch;
  const doPull = sync.doPull;

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
            detached={info()?.isDetached ?? false}
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
      <div class="px-3 h-9 border-b border-border flex items-center gap-2 text-body shrink-0">
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
          <span class={`text-warning text-body ${freshnessClass(freshness())}`} title={freshTitle()}>
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
          <GitSyncControls
            sync={sync}
            info={info}
            onManageRemotes={() => setRemotesOpen(true)}
          />
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
          <IconBtn label="Collapse git panel" expanded onClick={() => actions.toggleGitSidebar()}>
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
          {(key, i) => {
            // One per section, created inside the row's own reactive scope so
            // each keeps its own exit timer.
            const mounted = useCollapseMount(() => state.gitSections[key]);
            return (
            <Section
              label={SECTION_LABELS[key]}
              icon={sectionIcon(key)}
              open={state.gitSections[key]}
              mounted={mounted()}
              isLast={lastOpenSection() === key}
              onToggle={() => actions.toggleGitSection(key)}
              badge={key === "stashes" ? collapsedStashCount() : undefined}
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
            );
          }}
        </For>
      </div>

      {/* Pinned footer. Compare is a destination rather than a view of repo
          state, so it sits below the collapsible sections instead of
          competing with them for vertical space. */}
      <div class="shrink-0 border-t border-border p-2">
        <button
          onClick={() => actions.openCompareTab(props.worktreeId)}
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed border-border text-body text-muted-foreground hover:text-foreground hover:bg-accent/40 hover:border-border/80 transition-colors"
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
  selectedFile: { path: string; staged: boolean } | null;
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
  /// The last rejection, kept whole so its failure class survives. Cleared on
  /// the next push and once the divergence is resolved.
  const [rejection, setRejection] = createSignal<PushOutcome | null>(null);
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

  // ── Filter and keyboard cursor ───────────────────────────────────────────
  // The three lists behave as one keyboard surface: arrows walk from the last
  // staged file into the first unstaged one, and Space acts on whichever row
  // has the cursor. The ordering, the fuzzy filter and the movement all live
  // in `changesNav.ts` — see its header for why they are not inline here.
  let filterRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  const [filter, setFilter] = createSignal("");
  /// The cursor is a `ChangeRow.key`, not a path. A file that is staged and
  /// then edited again is now two rows with the same path and opposite
  /// actions, so a path could no longer say which one the cursor was on.
  const [focusKey, setFocusKey] = createSignal<string | null>(null);

  /// Rows as stable objects across a pulse that did not change them — see
  /// `store/stableRows`. This list rebuilds on every filesystem event, and
  /// `<For>` keyed by reference tore down the focused row with everything else.
  const stabilizeRows = createRowIdentity<ChangeRow>((r) => r.key);
  const rows = createMemo(() => stabilizeRows(flattenChanges(props.status ?? [], filter())));
  const conflictRows = () => rowsIn(rows(), "conflicted");
  const stagedRows = () => rowsIn(rows(), "staged");
  const unstagedRows = () => rowsIn(rows(), "unstaged");

  const rowDomId = (key: string) => `change-row-${key.replace(/[^\w-]/g, "_")}`;

  /// Keep the cursor on something real. Staging a file moves it between
  /// sections and typing into the filter can remove it entirely; in both cases
  /// the cursor lands near where it was so the user can keep pressing the same
  /// key rather than reaching for the mouse to find it again.
  createEffect(() => {
    const list = rows();
    const current = untrack(focusKey);
    if (!current) return;
    const previousIndex = untrack(() => lastIndex);
    const next = reconcileFocus(list, current, previousIndex);
    if (next !== current) setFocusKey(next);
  });
  let lastIndex = 0;
  createEffect(() => {
    const idx = rows().findIndex((r) => r.key === focusKey());
    if (idx !== -1) lastIndex = idx;
  });

  function onListKeyDown(e: KeyboardEvent) {
    const list = rows();
    const current = focusKey();
    const row = list.find((r) => r.key === current);
    const action = actionForKey(e.key, row?.section ?? "unstaged");
    if (action.kind === "none") return;
    e.preventDefault();
    switch (action.kind) {
      case "move":
        setFocusKey(moveFocus(list, current, action.delta));
        break;
      case "open":
        if (row) selectFile(row.entry.path, row.section === "staged");
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
    // Counted over distinct *paths*, not rows: a file that is staged and then
    // edited again contributes two rows, and "Discard all changes to 2 tracked
    // file(s)" for one file is the kind of number that makes a destructive
    // confirm untrustworthy.
    // Scoped to the filter when there is one. "Discard all changes" reverted
    // every change in the repository while the list in front of the user showed
    // four — the confirm was not lying, but the list is what they were reading,
    // and this is the one action here that cannot be undone.
    const filtering = filter().trim().length > 0;
    const all = filtering
      ? rows().map((r) => r.entry)
      : (props.status ?? []);
    const pathsWhere = (keep: (status: string) => boolean) =>
      new Set(all.filter((f) => keep(f.status)).map((f) => f.path));
    const untracked = pathsWhere((s) => s === "untracked");
    const tracked = pathsWhere((s) => s !== "untracked");
    /// `undefined` means "everything", which is what Rust wants when no filter
    /// is active. An explicit list is never allowed to be empty-and-implicit.
    const scope = filtering ? [...untracked, ...tracked] : undefined;
    const what = filtering ? "matching the filter" : "";

    if (all.length === 0) {
      pushToast(
        filtering
          ? "Nothing to discard — no changed file matches the filter."
          : "Nothing to discard — the working tree is clean.",
        "info",
        2500,
      );
      return;
    }

    let includeUntracked = false;
    if (tracked.size > 0) {
      const ok = await dialogConfirm(
        `Discard all changes to ${tracked.size} tracked file(s) ${what}? Staged and unstaged edits both revert to HEAD. This cannot be undone.`,
        { title: "Discard tracked changes", kind: "warning" },
      );
      if (!ok) return;
    }
    if (untracked.size > 0) {
      includeUntracked = await dialogConfirm(
        `Also delete ${untracked.size} untracked file(s) ${what} from disk? They are not in git, so this cannot be undone.`,
        { title: "Delete untracked files", kind: "warning" },
      );
      // Nothing at all was confirmed — don't run a no-op that reports success.
      if (!includeUntracked && tracked.size === 0) return;
    }

    await run(async () => {
      try {
        // Untracked paths are dropped from the scope when the user declined
        // the second confirm: Rust deletes an untracked path it is *given*
        // whenever `includeUntracked` is set, and the confirm the user answered
        // was about the tracked half only.
        const paths = scope
          ? includeUntracked
            ? scope
            : scope.filter((p) => !untracked.has(p))
          : undefined;
        await gitApi.discardAll(props.repoPath, includeUntracked, paths);
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
    // `resolveCommitCommand()` rather than the raw setting: Settings → AI no
    // longer has a command box, so a blank `commitCommand` is now the normal
    // state and means "the built-in `claude -p`", not "unconfigured".
    const result = await draftCommitMessage(props.repoPath, resolveCommitCommand());
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
  ///
  /// The rejection is kept as a whole `PushOutcome`, not just its message,
  /// because the recovery affordance underneath it is offered for one failure
  /// class and withheld for every other — and it cannot tell them apart by
  /// reading the prose. See `PushRecovery`.
  async function push() {
    if (pushing()) return;
    setPushing(true);
    setPushOk(false);
    setPushError("");
    setRejection(null);
    try {
      const outcome = await gitApi.push(props.repoPath);
      if (outcome.ok) {
        setPushOk(true);
        setTimeout(() => setPushOk(false), 2000);
      } else {
        setPushError(outcome.message);
        setRejection(outcome);
      }
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
  /// `staged` follows the section the row was clicked in, and it has to: a
  /// file that is both staged and modified appears in both lists with two
  /// different diffs behind it, and the tab is keyed on the pair.
  const selectFile = (path: string, staged: boolean) => {
    void openEditorTab({ kind: "open-diff", filePath: path, staged }, () =>
      actions.openDiffTab(props.worktreeId, path, staged),
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
          class={`w-full rounded-md bg-muted/50 border border-border/60 px-2.5 py-1.5 text-body resize-none focus:outline-none focus:ring-1 focus:ring-ring transition-colors ${
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
            class="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-ui font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.96] transition-[background-color,color,transform,opacity]"
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
            // No "configure a command first" branch any more — there is nothing
            // left to configure, and the button is never a no-op waiting on a
            // settings box.
            title={
              recentDraftMs() !== null
                ? `Regenerate (last draft: ${recentDraftMs()}ms)`
                : `Draft commit message with AI (${shortcutLabel("git.ai-draft-commit")})`
            }
            class={`px-2 py-1 rounded-md text-ui transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              recentDraftMs() !== null
                ? "text-primary hover:text-primary hover:bg-primary/10"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <Sparkles class={`w-3 h-3 ${drafting() ? "animate-pulse" : ""}`} />
          </button>
          {/* The reading pass. Reviewing your own branch used to mean opening
              one diff tab per file and holding the shape of the change in your
              head across them. */}
          <button
            onClick={() => actions.openCombinedTab(props.worktreeId)}
            aria-label="Review all changes in one view"
            title="Review all changes in one view"
            class="px-2 py-1 rounded-md text-ui text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <Layers class="w-3 h-3" />
          </button>
          <button
            onClick={() => void stageAll()}
            disabled={busy()}
            aria-label="Stage all changes"
            title="Stage all"
            class="px-2 py-1 rounded-md text-ui text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus class="w-3 h-3" />
          </button>
          <button
            onClick={() => void stashChanges()}
            disabled={busy()}
            aria-label="Stash changes"
            title="Stash changes"
            class="px-2 py-1 rounded-md text-ui text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Archive class="w-3 h-3" />
          </button>
          <button
            onClick={() => void push()}
            disabled={pushing()}
            aria-label="Push to remote"
            title="Push"
            class={`px-2 py-1 rounded-md text-ui transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
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
          <p class="text-body text-destructive truncate" title={commitError()}>{commitError()}</p>
        </Show>
        <Show when={pushError()}>
          <p class="text-body text-destructive truncate" title={pushError()}>
            Push failed: {pushError()}
          </p>
        </Show>
        {/* Force-push lives here and nowhere else: only under a rejection that
            proves the branches diverged. `PushRecovery` renders nothing for any
            other failure class. */}
        <Show when={rejection()}>
          {(r) => (
            <PushRecovery
              repoPath={props.repoPath}
              worktreeId={props.worktreeId}
              outcome={r()}
              onResolved={() => {
                setRejection(null);
                setPushError("");
              }}
            />
          )}
        </Show>
        <div class="flex items-center gap-2 text-label">
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
        <div class="mt-1.5 text-label">
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
                  class="rounded border border-border bg-muted/40 px-1.5 py-1 text-label focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <label class="text-muted-foreground">Email</label>
                <input
                  value={draftEmail()}
                  onInput={(e) => setDraftEmail(e.currentTarget.value)}
                  placeholder="ada@example.com"
                  class="rounded border border-border bg-muted/40 px-1.5 py-1 text-label font-mono focus:outline-none focus:ring-1 focus:ring-ring"
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
                setFocusKey(moveFocus(rows(), null, 1));
                listRef?.focus();
              } else if (e.key === "Escape" && filter()) {
                e.preventDefault();
                setFilter("");
              }
            }}
            placeholder="Filter changed files"
            aria-label="Filter changed files"
            class="w-full rounded-md bg-muted/40 border border-border/60 pl-7 pr-2 py-1 text-body outline-2 outline-transparent focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div
        ref={(el) => (listRef = el)}
        tabIndex={0}
        role="listbox"
        aria-label="Changed files"
        aria-activedescendant={focusKey() ? rowDomId(focusKey()!) : undefined}
        onKeyDown={onListKeyDown}
        class="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {/* Gated on the *filtered* rows, like its own count. Gating on the
            unfiltered list while counting the filtered one rendered a
            "Conflicts (0)" header above an empty section whenever the filter
            excluded every conflict — a header asserting there are no conflicts
            while a real one exists. */}
        <Show when={conflictRows().length > 0}>
          <div class="border-b border-border/50">
            <SectionLabel class="text-warning/90">
              <GitCompare class="w-3 h-3" />
              Conflicts (<span class="tabular-nums">{conflictRows().length}</span>)
            </SectionLabel>
            <For each={conflictRows()}>
              {(row) => (
                <button
                  id={rowDomId(row.key)}
                  role="option"
                  aria-selected={focusKey() === row.key}
                  onClick={() => {
                    setFocusKey(row.key);
                    openConflict(`${props.repoPath}/${row.entry.path}`);
                  }}
                  title={`Resolve conflict in ${row.entry.path}`}
                  class={`w-full flex items-center gap-2 px-2.5 h-6 text-ui text-left text-warning hover:bg-warning/10 transition-colors ${
                    focusKey() === row.key ? "bg-warning/15" : ""
                  }`}
                >
                  <StatusBadge status={row.entry.status} />
                  <span class="flex-1 truncate font-mono">
                    <FuzzyText text={row.entry.path} ranges={row.ranges} />
                  </span>
                  <span class="text-micro tracking-wide opacity-70">Resolve</span>
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
              focusKey={focusKey()}
              selectedFile={props.selectedFile}
              rowId={rowDomId}
              onFocusRow={setFocusKey}
              onSelect={(path) => selectFile(path, true)}
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
              // The control names its own scope, because the scope moved: with
              // a filter typed it discards the matches, and a button that says
              // "in the working tree" while acting on four of forty files is
              // the kind of mismatch you only notice afterwards.
              title={
                filter().trim()
                  ? "Discard changes in the files matching the filter"
                  : "Discard changes in the working tree"
              }
              aria-label={
                filter().trim()
                  ? "Discard changes in the files matching the filter"
                  : "Discard changes in the working tree"
              }
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
            focusKey={focusKey()}
            selectedFile={props.selectedFile}
            rowId={rowDomId}
            onFocusRow={setFocusKey}
            onSelect={(path) => selectFile(path, false)}
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
  /// Render the tags list underneath the branches.
  ///
  /// True for the workbench sidebar, which has no Tags section of its own.
  /// False for the standalone git window, which does — there, embedding it
  /// here put the same list in two places and fetched `git_list_refs` for
  /// whichever one happened to be showing.
  showTags?: boolean;
  /// HEAD is detached — no branch is checked out. Passed in because the branch
  /// list alone cannot say so: every row simply has `isHead: false`, which is
  /// indistinguishable from a list that failed to mark the current one.
  detached?: boolean;
}) {
  const { actions } = useAppStore();
  const { busy, run } = createInFlight();
  /// Why every branch mutation is unavailable right now, or null.
  const blocked = (): string | null =>
    props.operation ? `Finish or abort the ${props.operation} first` : null;
  const locked = () => busy() || blocked() !== null;
  /// The list, tagged with the repository it came from.
  ///
  /// Solid keeps the previous value while a refetch is in flight (`completeLoad`
  /// only calls `setValue` on success), so switching worktrees rendered the
  /// *old* repository's branches for the length of the round-trip — with the
  /// header already showing the new repo's name. Checking out from that list
  /// would have named a branch that may not exist here. Carrying the repo path
  /// in the payload is what lets the pane tell "still loading" from "loaded".
  const [branches, { refetch }] = createResource(
    () => props.repoPath,
    async (p) => ({ repo: p, list: await gitApi.listBranches(p, true) }),
  );
  const [error, setError] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [menu, setMenu] = createSignal<{ x: number; y: number; branch: string } | null>(null);
  /// Remote-tracking branches are hidden by default.
  ///
  /// `listBranches(p, true)` was hardcoded and the two kinds were interleaved
  /// through one sort, so in any clone of any size the local branches — the
  /// ones you can actually check out and delete — were scattered through a list
  /// dominated by rows that only exist to be read.
  const [showRemotes, setShowRemotes] = createSignal(false);

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
  //
  // The open context menu closes with it. It holds a branch *name*, captured
  // when the row was right-clicked, and a pulse is exactly the moment that name
  // can stop meaning what it did — the branch was renamed, deleted, or is now
  // mid-rebase. "Merge topic into current" would then act on a stale answer.
  onMount(() =>
    onCleanup(
      onGitRefsChanged(() => {
        setMenu(null);
        refetch();
      }),
    ),
  );

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
        const msg = e instanceof Error ? e.message : String(e);
        // `gitApi.renameBranch` has always taken a `force`, nothing ever passed
        // it, and there was no overwrite confirm — so renaming onto an existing
        // name failed with a raw libgit2 sentence and a dead end, while the tag
        // flow two panes down offers exactly this. Matched on libgit2's wording
        // because the rename goes straight through git2 with no marker of ours
        // to key off; a miss costs the old behaviour, not a wrong one.
        if (!/exists|failed to rename/i.test(msg)) {
          pushToast(msg, "error", 6000);
          return;
        }
        const force = await dialogConfirm(
          `A branch named ${next} already exists.\n\nOverwrite it? Its commits stay in the repository but nothing will point at them.`,
          { title: "Overwrite branch", kind: "warning" },
        );
        if (!force) return;
        try {
          await gitApi.renameBranch(props.repoPath, name, next, true);
          pushToast(`Renamed to ${next}`, "success", 2500);
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        }
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  /// Confirm outside the gate, mutate inside it.
  ///
  /// This was the one branch action not routed through `run()`, so `busy()`
  /// stayed false for the whole delete and a checkout could start on top of
  /// it — the exact overlap `commands/inflight` exists to prevent. The confirm
  /// stays outside because holding the gate across a modal would block every
  /// other button for as long as the dialog is up.
  async function deleteBranch(name: string, symbolicTarget?: string | null) {
    const ok = await dialogConfirm(
      symbolicTarget
        ? // A symbolic ref is an alias. Deleting it removes the alias and
          // leaves the branch it names untouched — which is either exactly
          // what the user wanted or the opposite of it, and the old one-line
          // confirm gave them no way to tell which they were about to get.
          `${name} is an alias for ${symbolicTarget}.\n\nDeleting it removes the alias only — ${symbolicTarget} and its commits are untouched.`
        : `Delete branch ${name}?`,
      { title: symbolicTarget ? "Delete branch alias" : "Delete branch", kind: "warning" },
    );
    if (!ok) return;
    await run(() => performDelete(name));
  }

  async function performDelete(name: string) {
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

  /// The list for *this* repository, or `undefined` — never a throw, and never
  /// the previous repo's. A Solid resource rethrows its rejection from every
  /// read, and this one is read inside a memo; see the same guard in
  /// `CommitGraph`.
  const settled = () => {
    if (branches.state === "errored") return undefined;
    const data = branches.latest;
    return data && data.repo === props.repoPath ? data.list : undefined;
  };

  /// One `BranchRow` per branch, with the fuzzy ranges the filter matched.
  ///
  /// The old matcher was hand-rolled and answered only yes/no: its subsequence
  /// fallback let `main` match `feature/my-api-normalizer`, and nothing said
  /// *which* characters had matched even though `FuzzyText` and `MatchRange`
  /// were already imported for it. `fuzzyMatch` is the same matcher the command
  /// palette and file finder use — it scores, so a loose subsequence hit sorts
  /// below a real one instead of sitting next to it, and it returns the ranges.
  const matched = createMemo(() => {
    const all = settled() ?? [];
    const visible = showRemotes() ? all : all.filter((b) => !b.isRemote);
    const q = filter().trim();
    if (!q) {
      return sortBranchesByMru(visible, props.repoPath).map((branch) => ({
        branch,
        ranges: [] as MatchRange[],
      }));
    }
    const hits = visible
      .map((branch) => ({ branch, match: fuzzyMatch(branch.name, q, { pathAware: true }) }))
      .filter((h): h is { branch: GitBranchInfo; match: FuzzyMatch } => h.match !== null);
    // Ordered by score only while filtering. With no query the MRU order is
    // what makes the list scannable — a branch stays where you last saw it.
    hits.sort((a, b) => b.match.score - a.match.score || a.branch.name.localeCompare(b.branch.name));
    return hits.map((h) => ({ branch: h.branch, ranges: h.match.ranges }));
  });

  /// Rows as stable objects across a pulse that did not change them.
  ///
  /// `<For>` is keyed by reference and this list is rebuilt on every refs
  /// pulse — which the filesystem watcher fires several times a second while
  /// anything is running. Every row was torn down and rebuilt each time, so a
  /// focused rename button lost focus mid-refresh and the hover-revealed
  /// controls flickered. See `store/stableRows`.
  ///
  /// Keyed on remote-ness *and* name, NUL-escaped for the same reason
  /// `changesNav.rowKey` does it: a local `foo` and `origin/foo` are different
  /// rows, and no ref name can contain the separator and forge another's key.
  const stabilize = createRowIdentity<{ branch: GitBranchInfo; ranges: MatchRange[] }>(
    (r) => `${r.branch.isRemote ? "r" : "l"}\u0000${r.branch.name}`,
  );
  const filtered = createMemo(() => stabilize(matched()));

  const localCount = () => (settled() ?? []).filter((b) => !b.isRemote).length;
  const remoteCount = () => (settled() ?? []).filter((b) => b.isRemote).length;

  /// Why this row cannot be acted on, or null.
  ///
  /// A lossily-decoded name is not the byte string git holds, so `find_branch`
  /// cannot locate it and two different invalid names can flatten to the same
  /// replacement character. Listing the row is the fix for it being invisible;
  /// leaving its buttons live would have replaced a hidden branch with a
  /// delete that might hit the wrong one.
  const rowBlocked = (b: GitBranchInfo): string | null =>
    b.lossyName
      ? "This branch's name is not valid UTF-8 — use the command line to work with it"
      : blocked();

  const rowProps = (row: { branch: GitBranchInfo; ranges: MatchRange[] }) => ({
    branch: row.branch,
    ranges: row.ranges,
    blockedReason: rowBlocked(row.branch),
    busy: busy(),
    onCheckout: () => void checkout(row.branch.name),
    onRename: () => void renameBranch(row.branch.name),
    onDelete: () => void deleteBranch(row.branch.name, row.branch.symbolicTarget),
    onMenu: (e: MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, branch: row.branch.name });
    },
  });

  return (
    <div class="p-2 space-y-1">
      <div class="flex items-center gap-1">
        <input
          type="text"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter branches…"
          class="flex-1 min-w-0 px-2 py-1 text-body bg-muted/50 border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
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
        <p class="text-body text-destructive px-1">{error()}</p>
      </Show>
      {/* Without this the pane just loses its highlight: no row is marked, and
          the missing highlight reads as a bug rather than as "you are not on a
          branch". It also explains why every row, including the one you came
          from, now offers delete. */}
      <Show when={props.detached}>
        <p class="text-label text-warning px-1 py-1 rounded bg-warning/10 border border-warning/20">
          HEAD is detached — no branch is checked out. Check one out to resume
          normal work.
        </p>
      </Show>
      {/* Three states this pane never had: while the first load is in flight,
          when the fetch failed, and when the repository genuinely has no
          branches, it rendered *nothing at all* — a blank rectangle that reads
          as a broken panel rather than as any of the three facts. */}
      <Show when={!branches.loading || settled()}>
        <Show when={!branches.error}>
          <Show when={(settled()?.length ?? 0) === 0}>
            <p class="text-label text-muted-foreground px-1 py-2">
              No branches yet — the first commit creates one.
            </p>
          </Show>
        </Show>
      </Show>
      <Show when={branches.loading && !settled()}>
        <p class="text-label text-muted-foreground px-1 py-2">Loading branches…</p>
      </Show>
      <Show when={branches.error}>
        <div class="px-1 py-2 space-y-1">
          <p class="text-label text-destructive">Could not list branches.</p>
          <p class="text-label font-mono text-muted-foreground break-words">
            {branches.error instanceof Error
              ? branches.error.message
              : String(branches.error)}
          </p>
          <button
            onClick={() => void refetch()}
            class="text-label px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            Try again
          </button>
        </div>
      </Show>
      {/* Grouped, because local and remote rows are different kinds of thing:
          one you check out and delete, the other you can only read. They used
          to interleave through a single sort, so in any real clone the handful
          of branches you work on were scattered through a hundred you don't. */}
      <Show when={filtered().some((r) => !r.branch.isRemote)}>
        <SectionLabel class="!bg-transparent">
          Local ({localCount()})
        </SectionLabel>
      </Show>
      <For each={filtered().filter((r) => !r.branch.isRemote)}>
        {(row) => <BranchRow {...rowProps(row)} />}
      </For>

      <Show when={remoteCount() > 0}>
        <button
          onClick={() => setShowRemotes((v) => !v)}
          aria-expanded={showRemotes()}
          class="w-full flex items-center gap-1 px-2 py-1 ui-section-label text-muted-foreground hover:text-foreground transition-colors"
        >
          <Show when={showRemotes()} fallback={<ChevronRight class="w-3 h-3" />}>
            <ChevronDown class="w-3 h-3" />
          </Show>
          Remote ({remoteCount()})
        </button>
      </Show>
      <For each={filtered().filter((r) => r.branch.isRemote)}>
        {(row) => <BranchRow {...rowProps(row)} />}
      </For>

      <Show when={(settled()?.length ?? 0) > 0 && filtered().length === 0}>
        <p class="text-label text-muted-foreground px-1 py-1">
          {showRemotes() || remoteCount() === 0
            ? "No matches."
            : `No matches among the local branches — ${remoteCount()} remote branch(es) are hidden.`}
        </p>
      </Show>

      <Show when={props.showTags !== false}>
        <TagsPane repoPath={props.repoPath} />
      </Show>

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

/// How long ago, in the shortest form that is still true.
///
/// `lastCommitTime` and `lastCommitSummary` were computed for every branch —
/// one `find_commit` each, on every pulse — and then never rendered anywhere.
/// The pane paid for them and showed a bare list of names, which is the one
/// question a branch list cannot answer on its own: *which of these is stale?*
export function relativeAge(seconds: number, now = Date.now()): string {
  const delta = Math.round(now / 1000) - seconds;
  // A commit stamped in the future is a real thing — a colleague's clock, a
  // rebase with a fixed date — and "in 3 hours" reads as a bug, so it clamps.
  if (delta < 60) return "just now";
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/// What a row's ahead/behind chip is claiming, spelled out.
///
/// Exported for its test. `↑2 ↓0` on `origin/feat` is ambiguous to anyone who
/// has not been told what the other side is — the remote's own upstream? the
/// default branch? — and the answer, "your local `feat`", is not guessable from
/// the row. The local row got the same treatment for free: it never said what
/// it was counting against either, it was just easier to assume.
export function comparisonLabel(name: string, isRemote: boolean, ab: AheadBehind): string {
  // "local feat" rather than "feat", because on a remote row the bare name
  // reads as another ref on the remote.
  const other = isRemote ? `local ${ab.against}` : ab.against;
  return `${name} is ${ab.ahead} ahead of and ${ab.behind} behind ${other}`;
}

/// One branch. Extracted so `<For>` renders a component rather than a closure
/// over the pane's whole scope, which is what makes the stable-identity keying
/// in `BranchesPane` worth anything: an untouched row's DOM survives a pulse.
function BranchRow(props: {
  branch: GitBranchInfo;
  ranges: MatchRange[];
  /// Why every mutation on this row is unavailable, or null.
  blockedReason: string | null;
  busy: boolean;
  onCheckout: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  const b = () => props.branch;
  const locked = () => props.busy || props.blockedReason !== null;
  const subtitle = () => {
    const parts: string[] = [];
    if (b().lastCommitSummary) parts.push(b().lastCommitSummary!);
    if (b().lastCommitTime !== null) parts.push(relativeAge(b().lastCommitTime!));
    return parts.join(" · ");
  };

  return (
    <div
      onContextMenu={props.onMenu}
      class={`group flex flex-col rounded-md px-2 py-0.5 text-ui transition-colors ${
        b().isHead ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent/40"
      }`}
    >
      <div class="flex items-center gap-2">
        <button
          onClick={props.onCheckout}
          disabled={b().isHead || locked()}
          aria-label={b().isHead ? `${b().name} (current branch)` : `Checkout ${b().name}`}
          title={
            props.blockedReason ??
            (b().isHead
              ? `${b().name} is the current branch`
              : b().symbolicTarget
                ? `${b().name} is an alias for ${b().symbolicTarget}`
                : b().isRemote
                  ? `Check out ${b().name} (creates a local branch tracking it)`
                  : `Checkout ${b().name}`)
          }
          class="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-foreground disabled:cursor-default disabled:hover:text-primary"
        >
          <GitBranch class="w-3 h-3 shrink-0" />
          <span class="truncate flex-1">
            <FuzzyText text={b().name} ranges={props.ranges} />
          </span>
        </button>
        {/* Without a label a remote row renders identically to a local branch —
            two very different facts drawn the same way, and only one of them is
            something you can check out, rename or delete. */}
        <Show when={b().isRemote}>
          <span
            class="shrink-0 px-1 rounded text-micro uppercase tracking-wide bg-muted/60 text-muted-foreground/80"
            title="A remote-tracking branch. Its ahead/behind is counted against the local branch of the same name."
          >
            remote
          </span>
        </Show>
        {/* An alias, not a branch — see `symbolicTarget`. */}
        <Show when={b().symbolicTarget}>
          {(target) => (
            <span
              class="shrink-0 text-micro text-muted-foreground/80 truncate max-w-[40%]"
              title={`Symbolic ref pointing at ${target()}`}
            >
              → {target()}
            </span>
          )}
        </Show>
        <Show when={b().lossyName}>
          <span class="shrink-0 text-warning" title={props.blockedReason ?? ""}>
            ⚠
          </span>
        </Show>
        {/* CMP-F22. `aheadBehind` is null when there was nothing to compare
            against — a remote-tracking branch nobody has a local copy of, or a
            local branch with no upstream — and that row shows no chip at all.
            A measured `↑0 ↓0` is a different answer and must still render, so
            the presence of the object, not the value of the numbers, is what
            decides.

            A local row keeps hiding a zero side: `main` in sync has always
            drawn nothing, and turning every quiet local branch into `↑0 ↓0`
            would be noise in the list's common case. A remote row shows both
            sides, because there the zero is the answer — "you have pulled
            everything" is exactly what someone opens this disclosure to learn,
            and it cannot be told from "not compared" by absence alone. */}
        <Show when={b().aheadBehind}>
          {(ab) => (
            <Show when={b().isRemote || ab().ahead > 0 || ab().behind > 0}>
              <span
                class="shrink-0 flex items-center gap-1"
                title={comparisonLabel(b().name, b().isRemote, ab())}
                aria-label={comparisonLabel(b().name, b().isRemote, ab())}
              >
                <Show when={b().isRemote || ab().ahead > 0}>
                  <span class="text-success tabular-nums">↑{ab().ahead}</span>
                </Show>
                <Show when={b().isRemote || ab().behind > 0}>
                  <span class="text-destructive tabular-nums">↓{ab().behind}</span>
                </Show>
              </span>
            </Show>
          )}
        </Show>
        <Show when={b().aheadBehindUnknown}>
          <span
            class="text-muted-foreground/70"
            title="Ahead/behind could not be computed for this branch (shallow clone?)"
          >
            ?
          </span>
        </Show>
        <Show when={b().isHead}>
          <span class="text-body tracking-wide text-primary/80">HEAD</span>
        </Show>
        <Show when={!b().isRemote}>
          <button
            onClick={props.onRename}
            disabled={locked()}
            title={props.blockedReason ?? "Rename branch"}
            aria-label={`Rename ${b().name}`}
            class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent/50 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40"
          >
            <Pencil class="w-3 h-3" />
          </button>
          <Show when={!b().isHead}>
            <button
              onClick={props.onDelete}
              disabled={locked()}
              title={props.blockedReason ?? "Delete branch"}
              aria-label={`Delete ${b().name}`}
              class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40"
            >
              <X class="w-3 h-3" />
            </button>
          </Show>
        </Show>
      </div>
      {/* The subtitle the backend was already paying for. Which branch is stale
          is the question a bare list of names cannot answer. */}
      <Show when={subtitle()}>
        <div class="pl-5 truncate text-label text-muted-foreground/70" title={subtitle()}>
          {subtitle()}
        </div>
      </Show>
      <Show when={b().upstream}>
        {(up) => (
          <div class="pl-5 truncate text-micro text-muted-foreground/60" title={`Tracking ${up()}`}>
            ⇅ {up()}
          </div>
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

  /// The repository this pane is actually showing, straight from git: the
  /// listing's main entry. Authoritative in a way the layout store is not —
  /// the standalone git window's store is a stale private copy.
  const shownRepoRoot = () =>
    (worktrees() ?? []).find((wt) => wt.isMain && !wt.isBare)?.path ?? props.repoPath;

  function addWorktree() {
    const ws = activeWorkspace();
    if (!ws?.repoRoot) {
      pushToast("Open a folder in this workspace first", "warning");
      return;
    }
    requestNewWorktree({
      workspaceId: ws.id,
      // The repo this pane is *showing*, not the one the local store happens
      // to remember. In the standalone git window that store is hydrated from
      // localStorage when the window opens and never updated by the context
      // broadcast, so after switching the workbench to another workspace the
      // panes followed — and this added the worktree to the previous
      // repository while copying env files from the current one.
      repoRoot: shownRepoRoot(),
      sourcePath: props.repoPath,
    });
  }

  /// Focus a worktree in the rail. It is registered on demand so a worktree
  /// created outside voidlink (plain `git worktree add`) still opens without
  /// waiting for the next hydration pass.
  function openWorktree(path: string, branch: string | null) {
    // In the standalone git window there is no rail and the store is a
    // private, unpersisted copy — selecting a worktree there changed state
    // nobody renders, so this button did nothing at all. Forward it, exactly
    // as `requestNewWorktree` already does for the wizard.
    if (isGitWindow()) {
      void requestOpenWorktreeOnMain({ path, branch });
      return;
    }
    const ws = activeWorkspace();
    if (!ws) return;
    const existing = ws.worktrees.find((wt) => samePath(wt.path, path));
    const id = existing?.id ?? actions.addWorktree(ws.id, { path, branch });
    if (id) actions.selectWorktree(id);
  }

  /// Clear a worktree's lock. Reachable only on a locked row, because that is
  /// the only place it means anything — and before this there was no way to
  /// clear a lock from inside the app at all: `remove` refuses, `--force`
  /// refuses too, and the user had to go to the CLI.
  async function unlock(path: string, label: string) {
    await run(async () => {
      try {
        await gitApi.unlockWorktree(props.repoPath, path);
        pushToast(`Unlocked worktree ${label}`, "info", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  /// Confirm, remove, pulse — all of it in `commands/worktreeRemove`, which
  /// the rail and the palette now share. This pane had the only correct
  /// version of the flow; the fix was to stop it being the only one.
  async function remove(path: string, label: string) {
    await run(() => removeWorktreeWithConfirm({ repoRoot: props.repoPath, path, label }));
  }

  return (
    <div class="p-1">
      <button
        onClick={() => void addWorktree()}
        class="w-full flex items-center justify-center gap-1.5 px-2 py-1 mb-1 rounded-md text-body text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-accent/50 transition-colors"
      >
        <Plus class="w-3 h-3" /> New worktree
      </button>
      {/* "Only the main worktree" rather than "no worktrees": a repository
          always has one, so a list showing a single entry means the user has
          not branched out yet.

          Gated on `worktrees()` having actually arrived, and rendered as the
          list's *fallback* rather than beside it: `?? 0` used to make the claim
          during the first load, so a repo with six worktrees flashed "only the
          main worktree exists" and then filled in. And bare entries are
          excluded from the count — a bare repository is not a working tree, so
          counting it suppressed this empty state in a repo that has none. */}
      <Show when={(worktrees() ?? []).filter((wt) => !wt.isBare).length <= 1 && !!worktrees()}>
        <EmptyState
          id="worktreesSingle"
          action={
            <EmptyStateAction onClick={() => void addWorktree()}>
              Create a worktree
            </EmptyStateAction>
          }
        />
      </Show>
      <For each={(worktrees() ?? []).filter((wt) => !wt.isBare)}>
        {(wt) => {
          const label = () => wt.branch ?? (wt.isDetached ? "(detached)" : wt.path);
          return (
            <div
              class={`group w-full flex items-center gap-2 rounded-md px-2 density-row text-ui hover:bg-accent/30 ${
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
              {/* Its directory is gone. Without this the row read as an
                  ordinary worktree, and "open" registered a workspace pointing
                  at nothing — where every terminal spawned there fails. */}
              <Show when={wt.isPrunable}>
                <span
                  class="text-destructive shrink-0 text-micro font-mono"
                  title={
                    wt.prunableReason
                      ? `git would prune this worktree: ${wt.prunableReason}`
                      : "This worktree's directory is gone — git would prune it"
                  }
                  aria-label="missing"
                >
                  missing
                </span>
              </Show>
              <Show when={wt.isLocked}>
                <button
                  onClick={() => void unlock(wt.path, label())}
                  disabled={busy()}
                  title="This worktree is locked — click to unlock it"
                  aria-label={`Unlock worktree ${label()}`}
                  class="p-0.5 rounded shrink-0 text-muted-foreground/70 hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Lock class="w-3 h-3" />
                </button>
              </Show>
              <Show when={wt.isMain}>
                <span class="text-micro tracking-wide text-primary/70">Main</span>
              </Show>
              <Show when={!wt.isMain}>
                <button
                  onClick={() => openWorktree(wt.path, wt.branch)}
                  disabled={wt.isPrunable}
                  title={
                    wt.isPrunable
                      ? "This worktree's directory no longer exists"
                      : "Open this worktree"
                  }
                  aria-label={`Open worktree ${label()}`}
                  class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent/50 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <FolderOpen class="w-3 h-3" />
                </button>
                <button
                  onClick={() => void remove(wt.path, label())}
                  disabled={busy()}
                  title="Remove worktree"
                  aria-label={`Remove worktree ${label()}`}
                  class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40 disabled:cursor-not-allowed"
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
        <span class="flex-1 tracking-wide text-micro text-muted-foreground font-semibold">
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
          <div class="group flex items-center gap-2 rounded-md px-2 density-row text-ui text-muted-foreground hover:bg-accent/30">
            <Tag class="w-3 h-3 shrink-0 opacity-70" />
            <span class="truncate flex-1" title={t}>{t}</span>
            <button
              onClick={() => void pushTag(t)}
              disabled={busy()}
              title="Push tag to origin"
              aria-label={`Push tag ${t}`}
              class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent/50 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out"
            >
              <Upload class="w-3 h-3" />
            </button>
            <button
              onClick={() => void deleteTag(t)}
              disabled={busy()}
              title="Delete tag"
              aria-label={`Delete tag ${t}`}
              class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out"
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
  /// Applying a stash is a merge, so it can stop on conflicts — and when it
  /// did, this pane showed libgit2's raw message in a red toast and left the
  /// user in a conflicted working tree with nothing to click. Pull, merge and
  /// rebase all route `conflicted` into the merge editor; stash now does the
  /// same, through the same shape.
  async function apply(entry: StashEntry, pop: boolean) {
    const label = pop ? "Pop" : "Apply";
    await run(async () => {
      try {
        const res = pop
          ? await gitApi.stashPop(props.repoPath, entry.index, entry.oid)
          : await gitApi.stashApply(props.repoPath, entry.index, entry.oid);
        if (res.conflicted) {
          const conflicts = await gitApi.listConflicts(props.repoPath);
          await Promise.all(
            conflicts.map((c) => openMerge(actions, props.worktreeId, `${props.repoPath}/${c}`)),
          );
          pushToast(
            pop
              ? "Pop stopped on conflicts — the stash is still there. Resolve them, then drop it."
              : "Apply stopped on conflicts — resolve them, then continue.",
            "warning",
            7000,
          );
        } else if (res.ok) {
          pushToast(pop ? "Popped stash" : "Applied stash", "success", 2500);
        } else {
          pushToast(res.message || `${label} failed`, "error", 6000);
        }
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  /// Confirm inside the gate, not before it.
  ///
  /// The confirm used to be awaited outside `run()`, so `busy()` stayed false
  /// for as long as the dialog was up and every apply/pop/drop button in the
  /// pane stayed live underneath it. That matters more here than anywhere else
  /// in the sidebar: every one of those buttons *shifts the stack*, so the
  /// answer the user is about to give is about a stash that may have moved by
  /// the time they give it. `verify_stash_oid` catches the result and errors
  /// rather than dropping the wrong stash, but the honest fix is not to let the
  /// window open. Tauri's native modal made this hard to hit, not impossible.
  async function drop(entry: StashEntry) {
    await run(async () => {
      const ok = await dialogConfirm(`Drop stash "${entry.message}"? This cannot be undone.`, {
        title: "Drop stash",
        kind: "warning",
      });
      if (!ok) return;
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

  /// Open the stash's diff addressed by **oid**, not by position.
  ///
  /// Reading is the one stash action that had no oid guard, and it was the one
  /// that needed it most: a compare tab stores its two refs and re-resolves
  /// them on every pulse, so `stash@{1}^1..stash@{1}` was not a snapshot of a
  /// stash — it was a live pointer at whatever sits at position 1 now. Stash
  /// something new, or drop the one below it, and an open diff silently starts
  /// describing a different stash, with no way to notice and no way for it to
  /// correct itself. A commit oid is the stash's only stable identity, so we
  /// use it; the tab keeps the position and message as its *label*, which is a
  /// snapshot of what was clicked and is allowed to go stale.
  function showDiff(entry: StashEntry) {
    actions.openCompareTab(props.worktreeId, {
      baseRef: `${entry.oid}^1`,
      headRef: entry.oid,
      useMergeBase: false,
      label: `stash@{${entry.index}} ${entry.message}`,
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
            <div class="group flex items-center gap-2 rounded-md px-2 density-row text-ui text-muted-foreground hover:bg-accent/30">
              <Archive class="w-3 h-3 shrink-0 opacity-70" />
              <button
                onClick={() => showDiff(s)}
                class="truncate flex-1 text-left hover:text-foreground"
                title={`Show diff for ${s.message}`}
              >
                <span class="text-micro text-muted-foreground/70 tabular-nums mr-1">{`{${s.index}}`}</span>
                {s.message}
              </button>
              <button
                onClick={() => void apply(s, false)}
                disabled={busy()}
                title="Apply (keep stash)"
                aria-label="Apply stash"
                class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent/50 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus class="w-3 h-3" />
              </button>
              <button
                onClick={() => void apply(s, true)}
                disabled={busy()}
                title="Pop (apply and remove)"
                aria-label="Pop stash"
                class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-accent/50 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowDownToLine class="w-3 h-3" />
              </button>
              <button
                onClick={() => void drop(s)}
                disabled={busy()}
                title="Drop stash"
                aria-label="Drop stash"
                class="p-0.5 rounded opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-[opacity,background-color,color] duration-[var(--dur-tint)] ease-out disabled:opacity-40 disabled:cursor-not-allowed"
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

export function RemotesDialog(props: { repoPath: string; open: boolean; onClose: () => void }) {
  const { busy, run } = createInFlight();
  const [remotes, { refetch }] = createResource(
    () => (props.open ? props.repoPath : null),
    (p) => gitApi.listRemotes(p),
  );

  // A remote added from the other window, from a terminal, or by the wizard did
  // not show up in an open dialog — which is the one place in the app whose
  // entire job is telling you which remotes exist. Every mutation in here emits
  // the pulse already; nothing was listening for anyone else's.
  onMount(() => onCleanup(onGitRefsChanged(() => props.open && refetch())));

  /// The remote as it exists *now*, or null.
  ///
  /// Every action here awaits a prompt outside the in-flight gate — deliberately,
  /// since holding it across a modal freezes every other button — so a pulse can
  /// land while the dialog is up and the `RemoteInfo` captured at click time can
  /// name a remote that has since been renamed or removed. Re-reading the list
  /// before mutating is what keeps "Set URL for origin" from writing to whatever
  /// happens to be called origin a minute later.
  const stillThere = (r: RemoteInfo): RemoteInfo | null =>
    (remotes() ?? []).find((x) => x.name === r.name) ?? null;

  function goneToast(name: string) {
    pushToast(`Remote "${name}" is no longer configured — nothing was changed.`, "warning", 5000);
    refetch();
  }

  async function addRemote() {
    const rawName = await textPrompt({ title: "Add remote", label: "Remote name", placeholder: "origin", confirmLabel: "Next" });
    if (!rawName) return;
    // Trimmed before it reaches libgit2, which would otherwise answer `" origin"`
    // with a raw "is not a valid remote name" naming a string the user did not
    // knowingly type.
    const name = normalizeRemoteName(rawName);
    if (!isValidRemoteName(name)) {
      pushToast(
        `"${rawName}" is not a valid remote name — no spaces or slashes.`,
        "error",
        5000,
      );
      return;
    }
    const rawUrl = await textPrompt({ title: "Add remote", label: `URL for ${name}`, placeholder: "git@github.com:user/repo.git", confirmLabel: "Add" });
    if (!rawUrl) return;
    const url = rawUrl.trim();
    // libgit2 accepts *any* string as a URL, so without this a typo produced a
    // remote that looked entirely normal here and failed later with an error
    // about the network rather than about the typo.
    if (!isValidRemoteUrl(url)) {
      pushToast(
        `"${url}" doesn't look like a git URL. Expected something like git@host:user/repo.git or https://host/user/repo.git`,
        "error",
        7000,
      );
      return;
    }
    await run(async () => {
      try {
        await gitApi.addRemote(props.repoPath, name, url);
        pushToast(`Added remote ${name}`, "success", 2500);
        // Fetch it, or adding a remote produces no visible change at all: its
        // branches only exist locally once they have been fetched, and nothing
        // else in the app would ever fetch this one on its own.
        try {
          await gitApi.fetch(props.repoPath, name);
        } catch (e) {
          pushToast(
            `Added ${name}, but fetching it failed: ${e instanceof Error ? e.message : String(e)}`,
            "warning",
            7000,
          );
        }
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
    const raw = await textPrompt({ title: "Set remote URL", label: r.name, initialValue: r.url ?? "", confirmLabel: "Save" });
    if (!raw) return;
    const url = raw.trim();
    if (!isValidRemoteUrl(url)) {
      pushToast(
        `"${url}" doesn't look like a git URL. Expected something like git@host:user/repo.git or https://host/user/repo.git`,
        "error",
        7000,
      );
      return;
    }
    if (!stillThere(r)) return goneToast(r.name);
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
    if (!stillThere(r)) return goneToast(r.name);
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
    // Says what it actually does. `remote_delete` also deletes every
    // `refs/remotes/<name>/*` **and** every `branch.*.remote`/`.merge` config
    // entry pointing at it — so afterwards every branch that tracked this
    // remote silently loses its upstream, ahead/behind goes blank, and Pull
    // starts answering "No upstream is set". The old one-line confirm warned
    // about none of that.
    const ok = await dialogConfirm(
      `Remove remote "${r.name}"?\n\nIts remote-tracking branches are deleted, and every local branch tracking it loses its upstream — ahead/behind goes blank and Pull stops working for them until you set one again.`,
      { title: "Remove remote", kind: "warning" },
    );
    if (!ok) return;
    if (!stillThere(r)) return goneToast(r.name);
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
              <h2 class="text-title font-semibold flex-1">Remotes</h2>
              <button onClick={() => void addRemote()} disabled={busy()} class="flex items-center gap-1 px-2 py-1 rounded text-body bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Plus class="w-3 h-3" /> Add
              </button>
            </div>
            <Show when={(remotes()?.length ?? 0) > 0} fallback={<p class="text-body text-muted-foreground py-2">No remotes configured.</p>}>
              <div class="space-y-1.5">
                <For each={remotes() ?? []}>
                  {(r) => (
                    <div class="group flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-body">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-foreground">{r.name}</div>
                        <div class="truncate text-muted-foreground font-mono text-label" title={r.url ?? ""}>{r.url ?? "—"}</div>
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
              <button onClick={props.onClose} class="px-3 py-1.5 rounded text-body text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors">Close</button>
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
        class="fixed z-[var(--z-menu)] bg-popover border border-border rounded-lg shadow-xl p-3 text-body max-w-xs pointer-events-none"
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
      >
        <div class="font-mono text-muted-foreground mb-1 text-micro tracking-wide">{props.commit.oid.slice(0, 12)}</div>
        <div class="font-medium text-foreground mb-1.5 leading-snug">{props.commit.summary}</div>
        <Show when={props.commit.body}>
          {(body) => (
            <div class="text-muted-foreground mb-2 whitespace-pre-wrap text-label leading-relaxed line-clamp-4">{body()}</div>
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

  const [hoveredCommit, setHoveredCommit] = createSignal<GitCommitInfo | null>(null);
  const [hoverPos, setHoverPos] = createSignal({ x: 0, y: 0 });
  const [menu, setMenu] = createSignal<{ x: number; y: number; commit: GitCommitInfo } | null>(null);

  function openCommitCompare(c: GitCommitInfo) {
    actions.openCompareTab(props.worktreeId, {
      baseRef: commitDiffBase(c.parentOids),
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
        <p class="px-2 py-1.5 text-label text-destructive" title={logError()}>
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
              <div class="flex-1 min-w-0 px-2 py-1.5 text-ui flex flex-col justify-center">
                <div class="flex items-center gap-2 h-[18px]">
                  <span class="font-mono text-muted-foreground text-body tabular-nums shrink-0">
                    {row.commit.oid.slice(0, 7)}
                  </span>
                  <span class="truncate flex-1 text-foreground">{row.commit.summary}</span>
                </div>
                <div class="text-body leading-4 text-muted-foreground/80 truncate tabular-nums">
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
          <div class="px-2.5 py-3 text-ui text-muted-foreground">
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
                  class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left text-ui cursor-pointer focus-visible:outline-none"
                >
                  <GitCompare class="w-3.5 h-3.5 shrink-0 text-info" />
                  <span class="flex-1 min-w-0 truncate">
                    <span class="text-muted-foreground text-label">diff · </span>{fileName()}
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
  /// A `ChangeRow.key`, not a path — the same file can be a row in both this
  /// list and the other one.
  focusKey: string | null;
  /// Which diff is open in the editor window: a path *and* which side of it,
  /// because staged and unstaged diffs of one file are two different tabs.
  selectedFile: { path: string; staged: boolean } | null;
  rowId: (key: string) => string;
  onFocusRow: (key: string) => void;
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
    const key = props.focusKey;
    if (!key) return;
    const idx = props.rows.findIndex((r) => r.key === key);
    if (idx === -1) return;
    if (props.rows.length > VIRTUALIZE_ABOVE) virtualizer.scrollToIndex(idx);
    else scrollRef?.querySelector(`#${CSS.escape(props.rowId(key))}`)?.scrollIntoView({ block: "nearest" });
  });

  const row = (r: ChangeRow) => (
    <FileRow
      id={props.rowId(r.key)}
      file={r.entry.path}
      ranges={r.ranges}
      status={r.entry.status}
      // A path that survived a lossy UTF-8 conversion is not the byte string
      // git holds, so every command that takes one would fail on it. Listing
      // the row fixes the file being invisible; leaving its buttons live would
      // trade that for three buttons that error.
      unactionable={r.entry.lossyPath ? "This path is not valid UTF-8 — use the command line for this file" : undefined}
      // Both halves of the path *and* the side: highlighting on path alone lit
      // the staged and unstaged rows of one file together, saying two tabs were
      // open when one was.
      selected={
        props.selectedFile?.path === r.entry.path &&
        props.selectedFile.staged === (r.section === "staged")
      }
      cursor={props.focusKey === r.key}
      onSelect={() => {
        props.onFocusRow(r.key);
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
  /// Why no action on this row can run, or undefined. See `GitFileStatus.lossyPath`.
  unactionable?: string;
}) {
  const Icon = props.actionIcon;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={!!props.cursor}
      // `h-6` rather than `density-row`: this row is the virtualizer's
      // `estimateSize`, and a height that moves with a setting desyncs it.
      class={`group flex items-center h-6 text-body transition-colors focus-within:bg-accent/40 ${
        props.selected ? "bg-accent/70 text-foreground" : "hover:bg-accent/40"
      } ${props.cursor ? "ring-1 ring-inset ring-ring" : ""}`}
    >
      <button
        onClick={props.onSelect}
        disabled={!!props.unactionable}
        title={props.unactionable}
        aria-label={`Open diff for ${props.file}`}
        aria-pressed={props.selected}
        class="flex-1 flex items-center gap-1.5 pl-2.5 h-full min-w-0 text-left cursor-pointer focus-visible:outline-none disabled:cursor-default"
      >
        <StatusBadge status={props.status} />
        <span class="flex-1 truncate">
          <FuzzyText text={props.file} ranges={props.ranges ?? []} />
        </span>
        <Show when={props.unactionable}>
          <span class="shrink-0 pr-1 text-warning" title={props.unactionable}>
            ⚠
          </span>
        </Show>
      </button>
      <Show when={props.secondaryIcon}>
        {(SecondaryIcon) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onSecondary?.();
            }}
            disabled={!!props.unactionable}
            aria-label={`${props.secondaryTitle} ${props.file}`}
            title={props.unactionable ?? props.secondaryTitle}
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
        disabled={!!props.unactionable}
        aria-label={`${props.actionTitle} ${props.file}`}
        title={props.unactionable ?? props.actionTitle}
        class="p-0.5 mr-2 rounded opacity-60 group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100 disabled:opacity-30"
      >
        <Icon class="w-3 h-3 text-muted-foreground" />
      </button>
    </div>
  );
}

/** Collapsed rail */
export function GitSidebarCollapsed(props: { onExpand: () => void }) {
  const { state } = useAppStore();
  return (
    <div class="flex flex-col items-center w-8 bg-sidebar py-2 gap-2 h-full relative">
      {/* The handle survives the collapse, disabled and saying why — the
          arrangement `TerminalSidebar` already had and this rail did not. A
          splitter that disappears with its panel leaves the user no evidence
          the column is resizable at all, and §7.6 asks a disabled control to
          state its reason rather than simply stop responding.

          `value` is the pre-collapse width, not the rail's 8 units: the rail is
          a render-time width that is never written to the store, which is what
          makes expanding come back to the width the user dragged to. */}
      <Splitter
        side="start"
        label="Git sidebar width"
        value={state.panels.gitSidebar}
        min={PANEL_BOUNDS.gitSidebar.min}
        max={PANEL_BOUNDS.gitSidebar.max}
        defaultValue={PANEL_BOUNDS.gitSidebar.default}
        disabledReason="The git panel is collapsed — expand it to resize"
        onResize={() => {}}
      />
      <button
        onClick={props.onExpand}
        aria-label="Expand git panel"
        // The counterpart of the collapse button in the expanded header, and it
        // has to make the same claim in the same vocabulary — `FilesRail` sets
        // this too, for the same pair.
        aria-expanded={false}
        class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        title="Expand git panel"
      >
        <ChevronLeft class="w-3.5 h-3.5" />
      </button>
      <GitBranch class="w-4 h-4 text-muted-foreground" />
    </div>
  );
}
