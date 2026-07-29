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
import { ChevronsRight, Pin, PinOff, X } from "lucide-solid";
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
import type { SplitOrientation } from "@/store/layout";

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
  | "brain"
  | "browser";

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
  /// The tab's live §7.5.3 signal, already reduced to one mark by the caller
  /// (`store/activity.ts`). `dirty` is folded in here rather than by the
  /// caller, so a window that only knows about unsaved buffers — the editor —
  /// keeps working without setting this at all.
  activity?: ActivitySignal;
  /// Present on terminal tabs. Swaps the icon for a live LED + process name;
  /// the strip owns that polling because the tab is the only place it shows.
  terminal?: TerminalSession;
  /// Terminals can't be reopened once their PTY is gone, so pinning them is
  /// meaningless. Repo-wide singleton tabs (commit graph, brain) and browser
  /// tabs are likewise neither pinnable nor draggable.
  pinnable?: boolean;
  draggable?: boolean;
  /// Refs and branch names read better monospaced.
  mono?: boolean;
  /// Tailwind max-width for the label, for kinds that need more room.
  labelWidth?: string;
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
  /// land in front of, or `null` for the end of the strip.
  onMoveTab?: (payload: TabDragPayload, beforeTabId: string | null) => void;
}

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

  /// Can the in-flight drag land on `tab`? Either as a move from another group
  /// (any kind), or as a reorder within this strip (same kind, reorderable,
  /// not onto itself).
  function canLandOn(tab: TabDescriptor): boolean {
    const drag = tabDrag();
    if (!drag) return false;
    if (incoming()) return true;
    return drag.kind === tab.kind && drag.id !== tab.id && isReorderable(tab);
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
    if (incoming()) props.onMoveTab?.(drag, tab.id);
    else props.onReorder(tab.kind, drag.id, tab.id);
    resetDrag();
  }

  /// A drop on the strip's empty space appends. Reached only when the event
  /// did not come from a tab row — those stop propagation above.
  function onStripDragOver(e: DragEvent) {
    const drag = tabDrag();
    if (!drag) return;
    if (!incoming() && !isReorderableKindHere(drag)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropRef(null);
    setDropAtEnd(true);
  }

  function onStripDrop(e: DragEvent) {
    const drag = tabDrag();
    if (!drag) return;
    e.preventDefault();
    if (incoming()) props.onMoveTab?.(drag, null);
    else if (isReorderableKindHere(drag)) props.onReorder(drag.kind, drag.id, null);
    resetDrag();
  }

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

  function tabClasses(tab: TabDescriptor, active: boolean) {
    const base =
      "group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors";
    const tone = active
      ? "bg-background text-foreground"
      : "text-muted-foreground hover:text-foreground hover:bg-accent/30";
    const drag = tabDrag();
    const dim = drag && drag.id === tab.id ? "opacity-50" : "";
    const last = ordered()[ordered().length - 1];
    const indicator = dropRef() === tab.id
      ? CARET_BEFORE
      : dropAtEnd() && last?.id === tab.id
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
    setCtx({ x: e.clientX, y: e.clientY, tab });
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
      class="flex items-center border-b border-border bg-sidebar shrink-0 h-9"
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
        <Index each={ordered()}>
          {(tab) => (
            <Show
              when={tab().terminal}
              fallback={
                <PlainTab
                  tab={tab()}
                  active={tab().id === props.activeId}
                  pinned={props.isPinned(tab().id)}
                  draggable={canDrag(tab())}
                  class={tabClasses(tab(), tab().id === props.activeId)}
                  onSelect={() => props.onSelect(tab())}
                  onClose={() => props.onClose(tab())}
                  onContextMenu={(e) => openCtx(e, tab())}
                  onDragStart={(e) => onDragStart(e, tab())}
                  onDragOver={(e) => onDragOver(e, tab())}
                  onDrop={(e) => onDrop(e, tab())}
                  onDragEnd={resetDrag}
                />
              }
            >
              {(session) => (
                <TerminalTab
                  session={session()}
                  tab={tab()}
                  active={tab().id === props.activeId}
                  draggable={canDrag(tab())}
                  class={tabClasses(tab(), tab().id === props.activeId)}
                  onSelect={() => props.onSelect(tab())}
                  onClose={() => props.onClose(tab())}
                  onContextMenu={(e) => openCtx(e, tab())}
                  onDragStart={(e) => onDragStart(e, tab())}
                  onDragOver={(e) => onDragOver(e, tab())}
                  onDrop={(e) => onDrop(e, tab())}
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

      <TabContextMenu
        ctx={ctx()}
        isPinned={props.isPinned}
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
    </div>
  );
}

/// The tab's right-hand slot: its §7.5.3 activity mark at rest, its close
/// button on hover. One box, one fixed size, both states inside it.
///
/// Three things about this are load-bearing and each is easy to lose:
///   • The mark **replaces** the close affordance rather than sitting beside
///     it (§7.5.3). A tab wearing both a badge and an × reads as two controls.
///   • The box is `w-4 h-4` whether or not there is a mark and whether or not
///     the tab is closable, so a background pane lighting up never nudges the
///     label (§7.5.3 rule 3, and §7.6's no-layout-shift rule).
///   • `dirty` is folded in here, so the editor window — which knows about
///     unsaved buffers and nothing else — gets the right mark from the
///     `dirty` prop alone.
function TabTrailing(props: {
  tab: TabDescriptor;
  closable: boolean;
  closeLabel: string;
  onClose: () => void;
}) {
  const mark = () =>
    highestSignal([props.tab.activity, props.tab.dirty ? ("dirty" as const) : undefined]);
  return (
    <span class="relative inline-flex w-4 h-4 shrink-0 items-center justify-center">
      <Show when={mark()}>
        {(m) => (
          <StatusLed
            signal={m()}
            /// Hidden while the close button is showing — the two share the
            /// slot rather than competing for it.
            class={props.closable ? "group-hover:opacity-0" : ""}
          />
        )}
      </Show>
      <Show when={props.closable}>
        <CloseButton label={props.closeLabel} onClose={props.onClose} />
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
      {/* The leading LED is the terminal tab's *icon*: it says whether this
          shell is busy, which is what you scan a row of shells for. The
          trailing slot is a different question — "did something happen here
          while I was elsewhere?" — and §7.5.3 rule 4 wants signals to differ
          in position as well as fill, so the two never read as one repeated
          mark. */}
      <LedDot active={props.active} busy={busy()} />
      <span class="max-w-[140px] truncate">{displayLabel()}</span>
      <TabTrailing
        tab={props.tab}
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
      onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }}
      class="absolute inset-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 focus-visible:!opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
      aria-label={props.label}
    >
      <X class="w-3 h-3" />
    </button>
  );
}

/// Thin wrapper over the shared `<StatusLed>` (MASTER.md §7.5.3) so the two
/// call sites keep their `(active, busy)` shape. The glyph itself lives in
/// `StatusLed.tsx`; do not re-derive its colours here.
function LedDot(props: { active: boolean; busy: boolean }) {
  return (
    <StatusLed signal={terminalSignal(props.busy, props.active)} dim={!props.active && props.busy} />
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
            class="fixed w-[280px] max-h-[60vh] overflow-y-auto scrollbar-thin rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999] py-1 text-[13px]"
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
  brain: "Brain",
  browser: "Browser",
};

/// Single right-click menu rendered as a portal so it escapes the strip's
/// `overflow-x-auto` clipping. Targets one tab at a time.
function TabContextMenu(props: {
  ctx: { x: number; y: number; tab: TabDescriptor } | null;
  isPinned: (id: string) => boolean;
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
            class="fixed w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999] py-1 text-[13px]"
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
              class="fixed z-[10000] pointer-events-none rounded-md border border-destructive/60 bg-popover px-2 py-1 text-[11px] text-destructive shadow-lg"
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
