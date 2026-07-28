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
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronsRight, Pin, PinOff, X } from "lucide-solid";
import { terminalApi } from "@/api/terminal";
import type { TerminalSession } from "@/types/workspace";
import { StatusLed, terminalSignal } from "@/components/layout/StatusLed";

const POLL_MS = 1500;

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
const isDraggable = (t: TabDescriptor) => t.draggable !== false;

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
  // Tabs of different kinds cannot be reordered across each other — they live
  // in separate arrays in the store — so `dragRef.kind` gates every dragover.
  const [dragRef, setDragRef] = createSignal<{ kind: TabKind; id: string } | null>(null);
  const [dropRef, setDropRef] = createSignal<{ kind: TabKind; id: string } | null>(null);

  function resetDrag() {
    setDragRef(null);
    setDropRef(null);
  }

  function onDragStart(e: DragEvent, tab: TabDescriptor) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/voidlink-item", `${tab.kind}:${tab.id}`);
    setDragRef({ kind: tab.kind, id: tab.id });
  }

  function onDragOver(e: DragEvent, tab: TabDescriptor) {
    const drag = dragRef();
    if (!drag || drag.kind !== tab.kind || drag.id === tab.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropRef({ kind: tab.kind, id: tab.id });
  }

  function onDrop(e: DragEvent, tab: TabDescriptor) {
    const drag = dragRef();
    if (!drag || drag.kind !== tab.kind || drag.id === tab.id) {
      resetDrag();
      return;
    }
    e.preventDefault();
    props.onReorder(tab.kind, drag.id, tab.id);
    resetDrag();
  }

  function tabClasses(tab: TabDescriptor, active: boolean) {
    const base =
      "group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors";
    const tone = active
      ? "bg-background text-foreground"
      : "text-muted-foreground hover:text-foreground hover:bg-accent/30";
    const drag = dragRef();
    const drop = dropRef();
    const dim = drag && drag.kind === tab.kind && drag.id === tab.id ? "opacity-50" : "";
    const indicator =
      drop && drop.kind === tab.kind && drop.id === tab.id
        ? "shadow-[inset_2px_0_0_0_var(--color-primary,theme(colors.primary))]"
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

  return (
    <div class="flex items-center border-b border-border bg-sidebar shrink-0 h-9">
      <div
        ref={(el) => (scrollRef = el)}
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
      draggable={isDraggable(props.tab)}
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
      <Show when={props.tab.dirty}>
        <span class="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
      </Show>
      <Show when={closable()}>
        <CloseButton label={`Close ${props.tab.label}`} onClose={props.onClose} />
      </Show>
    </div>
  );
}

/// A terminal tab. Polls its PTY so the tab can wear the name of whatever is
/// running in it, which is what you actually scan for across a row of shells.
function TerminalTab(props: TabChromeProps & { session: TerminalSession }) {
  const [busy, setBusy] = createSignal(false);
  const [processName, setProcessName] = createSignal<string | null>(null);

  // Keyed on `ptyId`, not on mount: the strip renders slot-keyed rows, so
  // closing a tab hands this component a different session at the same slot,
  // and a mount-only poll would keep reporting the old shell's process.
  createEffect(
    on(
      () => props.session.ptyId,
      (ptyId) => {
        setBusy(false);
        setProcessName(null);
        let alive = true;
        const poll = async () => {
          try {
            const info = await terminalApi.processInfo(ptyId);
            if (!alive) return;
            setBusy(info.busy);
            setProcessName(info.name);
          } catch {
            /* the PTY went away; the tab is about to be removed anyway */
          }
        };
        void poll();
        const interval = setInterval(poll, POLL_MS);
        onCleanup(() => {
          alive = false;
          clearInterval(interval);
        });
      },
    ),
  );

  /// While a foreground command runs, the tab wears its name. The static label
  /// ("Terminal 2") stays in the tooltip and comes back when the process exits.
  const displayLabel = () => (busy() && processName()) || props.session.label;

  return (
    <div
      draggable={isDraggable(props.tab)}
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
      <LedDot active={props.active} busy={busy()} />
      <span class="max-w-[140px] truncate">{displayLabel()}</span>
      <CloseButton label={`Kill ${props.session.label}`} onClose={props.onClose} />
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
      class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
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
