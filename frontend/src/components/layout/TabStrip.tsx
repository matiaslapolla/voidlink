/// The tab strip, shared by the workbench and the editor window.
///
/// Both windows show a horizontal row of tabs with the same affordances —
/// click to activate, middle-click or × to close, drag to reorder within a kind,
/// right-click for pin / close / close-others, a chevron popover when the row
/// overflows — but they show *different kinds* of tab, out of different state
/// (the workbench reads its store; the editor window renders a snapshot the
/// workbench broadcast). Rather than parameterise the strip over both state
/// shapes, callers flatten whatever they have into `TabDescriptor`s and this
/// module owns every pixel and interaction from there down.
///
/// That is why the strip takes no store: it is the one piece of UI that has to
/// look identical in a window that can write state and a window that can't.

import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  FolderMinus,
  FolderPlus,
  Pin,
  PinOff,
  X,
} from "lucide-solid";
import type { TerminalSession } from "@/types/workspace";
import {
  LedSlot,
  StatusLed,
  highestSignal,
  terminalSignal,
  type ActivitySignal,
} from "@/components/layout/StatusLed";
import { watchTerminal, type TerminalWatch } from "@/store/terminalWatch";
import { dropIntentAt, type DropIntent } from "@/components/layout/paneDrop";
import type { SplitOrientation, TabGroup, TabGroupColor } from "@/store/layout";
// Values come straight from the reducer module rather than through the store's
// barrel: the strip has to keep working in the editor window, which has no
// store, and `tabGroups.ts` is pure and DOM-free.
import { TAB_GROUP_COLORS, stripEntries } from "@/store/layout/tabGroups";

/// Every tab kind either window can show. The strip only ever compares these
/// for equality (grouping, reorder targets) — it attaches no behaviour to any
/// particular value, so adding a kind here costs nothing.
export type TabKind =
  | "file"
  | "terminal"
  | "diff"
  | "compare"
  | "stack"
  | "conflict"
  | "history"
  | "preview"
  | "timeline"
  | "mission"
  | "browser"
  | "agent";

/// One tab, flattened out of whatever the calling window keeps.
export interface TabDescriptor {
  kind: TabKind;
  id: string;
  /// The main text of the tab.
  label: string;
  /// Dimmed lead-in rendered before the label — "diff · ", "conflict · ".
  prefix?: string;
  prefixTone?: "muted" | "warning";
  /// Shown when the tab is not pinned; pinned tabs always show a pin instead.
  icon: JSX.Element;
  title: string;
  /// Unsaved-changes marker. Editor-window state, so only file tabs set it.
  dirty?: boolean;
  /// A write for this buffer is in flight. Puts the dirty dot into its pending
  /// form (MASTER §7.6) rather than replacing or hiding it — the buffer still
  /// differs from disk until the write lands, so the dot must stay.
  saving?: boolean;
  /// Reloaded from disk while this tab was in the background. The §7.5.3
  /// *finished* mark, cleared when the tab is next activated.
  reloaded?: boolean;
  /// A transient / preview tab: showing something the user glanced at rather
  /// than something they committed to keeping open. Italic label, the idiom
  /// every editor uses for this, and the only place italics appear in the strip.
  preview?: boolean;
  /// The tab's live §7.5.3 signal, already reduced to one mark by the caller
  /// (`store/activity.ts`). `dirty` is folded in here rather than by the
  /// caller, so a window that only knows about unsaved buffers — the editor —
  /// keeps working without setting this at all.
  activity?: ActivitySignal;
  /// Present on terminal tabs. Swaps the icon for a live LED + process name;
  /// the strip owns that polling because the tab is the only place it shows.
  terminal?: TerminalSession;
  /// Terminals can't be reopened once their PTY is gone, so pinning them is
  /// meaningless. Repo-wide singleton tabs (commit graph, timeline) and browser
  /// tabs are likewise neither pinnable nor draggable.
  pinnable?: boolean;
  draggable?: boolean;
  /// Refs and branch names read better monospaced.
  mono?: boolean;
  /// Tailwind max-width for the label, for kinds that need more room.
  labelWidth?: string;
}

/// The active tab's 2px `--primary` rule.
///
/// Rendered as a child rather than as a border or a box-shadow for two
/// reasons. A border would change `border-width` between states, which §7.6
/// forbids outright; a box-shadow would have to be composed with the drop
/// caret's inset shadow into one dynamic class string, and Tailwind v4 only
/// emits classes it can find literally in the source, so a runtime-built one
/// would silently produce no CSS at all.
///
/// Inset from the card's own edges by 6px so its ends clear the card's
/// `--island-radius-inner` corners instead of poking past them.
function ActiveRule() {
  return (
    <span
      aria-hidden="true"
      class="pointer-events-none absolute left-1.5 right-1.5 bottom-0 h-0.5 bg-primary"
    />
  );
}

const isPinnable = (t: TabDescriptor) => t.pinnable !== false && !t.terminal;
/// Whether a tab can be *reordered within its own strip*. Some kinds can't:
/// a browser tab's page is a child webview keyed by tab id, so shuffling the
/// store list would move the tab and leave the page behind.
const isReorderable = (t: TabDescriptor) => t.draggable !== false;

// ── Cross-group drag ───────────────────────────────────────────────────────
// One drag is in flight at a time, and every strip and every pane drop target
// in the window has to see it — the strip a tab is dropped on is usually not
// the strip it came from. This is module state rather than a store because it
// is transient gesture state, and because the strip has to keep working in the
// editor window, which has no store to put it in.

export interface TabDragPayload {
  kind: TabKind;
  id: string;
  /// Shown in the drag ghost when a drop is refused, so the refusal names the
  /// tab it is about.
  label: string;
  /// The pane group the drag started in, or `null` in a window with no groups
  /// (the editor). `null` on both ends means "reorder only", which is exactly
  /// the pre-groups behaviour.
  groupId: string | null;
  /// Set when the thing being dragged is a whole **tab group** rather than one
  /// tab; `id` and `kind` then describe its first member, so every existing
  /// drop target keeps working without knowing about groups.
  ///
  /// One payload rather than a second drag mechanism beside it: two module-level
  /// drags in flight is how a drop target ends up honouring the wrong one.
  tabGroupId?: string;
}

const [tabDrag, setTabDrag] = createSignal<TabDragPayload | null>(null);

/// The tab currently being dragged. Pane drop targets subscribe to it so they
/// only exist during a drag — a permanently mounted overlay would eat every
/// click in the pane underneath.
export const draggingTab = tabDrag;

/// The ghost is a single element for the whole window; `owner` is whichever
/// drop target last had the pointer, so two overlapping targets can't both
/// render one.
const [dragGhost, setDragGhost] = createSignal<{
  owner: string;
  x: number;
  y: number;
  reason: string;
} | null>(null);

export interface TabStripProps {
  tabs: TabDescriptor[];
  /// Id of the tab currently in front, or `null` when nothing is.
  activeId: string | null;
  isPinned: (id: string) => boolean;
  onSelect: (tab: TabDescriptor) => void;
  onClose: (tab: TabDescriptor) => void;
  onReorder: (kind: TabKind, fromId: string, toId: string | null) => void;
  onTogglePin: (id: string) => void;
  /// Buttons pinned to the right edge, after the overflow chevron — the "+"
  /// menu in the workbench, the markdown-preview eye in the editor window.
  trailing?: JSX.Element;

  // ── Pane groups ────────────────────────────────────────────────────────
  // All optional: a window with one group (or none at all, like the editor)
  // passes none of them and gets exactly the strip it had before.

  /// Which pane group this strip belongs to. Presence is what turns on
  /// cross-group drag — a tab can be dragged out of a strip that has an
  /// identity, whether or not its kind is reorderable.
  groupId?: string;
  /// The group header (workbench prompt `<design>`). Omitted with a single
  /// group: today's workbench has no header and grows none. With two or more,
  /// the focused group's strip takes a 2px `--primary` rule and the others
  /// take `--border` — the same 2px either way, so focus moving between groups
  /// never reflows anything.
  groupHeader?: "focused" | "unfocused";
  /// The group's aggregate activity mark (§7.5.3 escalation). Wave 5 fills it
  /// in; the slot is reserved from now so its arrival costs no layout.
  groupActivity?: ActivitySignal;
  /// Clicking anywhere in the strip focuses its group.
  onFocusGroup?: () => void;
  /// A tab from another group landed here. `beforeTabId` is the tab it should
  /// land in front of, or `null` for the end of the strip. When the payload
  /// carries a `tabGroupId` this is a whole group arriving.
  onMoveTab?: (payload: TabDragPayload, beforeTabId: string | null) => void;

  // ── Tab groups ─────────────────────────────────────────────────────────
  // Also all optional. A strip given none of them renders exactly the row it
  // rendered before groups existed, which is what the editor window gets.

  /// The labelled groups in this strip, in render order. A tab in none of them
  /// renders exactly as it does without groups at all.
  tabGroups?: TabGroup[];
  /// The aggregate mark for a *collapsed* group's chip (§7.5.3 escalation).
  /// A collapsed group hides its members' own marks, so this is where they go.
  tabGroupActivity?: (tabGroupId: string) => ActivitySignal | undefined;
  onToggleTabGroup?: (tabGroupId: string) => void;
  onRenameTabGroup?: (tabGroupId: string, label: string) => void;
  onRecolorTabGroup?: (tabGroupId: string, color: TabGroupColor) => void;
  onDissolveTabGroup?: (tabGroupId: string) => void;
  /// Wrap these tabs in a new group. Reached from the tab context menu, so
  /// grouping has a keyboard-and-pointer path and not only a drag.
  onCreateTabGroup?: (tabIds: string[]) => void;
  /// Put a tab in a group, or take it out of whichever holds it (`null`).
  onAssignTab?: (
    tabId: string,
    tabGroupId: string | null,
    beforeTabId: string | null,
  ) => void;
  /// Reorder a group within this strip.
  onReorderTabGroup?: (tabGroupId: string, beforeTabGroupId: string | null) => void;
}

/// The colour dot's fill, per token. A static map so Tailwind's scanner sees
/// every class literal — a computed `bg-${color}` would be purged.
const GROUP_DOT: Record<TabGroupColor, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

export function TabStrip(props: TabStripProps) {
  /// Group by kind (in the order the caller first mentions each kind), then
  /// sort pinned tabs to the front of their own group. Sorting at render time
  /// rather than in the underlying lists is what lets drag-and-drop keep
  /// operating on real array order — pinning never silently reorders anything.
  const ordered = createMemo(() => {
    const groups = new Map<TabKind, TabDescriptor[]>();
    for (const tab of props.tabs) {
      const group = groups.get(tab.kind);
      if (group) group.push(tab);
      else groups.set(tab.kind, [tab]);
    }
    const out: TabDescriptor[] = [];
    for (const group of groups.values()) {
      out.push(
        ...[...group].sort(
          (a, b) => (props.isPinned(a.id) ? 0 : 1) - (props.isPinned(b.id) ? 0 : 1),
        ),
      );
    }
    return out;
  });

  // ── Tab groups ───────────────────────────────────────────────────────────
  // The arrangement decision itself is `stripEntries` in `tabGroups.ts`; what
  // is here is only flattening it into rows the strip can render.

  /// Tab id → the group holding it, for the drop handlers. A drop's *position*
  /// is what decides membership, so both ends of a drag need this.
  const groupOfTabId = createMemo(() => {
    const out = new Map<string, string>();
    for (const group of props.tabGroups ?? []) {
      for (const id of group.tabIds) out.set(id, group.id);
    }
    return out;
  });

  type StripRow =
    | { kind: "chip"; group: TabGroup; count: number }
    | { kind: "tab"; tab: TabDescriptor };

  /// The flat row list. A collapsed group contributes its chip and nothing
  /// else; an expanded one contributes its chip followed by its members.
  const rows = createMemo<StripRow[]>(() => {
    const tabs = ordered();
    const groups = props.tabGroups ?? [];
    if (groups.length === 0) return tabs.map((tab) => ({ kind: "tab" as const, tab }));
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const out: StripRow[] = [];
    for (const entry of stripEntries(
      tabs.map((t) => t.id),
      groups,
    )) {
      if (entry.kind === "tab") {
        const tab = byId.get(entry.tabId);
        if (tab) out.push({ kind: "tab", tab });
        continue;
      }
      out.push({ kind: "chip", group: entry.group, count: entry.tabIds.length });
      if (entry.group.collapsed) continue;
      for (const id of entry.tabIds) {
        const tab = byId.get(id);
        if (tab) out.push({ kind: "tab", tab });
      }
    }
    return out;
  });

  /// The last *tab* row, for the append caret. A chip is never the caret's
  /// anchor: appending lands after the tabs, not after a group header.
  const lastTabId = () => {
    const list = rows();
    for (let i = list.length - 1; i >= 0; i--) {
      const row = list[i];
      if (row.kind === "tab") return row.tab.id;
    }
    return null;
  };

  // ── Drag state ───────────────────────────────────────────────────────────
  // Two different gestures share one drag. *Within* a strip a drag reorders,
  // and tabs of different kinds cannot cross each other because they live in
  // separate arrays in the store. *Between* groups a drag moves the tab, which
  // touches no store array at all — only the group's claim list — so it has
  // neither of those constraints.
  const [dropRef, setDropRef] = createSignal<string | null>(null);
  /// Insertion caret past the last tab, for a drop on the strip's empty space.
  const [dropAtEnd, setDropAtEnd] = createSignal(false);

  /// True when the in-flight drag came from another group and would therefore
  /// *move* rather than reorder.
  const incoming = () => {
    const drag = tabDrag();
    return !!drag && !!props.groupId && drag.groupId !== props.groupId;
  };

  function resetDrag() {
    setTabDrag(null);
    setDropRef(null);
    setDropAtEnd(false);
    setDragGhost(null);
  }

  function onDragStart(e: DragEvent, tab: TabDescriptor) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/voidlink-item", `${tab.kind}:${tab.id}`);
    setTabDrag({
      kind: tab.kind,
      id: tab.id,
      label: tab.label,
      groupId: props.groupId ?? null,
    });
  }

  /// Start dragging a whole tab group. Same payload as a tab drag with
  /// `tabGroupId` set, so every drop target that only knows about tabs keeps
  /// behaving — it sees the group's first member and moves the lot.
  function onGroupDragStart(e: DragEvent, group: TabGroup, memberIds: string[]) {
    if (!e.dataTransfer) return;
    const first = props.tabs.find((t) => t.id === memberIds[0]);
    if (!first) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/voidlink-item", `tabgroup:${group.id}`);
    setTabDrag({
      kind: first.kind,
      id: first.id,
      label: group.label,
      groupId: props.groupId ?? null,
      tabGroupId: group.id,
    });
  }

  /// Can the in-flight drag land on `tab`? Either as a move from another group
  /// (any kind), as a reorder within this strip (same kind, reorderable, not
  /// onto itself), or as a membership change — joining or leaving a tab group,
  /// which is possible across kinds because it touches no store array.
  function canLandOn(tab: TabDescriptor): boolean {
    const drag = tabDrag();
    if (!drag) return false;
    if (incoming()) return true;
    if (drag.id === tab.id) return false;
    // A whole group cannot be dropped onto a tab inside its own strip; it is
    // reordered against other *groups*, not slotted between tabs.
    if (drag.tabGroupId) return false;
    if (drag.kind === tab.kind && isReorderable(tab)) return true;
    return (
      !!props.onAssignTab &&
      groupOfTabId().get(tab.id) !== groupOfTabId().get(drag.id)
    );
  }

  function onDragOver(e: DragEvent, tab: TabDescriptor) {
    if (!canLandOn(tab)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropRef(tab.id);
    setDropAtEnd(false);
  }

  function onDrop(e: DragEvent, tab: TabDescriptor) {
    const drag = tabDrag();
    if (!drag || !canLandOn(tab)) {
      resetDrag();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (incoming()) {
      props.onMoveTab?.(drag, tab.id);
      // A tab dragged into another pane lands wherever it was dropped, which
      // means joining the group it was dropped into (or none).
      if (!drag.tabGroupId) {
        const target = groupOfTabId().get(tab.id) ?? null;
        if (target) props.onAssignTab?.(drag.id, target, tab.id);
      }
    } else {
      // Two independent outcomes of one drop: position within the kind's own
      // array, and membership of a tab group. Neither implies the other.
      if (drag.kind === tab.kind && isReorderable(tab)) {
        props.onReorder(tab.kind, drag.id, tab.id);
      }
      const target = groupOfTabId().get(tab.id) ?? null;
      const source = groupOfTabId().get(drag.id) ?? null;
      if (target !== source) props.onAssignTab?.(drag.id, target, tab.id);
    }
    resetDrag();
  }

  /// A drop on a group's chip. A tab joins the group; another group reorders
  /// in front of it, or moves in from another strip.
  function onChipDrop(e: DragEvent, group: TabGroup) {
    const drag = tabDrag();
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    if (drag.tabGroupId) {
      if (drag.tabGroupId !== group.id) {
        if (incoming()) props.onMoveTab?.(drag, null);
        else props.onReorderTabGroup?.(drag.tabGroupId, group.id);
      }
    } else if (incoming()) {
      props.onMoveTab?.(drag, null);
      props.onAssignTab?.(drag.id, group.id, null);
    } else {
      props.onAssignTab?.(drag.id, group.id, null);
    }
    resetDrag();
  }

  /// A drop on the strip's empty space appends. Reached only when the event
  /// did not come from a tab row — those stop propagation above.
  function onStripDragOver(e: DragEvent) {
    const drag = tabDrag();
    if (!drag) return;
    if (!incoming() && !drag.tabGroupId && !canLeaveGroupHere(drag) && !isReorderableKindHere(drag))
      return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropRef(null);
    setDropAtEnd(true);
  }

  function onStripDrop(e: DragEvent) {
    const drag = tabDrag();
    if (!drag) return;
    e.preventDefault();
    if (drag.tabGroupId) {
      if (incoming()) props.onMoveTab?.(drag, null);
      else props.onReorderTabGroup?.(drag.tabGroupId, null);
    } else if (incoming()) {
      props.onMoveTab?.(drag, null);
    } else {
      if (isReorderableKindHere(drag)) props.onReorder(drag.kind, drag.id, null);
      // The strip's empty space is *outside* every group, so a drop there is
      // how a tab leaves one. Without this the only way out of a group would
      // be a menu, and the drag that put it in would have no inverse.
      if (canLeaveGroupHere(drag)) props.onAssignTab?.(drag.id, null, null);
    }
    resetDrag();
  }

  const canLeaveGroupHere = (drag: TabDragPayload) =>
    !!props.onAssignTab && groupOfTabId().has(drag.id);

  /// Appending within the same strip only makes sense for a kind this strip
  /// actually holds — otherwise "move to the end" would target another kind's
  /// array.
  const isReorderableKindHere = (drag: TabDragPayload) =>
    props.tabs.some((t) => t.kind === drag.kind && isReorderable(t));

  /// The insertion caret: 2px `--primary` on the edge the tab would land on.
  /// It is an inset shadow rather than an element, so the row it marks does not
  /// move by a single pixel while the caret is on it.
  const CARET_BEFORE = "shadow-[inset_2px_0_0_0_var(--color-primary,theme(colors.primary))]";
  const CARET_AFTER = "shadow-[inset_-2px_0_0_0_var(--color-primary,theme(colors.primary))]";

  /// One tab, as a **contained card** (Direction D1, wave 2).
  ///
  /// Tabs used to be segments of a strip, divided by a `border-r` hairline.
  /// They are now cards seated on the strip surface, separated by
  /// `--space-3xs` and rounded to `--island-radius-inner`. Three rules govern
  /// this and each one is easy to undo by accident:
  ///
  ///   • **The card carries the only edge in the composition.** The island it
  ///     sits on has none (MASTER's no-card-in-card rule): if both had one,
  ///     the island's is the one to drop, and it already is.
  ///   • **`border-width` never changes.** Every card is bordered in every
  ///     state; inactive cards' borders are simply transparent. State goes to
  ///     `border-color` and `background-color` only, so nothing reflows when a
  ///     tab is hovered or activated (§7.6's no-layout-shift rule).
  ///   • **The card's height is fixed** at `h-7` inside the `h-9` strip, and
  ///     the breathing room above and below comes from the strip's own
  ///     `items-center` rather than from a margin. That matters: a grouped
  ///     strip also carries a 2px group-focus rule on its top edge, which
  ///     takes 2px out of the content box, and a hardcoded `my-1` would push
  ///     the cards 1px past it at each end. Centring absorbs it. The strip's
  ///     height itself is load-bearing — it lines up with the rail and both
  ///     sidebar headers across all three columns (§5's density audit).
  function tabClasses(tab: TabDescriptor, active: boolean) {
    const base =
      "group relative flex items-center gap-1.5 px-2.5 h-7 mx-[var(--space-3xs)] rounded-[var(--island-radius-inner)] border shrink-0 text-[13px] cursor-pointer select-none transition-colors";
    const tone = active
      ? "bg-background text-foreground border-border"
      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 hover:border-border/60";
    const drag = tabDrag();
    const dim = drag && drag.id === tab.id ? "opacity-50" : "";
    const indicator = dropRef() === tab.id
      ? CARET_BEFORE
      : dropAtEnd() && lastTabId() === tab.id
        ? CARET_AFTER
        : "";
    return `${base} ${tone} ${dim} ${indicator}`;
  }

  // ── Overflow detection ───────────────────────────────────────────────────
  // ResizeObserver covers width changes from window resize / sidebar collapse;
  // the effect over the tab count covers adding or closing a tab pushing the
  // strip across the threshold without the element itself changing size.
  let scrollRef: HTMLDivElement | undefined;
  const [overflowing, setOverflowing] = createSignal(false);

  function recomputeOverflow() {
    if (!scrollRef) return;
    setOverflowing(scrollRef.scrollWidth > scrollRef.clientWidth + 1);
  }

  onMount(() => {
    if (!scrollRef) return;
    recomputeOverflow();
    const ro = new ResizeObserver(() => recomputeOverflow());
    ro.observe(scrollRef);
    onCleanup(() => ro.disconnect());
  });

  createEffect(() => {
    void ordered().length;
    // Wait a microtask so layout has settled before measuring.
    queueMicrotask(recomputeOverflow);
  });

  // ── Context menu ─────────────────────────────────────────────────────────
  const [ctx, setCtx] = createSignal<{ x: number; y: number; tab: TabDescriptor } | null>(
    null,
  );
  const closeCtx = () => setCtx(null);

  function openCtx(e: MouseEvent, tab: TabDescriptor) {
    e.preventDefault();
    setGroupCtx(null);
    setCtx({ x: e.clientX, y: e.clientY, tab });
  }

  /// The group chip's own menu — recolour, collapse, dissolve. Separate from
  /// the tab menu because it acts on a different object; folding it in would
  /// give the tab menu four rows that are not about the tab.
  const [groupCtx, setGroupCtx] = createSignal<{
    x: number;
    y: number;
    group: TabGroup;
  } | null>(null);
  const closeGroupCtx = () => setGroupCtx(null);

  function openGroupCtx(e: MouseEvent, group: TabGroup) {
    e.preventDefault();
    setCtx(null);
    setGroupCtx({ x: e.clientX, y: e.clientY, group });
  }

  /// Close every unpinned tab of the same kind except `keep`. Derived from the
  /// descriptor list, so neither window has to maintain its own per-kind map of
  /// close functions.
  function closeOthers(keep: TabDescriptor) {
    for (const tab of props.tabs) {
      if (tab.kind !== keep.kind || tab.id === keep.id) continue;
      if (props.isPinned(tab.id)) continue;
      props.onClose(tab);
    }
  }

  function closeAllUnpinned() {
    for (const tab of props.tabs) {
      if (!props.isPinned(tab.id)) props.onClose(tab);
    }
  }

  /// A tab is DOM-draggable when it can be reordered *or* when this strip
  /// belongs to a pane group — a browser tab can't be shuffled within its strip
  /// but can absolutely be dragged into another pane, because moving it between
  /// groups reorders no store array.
  const canDrag = (tab: TabDescriptor) => isReorderable(tab) || props.groupId != null;

  return (
    <div
      // No `border-b`: the strip sits at the top of an island whose body is a
      // different surface, and that colour step is the separation. A hairline
      // here would be a second edge competing with the tab cards' (D1).
      class="flex items-center bg-sidebar shrink-0 h-9"
      classList={{
        // Same 2px in both states — see `groupHeader`. Only the colour moves.
        "border-t-2": !!props.groupHeader,
        "border-t-primary": props.groupHeader === "focused",
        "border-t-border": props.groupHeader === "unfocused",
      }}
      onMouseDown={() => props.onFocusGroup?.()}
    >
      <div
        ref={(el) => (scrollRef = el)}
        onDragOver={onStripDragOver}
        onDrop={onStripDrop}
        class="flex items-center overflow-x-auto scrollbar-none flex-1 min-w-0 h-full"
      >
        {/*
          `Index` rather than `For`: descriptors are rebuilt from scratch on
          every upstream change, so reference-keyed `For` would unmount and
          remount every row — and with it the terminal tabs' process poll — on
          any unrelated edit. Slot-keyed rows survive that; `TerminalTabItem`
          resets itself when the session at its slot actually changes.
        */}
        <Index each={rows()}>
          {(row) => (
            <Show
              when={row().kind === "chip" ? (row() as { group: TabGroup; count: number }) : null}
              fallback={
                <TabRow
                  tab={(row() as { tab: TabDescriptor }).tab}
                  activeId={props.activeId}
                  isPinned={props.isPinned}
                  canDrag={canDrag}
                  tabClasses={tabClasses}
                  onSelect={props.onSelect}
                  onClose={props.onClose}
                  onContextMenu={openCtx}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onDragEnd={resetDrag}
                />
              }
            >
              {(chip) => (
                <TabGroupChip
                  group={chip().group}
                  count={chip().count}
                  activity={props.tabGroupActivity?.(chip().group.id)}
                  dragging={tabDrag()?.tabGroupId === chip().group.id}
                  onToggle={() => props.onToggleTabGroup?.(chip().group.id)}
                  onRename={(label) => props.onRenameTabGroup?.(chip().group.id, label)}
                  onContextMenu={(e) => openGroupCtx(e, chip().group)}
                  onDragStart={(e) =>
                    onGroupDragStart(e, chip().group, chip().group.tabIds)
                  }
                  onDragOver={(e) => {
                    if (!tabDrag()) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                    setDropRef(null);
                    setDropAtEnd(false);
                  }}
                  onDrop={(e) => onChipDrop(e, chip().group)}
                  onDragEnd={resetDrag}
                />
              )}
            </Show>
          )}
        </Index>
      </div>

      {props.trailing}

      {/* The group's aggregate activity mark. Reserved, not conditional: it
          occupies its 8px whether or not a signal is live, so a background
          pane lighting up never nudges the "+" button sideways (§7.5.3 rule
          3). Wave 5 is what starts passing `groupActivity`. */}
      <Show when={props.groupHeader}>
        <LedSlot signal={props.groupActivity} class="mx-1.5" />
      </Show>

      <Show when={overflowing()}>
        <TabOverflowMenu
          tabs={props.tabs}
          activeId={props.activeId}
          onJump={(tab) => props.onSelect(tab)}
        />
      </Show>

      <TabGroupContextMenu
        ctx={groupCtx()}
        onClose={closeGroupCtx}
        onToggle={(id) => {
          props.onToggleTabGroup?.(id);
          closeGroupCtx();
        }}
        onRecolor={(id, color) => {
          props.onRecolorTabGroup?.(id, color);
          closeGroupCtx();
        }}
        onDissolve={(id) => {
          props.onDissolveTabGroup?.(id);
          closeGroupCtx();
        }}
      />

      <TabContextMenu
        ctx={ctx()}
        isPinned={props.isPinned}
        tabGroupId={ctx() ? (groupOfTabId().get(ctx()!.tab.id) ?? null) : null}
        canGroup={!!props.onCreateTabGroup}
        onCreateGroup={(tab) => {
          props.onCreateTabGroup?.([tab.id]);
          closeCtx();
        }}
        onUngroup={(tab) => {
          props.onAssignTab?.(tab.id, null, null);
          closeCtx();
        }}
        onClose={closeCtx}
        onTogglePin={(id) => {
          props.onTogglePin(id);
          closeCtx();
        }}
        onCloseTab={(tab) => {
          props.onClose(tab);
          closeCtx();
        }}
        onCloseOthers={(tab) => {
          closeOthers(tab);
          closeCtx();
        }}
        onCloseAllUnpinned={() => {
          closeAllUnpinned();
          closeCtx();
        }}
      />
    </div>
  );
}

/// One tab row, terminal or otherwise. Extracted so the strip's row list can
/// hold two shapes (a tab, a group chip) without duplicating the terminal /
/// plain fork at each of them.
function TabRow(props: {
  tab: TabDescriptor;
  activeId: string | null;
  isPinned: (id: string) => boolean;
  canDrag: (tab: TabDescriptor) => boolean;
  tabClasses: (tab: TabDescriptor, active: boolean) => string;
  onSelect: (tab: TabDescriptor) => void;
  onClose: (tab: TabDescriptor) => void;
  onContextMenu: (e: MouseEvent, tab: TabDescriptor) => void;
  onDragStart: (e: DragEvent, tab: TabDescriptor) => void;
  onDragOver: (e: DragEvent, tab: TabDescriptor) => void;
  onDrop: (e: DragEvent, tab: TabDescriptor) => void;
  onDragEnd: () => void;
}) {
  const active = () => props.tab.id === props.activeId;
  return (
    <Show
      when={props.tab.terminal}
      fallback={
        <PlainTab
          tab={props.tab}
          active={active()}
          pinned={props.isPinned(props.tab.id)}
          draggable={props.canDrag(props.tab)}
          class={props.tabClasses(props.tab, active())}
          onSelect={() => props.onSelect(props.tab)}
          onClose={() => props.onClose(props.tab)}
          onContextMenu={(e) => props.onContextMenu(e, props.tab)}
          onDragStart={(e) => props.onDragStart(e, props.tab)}
          onDragOver={(e) => props.onDragOver(e, props.tab)}
          onDrop={(e) => props.onDrop(e, props.tab)}
          onDragEnd={props.onDragEnd}
        />
      }
    >
      {(session) => (
        <TerminalTab
          session={session()}
          tab={props.tab}
          active={active()}
          draggable={props.canDrag(props.tab)}
          class={props.tabClasses(props.tab, active())}
          onSelect={() => props.onSelect(props.tab)}
          onClose={() => props.onClose(props.tab)}
          onContextMenu={(e) => props.onContextMenu(e, props.tab)}
          onDragStart={(e) => props.onDragStart(e, props.tab)}
          onDragOver={(e) => props.onDragOver(e, props.tab)}
          onDrop={(e) => props.onDrop(e, props.tab)}
          onDragEnd={props.onDragEnd}
        />
      )}
    </Show>
  );
}

/// A tab group's header chip: colour dot, disclosure triangle, label, and —
/// only while collapsed — the member count and the group's aggregate activity
/// mark.
///
/// Two properties are load-bearing:
///   • **The activity slot is only rendered while collapsed.** An expanded
///     group's members each wear their own mark right there; a chip repeating
///     it would be two controls saying one thing (§7.6).
///   • **Nothing animates.** Collapsing is a disclosure the user drives dozens
///     of times a session, and the strip's rows must not slide (§7.1).
function TabGroupChip(props: {
  group: TabGroup;
  count: number;
  activity?: ActivitySignal;
  dragging: boolean;
  onToggle: () => void;
  onRename: (label: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  function startEditing() {
    setEditing(true);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  function commit() {
    if (!editing()) return;
    const value = inputRef?.value ?? "";
    setEditing(false);
    if (value.trim() && value.trim() !== props.group.label) props.onRename(value);
  }

  return (
    <div
      draggable={!editing()}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
      onContextMenu={props.onContextMenu}
      // A chip is a tab card that happens to hold a group rather than a
      // document, so it takes the same geometry: `h-7` inside the `h-9` strip,
      // `--space-3xs` of separation, `--island-radius-inner`. It keeps a
      // permanent transparent border for the same reason the cards do — state
      // moves `border-color` and `background-color` only, never
      // `border-width`, so hovering a chip cannot reflow the strip (§7.6).
      class="flex items-center gap-1.5 pl-2 pr-1.5 h-7 mx-[var(--space-3xs)] rounded-[var(--island-radius-inner)] border border-transparent shrink-0 text-[12px] select-none cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/30 hover:border-border/60 transition-colors"
      classList={{ "opacity-50": props.dragging }}
      title={
        props.group.collapsed
          ? `${props.group.label} — ${props.count} tab${props.count === 1 ? "" : "s"}, collapsed`
          : props.group.label
      }
      onClick={() => {
        if (!editing()) props.onToggle();
      }}
      onDblClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
    >
      <span class={`w-2 h-2 rounded-full shrink-0 ${GROUP_DOT[props.group.color]}`} />
      <Show
        when={props.group.collapsed}
        fallback={<ChevronDown class="w-3 h-3 shrink-0 opacity-70" />}
      >
        <ChevronRight class="w-3 h-3 shrink-0 opacity-70" />
      </Show>
      <Show
        when={editing()}
        fallback={<span class="truncate max-w-[120px]">{props.group.label}</span>}
      >
        <input
          ref={inputRef}
          value={props.group.label}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          aria-label={`Rename ${props.group.label}`}
          class="w-[110px] bg-muted/40 border border-border rounded px-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </Show>
      {/* Count and mark exist only while collapsed — see the header comment.
          The slot is reserved inside that branch so a signal arriving on a
          collapsed group still costs no layout (§7.5.3 rule 3). */}
      <Show when={props.group.collapsed}>
        <span class="text-[10px] font-mono tabular-nums opacity-70">{props.count}</span>
        <LedSlot signal={props.activity} />
      </Show>
    </div>
  );
}

/// The group chip's right-click menu.
function TabGroupContextMenu(props: {
  ctx: { x: number; y: number; group: TabGroup } | null;
  onClose: () => void;
  onToggle: (id: string) => void;
  onRecolor: (id: string, color: TabGroupColor) => void;
  onDissolve: (id: string) => void;
}) {
  let panelRef: HTMLDivElement | undefined;

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!props.ctx) return;
      if (panelRef?.contains(e.target as Node)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (props.ctx && e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

  const pos = () => {
    const c = props.ctx;
    if (!c) return { left: 0, top: 0 };
    const width = 200;
    const height = 140;
    const pad = 6;
    let left = c.x;
    let top = c.y;
    if (left + width + pad > window.innerWidth) left = window.innerWidth - width - pad;
    if (top + height + pad > window.innerHeight) top = window.innerHeight - height - pad;
    return { left, top };
  };

  return (
    <Show when={props.ctx}>
      {(c) => (
        <Portal>
          <div
            ref={panelRef}
            role="menu"
            class="fixed w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-[13px]"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <div class="px-3 py-1 text-[11px] text-muted-foreground truncate border-b border-border/50">
              {c().group.label}
            </div>
            <MenuItem
              onClick={() => props.onToggle(c().group.id)}
              icon={
                c().group.collapsed ? (
                  <ChevronDown class="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight class="w-3.5 h-3.5" />
                )
              }
            >
              {c().group.collapsed ? "Expand group" : "Collapse group"}
            </MenuItem>
            <div class="px-3 py-1.5 flex items-center gap-1.5">
              <For each={TAB_GROUP_COLORS}>
                {(color) => (
                  <button
                    onClick={() => props.onRecolor(c().group.id, color)}
                    aria-label={`Colour ${color}`}
                    aria-pressed={c().group.color === color}
                    class={`w-4 h-4 rounded-full transition-[box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${GROUP_DOT[color]}`}
                    classList={{ "ring-2 ring-offset-1 ring-ring": c().group.color === color }}
                  />
                )}
              </For>
            </div>
            <MenuItem
              onClick={() => props.onDissolve(c().group.id)}
              icon={<FolderMinus class="w-3.5 h-3.5" />}
            >
              Dissolve group
            </MenuItem>
          </div>
        </Portal>
      )}
    </Show>
  );
}

interface TabChromeProps {
  tab: TabDescriptor;
  active: boolean;
  /// Resolved by the strip, because it depends on whether the strip has a pane
  /// group as well as on the descriptor.
  draggable: boolean;
  class: string;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}

function PlainTab(props: TabChromeProps & { pinned: boolean }) {
  const closable = () => !props.pinned;
  /// The mark itself is derived inside `TabTrailing`, which owns the slot —
  /// §7.5.3 rule 2's ordering lives in `highestSignal` and is not re-decided
  /// per caller.
  return (
    <div
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
      class={props.class}
      onClick={props.onSelect}
      onContextMenu={props.onContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1 && closable()) {
          e.preventDefault();
          props.onClose();
        }
      }}
      title={props.tab.title}
    >
      <Show when={props.pinned} fallback={props.tab.icon}>
        <Pin class="w-3 h-3 shrink-0 text-primary" />
      </Show>
      <span
        class={`truncate ${props.tab.labelWidth ?? "max-w-[140px]"} ${
          props.tab.mono ? "font-mono text-[12px]" : ""
        }`}
        classList={{ italic: props.tab.preview }}
      >
        <Show when={props.tab.prefix}>
          <span
            class={`text-[11px] ${
              props.tab.prefixTone === "warning"
                ? "text-warning"
                : "text-muted-foreground"
            } ${props.tab.mono ? "font-sans" : ""}`}
          >
            {props.tab.prefix}
          </span>
        </Show>
        {props.tab.label}
      </span>
      <TabTrailing
        tab={props.tab}
        closable={closable()}
        closeLabel={`Close ${props.tab.label}`}
        onClose={props.onClose}
      />
      <Show when={props.active}>
        <ActiveRule />
      </Show>
    </div>
  );
}

/// The tab's right-hand slot: its §7.5.3 activity mark at rest, its close
/// button on hover. One box, one fixed size, both states inside it.
///
/// Four things here are load-bearing and each is easy to lose:
///   • The mark **replaces** the close affordance rather than sitting beside
///     it (§7.5.3). A tab wearing both a badge and an × reads as two controls.
///   • The box is `w-4 h-4` whether or not there is a mark and whether or not
///     the tab is closable, so a background pane lighting up never nudges the
///     label (§7.5.3 rule 3, and §7.6's no-layout-shift rule).
///   • `dirty` and `reloaded` are folded in here, so the editor window — which
///     knows about unsaved buffers and disk reloads and nothing else — gets the
///     right mark without ever setting `activity`.
///   • On an *unmarked* tab the close button sits at 60% rather than
///     `opacity-0`: §10.4, a hover-only action is invisible until you already
///     know it is there. It only hides behind hover when a mark owns the slot.
function TabTrailing(props: {
  tab: TabDescriptor;
  /// A signal the *render site* knows and the activity store deliberately does
  /// not — today only the terminal tab's `idle`, which depends on local focus and
  /// must never escalate to a group header. Folded in through `highestSignal`
  /// like every other input, so precedence still decides.
  signal?: ActivitySignal;
  closable: boolean;
  closeLabel: string;
  onClose: () => void;
}) {
  const mark = () =>
    highestSignal([
      props.tab.activity,
      props.signal,
      props.tab.reloaded ? ("finished" as const) : undefined,
      props.tab.dirty ? ("dirty" as const) : undefined,
    ]);
  return (
    <span class="ml-0.5 w-4 h-4 shrink-0 flex items-center justify-center">
      <Show when={mark()}>
        {(signal) => (
          <span classList={{ "group-hover:hidden": props.closable }} class="flex">
            <StatusLed signal={signal()} pending={props.tab.saving} />
          </span>
        )}
      </Show>
      <Show when={props.closable}>
        <span classList={{ "hidden group-hover:flex": !!mark(), flex: !mark() }}>
          <CloseButton label={props.closeLabel} onClose={props.onClose} />
        </span>
      </Show>
    </span>
  );
}

/// A terminal tab. Polls its PTY so the tab can wear the name of whatever is
/// running in it, which is what you actually scan for across a row of shells.
function TerminalTab(props: TabChromeProps & { session: TerminalSession }) {
  const [watch, setWatch] = createSignal<TerminalWatch | null>(null);

  // Keyed on `ptyId`, not on mount: the strip renders slot-keyed rows, so
  // closing a tab hands this component a different session at the same slot,
  // and a mount-only subscription would keep reporting the old shell.
  //
  // The poll itself lives in `store/terminalWatch.ts` now — see its header for
  // why the strip stopped owning it. Subscribing inside `createRoot` gives the
  // subscription a lifetime tied to this `ptyId` rather than to the component,
  // so switching sessions releases the old shell's refcount.
  createEffect(
    on(
      () => ({ tabId: props.tab.id, ptyId: props.session.ptyId }),
      ({ tabId, ptyId }) => {
        const dispose = createRoot((d) => {
          setWatch(watchTerminal(tabId, ptyId));
          return d;
        });
        onCleanup(dispose);
      },
    ),
  );

  const busy = () => watch()?.busy() ?? false;
  /// Busy *and* producing output. `busy` alone is true for the whole life of a
  /// TUI, so it is the label's business (below) and not the LED's.
  const working = () => watch()?.working() ?? false;
  const processName = () => watch()?.processName() ?? null;

  /// While a foreground command runs, the tab wears its name. The static label
  /// ("Terminal 2") stays in the tooltip and comes back when the process exits.
  const displayLabel = () => (busy() && processName()) || props.session.label;

  return (
    <div
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
      class={props.class}
      onClick={props.onSelect}
      onContextMenu={props.onContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          props.onClose();
        }
      }}
      title={
        displayLabel() === props.session.label
          ? props.session.label
          : `${props.session.label} — ${displayLabel()}`
      }
    >
      {/* ONE dot per terminal tab, in the trailing slot.

          There used to be a second, leading LED here. The comment defending it
          claimed the two answered different questions ("is this shell busy?" vs
          "did something happen while I was elsewhere?"); they did not. Both read
          the same `busy` bit off the same poll, both rendered orange, both
          pulsed, and they sat two lines apart. The trailing slot is the one that
          survives because it is the sanctioned path — it escalates to group
          headers, collapsed chips and the status bar, while the leading LED
          escalated nowhere, abused `finished` to mean "idle", and could never be
          off.

          The tradeoff inherited from that choice: the trailing slot is
          hover-shared with the close button, so a marked tab hides its × until
          you hover it. */}
      <span class="max-w-[140px] truncate">{displayLabel()}</span>
      <TabTrailing
        tab={props.tab}
        signal={terminalSignal({ working: working(), focused: props.active })}
        closable
        closeLabel={`Kill ${props.session.label}`}
        onClose={props.onClose}
      />
      <Show when={props.active}>
        <ActiveRule />
      </Show>
    </div>
  );
}

function CloseButton(props: { label: string; onClose: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }}
      // §10.4: a hover-only action is invisible until you already know it is
      // there. 60% at rest, full on hover — the tint shift §7.6 sanctions.
      class="ml-0.5 p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={props.label}
    >
      <X class="w-3 h-3" />
    </button>
  );
}

/// Overflow chevron at the right edge of the strip. Opens a portal popover
/// grouping every tab by kind so any one can be reached without scrolling.
function TabOverflowMenu(props: {
  tabs: TabDescriptor[];
  activeId: string | null;
  onJump: (tab: TabDescriptor) => void;
}) {
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });

  function reposition() {
    if (!btnRef) return;
    const r = btnRef.getBoundingClientRect();
    const width = 280;
    const pad = 6;
    let left = r.right - width;
    if (left < pad) left = pad;
    setPos({ left, top: r.bottom + 4 });
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!open()) return;
      const target = e.target as Node;
      if (btnRef?.contains(target)) return;
      if (panelRef?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

  createEffect(() => {
    if (open()) queueMicrotask(reposition);
  });

  /// Tabs grouped by kind, in first-appearance order, with a human heading.
  const groups = createMemo(() => {
    const out: { kind: TabKind; tabs: TabDescriptor[] }[] = [];
    for (const tab of props.tabs) {
      const group = out.find((g) => g.kind === tab.kind);
      if (group) group.tabs.push(tab);
      else out.push({ kind: tab.kind, tabs: [tab] });
    }
    return out;
  });

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title={`${props.tabs.length} open tabs — show all`}
        aria-label="Show all tabs"
        class="px-1.5 mx-0.5 h-7 self-end mb-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors shrink-0 flex items-center gap-0.5"
      >
        <ChevronsRight class="w-3.5 h-3.5" />
        <span class="text-[10px] font-mono tabular-nums">{props.tabs.length}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panelRef}
            class="fixed w-[280px] max-h-[60vh] overflow-y-auto scrollbar-thin rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-[13px]"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="px-3 pt-1 pb-0.5 text-[10px] tracking-wide text-muted-foreground/70">
                    {KIND_LABELS[group.kind]}
                  </div>
                  <For each={group.tabs}>
                    {(tab) => (
                      <button
                        onClick={() => {
                          props.onJump(tab);
                          setOpen(false);
                        }}
                        title={tab.title}
                        class={`w-full flex items-center gap-2 px-3 py-1 text-left transition-colors ${
                          tab.id === props.activeId
                            ? "bg-accent/60 text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                        }`}
                      >
                        <span class="shrink-0 opacity-70">{tab.icon}</span>
                        <span class="flex-1 truncate font-mono text-[12px]">{tab.label}</span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}

const KIND_LABELS: Record<TabKind, string> = {
  file: "Files",
  terminal: "Terminals",
  diff: "Diffs",
  compare: "Compares",
  stack: "Stacks",
  conflict: "Conflicts",
  history: "Commit graph",
  preview: "Previews",
  timeline: "Timeline",
  mission: "Mission Control",
  browser: "Browser",
  agent: "Agents",
};

/// Single right-click menu rendered as a portal so it escapes the strip's
/// `overflow-x-auto` clipping. Targets one tab at a time.
function TabContextMenu(props: {
  ctx: { x: number; y: number; tab: TabDescriptor } | null;
  isPinned: (id: string) => boolean;
  /// The tab group holding this tab, or `null`. Decides which of the two
  /// grouping rows is offered — never both, because only one of them does
  /// anything (§7.6).
  tabGroupId: string | null;
  canGroup: boolean;
  onCreateGroup: (tab: TabDescriptor) => void;
  onUngroup: (tab: TabDescriptor) => void;
  onClose: () => void;
  onTogglePin: (id: string) => void;
  onCloseTab: (tab: TabDescriptor) => void;
  onCloseOthers: (tab: TabDescriptor) => void;
  onCloseAllUnpinned: () => void;
}) {
  let panelRef: HTMLDivElement | undefined;

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!props.ctx) return;
      const target = e.target as Node;
      if (panelRef?.contains(target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (props.ctx && e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

  /// Clamp inside the viewport — right-clicking near the window edge would
  /// otherwise push half the menu offscreen.
  const pos = () => {
    const c = props.ctx;
    if (!c) return { left: 0, top: 0 };
    const width = 200;
    const height = 160;
    const pad = 6;
    let left = c.x;
    let top = c.y;
    if (left + width + pad > window.innerWidth) left = window.innerWidth - width - pad;
    if (top + height + pad > window.innerHeight) top = window.innerHeight - height - pad;
    return { left, top };
  };

  return (
    <Show when={props.ctx}>
      {(c) => (
        <Portal>
          <div
            ref={panelRef}
            role="menu"
            class="fixed w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-[13px]"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <div class="px-3 py-1 text-[11px] text-muted-foreground truncate border-b border-border/50">
              {c().tab.prefix ?? ""}
              {c().tab.label}
            </div>
            <Show when={isPinnable(c().tab)}>
              <MenuItem
                onClick={() => props.onTogglePin(c().tab.id)}
                icon={
                  props.isPinned(c().tab.id) ? (
                    <PinOff class="w-3.5 h-3.5" />
                  ) : (
                    <Pin class="w-3.5 h-3.5" />
                  )
                }
              >
                {props.isPinned(c().tab.id) ? "Unpin tab" : "Pin tab"}
              </MenuItem>
            </Show>
            <Show when={props.canGroup}>
              <Show
                when={props.tabGroupId === null}
                fallback={
                  <MenuItem
                    onClick={() => props.onUngroup(c().tab)}
                    icon={<FolderMinus class="w-3.5 h-3.5" />}
                  >
                    Remove from group
                  </MenuItem>
                }
              >
                <MenuItem
                  onClick={() => props.onCreateGroup(c().tab)}
                  icon={<FolderPlus class="w-3.5 h-3.5" />}
                >
                  New tab group
                </MenuItem>
              </Show>
            </Show>
            <MenuItem onClick={() => props.onCloseTab(c().tab)} icon={<X class="w-3.5 h-3.5" />}>
              Close tab
            </MenuItem>
            <MenuItem
              onClick={() => props.onCloseOthers(c().tab)}
              icon={<X class="w-3.5 h-3.5" />}
            >
              Close others (this kind)
            </MenuItem>
            <MenuItem onClick={props.onCloseAllUnpinned} icon={<X class="w-3.5 h-3.5" />}>
              Close all unpinned
            </MenuItem>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/// The drop target covering one pane group's body.
///
/// It exists only while a tab is being dragged — the rest of the time there is
/// nothing between the user and the pane. Three outcomes, and each one has to
/// be *visible before release*, because a drag whose result you can only
/// discover by committing to it is not an affordance:
///
///   • Centre 60% — "drop into this group". `bg-primary/10` plus a 1px inset
///     `--primary` border.
///   • Outer 20% of any edge — a split. The prospective new group is filled
///     `bg-primary/15` **at the exact geometry it would occupy**, which is
///     computable because `splitGroup` always halves the group it splits. A
///     generic edge glow would tell the user something is about to happen but
///     not what.
///   • The same edge at the four-group cap — refused: `cursor: no-drop`, no
///     preview, and the reason in the ghost following the pointer. Not a toast:
///     a toast about a gesture arrives after the gesture.
///
/// Only `background` and `opacity` move. The preview's geometry is never
/// animated — it jumps between edges as the pointer crosses zones, which is
/// what makes it readable at drag speed.
export function PaneDropOverlay(props: {
  groupId: string;
  /// From `canSplit(paneLayout())`. False at the cap.
  canSplit: boolean;
  onMoveTab: (payload: TabDragPayload, beforeTabId: string | null) => void;
  onSplitDrop: (
    payload: TabDragPayload,
    orientation: SplitOrientation,
    placement: "before" | "after",
  ) => void;
}) {
  let ref: HTMLDivElement | undefined;
  const [intent, setIntent] = createSignal<DropIntent | null>(null);

  function clear() {
    setIntent(null);
    setDragGhost((g) => (g?.owner === props.groupId ? null : g));
  }

  function onDragOver(e: DragEvent) {
    if (!ref || !tabDrag()) return;
    e.preventDefault();
    const box = ref.getBoundingClientRect();
    const next = dropIntentAt(
      { width: box.width, height: box.height },
      { x: e.clientX - box.left, y: e.clientY - box.top },
      { canSplit: props.canSplit },
    );
    setIntent(next);
    if (e.dataTransfer) e.dataTransfer.dropEffect = next.kind === "refused" ? "none" : "move";
    if (next.kind === "refused") {
      setDragGhost({ owner: props.groupId, x: e.clientX, y: e.clientY, reason: next.reason });
    } else {
      setDragGhost((g) => (g?.owner === props.groupId ? null : g));
    }
  }

  function onDrop(e: DragEvent) {
    const drag = tabDrag();
    const target = intent();
    e.preventDefault();
    clear();
    setTabDrag(null);
    if (!drag || !target) return;
    if (target.kind === "body") props.onMoveTab(drag, null);
    else if (target.kind === "edge") {
      props.onSplitDrop(drag, target.orientation, target.placement);
    }
  }

  const edge = () => {
    const i = intent();
    return i?.kind === "edge" ? i.preview : null;
  };

  return (
    <Show when={draggingTab()}>
      <div
        ref={(el) => (ref = el)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!ref || (e.relatedTarget instanceof Node && ref.contains(e.relatedTarget))) return;
          clear();
        }}
        class="absolute inset-0 z-30 pointer-events-auto"
        classList={{ "cursor-no-drop": intent()?.kind === "refused" }}
        aria-hidden="true"
      >
        <Show when={intent()?.kind === "body"}>
          <div class="absolute inset-0 bg-primary/10 ring-1 ring-inset ring-primary" />
        </Show>
        <Show when={edge()}>
          {(rect) => (
            <div
              class="absolute bg-primary/15 ring-1 ring-inset ring-primary"
              style={{
                left: `${rect().x}px`,
                top: `${rect().y}px`,
                width: `${rect().width}px`,
                height: `${rect().height}px`,
              }}
            />
          )}
        </Show>
      </div>
      <Show when={dragGhost()?.owner === props.groupId ? dragGhost() : null}>
        {(g) => (
          <Portal>
            <div
              class="fixed z-[var(--z-drag)] pointer-events-none rounded-md border border-destructive/60 bg-popover px-2 py-1 text-[11px] text-destructive shadow-lg"
              style={{ left: `${g().x + 14}px`, top: `${g().y + 14}px` }}
            >
              {g().reason}
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  );
}

/// Row in a portal menu. Exported because the workbench's "+" menu and the
/// editor window's file menu render the same kind of row.
export function MenuItem(props: {
  onClick: () => void;
  icon: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <button
      role="menuitem"
      onClick={props.onClick}
      class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
    >
      <span class="text-muted-foreground/80">{props.icon}</span>
      <span class="flex-1">{props.children}</span>
    </button>
  );
}
