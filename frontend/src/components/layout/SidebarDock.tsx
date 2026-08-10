/// The docking affordances every sidebar shares: the grip you drag its header
/// by, the menu that moves or detaches it, and the overlay that draws where a
/// drop would land.
///
/// One module rather than three copies, for the same reason `Splitter` is one
/// control: the workspace rail, the files sidebar and the git panel are three
/// panels with one gesture, and three implementations of a drag would be three
/// hit-test rules to keep in step.
///
/// The panels themselves stay ignorant of the arrangement. They render a header
/// with `<SidebarGrip>` in it and take a `dock` prop so their splitter knows
/// which edge it sits on; nothing else about docking is visible from inside a
/// sidebar.
import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { ChevronLeft, ChevronRight, GripVertical, MoreVertical } from "lucide-solid";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import { useAppStore } from "@/store/LayoutContext";
import type { AppStore } from "@/store/layout";
import {
  SIDEBAR_COLLAPSE,
  SIDEBAR_PANEL,
  SIDEBAR_RAIL_WIDTH,
  sidebarsOnSide,
  type DockSide,
  type SidebarId,
} from "@/store/layout";
import { isStackedMode } from "@/commands/environment";
import { useSettings } from "@/store/settings";
import {
  canDetachSidebar,
  detachSidebar,
  dockSidebarBack,
} from "@/commands/sidebarWindows";
import {
  activeDrag,
  beginDrag,
  insertionIndex,
  registerDropZone,
  type Point,
} from "./dragDrop";
import {
  describeDockDrop,
  dockEdgeAt,
  dockInsertionBefore,
  dockPreviewRect,
} from "./sidebarDrop";

/// Human names, used by the drag ghost, the menu and the labels. Not the
/// headers' own titles — the git panel's header says the branch, not "Git".
export const SIDEBAR_LABEL: Record<SidebarId, string> = {
  workspaces: "Workspaces",
  explorer: "Explorer",
  terminals: "Terminals",
  git: "Git",
  agents: "Agents",
};

/// The way *out* of an expanded sidebar: the chevron in its header that takes
/// it down to its icon rail.
///
/// Every collapsed sidebar has always had a way back in — the rail is one big
/// button. The explorer and the terminals list were the two with no way *out*
/// from their own chrome: collapsing them meant the title bar's edge button or
/// a right-click, both of which are somewhere other than the panel you are
/// trying to put away. The workspace rail and the git panel have had this
/// button since they were written (their own inline copies, which predate this
/// one and are left where they are); this is that control, factored out at the
/// point a third and fourth panel needed it.
///
/// The chevron points the way the panel goes — outward, toward its own edge —
/// which is why it takes `dock` rather than assuming the left.
export function SidebarCollapseButton(props: {
  /// The edge this panel is docked to, so the glyph points at it.
  dock: DockSide;
  /// The panel, named for the tooltip: "Collapse the file explorer".
  label: string;
  onCollapse: () => void;
}) {
  return (
    <button
      onClick={props.onCollapse}
      aria-label={`Collapse ${props.label}`}
      // The chevron is the only thing reporting this panel's state, and a
      // chevron is not a state a screen reader can read — the same contract
      // the rail's rows and `Disclosure.tsx` state.
      aria-expanded={true}
      title={`Collapse ${props.label}\nThe sidebar returns to the width you left it at`}
      class="p-0.5 rounded shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-[background-color,color] duration-[var(--dur-tint)] ease-out"
    >
      <Show when={props.dock === "right"} fallback={<ChevronLeft class="w-3.5 h-3.5" />}>
        <ChevronRight class="w-3.5 h-3.5" />
      </Show>
    </button>
  );
}

/// Why a sidebar is not in the shell at all right now — or `null` when it is.
///
/// A *third* reason a panel can be absent, alongside zen (everything goes) and
/// detaching (it is in a window of its own): the arrangement itself makes it
/// redundant. Today there is exactly one such rule, and it is the terminals
/// list under vertical tabs — a vertical strip already lists every terminal in
/// the pane, down the same axis, at the same width, with the same LEDs. Two
/// columns of the same list against one edge is the arrangement the vertical
/// option exists to avoid.
///
/// It returns a *reason* rather than a boolean because every caller has to say
/// it out loud: the shell hides the panel, and the title bar's edge button
/// stops claiming to toggle something the user cannot see. A suppressed panel
/// is not collapsed — nothing was persisted, its width and its collapse state
/// are exactly as they were, and switching back to horizontal tabs restores it
/// with no state to migrate.
export function sidebarSuppressedReason(id: SidebarId): string | null {
  const { settings } = useSettings();
  if (id === "terminals" && settings.ui.tabOrientation === "vertical") {
    return "The terminals list is hidden while tabs run vertically — the tab column already lists every terminal";
  }
  return null;
}

/// The drag handle in a sidebar's header.
///
/// A grip rather than the whole header row: the headers already carry buttons
/// (collapse, refresh, the repo picker), and `beginDrag` watches every
/// `pointerdown` on the element it is called from — so making the row itself
/// the affordance would arm a drag from a press on any of them. The grip is a
/// target of its own, and §7.6's "a control says what it does" is why it has a
/// title rather than being an unlabelled texture.
export function SidebarGrip(props: { id: SidebarId; class?: string }) {
  const label = () => SIDEBAR_LABEL[props.id];
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={`Drag to dock the ${label().toLowerCase()} panel`}
      title={`Drag to the left or right edge to dock the ${label().toLowerCase()} panel`}
      data-sidebar-grip={props.id}
      onPointerDown={(e) =>
        beginDrag(e, { kind: "sidebar", id: props.id, label: label() })
      }
      class={`shrink-0 cursor-grab text-muted-foreground/70 hover:text-foreground transition-[color] duration-[var(--dur-tint)] ease-out ${props.class ?? ""}`}
    >
      <GripVertical class="w-3 h-3" />
    </span>
  );
}

/// The move/detach rows for one sidebar — move to the other edge, and detach
/// or dock back. Shared by `SidebarMenuButton` (the ⋮ button) and, per Stream
/// D, a right-click anywhere in the sidebar's own body: both are ways to ask
/// for the same menu, so both build it by calling this, rather than the body's
/// right-click keeping a parallel list that could drift from the button's.
export function sidebarDockMenuItems(store: AppStore, id: SidebarId): ContextMenuItem[] {
  const { state, actions } = store;
  const side = state.dockSide[id];
  const detached = state.detachedSidebars.includes(id);

  const rows: ContextMenuItem[] = [
    {
      label: "Move to the left edge",
      disabledReason: side === "left" ? "Already docked on the left" : undefined,
      onSelect: () => actions.dockSidebar(id, "left"),
    },
    {
      label: "Move to the right edge",
      disabledReason: side === "right" ? "Already docked on the right" : undefined,
      onSelect: () => actions.dockSidebar(id, "right"),
    },
  ];
  if (canDetachSidebar(id)) {
    rows.push(
      detached
        ? {
            label: "Dock back into this window",
            separatorBefore: true,
            onSelect: () => void dockSidebarBack(store, id),
          }
        : {
            label: "Detach into its own window…",
            separatorBefore: true,
            disabledReason: isStackedMode()
              ? "This environment shows the other surfaces as views, not windows"
              : undefined,
            onSelect: () => void detachSidebar(store, id),
          },
    );
  }
  return rows;
}

/// A right-click anywhere in a sidebar's own body opens the same move/detach
/// menu its ⋮ button (`SidebarMenuButton`) does — the item list a right-click
/// should open is *that* list, not a parallel one, so both build it from
/// `sidebarDockMenuItems`.
///
/// Wraps each of the five sidebar panels at the one call site that builds
/// `AppShellSidebars` (`App.tsx`), rather than five copies inside
/// `WorkspaceRail` / `FilesSidebar` / `TerminalsSidebar` / `AgentsSidebar` /
/// `GitSidebar`. `AppShell.tsx` itself stays store-free on purpose (its own
/// tests render it with no `AppStoreContext.Provider` at all — see
/// `AppShell.test.tsx`), so this lives beside the store-aware panels instead.
///
/// `class="contents"` keeps the wrapper out of the box model entirely — the
/// sidebar's own root element is still what `.island-slot` measures and what
/// `[data-sidebar]` queries find — while still giving this `<div>` a DOM node
/// to attach the listener to, since events dispatch on the DOM tree regardless
/// of `display`.
///
/// Every one of the sidebar's own rows (a file, a workspace, a diff…) already
/// calls `stopPropagation` on its own `onContextMenu`, so this only ever fires
/// for the sidebar's bare chrome — the same place a click already does
/// nothing.
export function SidebarBodyMenuScope(props: { id: SidebarId; children: JSX.Element }) {
  const store = useAppStore();
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  let returnFocusTo: HTMLElement | null = null;

  return (
    <div
      class="contents"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        returnFocusTo = document.activeElement as HTMLElement | null;
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {props.children}
      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={sidebarDockMenuItems(store, props.id)}
            onClose={() => setMenu(null)}
            returnFocusTo={returnFocusTo}
          />
        )}
      </Show>
    </div>
  );
}

/// The header menu: move to the other edge, and detach or dock back.
///
/// Every row runs the same store action the drag and the palette do, so a
/// sidebar has one way to be moved and three ways to ask.
export function SidebarMenuButton(props: { id: SidebarId }) {
  const store = useAppStore();
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  let trigger: HTMLButtonElement | undefined;

  const label = () => SIDEBAR_LABEL[props.id];

  return (
    <>
      <button
        ref={trigger}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom });
        }}
        aria-label={`${label()} panel options`}
        aria-haspopup="menu"
        title={`${label()} panel: move or detach`}
        class="p-0.5 rounded shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-[background-color,color] duration-[var(--dur-tint)] ease-out"
      >
        <MoreVertical class="w-3 h-3" />
      </button>
      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={sidebarDockMenuItems(store, props.id)}
            onClose={() => setMenu(null)}
            returnFocusTo={trigger}
          />
        )}
      </Show>
    </>
  );
}

/// The drop zone and its preview, for the duration of a sidebar drag.
///
/// Mounted inside the workbench view and covering it. It draws only while a
/// sidebar is in flight — a permanently mounted overlay would eat every click
/// underneath — and it never captures the pointer: `dragDrop` hit-tests by
/// coordinate, so `pointer-events: none` costs nothing and keeps the panels
/// underneath live right up to the release.
export function SidebarDockOverlay() {
  const { state, actions } = useAppStore();
  let host: HTMLDivElement | undefined;
  const [edge, setEdge] = createSignal<DockSide | null>(null);

  const dragged = createMemo<SidebarId | null>(() => {
    const p = activeDrag();
    return p && p.kind === "sidebar" ? (p.id as SidebarId) : null;
  });

  /// The panels already on `side`, dragged one excluded — a panel cannot land
  /// in front of itself, and leaving it in would make every drop on its own
  /// edge resolve to "no change".
  const neighbours = (side: DockSide, self: SidebarId): SidebarId[] =>
    sidebarsOnSide(state.dockOrder, state.dockSide, side, state.detachedSidebars).filter(
      (id) => id !== self,
    );

  /// Where the drop lands among those neighbours, by their slot rectangles.
  function beforeIdAt(side: DockSide, self: SidebarId, at: Point): SidebarId | null {
    const ids = neighbours(side, self);
    const rects: DOMRect[] = [];
    const kept: SidebarId[] = [];
    for (const id of ids) {
      const el = document.querySelector(`[data-sidebar="${id}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      kept.push(id);
      rects.push(r);
    }
    return dockInsertionBefore(kept, insertionIndex(rects, at, "x"));
  }

  function localPoint(at: Point) {
    const r = host?.getBoundingClientRect();
    if (!r) return { size: { width: 0, height: 0 }, point: { x: 0, y: 0 } };
    return {
      size: { width: r.width, height: r.height },
      point: { x: at.x - r.left, y: at.y - r.top },
    };
  }

  registerDropZone({
    id: "sidebar-dock",
    el: () => host,
    // Above the pane bodies: a sidebar dropped over the workbench is a dock,
    // never a pane split, and the two zones overlap by construction.
    priority: 5,
    accepts: (p) => p.kind === "sidebar",
    over: (p, at) => {
      const { size, point } = localPoint(at);
      const side = dockEdgeAt(size, point);
      setEdge(side);
      const self = p.id as SidebarId;
      if (!side) return null;
      const unchanged =
        state.dockSide[self] === side &&
        beforeIdAt(side, self, at) === nextOf(neighbours(side, self), self, state.dockOrder);
      return describeDockDrop(side, p.label, unchanged);
    },
    leave: () => setEdge(null),
    drop: (p, at) => {
      const { size, point } = localPoint(at);
      const side = dockEdgeAt(size, point);
      const self = p.id as SidebarId;
      if (side) actions.dockSidebar(self, side, beforeIdAt(side, self, at));
      setEdge(null);
    },
  });

  /// Whichever neighbour currently renders after `self` on its edge — the
  /// position a drop would have to reproduce to change nothing.
  function nextOf(
    ids: readonly SidebarId[],
    self: SidebarId,
    order: readonly SidebarId[],
  ): SidebarId | null {
    const at = order.indexOf(self);
    for (const id of order.slice(at + 1)) if (ids.includes(id)) return id;
    return null;
  }

  /// Whichever flag collapses `id` to its icon rail. The mapping lives in
  /// `store/layout/dock.ts` now — this used to be a `switch` here and a second
  /// copy in `TitleBar`, which is two places to forget a sixth sidebar in.
  const isRailed = (id: SidebarId): boolean => {
    const flag = SIDEBAR_COLLAPSE[id];
    return flag.kind === "section" ? !state.sidebarSections[flag.key] : state[flag.key];
  };

  const previewWidth = () => {
    const self = dragged();
    if (!self) return 0;
    return isRailed(self) ? SIDEBAR_RAIL_WIDTH : state.panels[SIDEBAR_PANEL[self]];
  };

  onCleanup(() => setEdge(null));

  return (
    <div
      ref={host}
      // Always mounted so the zone has a rectangle to measure; only *drawn*
      // during a sidebar drag.
      class="absolute inset-0 pointer-events-none z-30"
      aria-hidden="true"
    >
      <Show when={dragged()}>
        <For each={["left", "right"] as DockSide[]}>
          {(side) => {
            const size = () => {
              const r = host?.getBoundingClientRect();
              return { width: r?.width ?? 0, height: r?.height ?? 0 };
            };
            const rect = () => dockPreviewRect(size(), side, previewWidth());
            return (
              <Show when={edge() === side}>
                {/* The landing rectangle, not a hint: the panel comes back at
                    the width it left with, so this is the geometry the release
                    produces. Semantic tokens only — the preview borrows the
                    focus ring's colour rather than introducing one. */}
                <div
                  class="absolute rounded-[var(--island-radius)] border-2 border-ring bg-ring/10"
                  style={{
                    left: `${rect().x}px`,
                    top: `${rect().y}px`,
                    width: `${rect().width}px`,
                    height: `${rect().height}px`,
                  }}
                />
              </Show>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
