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
import { Dynamic, Portal } from "solid-js/web";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  FolderMinus,
  FolderPlus,
  PanelRightClose,
  Pin,
  PinOff,
  SquareDashed,
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
// `void tooltip` keeps the import alive: Solid erases a `use:` directive whose
// symbol it cannot see referenced as a value.
import { tooltip } from "@/components/ui/Tooltip";
void tooltip;
import {
  describeDropIntent,
  dropIntentAt,
  edgeDirection,
  residualRect,
  splitLineRect,
  type DropIntent,
  type Rect,
} from "@/components/layout/paneDrop";
import {
  activeDrag,
  beginDrag,
  dragPointer,
  dropActionLabel,
  insertionIndex,
  registerDropZone,
  type DragPayload,
  type Point,
} from "@/components/layout/dragDrop";
import type { SplitOrientation, TabGroup, TabGroupColor } from "@/store/layout";
import type { TabOrientation } from "@/store/settings";
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
  | "combined"
  | "mission"
  | "browser"
  | "agent"
  | "panegroup";

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
  /// A user-chosen label colour, from the same five chart tokens a tab
  /// group's chip uses (`TAB_GROUP_COLORS`). `undefined` is the tab's
  /// ordinary, unstyled chrome — most tabs never touch this.
  color?: TabGroupColor;
}

/// The active tab's 2px `--primary` rule — **one** of them, for the whole
/// strip, positioned by transform.
///
/// It used to be rendered inside each active tab (MOTION-PLAN F15), which
/// meant switching tabs destroyed the rule in one place and created it in
/// another. There was nothing to animate, because no single element persisted
/// across the change. A shared indicator that slides is the clearest native
/// signal a tab strip can emit, and it survives §7.1's frequency gate — which
/// otherwise forbids animating anything this often — because it *carries
/// information*: it shows where you came from, which a tab that simply lights
/// up cannot.
///
/// Positioned with `translateX` + `width` rather than `left`/`right`.
/// Transforms are the only geometry §7.3.2 permits, and `width` is animated
/// here rather than the transform's `scaleX` because a scaled 2px rule would
/// keep its own scale on the ends — a rounded cap would smear.
///
/// Rendered as a sibling of the scroller rather than a child, so the strip's
/// `overflow-x: auto` cannot clip it and so it does not scroll away from the
/// tab it marks; its offset is measured against the scroller and corrected by
/// `scrollLeft`.
///
/// Inset from the card's own edges by 6px so its ends clear the card's
/// `--island-radius-inner` corners instead of poking past them.
const RULE_INSET = 6;

/// Where the active card sits along the strip's own axis, in px. `start` is
/// `offsetLeft` in a horizontal strip and `offsetTop` in a vertical one, and
/// `extent` is the matching width or height — which is the whole of what the
/// two orientations differ by, so the measuring code stays single.
interface IndicatorRect {
  start: number;
  extent: number;
}

function ActiveIndicator(props: {
  /// `null` when nothing is active — a strip with no active tab (an editor
  /// window showing nothing) shows no rule.
  rect: IndicatorRect | null;
  /// Suppresses the transition for the first placement. Sliding in from x=0 on
  /// mount is motion that describes a journey that never happened.
  instant: boolean;
  /// A vertical strip's rule runs down the card's *leading* edge rather than
  /// under its bottom one. It is the same element with the same
  /// transform-driven placement — only the axis changes, so a strip that is
  /// re-oriented while a tab is active does not destroy and recreate it.
  vertical: boolean;
}) {
  const extent = () => (props.rect ? Math.max(0, props.rect.extent - RULE_INSET * 2) : 0);
  const offset = () => (props.rect?.start ?? 0) + RULE_INSET;
  return (
    <span
      aria-hidden="true"
      data-motion="tab-indicator"
      class={[
        "pointer-events-none absolute bg-primary",
        props.vertical ? "top-0 left-0 w-0.5" : "bottom-0 left-0 h-0.5",
        props.instant
          ? ""
          : "transition-[transform,width,height,opacity] duration-[var(--dur-short)] ease-out",
      ].join(" ")}
      style={{
        opacity: props.rect ? 1 : 0,
        ...(props.vertical
          ? { height: `${extent()}px`, transform: `translateY(${offset()}px)` }
          : { width: `${extent()}px`, transform: `translateX(${offset()}px)` }),
      }}
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
// the strip it came from. The gesture itself lives in `dragDrop.ts` (see that
// module's header for why it is pointer events and not HTML5 DnD); what is
// here is only the tab-shaped reading of its payload.

/// A tab (or a whole tab group) in flight.
///
/// A narrowing of `DragPayload` rather than a type of its own: one controller
/// carries every drag in the app, and a second payload shape beside it is how a
/// drop target ends up honouring the wrong one.
export type TabDragPayload = DragPayload;

/// The tab currently being dragged, or `null`. Pane drop targets subscribe to
/// it so their previews exist only during a drag.
export const draggingTab = () => {
  const p = activeDrag();
  return p && (p.kind === "tab" || p.kind === "tabgroup") ? p : null;
};

/// The tab kind a payload carries. Tab drags always set it; the field is
/// optional on `DragPayload` because a workspace or a path has no such thing.
const payloadKind = (p: DragPayload) => (p.tabKind ?? "") as TabKind;

/// Distinguishes two mounted strips that share a pane group id — or share the
/// absence of one, which every strip in the editor window does. Drop zone ids
/// have to be unique per *mounted component*, and a pane group id is not.
let stripSeq = 0;

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
  /// A vertical strip puts them in a footer row along its bottom edge instead,
  /// which is the same place relative to the *reading order* of the strip.
  trailing?: JSX.Element;

  /// Which way the strip runs. Absent means horizontal, so every existing
  /// caller keeps the strip it had. See `TabOrientation` in `store/settings.ts`.
  ///
  /// The type is imported for its shape only — this module still takes no
  /// store, because the editor window has none. Both callers read the
  /// preference and pass it down.
  orientation?: TabOrientation;
  /// The column's width in px while `orientation` is `vertical`; ignored
  /// otherwise. The caller owns it because the caller owns the preference.
  width?: number;

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
  /// Collapse this pane, handing its tabs back to the first group.
  ///
  /// Rendered only alongside `groupHeader`, which is to say only when there is
  /// more than one pane — the last pane is not closable and a control that is
  /// always disabled is not a control. The strip is where it belongs because
  /// the strip is the only chrome a pane has: the "header" is a 2px rule, and
  /// hanging a button off a rule is not a place a user would look.
  onClosePane?: () => void;
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

  // ── Per-tab rename and colour ─────────────────────────────────────────────
  // F2 (on the active tab) and double-click both start renaming, matching the
  // group chip's own two paths (`TabGroupChip`, above). `null` clears back to
  // the kind's derived label / the tab's unstyled default. Both absent (the
  // editor window's four kinds do not opt in yet) renders exactly today's row.
  onRenameTab?: (tabId: string, label: string | null) => void;
  onRecolorTab?: (tabId: string, color: TabGroupColor | null) => void;

  // ── "Add to split pane" ───────────────────────────────────────────────────
  /// Every `panegroup` tab open in this worktree, for "add to an existing
  /// split" rows in the tab context menu. Empty (or absent) leaves only "new
  /// split" — there is nothing existing to offer.
  splitPaneTargets?: { id: string; label: string }[];
  /// `null` enables the row; any other string is the reason it is disabled
  /// (§7.6) — a `panegroup` tab cannot itself be split into, and the row has
  /// nowhere to reach the pane-group action from in a window with no store
  /// (the editor window never provides this at all).
  addToSplitPaneDisabledReason?: (tab: TabDescriptor) => string | null;
  /// Move a tab into `targetId`'s split, or a fresh one when omitted.
  onAddToSplitPane?: (tabId: string, targetId?: string) => void;
}

/// The colour dot's fill, per token. A static map so Tailwind's scanner sees
/// every class literal — a computed `bg-${color}` would be purged.
/// Bounds for the vertical tab column, in px, and the width a fresh install
/// gets. The floor is where a tab card stops being able to show an icon, a
/// readable label and its trailing slot at once; the ceiling is where the
/// column stops being a strip and starts being a second sidebar.
///
/// Here rather than in `store/layout`'s `PANEL_BOUNDS` because the width is a
/// property of the *preference* (`ui.verticalTabWidth`), not of the layout — a
/// layout reset must not silently take the column back to 200px.
export const VERTICAL_TAB_WIDTH = { min: 140, max: 400, default: 200 };

const GROUP_DOT: Record<TabGroupColor, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

export function TabStrip(props: TabStripProps) {
  stripSeq += 1;
  const stripInstanceId = stripSeq;
  /// The one predicate the whole orientation fork hangs off. Everything below
  /// that differs between a row of tabs and a column of them reads this rather
  /// than re-deriving it, so there is exactly one place the default (absent
  /// prop ⇒ horizontal) is decided.
  const vertical = () => props.orientation === "vertical";

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
  // The whole strip is **one** drop zone, not one per tab. That is the change
  // that made mixed-kind ordering expressible: a zone answers "where in this
  // strip would a release land" by measuring the rows it already rendered, so
  // the answer is a *position*, and a position knows nothing about kinds. It
  // also means the strip can never be left holding an insertion caret for a
  // drag that has moved on — the controller guarantees exactly one live zone
  // and calls `leave` on the one before it.
  //
  // Three outcomes come out of one drop, and none of them implies another:
  //   • the pane claim (which strip shows the tab) — `onMoveTab`,
  //   • the position within the kind's own store array — `onReorder`,
  //   • membership and position within a tab group — `onAssignTab`.

  /// The tab an insertion would land in front of, and whether it would land
  /// past the last row. Both drive the caret only; the drop re-measures.
  const [dropBefore, setDropBefore] = createSignal<string | null>(null);
  const [dropAtEnd, setDropAtEnd] = createSignal(false);
  /// The tab group the slot under the pointer is inside, for the chip's own
  /// "this is where it lands" tint.
  const [dropGroup, setDropGroup] = createSignal<string | null>(null);

  /// True when the in-flight drag came from another pane group and would
  /// therefore *move* rather than reorder.
  const incoming = (p: DragPayload) =>
    !!props.groupId && (p.paneGroupId ?? null) !== props.groupId;

  function clearDropMarks() {
    setDropBefore(null);
    setDropAtEnd(false);
    setDropGroup(null);
  }

  const kindOfTabId = createMemo(() => {
    const out = new Map<string, TabKind>();
    for (const t of props.tabs) out.set(t.id, t.kind);
    return out;
  });
  const reorderableIds = createMemo(
    () => new Set(props.tabs.filter(isReorderable).map((t) => t.id)),
  );

  function startTabDrag(e: PointerEvent, tab: TabDescriptor) {
    if (!canDrag(tab)) return;
    beginDrag(e, {
      kind: "tab",
      id: tab.id,
      label: tab.label,
      tabKind: tab.kind,
      paneGroupId: props.groupId ?? null,
    });
  }

  /// Drag a whole tab group. `id` is its first member so a target that only
  /// understands tabs still behaves; `tabGroupId` is what makes it move as one.
  function startGroupDrag(e: PointerEvent, group: TabGroup, memberIds: string[]) {
    const first = props.tabs.find((t) => t.id === memberIds[0]);
    if (!first) return;
    beginDrag(e, {
      kind: "tabgroup",
      id: first.id,
      label: group.label,
      tabKind: first.kind,
      paneGroupId: props.groupId ?? null,
      tabGroupId: group.id,
    });
  }

  // ── Where a release would land ───────────────────────────────────────────

  interface MeasuredRow {
    kind: "tab" | "chip";
    /// A tab id, or a tab-group id for a chip.
    id: string;
    /// For a tab: the group holding it, if any.
    tabGroupId: string | null;
    rect: DOMRect;
  }

  /// The strip's rendered rows, measured, in visual order. Read from the DOM
  /// rather than derived from `rows()` because the question is geometric and
  /// the DOM is the only thing that knows where a row actually ended up —
  /// including after the scroller has been scrolled.
  function measureRows(): MeasuredRow[] {
    const host = scrollRef;
    if (!host) return [];
    const groups = groupOfTabId();
    const out: MeasuredRow[] = [];
    for (const el of host.querySelectorAll<HTMLElement>(
      "[data-tab-id],[data-tab-group-id]",
    )) {
      const groupId = el.dataset.tabGroupId;
      if (groupId) {
        out.push({ kind: "chip", id: groupId, tabGroupId: groupId, rect: el.getBoundingClientRect() });
        continue;
      }
      const id = el.dataset.tabId;
      if (!id) continue;
      out.push({
        kind: "tab",
        id,
        tabGroupId: groups.get(id) ?? null,
        rect: el.getBoundingClientRect(),
      });
    }
    return out;
  }

  interface StripTarget {
    /// The tab the dropped tab lands in front of, or `null` for the end.
    beforeTabId: string | null;
    /// The tab group the slot is inside, or `null` for "outside every group".
    tabGroupId: string | null;
    /// For a group drag: the group it lands in front of, or `null` for the end.
    beforeGroupId: string | null;
  }

  /// Resolve a point to a slot in this strip.
  ///
  /// The rule for group membership is positional and has one deliberate
  /// asymmetry: a slot immediately after a chip, or between two members, is
  /// *inside* that group — but the slot past the very last row is outside every
  /// group. That last one is what gives a tab a way out of a group by drag, so
  /// the gesture that puts it in has an inverse (§7.6).
  function targetAt(at: Point): StripTarget {
    const rows = measureRows();
    const i = insertionIndex(
      rows.map((r) => r.rect),
      at,
      vertical() ? "y" : "x",
    );
    const next = rows[i] ?? null;
    const prev = rows[i - 1] ?? null;

    // A chip is never the anchor tab: an insertion in front of a group header
    // is an insertion in front of the whole group, not into it.
    const beforeTabId = next?.kind === "tab" ? next.id : null;

    let tabGroupId: string | null = null;
    if (prev?.kind === "chip") tabGroupId = prev.id;
    else if (prev?.kind === "tab" && prev.tabGroupId && next) tabGroupId = prev.tabGroupId;

    const beforeGroupId = rows.slice(i).find((r) => r.kind === "chip")?.id ?? null;
    return { beforeTabId, tabGroupId, beforeGroupId };
  }

  /// The label for a tab landing at `target`. Says what changes, and names the
  /// group when membership is what changes — "Add to Review" tells the user
  /// something "Move here" does not.
  function describeTabDrop(p: DragPayload, target: StripTarget): string {
    const groups = props.tabGroups ?? [];
    const nameOf = (id: string) => groups.find((g) => g.id === id)?.label ?? "group";
    const from = groupOfTabId().get(p.id) ?? null;
    const to = target.tabGroupId;
    if (incoming(p)) {
      return to ? `Move into “${nameOf(to)}”` : "Move to this pane";
    }
    if (to !== from) {
      if (to) return `Add to “${nameOf(to)}”`;
      if (from) return `Remove from “${nameOf(from)}”`;
    }
    return target.beforeTabId ? "Reorder" : "Move to the end";
  }

  function stripOver(p: DragPayload, at: Point): string | null {
    if (p.kind === "tabgroup") {
      const target = targetAt(at);
      // A group is reordered against other groups, never slotted between
      // tabs — so no tab caret, and the chip is the only affordance.
      clearDropMarks();
      if (incoming(p)) return "Move this group to the pane";
      if (p.tabGroupId === target.beforeGroupId) return null;
      return target.beforeGroupId ? "Reorder group" : "Move group to the end";
    }
    const target = targetAt(at);
    // Dropping a tab exactly where it already is changes nothing, and a ghost
    // that promises "Reorder" for a no-op is a ghost that lies.
    if (
      !incoming(p) &&
      target.beforeTabId === p.id &&
      (groupOfTabId().get(p.id) ?? null) === target.tabGroupId
    ) {
      clearDropMarks();
      return null;
    }
    setDropBefore(target.beforeTabId);
    setDropAtEnd(target.beforeTabId === null);
    setDropGroup(target.tabGroupId);
    return describeTabDrop(p, target);
  }

  function stripDrop(p: DragPayload, at: Point) {
    const target = targetAt(at);
    clearDropMarks();

    if (p.kind === "tabgroup") {
      if (!p.tabGroupId) return;
      if (incoming(p)) props.onMoveTab?.(p, null);
      else props.onReorderTabGroup?.(p.tabGroupId, target.beforeGroupId);
      return;
    }

    if (incoming(p)) props.onMoveTab?.(p, target.beforeTabId);
    else {
      // Position within the kind's own store array. Only a *same-kind* anchor
      // means anything there — the arrays are per kind — so the anchor is the
      // first same-kind tab at or after the slot, and "none" means the end.
      const kind = payloadKind(p);
      if (reorderableIds().has(p.id) && props.tabs.some((t) => t.kind === kind)) {
        props.onReorder(kind, p.id, sameKindAnchor(target.beforeTabId, kind, p.id));
      }
    }
    // Membership *and* position inside the group, always: this is the only
    // order that can hold tabs of different kinds, because it is the only one
    // that is not a per-kind array.
    props.onAssignTab?.(p.id, target.tabGroupId, target.beforeTabId);
  }

  /// The first tab of `kind` at or after the slot anchored by `beforeTabId`.
  /// `null` means "append", which is what a slot past the last tab of that kind
  /// means for that kind's array.
  function sameKindAnchor(
    beforeTabId: string | null,
    kind: TabKind,
    dragId: string,
  ): string | null {
    if (!beforeTabId) return null;
    const order = rows().flatMap((r) => (r.kind === "tab" ? [r.tab.id] : []));
    const from = order.indexOf(beforeTabId);
    if (from < 0) return null;
    for (let i = from; i < order.length; i++) {
      const id = order[i];
      if (id !== dragId && kindOfTabId().get(id) === kind) return id;
    }
    return null;
  }

  registerDropZone({
    // One per mounted strip. The pane group is not enough on its own — the
    // editor window has strips with no pane group at all.
    id: `strip:${props.groupId ?? "solo"}:${stripInstanceId}`,
    el: () => scrollRef,
    // Above the pane body it sits on: a drop on the strip is about tab order,
    // and a drop on the body is about panes.
    priority: 2,
    accepts: (p) => p.kind === "tab" || p.kind === "tabgroup",
    over: stripOver,
    leave: clearDropMarks,
    drop: stripDrop,
  });

  /// The insertion caret: 2px `--primary` on the edge the tab would land on.
  /// It is an inset shadow rather than an element, so the row it marks does not
  /// move by a single pixel while the caret is on it.
  ///
  /// "Before" and "after" are along the strip's own axis — a leading edge is
  /// the card's left in a row and its top in a column. A caret that stayed on
  /// the left edge in a vertical strip would point across the direction the
  /// tab is actually about to move.
  const CARET_BEFORE_X = "shadow-[inset_2px_0_0_0_var(--color-primary,theme(colors.primary))]";
  const CARET_AFTER_X = "shadow-[inset_-2px_0_0_0_var(--color-primary,theme(colors.primary))]";
  const CARET_BEFORE_Y = "shadow-[inset_0_2px_0_0_var(--color-primary,theme(colors.primary))]";
  const CARET_AFTER_Y = "shadow-[inset_0_-2px_0_0_var(--color-primary,theme(colors.primary))]";
  const caretBefore = () => (vertical() ? CARET_BEFORE_Y : CARET_BEFORE_X);
  const caretAfter = () => (vertical() ? CARET_AFTER_Y : CARET_AFTER_X);

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
  ///
  /// A vertical strip changes exactly two things about the card: the
  /// separation moves to the cross axis (`my-` rather than `mx-`), and the
  /// card stops being `shrink-0`-in-a-row and instead fills the column's
  /// width. Its height, its radius, its border discipline and its states are
  /// untouched, which is the point — the card is the same object seen from a
  /// different axis, not a second design.
  function tabClasses(tab: TabDescriptor, active: boolean) {
    const base =
      "group relative flex items-center gap-1.5 px-2.5 h-7 rounded-[var(--island-radius-inner)] border shrink-0 text-ui cursor-pointer select-none transition-colors";
    const axis = vertical()
      ? "my-[var(--space-3xs)] mx-[var(--space-2xs)] w-auto"
      : "mx-[var(--space-3xs)]";
    const tone = active
      ? "bg-background text-foreground border-border"
      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 hover:border-border/60";
    const drag = draggingTab();
    const dim = drag && drag.kind === "tab" && drag.id === tab.id ? "opacity-50" : "";
    const indicator = dropBefore() === tab.id
      ? caretBefore()
      : dropAtEnd() && lastTabId() === tab.id
        ? caretAfter()
        : "";
    return `${base} ${axis} ${tone} ${dim} ${indicator}`;
  }

  // ── Overflow detection ───────────────────────────────────────────────────
  // ResizeObserver covers width changes from window resize / sidebar collapse;
  // the effect over the tab count covers adding or closing a tab pushing the
  // strip across the threshold without the element itself changing size.
  let scrollRef: HTMLDivElement | undefined;
  const [overflowing, setOverflowing] = createSignal(false);

  function recomputeOverflow() {
    if (!scrollRef) return;
    setOverflowing(
      vertical()
        ? scrollRef.scrollHeight > scrollRef.clientHeight + 1
        : scrollRef.scrollWidth > scrollRef.clientWidth + 1,
    );
  }

  // ── The shared active indicator (MOTION-PLAN F15) ────────────────────────
  // One rule for the strip, measured off whichever card is active. Measurement
  // is by `offsetLeft`/`offsetWidth` against the scroller — which is
  // `position: relative`, so the cards' `offsetParent` *is* the scroller and
  // the numbers are already in the indicator's own coordinate space. That is
  // also why no `scrollLeft` correction appears anywhere here: the indicator
  // lives inside the scroller and scrolls with the tab it marks, which is the
  // only behaviour that stays truthful when the strip overflows.
  const [indicator, setIndicator] = createSignal<IndicatorRect | null>(null);
  /// True until the indicator has been placed once. A rule that slides in from
  /// the strip's left edge on mount is describing a journey that never
  /// happened.
  const [indicatorInstant, setIndicatorInstant] = createSignal(true);

  function measureIndicator() {
    const host = scrollRef;
    const id = props.activeId;
    if (!host || !id) {
      setIndicator(null);
      return;
    }
    const el = host.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    if (!el) {
      // The active tab is inside a collapsed group, or in another strip. No
      // rule rather than a stale one — the indicator states a fact.
      setIndicator(null);
      return;
    }
    setIndicator(
      vertical()
        ? { start: el.offsetTop, extent: el.offsetHeight }
        : { start: el.offsetLeft, extent: el.offsetWidth },
    );
  }

  function remeasure() {
    recomputeOverflow();
    measureIndicator();
  }

  onMount(() => {
    if (!scrollRef) return;
    remeasure();
    // One frame after the first placement, allow the transition. Doing it on a
    // frame rather than a microtask guarantees the initial values have been
    // painted, so enabling the transition cannot retroactively animate them.
    requestAnimationFrame(() => setIndicatorInstant(false));
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(scrollRef);
    // Cards change width when a terminal tab picks up a running process name,
    // which moves every card after it. `ResizeObserver` on the scroller alone
    // does not see that — the scroller's own size has not changed.
    const mo = new MutationObserver(() => queueMicrotask(measureIndicator));
    mo.observe(scrollRef, { childList: true, subtree: true, characterData: true });
    onCleanup(() => {
      ro.disconnect();
      mo.disconnect();
    });
  });

  createEffect(() => {
    void ordered().length;
    void props.activeId;
    // Flipping the orientation moves every card and changes which axis is
    // measured; changing the column's width moves them again. Neither resizes
    // the *scroller*, so the `ResizeObserver` above does not see either.
    void props.orientation;
    void props.width;
    // Wait a microtask so layout has settled before measuring.
    queueMicrotask(remeasure);
  });

  // ── Per-tab rename ────────────────────────────────────────────────────────
  // One id at a time, strip-wide — the same shape `TabGroupChip` keeps
  // locally for a chip, lifted here because a tab card is a slot-keyed row
  // (`Index`, not `For` — see the comment below) and F2 has to name *which*
  // slot without a pointer having touched it.
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  function startRename(tabId: string) {
    if (props.onRenameTab) setRenamingId(tabId);
  }
  function commitRename(tab: TabDescriptor, value: string) {
    setRenamingId(null);
    const trimmed = value.trim();
    // Unchanged or blank: neither is worth a write, and a blank commit reads
    // as "clear the rename" everywhere else in the app it could be — leaving
    // it alone here instead so an accidental all-select-delete followed by
    // blur does not silently rename the tab back to nothing.
    if (!trimmed || trimmed === tab.label) return;
    props.onRenameTab?.(tab.id, trimmed);
  }

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
      //
      // The group-focus rule follows the strip: it is the strip's *outer* edge
      // in both orientations — the top of a row, the left of a column — so it
      // still reads as the pane's own frame rather than as a divider between
      // the strip and the body. Same 2px either way, so focus moving between
      // groups still costs no layout.
      class="flex bg-surface-tabstrip shrink-0"
      classList={{
        "items-center h-9": !vertical(),
        "flex-col h-full": vertical(),
        "border-t-2": !!props.groupHeader && !vertical(),
        "border-t-primary": props.groupHeader === "focused" && !vertical(),
        "border-t-border": props.groupHeader === "unfocused" && !vertical(),
        "border-l-2": !!props.groupHeader && vertical(),
        "border-l-primary": props.groupHeader === "focused" && vertical(),
        "border-l-border": props.groupHeader === "unfocused" && vertical(),
      }}
      style={vertical() ? { width: `${props.width ?? VERTICAL_TAB_WIDTH.default}px` } : undefined}
      onMouseDown={() => props.onFocusGroup?.()}
    >
      <div
        ref={(el) => (scrollRef = el)}
        // No drag handlers: the scroller *is* the strip's drop zone, registered
        // with the controller above and hit-tested by rect.
        //
        // `relative` is load-bearing twice over: it makes the scroller the
        // cards' `offsetParent` (so `measureIndicator` needs no coordinate
        // arithmetic) and it is what the shared indicator is positioned
        // against.
        //
        // `items-stretch` in the column is what gives a vertical tab the whole
        // width to put a label in — the single reason to want vertical tabs at
        // all, and it is lost the moment a stray `items-center` creeps back.
        class="relative flex scrollbar-none flex-1"
        classList={{
          "items-center overflow-x-auto overflow-y-hidden min-w-0 h-full": !vertical(),
          "flex-col items-stretch overflow-y-auto overflow-x-hidden min-h-0 w-full py-[var(--space-3xs)]":
            vertical(),
        }}
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
                  vertical={vertical()}
                  tabClasses={tabClasses}
                  onSelect={props.onSelect}
                  onClose={props.onClose}
                  onContextMenu={openCtx}
                  onPointerDown={startTabDrag}
                  renamingId={renamingId()}
                  onRenameRequest={props.onRenameTab ? (tab) => startRename(tab.id) : undefined}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingId(null)}
                />
              }
            >
              {(chip) => (
                <TabGroupChip
                  group={chip().group}
                  count={chip().count}
                  activity={props.tabGroupActivity?.(chip().group.id)}
                  dragging={draggingTab()?.tabGroupId === chip().group.id}
                  /// The chip lights up when the slot under the pointer is
                  /// inside its group — the only signal that says "this is the
                  /// group it joins" when the caret is between two members.
                  targeted={dropGroup() === chip().group.id}
                  vertical={vertical()}
                  onToggle={() => props.onToggleTabGroup?.(chip().group.id)}
                  onRename={(label) => props.onRenameTabGroup?.(chip().group.id, label)}
                  onContextMenu={(e) => openGroupCtx(e, chip().group)}
                  onPointerDown={(e) =>
                    startGroupDrag(e, chip().group, chip().group.tabIds)
                  }
                />
              )}
            </Show>
          )}
        </Index>
        {/* Last child, so it paints over the cards rather than under them. */}
        <ActiveIndicator
          rect={indicator()}
          instant={indicatorInstant()}
          vertical={vertical()}
        />
      </div>

      {/* The strip's controls: the "+" menu, the group's aggregate mark, the
          overflow chevron.
          A row keeps them inline at its right end. A column cannot — they would
          each become a full-width row in the tab list — so it gives them a
          fixed footer along its bottom edge, which is the same position in the
          strip's own reading order and lands them beside the status bar rather
          than adrift in the tab column. The hairline is the only border either
          orientation draws inside the strip, and it exists because the footer
          is a different kind of thing from the tabs above it. */}
      <div
        class="flex items-center shrink-0"
        classList={{
          // `h-full` in a row so the overflow chevron's `self-end mb-1` still
          // measures against the strip's own 9-unit height, exactly as it did
          // when these three were direct children of it.
          "h-full": !vertical(),
          "justify-end gap-0.5 h-9 px-1 border-t border-border/50 w-full": vertical(),
        }}
      >
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

        {/* Undoing a split, in the place the split happened. Last in the
            trailing row so it sits at the pane's outside corner, away from the
            "+" — closing the pane and opening a tab in it are opposite
            intents and adjacency invites the wrong one. `PanelRightClose`
            rather than an `×`: an × in a tab strip already means "close the
            tab", and two glyphs a few pixels apart meaning different closes is
            the confusion §7.6 is about. */}
        <Show when={props.groupHeader && props.onClosePane}>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              props.onClosePane?.();
            }}
            class="ml-0.5 p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-accent/40 hover:text-foreground transition-[opacity,background-color,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close this pane"
            // §7.6: the control says what it does, including the part a user
            // would otherwise have to risk a click to find out — that the tabs
            // survive. Losing a terminal to a layout tweak is the fear that
            // stops people using splits at all.
            use:tooltip="Close this pane — its tabs move to the first pane"
          >
            <PanelRightClose class="w-3 h-3" />
          </button>
        </Show>
      </div>

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
        onRecolor={props.onRecolorTab}
        splitPaneTargets={props.splitPaneTargets}
        addToSplitPaneDisabledReason={props.addToSplitPaneDisabledReason}
        onAddToSplitPane={props.onAddToSplitPane}
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
  /// Only reaches the label: a vertical card has the column's whole width, so
  /// the fixed `max-w` truncation that a row needs is exactly wrong there.
  vertical: boolean;
  tabClasses: (tab: TabDescriptor, active: boolean) => string;
  onSelect: (tab: TabDescriptor) => void;
  onClose: (tab: TabDescriptor) => void;
  onContextMenu: (e: MouseEvent, tab: TabDescriptor) => void;
  onPointerDown: (e: PointerEvent, tab: TabDescriptor) => void;
  renamingId: string | null;
  onRenameRequest?: (tab: TabDescriptor) => void;
  onCommitRename: (tab: TabDescriptor, value: string) => void;
  onCancelRename: () => void;
}) {
  const active = () => props.tab.id === props.activeId;
  const renaming = () => props.tab.id === props.renamingId;
  return (
    <Show
      when={props.tab.terminal}
      fallback={
        <PlainTab
          tab={props.tab}
          active={active()}
          pinned={props.isPinned(props.tab.id)}
          vertical={props.vertical}
          class={props.tabClasses(props.tab, active())}
          onSelect={() => props.onSelect(props.tab)}
          onClose={() => props.onClose(props.tab)}
          onContextMenu={(e) => props.onContextMenu(e, props.tab)}
          onPointerDown={(e) => props.onPointerDown(e, props.tab)}
          onRenameRequest={props.onRenameRequest && (() => props.onRenameRequest?.(props.tab))}
          renaming={renaming()}
          onCommitRename={(v) => props.onCommitRename(props.tab, v)}
          onCancelRename={props.onCancelRename}
        />
      }
    >
      {(session) => (
        <TerminalTab
          session={session()}
          tab={props.tab}
          active={active()}
          vertical={props.vertical}
          class={props.tabClasses(props.tab, active())}
          onSelect={() => props.onSelect(props.tab)}
          onClose={() => props.onClose(props.tab)}
          onContextMenu={(e) => props.onContextMenu(e, props.tab)}
          onPointerDown={(e) => props.onPointerDown(e, props.tab)}
          onRenameRequest={props.onRenameRequest && (() => props.onRenameRequest?.(props.tab))}
          renaming={renaming()}
          onCommitRename={(v) => props.onCommitRename(props.tab, v)}
          onCancelRename={props.onCancelRename}
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
  /// The slot under the pointer is inside this group.
  targeted: boolean;
  vertical: boolean;
  onToggle: () => void;
  onRename: (label: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
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
      // What the strip's drop zone measures to find group boundaries.
      data-tab-group-id={props.group.id}
      // A `div` that toggles a disclosure on click is a button that told
      // nobody. It stays a `div` because a real `<button>` cannot host the
      // rename `<input>` this swaps in, so the role, the tab stop and the
      // keyboard activation below are what a `<button>` would have given for
      // free — and `aria-expanded` is what the chevron says to everyone else.
      role={editing() ? undefined : "button"}
      tabIndex={editing() ? undefined : 0}
      aria-expanded={editing() ? undefined : !props.group.collapsed}
      onKeyDown={(e) => {
        if (editing()) return;
        // `F2` renames, matching the double-click the pointer has. Enter and
        // Space toggle, which is what the role promises.
        if (e.key === "F2") {
          e.preventDefault();
          startEditing();
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        props.onToggle();
      }}
      onPointerDown={(e) => {
        // A chip being renamed is a text field, not a grip.
        if (!editing()) props.onPointerDown(e);
      }}
      onContextMenu={props.onContextMenu}
      // A chip is a tab card that happens to hold a group rather than a
      // document, so it takes the same geometry: `h-7` inside the `h-9` strip,
      // `--space-3xs` of separation, `--island-radius-inner`. It keeps a
      // permanent transparent border for the same reason the cards do — state
      // moves `border-color` and `background-color` only, never
      // `border-width`, so hovering a chip cannot reflow the strip (§7.6).
      // Same geometry fork the tab cards take — see `tabClasses`.
      class="flex items-center gap-1.5 pl-2 pr-1.5 h-7 rounded-[var(--island-radius-inner)] border border-transparent shrink-0 text-body select-none cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/30 hover:border-border/60 transition-colors"
      classList={{
        "opacity-50": props.dragging,
        // The one affordance that says "the tab lands in *this* group". It
        // moves `border-color` and `background-color` only — never
        // `border-width` — so a chip lighting up cannot reflow the strip.
        "!border-primary bg-primary/10 text-foreground": props.targeted,
        "mx-[var(--space-3xs)]": !props.vertical,
        "my-[var(--space-3xs)] mx-[var(--space-2xs)]": props.vertical,
      }}
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
        fallback={
          <span
            class="truncate"
            classList={{
              "max-w-[120px]": !props.vertical,
              "flex-1 min-w-0": props.vertical,
            }}
          >
            {props.group.label}
          </span>
        }
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
          class="w-[110px] bg-muted/40 border border-border rounded px-1 text-body focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </Show>
      {/* Count and mark exist only while collapsed — see the header comment.
          The slot is reserved inside that branch so a signal arriving on a
          collapsed group still costs no layout (§7.5.3 rule 3). */}
      <Show when={props.group.collapsed}>
        <span class="text-micro font-mono tabular-nums opacity-70">{props.count}</span>
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
            class="fixed w-[200px] rounded-md border border-border material-chrome text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-ui"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <div class="px-3 py-1 text-label text-muted-foreground truncate border-b border-border/50">
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
  /// See `TabRow.vertical`.
  vertical: boolean;
  class: string;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: MouseEvent) => void;
  /// Offers the press to the drag controller. Nothing happens until the pointer
  /// has actually moved, so this never competes with `onSelect` — and the strip
  /// decides whether this tab may be dragged at all.
  onPointerDown: (e: PointerEvent) => void;
  /// Double-click and, on the active tab, `F2` both start a rename — matching
  /// the group chip's own two paths. Absent when the caller gave no
  /// `onRenameTab` at all, in which case the card renders exactly as it did
  /// before renaming existed.
  onRenameRequest?: () => void;
  /// This card is the one currently swapped for its rename `<input>`.
  renaming: boolean;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
}

/// A tab's rename `<input>`, swapped in for its label span. One
/// implementation shared by `PlainTab` and `TerminalTab` — see the "a chip
/// being renamed is a text field, not a grip" comment on `TabGroupChip`,
/// which this mirrors one level down from the chip to the tab itself.
function EditableTabLabel(props: {
  tab: TabDescriptor;
  displayLabel: string;
  vertical: boolean;
  mono?: boolean;
  renaming: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (!props.renaming) return;
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  return (
    <Show
      when={props.renaming}
      fallback={
        <span
          class={`truncate ${
            props.vertical ? "flex-1 min-w-0" : (props.tab.labelWidth ?? "max-w-[140px]")
          } ${props.mono ? "font-mono text-body" : ""}`}
          classList={{ italic: props.tab.preview }}
        >
          <Show when={props.tab.prefix}>
            <span
              class={`text-label ${
                props.tab.prefixTone === "warning" ? "text-warning" : "text-muted-foreground"
              } ${props.mono ? "font-sans" : ""}`}
            >
              {props.tab.prefix}
            </span>
          </Show>
          {props.displayLabel}
        </span>
      }
    >
      <input
        ref={inputRef}
        value={props.tab.label}
        // A rename is a text field, not a grip or a select — none of these
        // three may reach the card underneath it.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => props.onCommit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onCommit((e.currentTarget as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            props.onCancel();
          }
        }}
        aria-label={`Rename ${props.tab.label}`}
        class={`min-w-0 max-w-[140px] bg-muted/40 border border-border rounded px-1 text-body focus:outline-none focus:ring-1 focus:ring-ring ${
          props.vertical ? "flex-1" : ""
        }`}
      />
    </Show>
  );
}

function PlainTab(props: TabChromeProps & { pinned: boolean }) {
  const closable = () => !props.pinned;
  /// The mark itself is derived inside `TabTrailing`, which owns the slot —
  /// §7.5.3 rule 2's ordering lives in `highestSignal` and is not re-decided
  /// per caller.
  return (
    <div
      // What the shared active indicator measures against, *and* what the
      // strip's drop zone measures to find the slot under the pointer.
      // `data-active` is not read by the indicator (the strip already knows
      // which id is active) — it is there so the card's own state is legible in
      // the inspector now that the rule inside it is gone.
      data-tab-id={props.tab.id}
      data-active={props.active ? "" : undefined}
      // Focusable only when it can be renamed *and* is the front tab — `F2`
      // asks "rename the tab I am looking at", and a card nobody can reach by
      // keyboard cannot receive it. Tabbing between every card in the strip is
      // a bigger a11y change than renaming needs today.
      tabIndex={props.onRenameRequest && props.active ? 0 : undefined}
      onPointerDown={props.onPointerDown}
      class={props.class}
      onClick={props.onSelect}
      onDblClick={(e) => {
        if (!props.onRenameRequest) return;
        e.stopPropagation();
        props.onRenameRequest();
      }}
      onKeyDown={(e) => {
        if (e.key !== "F2" || !props.onRenameRequest) return;
        e.preventDefault();
        props.onRenameRequest();
      }}
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
      <Show when={props.tab.color}>
        {(color) => (
          <span
            aria-hidden="true"
            class={`w-1.5 h-1.5 rounded-full shrink-0 ${GROUP_DOT[color()]}`}
          />
        )}
      </Show>
      {/* In a column the label takes the space that is there — `flex-1
          min-w-0` — instead of the 140px a row can spare. `labelWidth` is a
          per-kind override of that row budget and has nothing to say about a
          column, so it is ignored there rather than fought with. */}
      <EditableTabLabel
        tab={props.tab}
        displayLabel={props.tab.label}
        vertical={props.vertical}
        mono={props.tab.mono}
        renaming={props.renaming}
        onCommit={props.onCommitRename}
        onCancel={props.onCancelRename}
      />
      <TabTrailing
        tab={props.tab}
        closable={closable()}
        closeLabel={`Close ${props.tab.label}`}
        onClose={props.onClose}
      />
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
  /// Whether the foreground process is a recognised agent CLI, and whether it
  /// has gone quiet on the user. Both come off the same shared poll — the strip
  /// adds no second `processInfo` loop for them.
  const agent = () => watch()?.agent() ?? false;
  const waiting = () => watch()?.waiting() ?? false;

  /// While a foreground command runs, the tab wears its name. The static label
  /// — a rename if the tab has one, else "Terminal 2" — stays in the tooltip
  /// and comes back when the process exits.
  const displayLabel = () => (busy() && processName()) || props.tab.label;

  return (
    <div
      // See `PlainTab` for what these two attributes are read by.
      data-tab-id={props.tab.id}
      data-active={props.active ? "" : undefined}
      tabIndex={props.onRenameRequest && props.active ? 0 : undefined}
      onPointerDown={props.onPointerDown}
      class={props.class}
      onClick={props.onSelect}
      onDblClick={(e) => {
        if (!props.onRenameRequest) return;
        e.stopPropagation();
        props.onRenameRequest();
      }}
      onKeyDown={(e) => {
        if (e.key !== "F2" || !props.onRenameRequest) return;
        e.preventDefault();
        props.onRenameRequest();
      }}
      onContextMenu={props.onContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          props.onClose();
        }
      }}
      title={
        displayLabel() === props.tab.label
          ? props.tab.label
          : `${props.tab.label} — ${displayLabel()}`
      }
    >
      <Show when={props.tab.color}>
        {(color) => (
          <span
            aria-hidden="true"
            class={`w-1.5 h-1.5 rounded-full shrink-0 ${GROUP_DOT[color()]}`}
          />
        )}
      </Show>
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
      <EditableTabLabel
        tab={props.tab}
        displayLabel={displayLabel()}
        vertical={props.vertical}
        renaming={props.renaming}
        onCommit={props.onCommitRename}
        onCancel={props.onCancelRename}
      />
      <TabTrailing
        tab={props.tab}
        signal={terminalSignal({
          working: working(),
          agent: agent(),
          waiting: waiting(),
          focused: props.active,
        })}
        closable
        closeLabel={`Kill ${props.session.label}`}
        onClose={props.onClose}
      />
    </div>
  );
}

function CloseButton(props: { label: string; onClose: () => void }) {
  return (
    <button
      // The × is a button, not a grip. Without this the press would reach the
      // card's `onPointerDown` and a 4px wobble on the way to clicking it would
      // start dragging the tab instead of closing it.
      onPointerDown={(e) => e.stopPropagation()}
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
        <span class="text-micro font-mono tabular-nums">{props.tabs.length}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panelRef}
            class="fixed w-[280px] max-h-[60vh] overflow-y-auto scrollbar-thin rounded-md border border-border material-chrome text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-ui"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="px-3 pt-1 pb-0.5 text-micro tracking-wide text-muted-foreground/70">
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
                        <span class="flex-1 truncate font-mono text-body">{tab.label}</span>
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
  combined: "All changes",
  mission: "Mission Control",
  browser: "Browser",
  agent: "Agents",
  panegroup: "Splits",
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
  onRecolor?: (tabId: string, color: TabGroupColor | null) => void;
  splitPaneTargets?: { id: string; label: string }[];
  addToSplitPaneDisabledReason?: (tab: TabDescriptor) => string | null;
  onAddToSplitPane?: (tabId: string, targetId?: string) => void;
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
            class="fixed w-[200px] rounded-md border border-border material-chrome text-popover-foreground shadow-lg z-[var(--z-menu)] py-1 text-ui"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <div class="px-3 py-1 text-label text-muted-foreground truncate border-b border-border/50">
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
            {/* Label colour: the same five chart-token swatches the group
                chip's own menu offers, applied to this one tab rather than to
                a whole group. Absent when the caller gave no `onRecolor` — the
                editor window's four kinds do not opt in. */}
            <Show when={props.onRecolor}>
              {(onRecolor) => (
                <div class="px-3 py-1.5 flex items-center gap-1.5 border-t border-border/50">
                  <For each={TAB_GROUP_COLORS}>
                    {(color) => (
                      <button
                        onClick={() =>
                          onRecolor()(c().tab.id, c().tab.color === color ? null : color)
                        }
                        aria-label={`Colour ${color}`}
                        aria-pressed={c().tab.color === color}
                        class={`w-4 h-4 rounded-full transition-[box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${GROUP_DOT[color]}`}
                        classList={{ "ring-2 ring-offset-1 ring-ring": c().tab.color === color }}
                      />
                    )}
                  </For>
                </div>
              )}
            </Show>
            {/* "Add to split pane": a new pane group tab, or an existing one.
                One row per open split rather than a flyout submenu — the same
                choice `TabGroupChip`'s own menu makes for colour, and it is
                small in practice: a worktree with many splits open is rare. */}
            <Show when={props.onAddToSplitPane}>
              {(onAdd) => {
                const reason = () => props.addToSplitPaneDisabledReason?.(c().tab) ?? undefined;
                return (
                  <div class="border-t border-border/50">
                    <MenuItem
                      onClick={() => {
                        onAdd()(c().tab.id);
                        props.onClose();
                      }}
                      icon={<SquareDashed class="w-3.5 h-3.5" />}
                      disabledReason={reason()}
                      tooltip={reason() ? undefined : "Move this tab into a new split pane"}
                    >
                      Add to split pane
                    </MenuItem>
                    <For each={props.splitPaneTargets ?? []}>
                      {(target) => (
                        <MenuItem
                          onClick={() => {
                            onAdd()(c().tab.id, target.id);
                            props.onClose();
                          }}
                          icon={<SquareDashed class="w-3.5 h-3.5" />}
                          disabledReason={reason()}
                          tooltip={reason() ? undefined : `Move this tab into ${target.label}`}
                        >
                          Add to {target.label}
                        </MenuItem>
                      )}
                    </For>
                  </div>
                );
              }}
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/// A rect from `paneDrop` as absolute-position CSS, in the overlay's own box.
function overlayRectStyle(rect: Rect): JSX.CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

const EDGE_ARROWS = {
  left: ArrowLeftToLine,
  right: ArrowRightToLine,
  up: ArrowUpToLine,
  down: ArrowDownToLine,
};

/// The drop target covering one pane group's body.
///
/// It exists only while a tab is being dragged — the rest of the time there is
/// nothing between the user and the pane. Every outcome has to be *visible
/// before release*, because a drag whose result you can only discover by
/// committing to it is not an affordance. Three layers of that, from weakest to
/// strongest:
///
///   • **Armed.** The moment any drag starts, every pane in the window takes a
///     dashed `--primary/40` inset outline. Nothing else in the app says "there
///     are N places this can land"; without it a user who has never split a pane
///     has no reason to believe the pane beside the one they grabbed from is a
///     target at all. It is the one state that is not about the pointer.
///   • **Centre 60%** — "move into this pane". `bg-primary/10` plus a 1px inset
///     `--primary` ring, and the ring goes solid so the armed dashes are
///     visibly *resolved* rather than merely recoloured.
///   • **Outer 20% of any edge** — a split, drawn as the whole resulting layout:
///     the new pane filled at the exact geometry it would occupy, the pane being
///     split shown at what it shrinks to, and the seam between them where the
///     splitter would appear. `splitGroup` always halves the group it splits,
///     which is what makes all three honest. A generic edge glow would say
///     something is about to happen but not what.
///
/// There is no refused outcome: the group cap is gone, so every edge always
/// splits. What used to be unreachable-by-count is now unreachable-by-pixels,
/// and a pane too narrow to be worth splitting is a judgement the user makes by
/// looking at it.
///
/// Only `background` and `opacity` move. The preview's geometry is never
/// animated — it jumps between edges as the pointer crosses zones, which is
/// what makes it readable at drag speed, and §7.3.10 forbids running a
/// fixed-duration animation for something the user is still holding.
export function PaneDropOverlay(props: {
  groupId: string;
  /// How many panes the worktree has right now. Feeds the ghost's sentence —
  /// "Split right — 3 panes" — which is the count *after* the drop, so the
  /// arithmetic lives in `describeDropIntent` and not here.
  paneCount: number;
  onMoveTab: (payload: TabDragPayload, beforeTabId: string | null) => void;
  onSplitDrop: (
    payload: TabDragPayload,
    orientation: SplitOrientation,
    placement: "before" | "after",
  ) => void;
}) {
  let ref: HTMLDivElement | undefined;
  const [intent, setIntent] = createSignal<DropIntent | null>(null);
  /// The body's measured size, kept beside the intent because the residual and
  /// the seam are computed from the whole box and `DropIntent` only carries the
  /// new pane's rect.
  const [box, setBox] = createSignal<{ width: number; height: number }>({ width: 0, height: 0 });

  registerDropZone({
    id: `pane:${props.groupId}`,
    el: () => ref,
    // Below the tab strips that sit on top of this pane: a drop on a strip is
    // about tab order, a drop on the body is about panes.
    priority: 1,
    accepts: (p) => p.kind === "tab" || p.kind === "tabgroup",
    over: (_p, at) => {
      if (!ref) return null;
      const rect = ref.getBoundingClientRect();
      const size = { width: rect.width, height: rect.height };
      const next = dropIntentAt(size, { x: at.x - rect.left, y: at.y - rect.top });
      setBox(size);
      setIntent(next);
      return describeDropIntent(next, props.paneCount);
    },
    // The controller calls this the moment the pointer belongs to someone else,
    // so a pane cannot be left drawing a preview for a drag that has moved on.
    leave: () => setIntent(null),
    drop: (p) => {
      const target = intent();
      setIntent(null);
      if (!target) return;
      if (target.kind === "body") props.onMoveTab(p, null);
      else props.onSplitDrop(p, target.orientation, target.placement);
    },
  });

  const edge = () => {
    const i = intent();
    return i?.kind === "edge" ? i : null;
  };

  return (
    // Always mounted, always `pointer-events-none`: the zone is hit-tested by
    // rect, so this element never has to be under the pointer to receive the
    // drop — which is the whole reason a browser tab's child webview can no
    // longer swallow it. What is conditional is only what it *draws*.
    <div ref={(el) => (ref = el)} class="absolute inset-0 pointer-events-none" aria-hidden="true">
      {/* `draggingTab`, not `isDragging`: a path dragged out of the file tree
          cannot land in a pane, and arming every pane for it would promise a
          drop that does not exist. */}
      <Show when={draggingTab()}>
        {/* The armed outline. Dashed and inset: a solid ring here would be
            indistinguishable from the "move into this pane" state it has to be
            weaker than. */}
        <div class="absolute inset-0 outline-dashed outline-1 -outline-offset-1 outline-primary/40" />
        <Show when={intent()?.kind === "body"}>
          <div class="absolute inset-0 bg-primary/10 ring-1 ring-inset ring-primary" />
        </Show>
        <Show when={edge()}>
          {(hit) => (
            <>
              {/* What is left of the pane being split. Tinted the other way —
                  a wash of the surface rather than of `--primary` — so the two
                  halves read as "new" and "existing" rather than as two
                  equally-new things. */}
              <div
                class="absolute bg-background/70"
                style={overlayRectStyle(residualRect(box(), hit().orientation, hit().placement))}
              />
              {/* The new pane. */}
              <div
                class="absolute bg-primary/15 ring-1 ring-inset ring-primary"
                style={overlayRectStyle(hit().preview)}
              />
              {/* The seam: where the splitter this drop creates will be. */}
              <div
                class="absolute bg-primary"
                style={overlayRectStyle(splitLineRect(box(), hit().orientation, hit().placement))}
              />
              <SplitPreviewBadge
                rect={hit().preview}
                direction={edgeDirection(hit().orientation, hit().placement)}
              />
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

/// The arrow sitting in the middle of the prospective new pane.
///
/// Deliberately wordless. The sentence is the ghost's job and the ghost is
/// already under the user's eye at the pointer; repeating it here would be two
/// controls saying one thing (§7.6), and in a pane a few hundred pixels wide
/// there is no room to say it twice anyway. What the badge adds that the ghost
/// cannot is *location* — it marks which half of this pane the tab lands in,
/// at the place it lands.
///
/// Hidden below `MIN_BADGE_PX` on either axis rather than scaled down: a glyph
/// squeezed into a sliver of a pane is decoration that obscures the preview it
/// is annotating.
function SplitPreviewBadge(props: { rect: Rect; direction: "left" | "right" | "up" | "down" }) {
  const MIN_BADGE_PX = 64;
  const fits = () => props.rect.width >= MIN_BADGE_PX && props.rect.height >= MIN_BADGE_PX;
  return (
    <Show when={fits()}>
      <div
        class="absolute flex items-center justify-center pointer-events-none"
        style={overlayRectStyle(props.rect)}
      >
        <span class="flex items-center justify-center rounded-[var(--island-radius-inner)] bg-primary text-primary-foreground p-1.5">
          <Dynamic component={EDGE_ARROWS[props.direction]} class="w-4 h-4" />
        </span>
      </div>
    </Show>
  );
}

/// The thing that follows the cursor while a tab is in flight.
///
/// VoidLink draws its own drag image (see `beginDragTracking`) for one reason:
/// the browser's is a snapshot of the tab card, which names what the user picked
/// up — something they already know — and can never name what releasing would
/// do, which is the only thing they cannot see. So the ghost carries both, and
/// the second line changes live as the pointer crosses panes and edges.
///
/// Mounted once per window, at `--z-drag`, which the token table describes as
/// "the drag ghost, above everything it explains" — this is the component that
/// name was reserved for.
///
/// `pointer-events-none` is not a nicety: an element under the cursor during an
/// HTML5 drag that accepted events would swallow the `dragover` of every drop
/// target it covered, and the ghost covers whichever one the user is aiming at.
///
/// It tracks the pointer 1:1 with no transition (§7.3.10) — a ghost that eased
/// toward the cursor would lag exactly when the user is aiming at a 20% edge
/// zone.
export function DragGhost(props: {
  /// What the second line says while the pointer is over nothing that would
  /// accept the drop. It is per window because the two windows offer different
  /// gestures: the workbench has pane groups to land in, the editor window has
  /// none and its drag can only ever reorder. A single sentence would be wrong
  /// in one of them, and "Release over a pane" in a window that has no panes is
  /// the worse of the two errors.
  hint?: string;
}) {
  const drag = () => activeDrag();
  const at = () => dragPointer();
  const action = () => dropActionLabel();

  /// Offset from the pointer, in px. Below and right, so the ghost never covers
  /// the edge zone the pointer is currently in — a label sitting *on* the strip
  /// of pane the user is aiming at is a label hiding its own answer.
  const OFFSET = 14;

  return (
    <Show when={drag() && at()}>
      <Portal>
        <div
          class="fixed pointer-events-none z-[var(--z-drag)]"
          style={{ left: `${(at()?.x ?? 0) + OFFSET}px`, top: `${(at()?.y ?? 0) + OFFSET}px` }}
          // `aria-hidden` because a screen reader gets nothing from a thing
          // trailing a pointer it cannot see; the test id is because the ghost
          // repeats the dragged tab's label by design, so "the label appears
          // twice on the page" is the correct state and a bare text query
          // cannot tell the two copies apart.
          aria-hidden="true"
          data-testid="drag-ghost"
        >
          <div class="material-chrome flex flex-col gap-0.5 rounded-[var(--island-radius-inner)] border border-border px-2 py-1.5 shadow-lg max-w-[240px]">
            <span class="flex items-center gap-1.5 text-body text-foreground truncate">
              <SquareDashed class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              {drag()?.label}
            </span>
            {/* The sentence, and the em dash when there isn't one. §9.7 asks
                for a specific sentence rather than a blank: a ghost with an
                empty second line reads as a string that failed to load, where
                "Release over a pane" reads as instruction. */}
            <span class="text-label text-muted-foreground truncate">
              {action() ?? props.hint ?? "Release over a pane"}
            </span>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/// Row in a portal menu. Exported because the workbench's "+" menu and the
/// editor window's file menu render the same kind of row.
///
/// `tooltip` is the row's *explanation*, never a restatement of its label — a
/// tooltip that repeats the text it is anchored to is noise (§7.3.12). It goes
/// through `use:tooltip` rather than `title` for the reasons in `Tooltip.tsx`:
/// the native attribute never fires on keyboard focus, and a menu whose rows
/// are reached with the arrow keys is exactly where that matters.
export function MenuItem(props: {
  onClick: () => void;
  icon: JSX.Element;
  children: JSX.Element;
  tooltip?: string;
  /// A reason, not a boolean (§7.6: every disabled control states why). Undo
  /// itself is what "no reason" looks like — the tooltip carries the reason
  /// either way, so a caller with nothing to add can still pass one along.
  disabledReason?: string;
}) {
  const disabled = () => !!props.disabledReason;
  return (
    <button
      role="menuitem"
      disabled={disabled()}
      use:tooltip={props.disabledReason ?? props.tooltip}
      onClick={() => {
        if (!disabled()) props.onClick();
      }}
      class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
    >
      <span class="text-muted-foreground/80">{props.icon}</span>
      <span class="flex-1">{props.children}</span>
    </button>
  );
}
