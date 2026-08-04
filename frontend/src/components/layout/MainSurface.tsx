import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  TerminalSquare,
  GitBranchPlus,
  Layers,
  Plus,
  FilePlus2,
  GitCommitHorizontal,
  Brain,
  History as TimelineIcon,
  Layers as CombinedIcon,
  Radar as MissionIcon,
  Globe,
  Bot,
} from "lucide-solid";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { CompareTab as CompareTabView } from "@/components/git/compare/CompareTab";
import { StackTab as StackTabView } from "@/components/git/stack/StackTab";
import { CommitGraph } from "@/components/git/history/CommitGraph";
import { CombinedDiffView } from "@/components/git/shared/CombinedDiffView";
import { GitErrorBoundary } from "@/components/git/GitErrorBoundary";
import { commitDiffBase, resolveCommitDiffBase } from "@/commands/commitDiff";
import { TimelineSurface } from "@/components/timeline/TimelineSurface";
import { MissionSurface } from "@/components/mission/MissionSurface";
import { BrowserPane, browserTabLabel, normalizeUrl } from "@/components/browser/BrowserPane";
import { AgentThreadView } from "@/components/agent/AgentThreadView";
import { agentThread, dropAgentThread } from "@/commands/agent";
import { agentById, defaultAgentId, useSettings } from "@/store/settings";
import {
  MenuItem,
  PaneDropOverlay,
  TabStrip,
  VERTICAL_TAB_WIDTH,
  type TabDescriptor,
  type TabDragPayload,
} from "@/components/layout/TabStrip";
import { Splitter, islandGapPx } from "@/components/layout/Splitter";
import { EmptyState, EmptyStateAction } from "@/components/layout/EmptyState";
import { ratiosAfterDrag, resolveActiveTabId, type Rect } from "@/components/layout/paneDrop";
import { isZen, visibleGroupIds } from "@/store/focusMode";
import {
  clearTabActivity,
  escalate,
  noteBell,
  noteFinished,
  isWindowFocused,
  publishHiddenActivity,
  publishHiddenWorktreeActivity,
  publishViewActivity,
  publishWorktreeActivity,
  setVisibleTabs,
  signalsOf,
  tabMark,
  tabSignals,
  trackWindowFocus,
} from "@/store/activity";
import { currentStackedView } from "@/commands/environment";
import { notifyApi } from "@/api/notify";
import { notifyTerminal } from "@/commands/terminalNotify";
import { watchTerminal } from "@/store/terminalWatch";
import type { ActivitySignal } from "@/components/layout/StatusLed";
import {
  MIN_RATIO,
  canSplit,
  groupList,
  resolveGroupTabs,
  type PaneNode,
  type SplitOrientation,
} from "@/store/layout";
import { useAppStore } from "@/store/LayoutContext";
import { fsApi } from "@/api/fs";
import { gitApi } from "@/api/git";
import { recordBranchUse } from "@/commands/branchMru";
import { pushToast } from "@/commands/toast";
import { openBrain } from "@/commands/registry";

interface MainSurfaceProps {
  /// Hand a file to the editor window. The workbench has no editor of its own
  /// any more, so every path that used to open a Monaco tab — a terminal
  /// deep-link, a new file from the "+" menu — routes through here.
  onOpenFile: (path: string, line?: number, column?: number) => void;
  /// Open Settings → AI. An agent pane with no configured CLI has to be able to
  /// send the user somewhere; the pane body is not allowed to reach for the
  /// settings dialog itself.
  onOpenSettings: () => void;
}

/// The workbench's tab surface: terminals, branch compares, stacks, the commit
/// graph and the embedded browser.
///
/// Files, diffs, merges and markdown previews used to live here too. They moved
/// to the editor window (`EditorApp.tsx`), which is why this component no longer
/// touches Monaco and why the tab strip it renders is the shared one in
/// `TabStrip.tsx` rather than a bespoke row.
///
/// ## Why the panes are not inside their groups
///
/// The surface renders in two layers. The split tree (`renderNode`) draws the
/// strips and an *empty* body box per group; every tab's actual content lives
/// in one flat layer above it, absolutely positioned over its group's measured
/// rectangle.
///
/// The obvious alternative — render each pane inside the group that owns it —
/// costs a DOM reparent every time a tab moves between groups, and a reparent
/// is a remount: xterm loses its scrollback and a `BrowserPane` tears down and
/// re-creates its child webview. Dragging a terminal into the pane beside it
/// would wipe the output you dragged it there to read. So the pane list stays
/// flat and stable, and only its `left/top/width/height` change.
///
/// It also makes the single-group case free: one group's body *is* the whole
/// content area, so the rectangle every pane gets is the one it had before
/// there were groups at all.
export function MainSurface(props: MainSurfaceProps) {
  const {
    state,
    activeRepoPath,
    activeTerminals,
    activeCompareTabs,
    activeStackTabs,
    activeHistoryTabs,
    activeTimelineTabs,
    activeCombinedTabs,
    activeMissionTabs,
    activeBrowserTabs,
    activeAgentTabs,
    activeItem,
    activePinnedTabs,
    workbenchTabIds,
    paneLayout,
    focusedGroupId,
    actions,
  } = useAppStore();
  const { settings } = useSettings();

  const isPinned = (id: string) => activePinnedTabs().includes(id);

  const hasAnyTab = () => tabs().length > 0;

  const repoRoot = () => activeRepoPath() ?? null;

  // ── Tab descriptors ──────────────────────────────────────────────────────
  // Flattened for the shared strip. Order here is render order there.

  /// SHAs read as noise in tab labels; show the short form.
  const short = (r: string) => (/^[0-9a-f]{12,40}$/i.test(r) ? r.slice(0, 7) : r);

  const tabs = createMemo<TabDescriptor[]>(() => {
    const out: TabDescriptor[] = [];
    for (const term of activeTerminals()) {
      out.push({
        kind: "terminal",
        id: term.id,
        label: term.label,
        icon: <TerminalSquare class="w-3.5 h-3.5 shrink-0" />,
        // A session restore recreates the tab against a *fresh* PTY. The pane
        // is empty because the shell is new, not because output was lost, and
        // the tooltip is where that is said rather than left to be inferred.
        title: term.restored
          ? `${term.label} — new shell in ${term.cwd}; scrollback was not restored`
          : term.label,
        terminal: term,
        activity: tabMark(term.id),
      });
    }
    for (const tab of activeCompareTabs()) {
      out.push({
        kind: "compare",
        id: tab.id,
        // A tab that named itself keeps its name: a stash diff addresses its
        // trees by oid, and the derived label would be two shas the user never
        // saw. The refs still show in the tooltip, which is where "what is this
        // actually diffing" belongs.
        label: tab.label || `${short(tab.baseRef) || "?"}..${short(tab.headRef) || "?"}`,
        prefix: "compare · ",
        icon: <GitBranchPlus class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: tab.label
          ? `${tab.label} — ${tab.baseRef || "?"}..${tab.headRef || "?"}`
          : `Compare: ${tab.baseRef || "?"}..${tab.headRef || "?"}`,
        activity: tabMark(tab.id),
        mono: true,
        labelWidth: "max-w-[200px]",
      });
    }
    for (const tab of activeStackTabs()) {
      out.push({
        kind: "stack",
        id: tab.id,
        label: tab.topBranch,
        prefix: "stack · ",
        icon: <Layers class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: `Stack: ${tab.topBranch} → ${tab.trunk}`,
        activity: tabMark(tab.id),
        mono: true,
        labelWidth: "max-w-[200px]",
      });
    }
    for (const tab of activeHistoryTabs()) {
      out.push({
        kind: "history",
        id: tab.id,
        label: "graph",
        icon: <GitCommitHorizontal class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: "Commit graph",
        activity: tabMark(tab.id),
        // Repo-wide singletons: one per worktree, so there is nothing to sort
        // them against and nothing a pin would protect them from.
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeTimelineTabs()) {
      out.push({
        kind: "timeline",
        id: tab.id,
        label: "timeline",
        icon: <TimelineIcon class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: "Timeline",
        activity: tabMark(tab.id),
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeCombinedTabs()) {
      out.push({
        kind: "combined",
        id: tab.id,
        label: "all changes",
        icon: <CombinedIcon class="w-3.5 h-3.5 shrink-0 text-info opacity-90" />,
        title: "All changes",
        activity: tabMark(tab.id),
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeMissionTabs()) {
      out.push({
        kind: "mission",
        id: tab.id,
        label: "mission",
        icon: <MissionIcon class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: "Mission Control",
        activity: tabMark(tab.id),
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeBrowserTabs()) {
      out.push({
        kind: "browser",
        id: tab.id,
        label: browserTabLabel(tab),
        icon: <Globe class="w-3.5 h-3.5 shrink-0 text-info opacity-80" />,
        title: tab.url,
        activity: tabMark(tab.id),
        labelWidth: "max-w-[160px]",
        // The page is a child webview keyed by tab id; reordering the store
        // list would not move it, so the tab stays put too.
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeAgentTabs()) {
      out.push({
        kind: "agent",
        id: tab.id,
        label: tab.title?.trim() || "Agent",
        icon: <Bot class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        // The question the thread opened with, so two tabs on the same agent are
        // told apart by what they are about rather than by position.
        title: agentTabTitle(tab.id, tab.title),
        activity: tabMark(tab.id),
        labelWidth: "max-w-[160px]",
        // Unlike the browser there is nothing structural stopping either:
        // the thread is store state keyed by tab id, so it moves wherever the
        // tab moves and survives being pinned.
        pinnable: true,
        draggable: true,
      });
    }
    return out;
  });

  /// Tooltip for an agent tab: the agent's name, plus the first thing asked in
  /// that thread. The label can only show one of the two.
  function agentTabTitle(tabId: string, name: string | undefined): string {
    const agent = name?.trim() || "Agent";
    const first = agentThread(state.activeWorktreeId, tabId).find((m) => m.role === "user");
    return first ? `${agent} — ${first.content}` : agent;
  }

  // ── The pane tree ────────────────────────────────────────────────────────

  const groups = createMemo(() => groupList(paneLayout()));

  /// Which tabs each group shows. With the default layout — one group, no
  /// claims — this is `tabs()` in registry order under a single key, which is
  /// what makes the un-split workbench identical to the one before splits
  /// existed.
  const groupTabIds = createMemo(() => resolveGroupTabs(paneLayout(), workbenchTabIds()));

  const descriptorsById = createMemo(() => new Map(tabs().map((t) => [t.id, t])));

  const tabsOf = (groupId: string): TabDescriptor[] => {
    const byId = descriptorsById();
    return (groupTabIds().get(groupId) ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is TabDescriptor => !!t);
  };

  const groupOfTab = createMemo(() => {
    const out = new Map<string, string>();
    for (const [groupId, ids] of groupTabIds()) for (const id of ids) out.set(id, groupId);
    return out;
  });

  /// The front tab of every group. See `resolveActiveTabId` for the precedence
  /// rule and why it collapses to `activeItem()` in the single-group case.
  const frontTabIds = createMemo(() => {
    const item = activeItem();
    // `undefined` when the active item is not a workbench tab at all — an open
    // file lives in the editor window — which is not the same as it being in
    // another group.
    const owner = item ? groupOfTab().get(item.id) : undefined;
    const out = new Map<string, string | null>();
    for (const g of groups()) {
      out.set(
        g.id,
        resolveActiveTabId(
          groupTabIds().get(g.id) ?? [],
          g.activeTabId,
          item?.id ?? null,
          !!owner && owner !== g.id,
        ),
      );
    }
    return out;
  });

  /// Maximize hides every group but one. Zen hides chrome, not panes.
  const visibleGroups = createMemo(() => new Set(visibleGroupIds(groups().map((g) => g.id))));

  /// The group holding this tab is on screen. Distinct from "the tab is on
  /// screen": a browser tab that is the front tab of a maximized-away group is
  /// the second, not the first, and its webview has to be told so — nothing in
  /// the DOM can cover a child webview.
  const tabGroupVisible = (tabId: string) => {
    const groupId = groupOfTab().get(tabId);
    return !!groupId && visibleGroups().has(groupId);
  };
  const tabIsFront = (tabId: string) => {
    const groupId = groupOfTab().get(tabId);
    return !!groupId && frontTabIds().get(groupId) === tabId;
  };
  const tabIsVisible = (tabId: string) => tabIsFront(tabId) && tabGroupVisible(tabId);

  // ── Activity and its escalation (§7.5.3) ─────────────────────────────────
  // This component is the only one that knows both what every tab is
  // signalling and where every tab is on screen, so the escalation decision
  // is made here and published outward: group headers get theirs through the
  // strip's reserved slot, the status bar through `publishHiddenActivity`.

  /// Whether the workbench is the surface in front of the user.
  ///
  /// In stacked mode the editor and the git client are *views* of this window,
  /// and a view that is not in front is `visibility: hidden` over a workbench
  /// that stays mounted and keeps running. So "this pane is on screen" and
  /// "the user can see this pane" stop being the same question, and every
  /// answer below has to ask the second one. Always true in detached mode,
  /// where the satellites are windows and hide nothing.
  const workbenchInFront = () => currentStackedView() === "workbench";

  /// Which tabs the user can actually see. Feeding this back into the activity
  /// store is what stops a command you watched finish from leaving a badge,
  /// and what clears `bell` / `finished` when a tab comes to the front. Under
  /// zen the panes are still on screen — zen hides chrome, not content — so
  /// the front tab of a visible group still counts as seen.
  ///
  /// A covered workbench sees *nothing*. Without that clause a terminal that
  /// finished while the user was reading a diff in the editor view counted as
  /// watched, `noteFinished` returned early, and the event raised no mark at
  /// all — the one case §7.5.3 rule 1 exists for, in the arrangement that
  /// makes it easiest to miss.
  createEffect(() => {
    const seen: string[] = [];
    if (workbenchInFront()) {
      for (const [groupId, tabId] of frontTabIds()) {
        if (tabId && visibleGroups().has(groupId)) seen.push(tabId);
      }
    }
    setVisibleTabs(seen);

    // The same set, told to Rust's notifier, so a banner is never raised for
    // something the user is already looking at. Deliberately fed from *this*
    // effect rather than computed separately: two notions of "visible" that can
    // disagree is how you get a banner suppressed in one place and shown in the
    // other for the same event.
    //
    // Repositories rather than tab ids, because an event carries a repo — and
    // the tab→repo join belongs in the store that owns the mapping.
    const repo = repoRoot();
    void notifyApi
      .setVisible(seen.length && repo ? [repo] : [], isWindowFocused())
      // Fire-and-forget, like `record()`: failing to tell the notifier what is
      // on screen costs one redundant banner, and is not worth propagating into
      // a render effect.
      .catch(() => {});
  });

  /// Whether this OS window has focus, which `setVisibleTabs` needs in order to
  /// mean "being looked at" rather than "on screen". A bell in the front tab of a
  /// backgrounded window used to be dropped — the tab counted as visible, so
  /// nothing was badged, in exactly the case a badge is for. Installed here
  /// because this component is always mounted in the workbench and already owns
  /// the visibility feed.
  onMount(() => onCleanup(trackWindowFocus()));

  /// Why a tab's `notify` was raised, for the OS notification's body. Written by
  /// the OSC handler; absent for a plain "the command ended" completion, which
  /// has no message of its own.
  const notifyReason = new Map<string, string>();

  /// Escalate `notify` to the operating system, once per transition.
  ///
  /// Driven off the activity store rather than off the event, so there is exactly
  /// one place an OS notification can come from and it cannot disagree with the
  /// in-app mark. `notified` is the edge detector: the effect re-runs on every
  /// signal change, and without it a second tab lighting up would re-notify the
  /// first.
  let notified: ReadonlySet<string> = new Set();
  createEffect(() => {
    const live = new Set<string>();
    for (const term of activeTerminals()) {
      if (!signalsOf(term.id).includes("notify")) continue;
      live.add(term.id);
      if (notified.has(term.id)) continue;
      notifyTerminal(term.label, notifyReason.get(term.id));
    }
    for (const id of [...notifyReason.keys()]) if (!live.has(id)) notifyReason.delete(id);
    notified = live;
  });

  /// Every collapsed tab group, with the pane its chip renders in. A collapsed
  /// group is a hiding place, so `escalate` has to know about it — the rule
  /// that already carries a hidden pane's signal to the status bar is the same
  /// one that carries a hidden member's signal to the chip.
  const collapsedTabGroups = createMemo(() => {
    const out = new Map<string, { paneGroupId: string; tabIds: readonly string[] }>();
    for (const group of groups()) {
      for (const tabGroup of actions.tabGroupsOfPane(group.id)) {
        if (!tabGroup.collapsed) continue;
        out.set(tabGroup.id, { paneGroupId: group.id, tabIds: tabGroup.tabIds });
      }
    }
    return out;
  });

  /// The escalation snapshot. Recomputed on any change to the signals, the
  /// group membership, what is on screen or which group has focus.
  const escalation = createMemo(() => {
    void tabSignals();
    const owner = actions.tabWorktreeMap();
    // Every signalling tab in the window, not just the ones in the rendered
    // worktree's pane tree. Walking `groupTabIds()` — as this used to — meant a
    // signal in another worktree was never even in the input, which is why it
    // reached no surface at all.
    const live = new Map<string, ActivitySignal[]>();
    for (const id of Object.keys(tabSignals())) {
      const s = signalsOf(id);
      if (s.length) live.set(id, s);
    }
    return escalate({
      tabSignals: live,
      groupTabs: groupTabIds(),
      visibleGroupIds: visibleGroups(),
      focusedGroupId: focusedGroupId(),
      collapsedTabGroups: collapsedTabGroups(),
      zen: isZen(),
      tabWorktree: owner,
      activeWorktreeId: state.activeWorktreeId,
      // No `tabView`: every tab in this window's escalation input is a
      // workbench tab, which is what the default already assumes. The editor
      // view's tabs escalate inside `EditorView`, over its own strip.
      currentView: currentStackedView(),
    });
  });


  /// Hand the off-screen half to the status bar, and the per-worktree half to
  /// the rail. Effects rather than the two components reading `escalation()`
  /// directly, because all three are siblings in `AppShell` with no shared
  /// ancestor that knows geometry.
  createEffect(() => publishHiddenActivity(escalation().statusBar));
  createEffect(() => publishWorktreeActivity(escalation().worktrees));
  createEffect(() => publishHiddenWorktreeActivity(escalation().worktreeStatusBar));
  createEffect(() => publishViewActivity(escalation().views));
  onCleanup(() => {
    publishHiddenActivity(null);
    publishWorktreeActivity(new Map());
    publishHiddenWorktreeActivity(null);
    publishViewActivity(new Map());
  });

  // ── Group geometry ───────────────────────────────────────────────────────
  // Each group's body box, measured relative to this component's root, so the
  // flat pane layer can be positioned over it. See the component comment.

  let rootRef: HTMLDivElement | undefined;
  const bodyEls = new Map<string, HTMLElement>();
  const [rects, setRects] = createSignal<Record<string, Rect>>({});
  let observer: ResizeObserver | undefined;

  function measure() {
    if (!rootRef) return;
    const root = rootRef.getBoundingClientRect();
    const out: Record<string, Rect> = {};
    for (const [groupId, el] of bodyEls) {
      const r = el.getBoundingClientRect();
      out[groupId] = {
        // No rounding: the numbers go straight back into CSS pixels, and a
        // rounded rect would leave a hairline of background between a pane and
        // its splitter.
        x: r.left - root.left,
        y: r.top - root.top,
        width: r.width,
        height: r.height,
      };
    }
    setRects(out);
  }

  function registerBody(groupId: string, el: HTMLElement) {
    bodyEls.set(groupId, el);
    observer?.observe(el);
    queueMicrotask(measure);
    onCleanup(() => {
      bodyEls.delete(groupId);
      observer?.unobserve(el);
      queueMicrotask(measure);
    });
  }

  onMount(() => {
    observer = new ResizeObserver(() => measure());
    if (rootRef) observer.observe(rootRef);
    for (const el of bodyEls.values()) observer.observe(el);
    measure();
    const onReflow = () => measure();
    window.addEventListener("resize", onReflow);
    onCleanup(() => {
      observer?.disconnect();
      observer = undefined;
      window.removeEventListener("resize", onReflow);
    });
  });

  /// A structural change (split, collapse) or a chrome change (zen) moves every
  /// body without necessarily resizing the one the observer is watching first.
  createEffect(() => {
    void paneLayout();
    void isZen();
    void visibleGroups();
    queueMicrotask(measure);
  });

  /// How a pane clips itself to its island (D1).
  ///
  /// The flat pane layer is a *sibling* of the split tree, not a child of it,
  /// so a group's `.island` clipping cannot reach the pane drawn over its body
  /// — each pane has to carry the same radius itself. A pane fills the group's
  /// body box, so its bottom corners are the island's bottom corners. Its top
  /// corners are covered by the tab strip, and rounding them would clip the
  /// first line of a Monaco or xterm buffer for nothing. Under zen there is no
  /// strip, the body *is* the island, and all four corners are its own.
  ///
  /// `BrowserPane` is the one pane this cannot clip: its page is an OS-level
  /// child webview composited above the DOM, and no CSS radius reaches it. See
  /// the browser tab's entry in the pane layer below for how that is handled.
  const paneClass = () => (isZen() ? "absolute island" : "absolute island-bottom");

  /// Where one pane draws. `display` rather than unmounting: a hidden terminal
  /// keeps its xterm, and `visibility` would leave it eating pointer events.
  const paneStyle = (tabId: string): JSX.CSSProperties => {
    const groupId = groupOfTab().get(tabId);
    const rect = groupId ? rects()[groupId] : undefined;
    return {
      display: tabIsVisible(tabId) ? "block" : "none",
      ...(rect
        ? {
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }
        : // Before the first measurement — and for the single-group default,
          // where it is also exactly right.
          { inset: "0" }),
    };
  };

  // ── Group actions ────────────────────────────────────────────────────────

  /// A tab opened while a background group has focus belongs to that group.
  /// Without this every new terminal would land in the first group, because an
  /// unclaimed tab falls there by definition — which would make splitting a
  /// one-way trip.
  createEffect(
    on(workbenchTabIds, (ids, prev) => {
      const target = focusedGroupId();
      const first = groups()[0]?.id;
      if (!prev || !target || !first || target === first) return;
      const known = new Set(prev);
      for (const id of ids) {
        if (!known.has(id)) actions.moveTabToPaneGroup(state.activeWorktreeId, id, target, null);
      }
    }),
  );

  /// A drop landed in `groupId`. One payload covers both shapes of drag: a
  /// whole tab group moves as a unit through the action that re-claims each
  /// member via the pane reducer, and a lone tab moves as it always did.
  function moveTabHere(payload: TabDragPayload, groupId: string, beforeTabId: string | null) {
    if (payload.tabGroupId) {
      actions.moveTabGroupToPane(state.activeWorktreeId, payload.tabGroupId, groupId);
      return;
    }
    actions.moveTabToPaneGroup(state.activeWorktreeId, payload.id, groupId, beforeTabId);
  }

  /// A tab dropped on a group's edge: split that group and land the tab in the
  /// new one. `splitPaneGroup` returns `null` at the cap — the drop target has
  /// already refused by then, so this is only the belt to its braces.
  function splitWithTab(
    payload: TabDragPayload,
    groupId: string,
    orientation: SplitOrientation,
    placement: "before" | "after",
  ) {
    const wtId = state.activeWorktreeId;
    const newGroupId = actions.splitPaneGroup(wtId, orientation, placement, groupId);
    if (!newGroupId) return;
    moveTabHere(payload, newGroupId, null);
  }

  function selectTab(tab: TabDescriptor, groupId: string) {
    const wtId = state.activeWorktreeId;
    actions.focusPaneGroup(wtId, groupId);
    actions.setPaneGroupActiveTab(wtId, groupId, tab.id);
    switch (tab.kind) {
      case "terminal": actions.selectTerminal(wtId, tab.id); break;
      case "compare": actions.selectCompareTab(wtId, tab.id); break;
      case "stack": actions.selectStackTab(wtId, tab.id); break;
      case "history": actions.selectHistoryTab(wtId, tab.id); break;
      case "timeline": actions.selectTimelineTab(wtId, tab.id); break;
      case "combined": actions.selectCombinedTab(wtId, tab.id); break;
      case "mission": actions.selectMissionTab(wtId, tab.id); break;
      case "browser": actions.selectBrowserTab(wtId, tab.id); break;
      case "agent": actions.selectAgentTab(wtId, tab.id); break;
    }
  }

  function closeTab(tab: TabDescriptor) {
    const wtId = state.activeWorktreeId;
    // A badge for a pane that no longer exists would escalate forever with
    // nowhere to send the user.
    clearTabActivity(tab.id);
    switch (tab.kind) {
      case "terminal": actions.removeTerminal(wtId, tab.id); break;
      case "compare": actions.closeCompareTab(wtId, tab.id); break;
      case "stack": actions.closeStackTab(wtId, tab.id); break;
      case "history": actions.closeHistoryTab(wtId, tab.id); break;
      case "timeline": actions.closeTimelineTab(wtId, tab.id); break;
      case "combined": actions.closeCombinedTab(wtId, tab.id); break;
      case "mission": actions.closeMissionTab(wtId, tab.id); break;
      case "browser": actions.closeBrowserTab(wtId, tab.id); break;
      case "agent":
        actions.closeAgentTab(wtId, tab.id);
        // Reopen-last-closed mints a fresh tab id by design, so nothing can
        // address this conversation again; keeping it would only ride every
        // future `voidlink-agent-threads` write.
        dropAgentThread(wtId, tab.id);
        break;
    }
  }

  /// Local branch names for the active repo. Feeds the terminal's branch
  /// deep-link provider so only real branches get linkified. Refreshed on
  /// repo change and on the same `voidlink:refresh-git` pulse the sidebar
  /// uses after a checkout/commit.
  const [branchNames, setBranchNames] = createSignal<string[]>([]);
  async function refreshBranchNames() {
    const root = repoRoot();
    if (!root) {
      setBranchNames([]);
      return;
    }
    try {
      const branches = await gitApi.listBranches(root, false);
      setBranchNames(branches.map((b) => b.name));
    } catch {
      setBranchNames([]);
    }
  }
  createEffect(() => {
    // Re-fetch whenever the active repo changes.
    repoRoot();
    void refreshBranchNames();
  });
  onMount(() => {
    onCleanup(onGitRefsChanged(() => void refreshBranchNames()));
  });

  /// The ⌘K "Open commit graph" command (registered in commands/registry.ts)
  /// broadcasts this event so it can stay decoupled from the store. We open
  /// the graph tab for the active workspace when a repo is selected.
  onMount(() => {
    const handler = () => {
      if (!repoRoot()) {
        pushToast("Open a repository first", "warning");
        return;
      }
      actions.openHistoryTab(state.activeWorktreeId);
    };
    window.addEventListener("voidlink:open-commit-graph", handler);
    onCleanup(() => window.removeEventListener("voidlink:open-commit-graph", handler));
  });

  /// Switch to `branch` from a terminal deep-link. Mirrors the git sidebar's
  /// safe-checkout flow: auto-stash feedback, MRU bump, and a refresh pulse
  /// so every pane (sidebar, status bar, blame) re-reads HEAD.
  async function openBranchFromTerminal(branch: string) {
    const root = repoRoot();
    if (!root) return;
    try {
      const result = await gitApi.safeCheckout(root, branch);
      recordBranchUse(root, branch);
      if (result.autoStashed) {
        pushToast(
          `Switched to ${branch}. Auto-stashed your changes — restore with \`git stash pop\`.`,
          "info",
          5000,
        );
      } else {
        pushToast(`Switched to ${branch}.`, "info", 2500);
      }
      window.dispatchEvent(new CustomEvent("voidlink:refresh-files"));
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 5000);
    }
  }

  /// Which group's "+" menu is open, if any. Per group rather than a boolean:
  /// every strip has its own "+", and a new tab opens in the group whose "+"
  /// you pressed.
  const [menuGroup, setMenuGroup] = createSignal<string | null>(null);
  const [newFileMode, setNewFileMode] = createSignal(false);
  const [newFileName, setNewFileName] = createSignal("");
  const [newFileError, setNewFileError] = createSignal("");

  function closeMenu() {
    setMenuGroup(null);
    setNewFileMode(false);
    setNewFileName("");
    setNewFileError("");
  }

  async function onNewTerminal() {
    if (!repoRoot()) return;
    await actions.spawnTerminal(state.activeWorktreeId);
    closeMenu();
  }

  function onNewCompare() {
    if (!repoRoot()) return;
    actions.openCompareTab(state.activeWorktreeId);
    closeMenu();
  }

  /// Open an embedded browser tab. Starts blank-ish rather than prompting —
  /// the pane has its own address bar, and one fewer modal is one fewer thing
  /// that has to fight the child webview for the top of the stack.
  function onNewBrowser() {
    actions.openBrowserTab(state.activeWorktreeId, normalizeUrl("example.com"));
    closeMenu();
  }

  async function onCreateFile() {
    const root = repoRoot();
    if (!root) return;
    const name = newFileName().trim();
    if (!name) return;
    // Block path traversal — keep new files at the workspace root.
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      setNewFileError("Use a plain file name at the workspace root.");
      return;
    }
    const fullPath = `${root}/${name}`;
    try {
      await fsApi.createFile(fullPath);
      // The file itself opens over in the editor window.
      props.onOpenFile(fullPath);
      // A new file is invisible to the sidebar until the file tree re-lists
      // its dir and the git status re-runs (the file is untracked).
      window.dispatchEvent(new CustomEvent("voidlink:refresh-files"));
      emitGitRefsChanged();
      closeMenu();
    } catch (e) {
      setNewFileError(e instanceof Error ? e.message : String(e));
    }
  }

  // Always show the tab bar when a repo is selected — the "+" button is the
  // primary entry point for opening terminals / compares / files.
  const showTabBar = () => hasAnyTab() || !!repoRoot();

  // ── Tab strip orientation ────────────────────────────────────────────────
  // A `ui` preference rather than layout state: it is a statement about how
  // you like to read tabs, not about this window's arrangement, so it survives
  // a layout reset and applies to every pane group at once.
  //
  // The width is clamped on read rather than on write. The settings file is
  // user-editable JSON (Settings → JSON writes it), so `verticalTabWidth: 4`
  // is a realistic input, and a strip four pixels wide is a workbench with no
  // visible way back.
  const verticalTabs = () => settings.ui.tabOrientation === "vertical";
  const verticalTabWidth = () =>
    Math.min(
      VERTICAL_TAB_WIDTH.max,
      Math.max(VERTICAL_TAB_WIDTH.min, settings.ui.verticalTabWidth),
    );

  // ── Rendering the tree ───────────────────────────────────────────────────

  /// Group ids, split ids and orientations — no ratios, no tab claims.
  ///
  /// `renderNode` reads the tree through a memo keyed on this string, so a
  /// splitter drag (a ratio change, sixty times a second) changes two
  /// `flex-basis` values and rebuilds nothing. Rebuilding would restart every
  /// terminal tab's process poll and throw away each strip's scroll position,
  /// mid-drag, every frame.
  /// Undefined-tolerant because Solid runs a memo's comparator against its
  /// (absent) initial value on the very first computation.
  const structureKey = (node: PaneNode | undefined): string =>
    !node
      ? ""
      : node.kind === "group"
      ? `g:${node.group.id}`
      : `s:${node.id}:${node.orientation}:(${node.children.map(structureKey).join(",")})`;

  const structure = createMemo(() => paneLayout(), undefined, {
    equals: (a, b) => structureKey(a) === structureKey(b),
  });

  /// Ratios, read separately from the structure for the reason above.
  const ratiosBySplit = createMemo(() => {
    const out = new Map<string, number[]>();
    const walk = (n: PaneNode) => {
      if (n.kind !== "split") return;
      out.set(n.id, n.ratios);
      n.children.forEach(walk);
    };
    walk(paneLayout());
    return out;
  });
  const ratioAt = (splitId: string, index: number) => ratiosBySplit().get(splitId)?.[index] ?? 0;

  /// The px extent of a split along its own axis, measured on demand — the
  /// `<Splitter>` works in pixels and the tree works in ratios, and this is the
  /// only place the two meet.
  const splitEls = new Map<string, HTMLElement>();
  const splitExtent = (splitId: string, orientation: SplitOrientation) => {
    const el = splitEls.get(splitId);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return orientation === "row" ? r.width : r.height;
  };

  function renderGroup(groupId: string): JSX.Element {
    /// No header at all with one group: today's workbench, unchanged. With two
    /// or more, the rule is 2px in both states so focus moving between groups
    /// costs no layout.
    const header = () =>
      groups().length < 2 ? undefined : focusedGroupId() === groupId ? "focused" : "unfocused";
    const focusGroup = () => actions.focusPaneGroup(state.activeWorktreeId, groupId);

    return (
      // One pane group = one island (D1). The radius and the clipping come
      // from `.island` in `index.css`; this component owns *where* islands sit
      // (the gaps between them, below) and nothing else owns either.
      //
      // `flex-row` under the vertical tab preference: the strip and the body
      // are the same two children in the same order, read left-to-right
      // instead of top-to-bottom. The island itself is unchanged, so a split
      // still looks like the diagram in the directions spec.
      <div
        class="island flex-1 flex min-w-0 min-h-0 bg-background"
        classList={{ "flex-col": !verticalTabs(), "flex-row": verticalTabs() }}
      >
        <Show when={showTabBar() && !isZen()}>
          <TabStrip
            orientation={settings.ui.tabOrientation}
            width={verticalTabWidth()}
            tabs={tabsOf(groupId)}
            activeId={frontTabIds().get(groupId) ?? null}
            isPinned={isPinned}
            groupId={groupId}
            groupHeader={header()}
            groupActivity={escalation().groups.get(groupId)}
            tabGroups={actions.tabGroupsOfPane(groupId)}
            tabGroupActivity={(id) => escalation().tabGroups.get(id)}
            onToggleTabGroup={(id) => actions.toggleTabGroup(state.activeWorktreeId, id)}
            onRenameTabGroup={(id, label) =>
              actions.renameTabGroup(state.activeWorktreeId, id, label)
            }
            onRecolorTabGroup={(id, color) =>
              actions.recolorTabGroup(state.activeWorktreeId, id, color)
            }
            onDissolveTabGroup={(id) => actions.dissolveTabGroup(state.activeWorktreeId, id)}
            onCreateTabGroup={(tabIds) =>
              actions.createTabGroup(state.activeWorktreeId, groupId, tabIds)
            }
            onAssignTab={(tabId, tabGroupId, before) =>
              actions.assignTabToGroup(state.activeWorktreeId, tabId, tabGroupId, before)
            }
            onReorderTabGroup={(id, before) =>
              actions.reorderTabGroup(state.activeWorktreeId, id, before)
            }
            onFocusGroup={focusGroup}
            onMoveTab={(payload, before) => moveTabHere(payload, groupId, before)}
            onSelect={(tab) => selectTab(tab, groupId)}
            onClose={closeTab}
            onReorder={(kind, fromId, toId) => {
              // Only the three reorderable kinds reach this; the rest are
              // marked non-draggable in their descriptors.
              if (kind !== "terminal" && kind !== "compare" && kind !== "stack") return;
              actions.reorderItemTab(state.activeWorktreeId, kind, fromId, toId);
            }}
            onTogglePin={(id) => actions.togglePinTab(state.activeWorktreeId, id)}
            trailing={
              <NewTabMenu
                open={menuGroup() === groupId}
                onOpen={() => {
                  focusGroup();
                  setMenuGroup(groupId);
                }}
                onClose={closeMenu}
                disabled={!repoRoot()}
                newFileMode={newFileMode()}
                onEnterFileMode={() => { setNewFileMode(true); setNewFileError(""); }}
                newFileName={newFileName()}
                setNewFileName={setNewFileName}
                newFileError={newFileError()}
                onCreateFile={() => void onCreateFile()}
                onNewTerminal={() => void onNewTerminal()}
                onNewCompare={onNewCompare}
                onOpenBrain={() => {
                  // An overlay since cut C2, not a tab — but still reachable
                  // from the same menu, because the menu is where somebody
                  // looks for it.
                  openBrain();
                  closeMenu();
                }}
                onOpenTimeline={() => {
                  actions.openTimelineTab(state.activeWorktreeId);
                  closeMenu();
                }}
                onOpenMission={() => {
                  actions.openMissionTab(state.activeWorktreeId);
                  closeMenu();
                }}
                onNewBrowser={onNewBrowser}
                onNewAgent={() => {
                  actions.openAgentTab(
                    state.activeWorktreeId,
                    defaultAgentId(),
                    agentById(defaultAgentId())?.name,
                  );
                  closeMenu();
                }}
              />
            }
          />
        </Show>
        {/* The body is deliberately empty: it is a measuring box, and the pane
            that fills it lives in the flat layer below.
            `min-w-0 min-h-0` because it is now a flex child on *either* axis:
            without it a wide tab label or a tall pane would push the box past
            the island rather than being clipped by it, and the flat layer
            would then position panes against a rectangle bigger than the one
            they are drawn in. */}
        <div
          ref={(el) => registerBody(groupId, el)}
          class="flex-1 relative overflow-hidden min-w-0 min-h-0"
        />
      </div>
    );
  }

  function renderNode(node: PaneNode): JSX.Element {
    if (node.kind === "group") return renderGroup(node.group.id);
    const orientation = node.orientation;
    const extent = () => splitExtent(node.id, orientation);
    /// Islands inside a split are separated by the same canvas gap the shell
    /// uses at the window edge, so a split reads as two panels rather than as
    /// one panel with a rule down it.
    ///
    /// The gap is real space, so the ratio arithmetic has to be re-derived
    /// against it: with `n` children there are `n - 1` gaps, and the space
    /// ratios divide is `100% - (n - 1) × gap`. Expressing it as one `calc`
    /// rather than as a per-child subtraction keeps the children summing to
    /// exactly the container — a rounded-down share would leave a hairline of
    /// canvas at the far edge that moves as you drag.
    const basis = (i: number) =>
      `calc(${ratioAt(node.id, i)} * (100% - ${node.children.length - 1} * var(--island-gap)))`;
    /// The px extent the *ratios* divide — the split's own extent minus the
    /// gaps between its children. `<Splitter>` works in px and the tree works
    /// in ratios; feeding it the raw extent would make a drag drift by the
    /// gap's width across the pane.
    const usable = () => Math.max(0, extent() - (node.children.length - 1) * islandGapPx());
    return (
      <div
        ref={(el) => {
          splitEls.set(node.id, el);
          onCleanup(() => splitEls.delete(node.id));
        }}
        class="flex-1 flex min-w-0 min-h-0"
        style={{ gap: "var(--island-gap)" }}
        classList={{
          "flex-row": orientation === "row",
          "flex-col": orientation === "column",
        }}
      >
        <Index each={node.children}>
          {(child, i) => (
            <div
              class="relative flex min-w-0 min-h-0"
              style={{
                "flex-basis": basis(i),
                "flex-grow": "0",
                "flex-shrink": "0",
              }}
            >
              {renderNode(child())}
              <Show when={i < node.children.length - 1}>
                <Splitter
                  axis={orientation === "row" ? "x" : "y"}
                  side="end"
                  inGap
                  label={orientation === "row" ? "Pane width" : "Pane height"}
                  value={ratioAt(node.id, i) * usable()}
                  min={MIN_RATIO * usable()}
                  max={(ratioAt(node.id, i) + ratioAt(node.id, i + 1) - MIN_RATIO) * usable()}
                  defaultValue={((ratioAt(node.id, i) + ratioAt(node.id, i + 1)) / 2) * usable()}
                  onResize={(px) => {
                    actions.setPaneSplitRatios(
                      state.activeWorktreeId,
                      node.id,
                      ratiosAfterDrag(ratiosBySplit().get(node.id) ?? [], i, px, usable()),
                    );
                  }}
                />
              </Show>
            </div>
          )}
        </Index>
      </div>
    );
  }

  return (
    <div
      ref={(el) => (rootRef = el)}
      /* The canvas the group islands float on (D1). Not `bg-background`: that
         is the *island* surface, and the gaps between split groups have to
         show the recessed colour or the split reads as one panel. */
      class="flex-1 flex flex-col overflow-hidden bg-canvas relative"
    >
      {renderNode(structure())}

      {/* ── The pane layer ─────────────────────────────────────────────────
          One flat list, never reparented; each pane is positioned over its
          group's measured body. See the component comment for why. */}

      {/* Terminals */}
      <For each={activeTerminals()}>
        {(term) => {
          // Subscribe from the pane layer, not only from the tab strip. Zen
          // renders no strips at all, and a shell whose activity is only
          // watched while its strip is mounted reports nothing precisely when
          // the user has the least chance of noticing (§7.5.3 rule 1). The
          // watcher is refcounted, so this and the strip share one poll.
          watchTerminal(term.id, term.ptyId);
          return (
          <div class={paneClass()} style={paneStyle(term.id)}>
            <TerminalPane
              ptyId={term.ptyId}
              active={tabIsVisible(term.id)}
              class="w-full h-full"
              onBell={() => noteBell(term.id)}
              // A program inside the shell said it was done (OSC 9 / OSC 777).
              // Same mark as a bell, because to the user they are the same
              // event, and the body is what the OS notification says.
              onNotify={(body) => {
                if (body) notifyReason.set(term.id, body);
                noteBell(term.id);
              }}
              onExit={(exitCode) => {
                // A shell that exited cleanly is done and its tab goes with it.
                // A non-zero exit is a *result*, and §7.5.3 says a failure is
                // acknowledged rather than dismissed — so the tab stays, wearing
                // the red mark, and closing it is the acknowledgement. Without
                // this the `failed` signal had nowhere it could ever be seen:
                // the tab was always removed in the same breath.
                if (exitCode !== null && exitCode !== 0) {
                  noteFinished(term.id, false);
                  return;
                }
                clearTabActivity(term.id);
                actions.removeTerminal(state.activeWorktreeId, term.id);
              }}
              onOpenPath={(path, line, column) => {
                // Resolve relative paths against the workspace root; tools
                // print both, so accept either.
                const root = repoRoot();
                const full = path.startsWith("/") ? path : root ? `${root}/${path}` : path;
                props.onOpenFile(full, line, column);
              }}
              onOpenSha={(sha) => {
                const root = repoRoot();
                if (!root) return;
                // Asked rather than assumed. `` `${sha}^` `` does not resolve
                // for a root commit, so the first commit in a repository —
                // clicked out of `git log` output like any other — opened a
                // compare tab onto an error.
                void resolveCommitDiffBase(root, sha).then((baseRef) => {
                  actions.openCompareTab(state.activeWorktreeId, {
                    baseRef,
                    headRef: sha,
                    useMergeBase: false,
                  });
                });
              }}
              branchNames={branchNames}
              onOpenBranch={(branch) => void openBranchFromTerminal(branch)}
            />
          </div>
          );
        }}
      </For>

      {/* Compare tabs */}
      <For each={activeCompareTabs()}>
        {(tab) => (
          <Show when={activeRepoPath()}>
            {(repo) => (
              <div class={paneClass()} style={paneStyle(tab.id)}>
                {/* A rejected `git_compare` does not merely blank this pane: the
                    throw aborts the update that was carrying it, and every
                    effect downstream of `CompareTab`'s files memo stays marked
                    stale forever. Refresh, Retry, the merge-base toggle and
                    swapping base/head then all re-run the fetch and change
                    nothing on screen, while the tab's activity dot keeps
                    spinning. The boundary's reset is the only thing that
                    rebuilds those computations. */}
                <GitErrorBoundary surface="This comparison">
                  <CompareTabView
                    repoPath={repo()}
                    tab={tab}
                    worktreeId={state.activeWorktreeId}
                  />
                </GitErrorBoundary>
              </div>
            )}
          </Show>
        )}
      </For>

      {/* Stack tabs */}
      <For each={activeStackTabs()}>
        {(tab) => (
          <Show when={activeRepoPath()}>
            {(repo) => (
              <div class={paneClass()} style={paneStyle(tab.id)}>
                <StackTabView
                  repoPath={repo()}
                  tab={tab}
                  worktreeId={state.activeWorktreeId}
                />
              </div>
            )}
          </Show>
        )}
      </For>

      {/* Timeline tabs (the event log) */}
      <For each={activeTimelineTabs()}>
        {(tab) => (
          <div class={paneClass()} style={paneStyle(tab.id)}>
            <TimelineSurface repoPath={activeRepoPath() ?? ""} />
          </div>
        )}
      </For>

      {/* Every staged, unstaged and untracked change in one scroll */}
      <For each={activeCombinedTabs()}>
        {(tab) => (
          <div class={paneClass()} style={paneStyle(tab.id)}>
            <CombinedDiffView repoPath={activeRepoPath() ?? ""} />
          </div>
        )}
      </For>

      {/* Mission Control (the lineup, the check-in and the hills) */}
      <For each={activeMissionTabs()}>
        {(tab) => (
          <div class={paneClass()} style={paneStyle(tab.id)}>
            <MissionSurface
              workspaceId={state.activeWorkspaceId}
              repoPath={activeRepoPath() ?? undefined}
              onOpen={(row) => {
                // The Lineup spans every workspace, so a row's worktree is
                // usually not the one this window is showing. `selectWorktree`
                // switches workspaces too, which is exactly the navigation the
                // surface exists to enable.
                if (row.worktreeId) actions.selectWorktree(row.worktreeId);
              }}
              onInspectLeg={(leg) => {
                // A leg's work is a branch. Comparing it against the branch it
                // came from is how you read what the agent actually did.
                actions.openCompareTab(state.activeWorktreeId, {
                  headRef: leg.branch,
                  useMergeBase: true,
                });
              }}
            />
          </div>
        )}
      </For>

      {/* Agent tabs. Kept mounted like every other pane body: a turn streams
          into the store rather than into this component, so a tab in the
          background keeps growing its answer and reports itself through the
          strip's LED. */}
      <For each={activeAgentTabs()}>
        {(tab) => (
          <div class={paneClass()} style={paneStyle(tab.id)}>
            <AgentThreadView
              wtId={state.activeWorktreeId}
              tabId={tab.id}
              agentId={tab.agentId}
              onOpenSettings={props.onOpenSettings}
            />
          </div>
        )}
      </For>

      {/* Browser tabs. Kept mounted so the webview isn't torn down on every
          tab switch — BrowserPane hides it instead. `groupVisible` is the
          second half of that: the page is a child webview painting above the
          DOM, so a group that is maximized away hides nothing by itself. */}
      <For each={activeBrowserTabs()}>
        {(tab) => (
          <div class={paneClass()} style={paneStyle(tab.id)}>
            <BrowserPane
              tab={tab}
              active={tabIsFront(tab.id)}
              groupVisible={tabGroupVisible(tab.id)}
              onUrlChange={(url) => actions.setBrowserUrl(state.activeWorktreeId, tab.id, url)}
              onTitleChange={(title) => actions.setBrowserTitle(state.activeWorktreeId, tab.id, title)}
              onZoomChange={(zoom) => actions.setBrowserZoom(state.activeWorktreeId, tab.id, zoom)}
            />
          </div>
        )}
      </For>

      {/* Commit graph tabs */}
      <For each={activeHistoryTabs()}>
        {(tab) => (
          <Show when={activeRepoPath()}>
            {(repo) => (
              <div class={paneClass()} style={paneStyle(tab.id)}>
                {/* `CommitGraph` reads its resource inside the lane memo, so a
                    repository that moved out from under us takes the whole
                    window white rather than rendering the graph's own error
                    state — which is unreachable without something above it to
                    catch the throw. */}
                <GitErrorBoundary surface="The commit graph">
                  <CommitGraph
                    repoPath={repo()}
                    onOpenCommit={(oid, parentOids) => {
                      // `commitDiffBase` rather than a literal `<oid>^`, which
                      // does not resolve for a root commit — clicking the first
                      // commit in a repository used to error here and error
                      // *differently* from the sidebar's history section.
                      actions.openCompareTab(state.activeWorktreeId, {
                        baseRef: commitDiffBase(parentOids),
                        headRef: oid,
                        useMergeBase: false,
                      });
                    }}
                  />
                </GitErrorBoundary>
              </div>
            )}
          </Show>
        )}
      </For>

      {/* ── Per-group overlays ─────────────────────────────────────────────
          Empty state, then the drop target on top of it. Both are positioned
          from the same rects as the panes. */}
      <For each={groups()}>
        {(group) => (
          <Show when={visibleGroups().has(group.id) ? rects()[group.id] : undefined}>
            {(rect) => (
              <>
                {/* Two different emptinesses, and §9.7's no-shared-sentence
                    rule is what lets the user tell them apart: the only pane
                    in the worktree being empty means "nothing is open at all",
                    while one pane of a split being empty means "the others
                    have your tabs". Same box, different icon and sentence. */}
                <Show when={activeRepoPath() && tabsOf(group.id).length === 0}>
                  <div
                    class={`${paneClass()} flex items-center justify-center bg-background z-10`}
                    style={rectStyle(rect())}
                  >
                    <EmptyState
                      id={groups().length > 1 ? "groupNoTabs" : "worktreeNoTabs"}
                      size="pane"
                      action={
                        <EmptyStateAction
                          onClick={() => {
                            actions.focusPaneGroup(state.activeWorktreeId, group.id);
                            actions.openCompareTab(state.activeWorktreeId);
                          }}
                        >
                          <GitBranchPlus class="w-3.5 h-3.5" />
                          Compare branches
                        </EmptyStateAction>
                      }
                    />
                  </div>
                </Show>
                {/* `pointer-events-none` at rest: the drop target only exists
                    during a drag, and this wrapper must never sit between the
                    user and the pane. */}
                <div
                  class={`${paneClass()} pointer-events-none z-20`}
                  style={rectStyle(rect())}
                >
                  <PaneDropOverlay
                    groupId={group.id}
                    canSplit={canSplit(paneLayout())}
                    onMoveTab={(payload, before) => moveTabHere(payload, group.id, before)}
                    onSplitDrop={(payload, orientation, placement) =>
                      splitWithTab(payload, group.id, orientation, placement)
                    }
                  />
                </div>
              </>
            )}
          </Show>
        )}
      </For>

      {/* No repository: the whole surface, not a pane — there are no panes to
          speak of yet. */}
      <Show when={!activeRepoPath()}>
        <div class="island absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-3 bg-background z-10">
          <TerminalSquare class="w-7 h-7 opacity-60" />
          <p class="text-ui">Open a folder from the workspace rail to start working.</p>
        </div>
      </Show>
    </div>
  );
}

/// One group's body box as absolute-position CSS.
function rectStyle(rect: Rect): JSX.CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function NewTabMenu(props: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  disabled: boolean;
  newFileMode: boolean;
  onEnterFileMode: () => void;
  newFileName: string;
  setNewFileName: (v: string) => void;
  newFileError: string;
  onCreateFile: () => void;
  onNewTerminal: () => void;
  onNewCompare: () => void;
  onOpenBrain: () => void;
  onOpenTimeline: () => void;
  onOpenMission: () => void;
  onNewBrowser: () => void;
  onNewAgent: () => void;
}) {
  // The parent tab bar uses `overflow-x-auto`, which clips any descendant
  // absolutely-positioned dropdown. Render the menu in a Portal and anchor
  // it to the button's viewport rect so it escapes the clipping container.
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  const [pos, setPos] = createSignal({ left: 0, top: 0 });

  function reposition() {
    if (!btnRef) return;
    const r = btnRef.getBoundingClientRect();
    const width = 224; // w-56
    const pad = 8;
    let left = r.left;
    if (left + width + pad > window.innerWidth) left = window.innerWidth - width - pad;
    if (left < pad) left = pad;
    setPos({ left, top: r.bottom + 4 });
  }

  // Close on outside click / Escape, reposition on resize/scroll.
  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!props.open) return;
      const target = e.target as Node;
      if (btnRef?.contains(target)) return;
      if (panelRef?.contains(target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) props.onClose();
    };
    const onReflow = () => { if (props.open) reposition(); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    });
  });

  // Reposition whenever the menu opens or its contents (mode) change height.
  createEffect(() => {
    void props.open;
    void props.newFileMode;
    if (props.open) queueMicrotask(reposition);
  });

  // Auto-focus the filename input when we switch into file-naming mode.
  createEffect(() => {
    if (props.open && props.newFileMode) {
      queueMicrotask(() => inputRef?.focus());
    }
  });

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (props.open ? props.onClose() : props.onOpen())}
        disabled={props.disabled}
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={props.open}
        title={props.disabled ? "Open a folder first" : "New tab"}
        class={`mx-1 p-1 rounded transition-colors shrink-0 ${
          props.disabled
            ? "text-muted-foreground/40 cursor-not-allowed"
            : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
        }`}
      >
        <Plus class="w-3.5 h-3.5" />
      </button>

      <Show when={props.open}>
        <Portal>
          <div
            ref={panelRef}
            role="menu"
            class="fixed w-56 rounded-md border border-border material-chrome text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-ui"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <Show
              when={!props.newFileMode}
              fallback={
                <div class="p-2 space-y-1.5">
                  <label class="block text-label text-muted-foreground">
                    New file at workspace root
                  </label>
                  <input
                    ref={inputRef}
                    type="text"
                    value={props.newFileName}
                    placeholder="filename.txt"
                    onInput={(e) => props.setNewFileName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); props.onCreateFile(); }
                    }}
                    class="w-full rounded border border-border bg-muted/40 px-2 py-1 text-body font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Show when={props.newFileError}>
                    <p class="text-label text-destructive">{props.newFileError}</p>
                  </Show>
                  <div class="flex justify-end gap-1.5">
                    <button
                      onClick={props.onClose}
                      class="px-2 py-0.5 rounded text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={props.onCreateFile}
                      disabled={!props.newFileName.trim()}
                      class="px-2 py-0.5 rounded text-label bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                      Create
                    </button>
                  </div>
                </div>
              }
            >
              {/* Every row carries a tooltip, and none of them restates its
                  label. Half this menu opens surfaces whose names mean nothing
                  until you have already met them — "Timeline", "Brain",
                  "Mission Control" — so the row's job is only to be findable
                  and the tooltip's is to say what lands. */}
              <MenuItem
                onClick={props.onNewTerminal}
                icon={<TerminalSquare class="w-3.5 h-3.5" />}
                tooltip="A shell in this worktree's root, as a tab in this pane."
              >
                New terminal
              </MenuItem>
              <MenuItem
                onClick={props.onNewCompare}
                icon={<GitBranchPlus class="w-3.5 h-3.5" />}
                tooltip="Diff any two refs — branches, tags, SHAs, HEAD~3 — with a changed-file tree beside the diff."
              >
                New branch compare
              </MenuItem>
              <MenuItem
                onClick={props.onEnterFileMode}
                icon={<FilePlus2 class="w-3.5 h-3.5" />}
                tooltip="Create an empty file at the workspace root and open it in the editor."
              >
                New file at root…
              </MenuItem>
              <MenuItem
                onClick={props.onOpenTimeline}
                icon={<TimelineIcon class="w-3.5 h-3.5" />}
                tooltip="The event log for this repo: agent turns, finished commands, commits, branch switches, rebases."
              >
                Timeline
              </MenuItem>
              <MenuItem
                onClick={props.onOpenMission}
                icon={<MissionIcon class="w-3.5 h-3.5" />}
                tooltip="What is happening across every workspace, not just this one — plus fan-out and triggers."
              >
                Mission Control
              </MenuItem>
              <MenuItem
                onClick={props.onOpenBrain}
                icon={<Brain class="w-3.5 h-3.5" />}
                tooltip="This repo's own notes and decisions, kept as markdown in .voidlink/brain/. Opens as an overlay, not a tab."
              >
                Brain
              </MenuItem>
              <MenuItem
                onClick={props.onNewBrowser}
                icon={<Globe class="w-3.5 h-3.5" />}
                tooltip="A real webview with its own cookie jar — a logged-in page stays logged in, and no site can refuse to be framed."
              >
                New browser tab
              </MenuItem>
              <MenuItem
                onClick={props.onNewAgent}
                icon={<Bot class="w-3.5 h-3.5" />}
                tooltip="A thread against your configured AI CLI, grounded in this repo's files and diff."
              >
                New agent thread
              </MenuItem>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
