/// The dock strip — `environmentMode: "docked"`'s replacement for five icon
/// rails.
///
/// **What it is.** One floating strip pinned to the left, right or bottom edge,
/// holding a button per dockable sidebar, a divider, and then one button per
/// process running in the active workspace. At most one sidebar is expanded at
/// a time and it opens against the strip's edge; everything else is a 28px
/// target. On a single screen that is the difference between three columns of
/// chrome and one.
///
/// **Why a strip rather than five rails.** The five rails were already the
/// collapsed state — the shell just drew them as five separate 32px columns,
/// each with its own gap, its own island and its own splitter, which costs
/// ~200px of window to say five words. Collapsing them into one strip is the
/// same information at a fifth of the width, and it makes "which panels do I
/// have" a single object the user can pick up and move.
///
/// **The split this file holds to** (`SidebarDock.tsx`'s header states it for
/// sidebars, and the rule is the same one): every decision about *rectangles*
/// — which edge a drop resolves to, how much room the shell must reserve, what
/// the preview covers — lives in `store/layout/dock.ts`, pure and unit-tested
/// with no DOM under it. What is here renders what it is handed and owns only
/// the pointer plumbing.
///
/// **Material.** `bg-surface-rail`, deliberately not a new token and not a
/// gloss. The strip *is* the rail — the region token named for it already
/// exists, is already derived from `--background` per theme, and is already in
/// the translucency and frost lists a background image drives (`index.css`).
/// MASTER §6 is explicit that separation here is lightness and not shadow, and
/// §11 bans a decorative gradient outright, so the strip separates from the
/// canvas it floats on the way every other island does: by sitting one step up
/// the lightness ladder, with `.island`'s radius and nothing else.
///
/// **Motion.** Hover and press are a tint shift at `--dur-tint` (§7.1's
/// >50×-per-session budget; §7.3.5 forbids the hover-scale). An edge change is
/// a <5×-per-session event and settles at `--dur-long` on `transform` alone
/// (§7.3.2), with no overshoot — §7.3.4 reserves that for tab drag-reorder and
/// nothing else. The only thing that runs on its own is the process LEDs, and
/// they are functional loops: they turn because a process is working and stop
/// when it exits, which is the one kind of continuous motion §7.3.9 permits.
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  mapArray,
  onCleanup,
  type Component,
} from "solid-js";
import { Bot, Files, FolderGit2, GitBranch, GripHorizontal, TerminalSquare } from "lucide-solid";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import { LedSlot } from "@/components/layout/StatusLed";
import { tooltip } from "@/components/ui/Tooltip";
import { useAppStore } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import { tabMark } from "@/store/activity";
import { watchTerminal } from "@/store/terminalWatch";
import {
  DOCK_SIDES,
  DOCK_STRIP_THICKNESS,
  dockStripAxis,
  dockStripEdgeAt,
  dockStripPreviewRect,
  type DockSide,
  type SidebarId,
} from "@/store/layout";
import { terminalSignal } from "./activitySignal";
import { SIDEBAR_LABEL, sidebarSuppressedReason } from "./SidebarDock";
import { activeDrag, beginDrag, registerDropZone, type Point } from "./dragDrop";
import {
  centreOf,
  prefersReducedMotion,
  runDockMorph,
  shouldMorph,
  type MorphPoint,
} from "./dockMorph";

// `tooltip` is a `use:` directive; TypeScript prunes an import it thinks is
// unused, and the directive is only ever referenced in JSX attribute position.
void tooltip;

/// Which sidebar the dock currently has expanded, or `null` for none.
///
/// Module state, not store state, and deliberately not persisted — the same
/// call `stackedView` makes in `commands/environment.ts`, for the same reason:
/// it is neither per worktree nor worth surviving a reload, and a boot that
/// lands on the bare workbench is the right one.
///
/// It is also a *single* id rather than the five existing collapse flags. Those
/// five (`SIDEBAR_COLLAPSE`) each answer "is this panel railed", which is a
/// question docked mode does not have — there are no rails, and two panels open
/// at once is the layout this mode exists to get rid of. Reusing them would
/// have meant enforcing "at most one" across five booleans on every write.
const [openPanel, setOpenPanel] = createSignal<SidebarId | null>(null);

export { openPanel };

/// The panel that is on its way out, and the only reason it still exists.
///
/// An exit animation needs the thing it animates, and `openPanel` going to
/// `null` unmounts the panel in the same update — there is nothing left to
/// animate by the next frame. So the two are split: `openPanel` flips
/// immediately, because the button's pressed state is press feedback and §7.1
/// gives that no delay, and `closingPanel` keeps the panel mounted for the
/// 135ms it takes to leave. `shows()` in `App.tsx` reads both.
const [closingPanel, setClosingPanel] = createSignal<SidebarId | null>(null);

export { closingPanel };

/// The morph in flight, if any, so it can be cancelled.
///
/// One handle rather than one per panel: at most one panel is ever open, so at
/// most one is ever animating, and a second handle would only exist to describe
/// a state the mode forbids.
let inFlight: Animation | null = null;

/// Drop whatever is animating and unmount whatever was leaving, now.
///
/// Every interruption lands here — opening a second panel mid-exit, leaving
/// docked mode, a panel being detached out from under the dock. `cancel()`
/// rather than `finish()`: the exit holds its last frame (`fill: "forwards"`),
/// and finishing it would leave an invisible panel behind on an element that is
/// about to be shown again.
function settleMorph(): void {
  inFlight?.cancel();
  inFlight = null;
  setClosingPanel(null);
}

/// Open `id`, or close it if it is already the open one. The dock's buttons are
/// toggles: pressing the panel you are looking at is how you get the space
/// back, and it is the only way that does not need a second control.
///
/// `from` is where the panel should grow out of — the centre of the button that
/// was pressed — and `null` means "appear finished" (keyboard, reduced motion).
/// It is a parameter rather than something the dock reads off the DOM later
/// because only the caller knows *which* control was used, and §7.1 makes that
/// the difference between 180ms and 0.
export function toggleDockPanel(id: SidebarId, from: MorphPoint | null = null): void {
  const opening = openPanel() !== id;
  // Whatever was leaving is gone the moment anything else is asked for. An exit
  // that kept playing under a panel that is now opening would put two floated
  // panels on one edge, stacked, for the length of the animation.
  settleMorph();
  setOpenPanel((current) => (current === id ? null : id));
  if (!from) return;
  if (opening) morphPanelOpen(id, from);
  else morphPanelClosed(id, from);
}

/// Grow the panel `id` out of `from`, once it exists.
///
/// The slot is found by `data-sidebar` — the attribute `AppShell` already puts
/// on every slot — rather than by a ref threaded down through the shell. The
/// alternative is an animation-shaped hole in `AppShellProps`, and `AppShell` is
/// deliberately store-free geometry (see its header); "which panel just opened
/// and from where" is the dock's business, not the shell's.
///
/// One frame of delay, and it is required rather than defensive: the panel's
/// content mounts as part of the same update that set `openPanel`, so at the end
/// of this call the slot is still the empty, zero-height box it was before, and
/// `runDockMorph` would measure nothing and bail.
function morphPanelOpen(id: SidebarId, from: MorphPoint): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (openPanel() !== id) return;
    const el = panelSlot(id);
    if (el) inFlight = runDockMorph(el, from, "in");
  });
}

/// Collapse the panel `id` back into `from`, then unmount it.
///
/// The mirror of `morphPanelOpen`, with the mount/unmount at the other end: the
/// panel is already on screen, so there is no frame to wait for, and what has to
/// wait is the teardown. `closingPanel` is what holds it there until `finished`
/// resolves.
///
/// A `null` animation — no box, or a platform without WAAPI — means there is
/// nothing to wait for, so the panel goes immediately rather than being left
/// mounted forever by a promise that never arrives.
function morphPanelClosed(id: SidebarId, from: MorphPoint): void {
  const el = panelSlot(id);
  const animation = el && runDockMorph(el, from, "out");
  if (!animation) return;
  setClosingPanel(id);
  inFlight = animation;
  void animation.finished
    .then(() => {
      // Only settle the exit that is still the current one. A cancel already
      // ran `settleMorph`, and by now `inFlight` may belong to an entrance that
      // started after this one was interrupted.
      if (inFlight === animation) settleMorph();
    })
    .catch(() => {
      // `cancel()` rejects `finished`. The interruption path already settled.
    });
}

/// The slot `AppShell` renders for `id`.
///
/// Found by `data-sidebar` — the attribute the shell already puts on every slot
/// — rather than by a ref threaded down through it. The alternative is an
/// animation-shaped hole in `AppShellProps`, and `AppShell` is deliberately
/// store-free geometry (see its header); "which panel just opened, and from
/// where" is the dock's business, not the shell's.
function panelSlot(id: SidebarId): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-sidebar="${id}"]`);
}

/// Close whatever the dock has open. Called when the mode leaves `docked`, so
/// a panel does not stay expanded as a floating overlay in a shell that no
/// longer draws a dock beside it.
export function closeDockPanel(): void {
  // No exit animation: this is not a user closing a panel, it is the panel
  // losing the shell it was anchored to. Animating a collapse toward a strip
  // that is no longer drawn would be motion describing geometry that is gone.
  settleMorph();
  setOpenPanel(null);
}

/// One Lucide glyph per sidebar, reusing each panel's own rail icon rather than
/// picking a fresh set: the explorer's rail is `Files`, the workspace rail's is
/// `FolderGit2`, the terminals list's header is `TerminalSquare`, the agents
/// board's is `Bot`, and the git panel's branch row is `GitBranch`. A user who
/// knows the rails knows the dock.
const SIDEBAR_ICON: Record<SidebarId, Component<{ class?: string }>> = {
  workspaces: FolderGit2,
  explorer: Files,
  terminals: TerminalSquare,
  git: GitBranch,
  agents: Bot,
};

/// One running process, as the dock needs it. `ptyId` is `null` for an agent
/// thread, which is a conversation rather than a shell and so has no PTY to
/// watch — its label is its title and it has no activity LED.
interface DockProcess {
  key: string;
  kind: "terminal" | "agent";
  /// The tab id, for selecting it.
  tabId: string;
  ptyId: string | null;
  worktreeId: string;
  /// The label at rest — the terminal's name, or the agent thread's title.
  /// The *live* label (`claude`, `vitest`) comes off `watchTerminal`.
  label: string;
}

// ── The strip ────────────────────────────────────────────────────────────────

/// The dock, rendered once by `AppShell` in a fixed DOM position and moved
/// between edges by CSS alone.
///
/// That last part matters as much here as it does for the sidebar slots
/// (`AppShellSidebar`'s header): the strip subscribes to every running
/// terminal through `watchTerminal`, whose poll is refcounted per PTY, and a
/// strip that unmounted and remounted on every edge change would drop and
/// re-take every one of those subscriptions — restarting the poll interval for
/// shells that never stopped running.
export function DockStrip() {
  const store = useAppStore();
  const { state, actions, activeWorkspace } = store;
  const { settings } = useSettings();
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  let host: HTMLDivElement | undefined;
  let grip: HTMLSpanElement | undefined;

  const side = () => state.dockStripSide;
  const vertical = () => dockStripAxis(side()) === "vertical";

  /// The sidebars the dock offers, in the arrangement order the user already
  /// set for them (`dockOrder`). The dock does not invent a second ordering —
  /// a panel dragged to the front of the left edge is the panel at the front of
  /// the dock, whichever edge the dock itself is on.
  ///
  /// Detached panels are dropped: one in a window of its own has no button
  /// here, exactly as it has no slot in the shell. So are suppressed ones, for
  /// the reason `sidebarSuppressedReason` gives — a button that toggles a panel
  /// the arrangement refuses to draw is a control that lies.
  const panels = createMemo<SidebarId[]>(() =>
    state.dockOrder.filter(
      (id) =>
        !state.detachedSidebars.includes(id) &&
        !sidebarSuppressedReason(id) &&
        (id !== "agents" || settings.experimental.agentDashboard),
    ),
  );

  /// Every shell and every agent thread in the **active workspace**, flattened
  /// across its worktrees.
  ///
  /// The workspace rather than the worktree, because the whole point of the
  /// second section is "what is my project doing" — a build running in the
  /// worktree you are not looking at is exactly the one worth a dot on the
  /// dock. And the workspace rather than every open one, for the reason
  /// `useSessionRows` gives in `store/agentSessions.ts`: cross-workspace
  /// aggregation is a different product question and would put entries here
  /// with no navigation to reach them.
  const processes = createMemo<DockProcess[]>(() => {
    const ws = activeWorkspace();
    if (!ws) return [];
    const out: DockProcess[] = [];
    for (const wt of ws.worktrees) {
      for (const term of state.terminalsByWorktree[wt.id] ?? []) {
        out.push({
          key: `terminal:${term.id}`,
          kind: "terminal",
          tabId: term.id,
          ptyId: term.ptyId,
          worktreeId: wt.id,
          label: term.label,
        });
      }
      for (const agent of state.agentTabsByWorktree[wt.id] ?? []) {
        out.push({
          key: `agent:${agent.id}`,
          kind: "agent",
          tabId: agent.id,
          ptyId: null,
          worktreeId: wt.id,
          label: agent.title || "Agent",
        });
      }
    }
    return out;
  });

  /// `mapArray`, not `<For>`'s children, because each row takes a subscription:
  /// `watchTerminal` refcounts by PTY and releases on its owner's cleanup, and
  /// `mapArray` gives every row a reactive root of its own so a shell that
  /// closes stops being polled the moment it leaves the list rather than when
  /// the whole dock unmounts. `store/agentSessions.ts` takes the same shape for
  /// the same reason.
  const rows = mapArray(processes, (process) => {
    // Agent threads have no PTY, so there is nothing to watch and no LED —
    // their label is their title and it does not move.
    if (!process.ptyId) {
      return () => ({ process, label: process.label, signal: undefined });
    }
    const watch = watchTerminal(process.tabId, process.ptyId);
    return () => ({
      process,
      // The live label the terminal tab strip already shows: the foreground
      // process's name while the shell is busy, and the tab's own name when it
      // is not. Read from `watchTerminal` and not from a poll of the dock's own
      // — there is exactly one `processInfo` per shell per interval in this
      // app, and it belongs to that module.
      label: (watch.busy() && watch.processName()) || process.label,
      signal: tabMark(
        process.tabId,
        terminalSignal({
          working: watch.working(),
          agent: watch.agent(),
          waiting: watch.waiting(),
          // Focused, so a quiet agent resolves to `idle` rather than to
          // nothing: on the dock, as on the agent board, "this shell is here
          // and quiet" is a dim LED, not an absence. The row itself is not
          // evidence enough at 28px.
          focused: true,
        }),
      ),
    });
  });

  /// Bring a process forward: switch to its worktree first, because a shell in
  /// another worktree is not selectable from here without doing so, and then
  /// select the tab. Two writes, in this order, because the second is scoped by
  /// the first.
  function open(process: DockProcess) {
    if (process.worktreeId !== state.activeWorktreeId) {
      actions.selectWorktree(process.worktreeId);
    }
    if (process.kind === "terminal") actions.selectTerminal(process.worktreeId, process.tabId);
    else actions.selectAgentTab(process.worktreeId, process.tabId);
  }

  // ── The arrival nudge ──────────────────────────────────────────────────
  //
  // An edge change is a <5×-per-session event, so §7.1 allows up to
  // `--dur-long`. It animates `transform` only (§7.3.2 bans animating `inset`
  // or `width`) and with no overshoot (§7.3.4). The strip is already at its new
  // edge on the frame this arms; what animates is the last few pixels of travel
  // *toward* that edge, which is §7.3.11's "enter along the path you left by".
  const [arriving, setArriving] = createSignal(false);
  createEffect((previous: DockSide | undefined) => {
    const next = side();
    if (previous !== undefined && previous !== next) {
      setArriving(true);
      // One frame at the offset, then release. A timeout rather than a
      // transition on a value that just changed, because the browser
      // coalesces a style write and its removal in the same frame into no
      // transition at all.
      const timer = setTimeout(() => setArriving(false), 0);
      onCleanup(() => clearTimeout(timer));
    }
    return next;
  });

  /// The push-off the strip animates in from, in its own axis. `.island`'s
  /// radius' worth of travel: enough to read as arriving, short enough that it
  /// is over before the eye has finished moving.
  const enterTransform = () => {
    if (!arriving()) return "none";
    if (side() === "bottom") return "translateY(8px)";
    return side() === "left" ? "translateX(-8px)" : "translateX(8px)";
  };

  /// Move the strip to `edge`, from the menu. The pointer path is the drag
  /// below and the keyboard path is Settings → UI → Dock edge; all three write
  /// this one action, so the strip has one way of being moved and three ways to
  /// ask (`sidebarDockMenuItems` states the same rule for sidebars).
  const menuItems = (): ContextMenuItem[] =>
    DOCK_SIDES.map((edge) => ({
      label: `Move to the ${edge} edge`,
      disabledReason: side() === edge ? `Already docked on the ${edge}` : undefined,
      onSelect: () => actions.setDockStripSide(edge),
    }));

  return (
    <>
      <div
        ref={host}
        role="toolbar"
        aria-label="Dock"
        aria-orientation={vertical() ? "vertical" : "horizontal"}
        data-dock-strip={side()}
        data-motion="dock-strip"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        class="island bg-surface-rail flex items-center gap-1 p-1 pointer-events-auto transition-transform duration-[var(--dur-long)] ease-[var(--ease-out)]"
        classList={{ "flex-col": vertical() }}
        // Both keys named, one of them `undefined`, rather than a computed key
        // that appears and disappears: the strip is content-sized along its own
        // axis and fixed across it, and which axis that is changes with the
        // edge. Naming both is what guarantees the old one is *removed* on the
        // flip rather than left behind as a 40px cap on the wrong axis.
        style={{
          transform: enterTransform(),
          width: vertical() ? `${DOCK_STRIP_THICKNESS}px` : undefined,
          height: vertical() ? undefined : `${DOCK_STRIP_THICKNESS}px`,
        }}
      >
        {/* The grip, and the whole reason the strip is a *thing* rather than a
            row of buttons: `beginDrag` watches every pointer-down on the
            element it is called from, so making the strip itself draggable
            would arm a drag from a press on any button in it. Same call
            `SidebarGrip` makes, one level up. */}
        <span
          ref={grip}
          role="button"
          tabIndex={-1}
          aria-label="Drag to move the dock to another edge"
          data-dock-grip
          use:tooltip={"Drag the dock to the left, right or bottom edge\nOr right-click for the same three, by name"}
          onPointerDown={(e) => beginDrag(e, { kind: "dock", id: "dock", label: "the dock" })}
          class="shrink-0 cursor-grab text-muted-foreground/70 hover:text-foreground transition-[color] duration-[var(--dur-tint)] ease-out"
        >
          <GripHorizontal class="w-3 h-3" />
        </span>

        <For each={panels()}>
          {(id) => {
            const Icon = SIDEBAR_ICON[id];
            const open = () => openPanel() === id;
            return (
              <button
                type="button"
                data-dock-panel={id}
                aria-label={SIDEBAR_LABEL[id]}
                aria-pressed={open()}
                use:tooltip={`${SIDEBAR_LABEL[id]}\nOpens against the dock's edge; press again to close`}
                // `detail === 0` is a click the keyboard produced (Enter or
                // Space on the focused button). §7.1 gives those no motion at
                // all, so the origin is withheld rather than the animation
                // being cancelled somewhere further down.
                onClick={(e) =>
                  toggleDockPanel(
                    id,
                    shouldMorph({ pointer: e.detail !== 0, reducedMotion: prefersReducedMotion() })
                      ? centreOf(e.currentTarget)
                      : null,
                  )
                }
                // §11.5's one "this is active" idiom, and a tint-only hover
                // (§7.3.5). `border` at a constant width in every state so
                // nothing reflows on hover (§7.6).
                class="shrink-0 p-1.5 rounded-md border border-transparent cursor-pointer transition-[background-color,border-color,color] duration-[var(--dur-tint)] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                classList={{
                  "bg-primary/15 border-primary/40 text-primary": open(),
                  "text-muted-foreground hover:text-foreground hover:bg-accent/60 active:bg-accent/80":
                    !open(),
                }}
              >
                <Icon class="w-4 h-4" />
              </button>
            );
          }}
        </For>

        {/* The divider between "panels I can open" and "things that are
            running". Two sections of buttons with no rule between them is one
            long list of unrelated targets. `aria-orientation` is the cross
            axis of the strip's own, because a separator runs across what it
            separates. */}
        <div
          role="separator"
          aria-orientation={vertical() ? "horizontal" : "vertical"}
          data-dock-divider
          class="shrink-0 bg-border"
          classList={{
            "w-4 h-px my-0.5": vertical(),
            "h-4 w-px mx-0.5": !vertical(),
          }}
        />

        {/* The one part of this surface that moves on its own, and it moves
            because something is running: each LED turns while its shell is
            working and stops when the process exits (§7.3.9 — a loop that ran
            with nothing in flight would be a false statement about state).
            `LedSlot` is the app's single status glyph; a second shape here
            would be the §7.5.3 rule-5 violation. */}
        {/* Scrolls rather than clips. A workspace with twenty shells in it is
            a normal Tuesday, and a dock that silently swallowed the last
            fifteen would be worse than one that is a little long — the whole
            claim of this section is that it shows you everything that is
            running. `scroll-edge-fade` rather than a hairline, per §7.4: a rule
            across floating chrome reads as a seam in the material. */}
        <div
          class="flex items-center gap-1 min-w-0 min-h-0 overflow-auto scroll-edge-fade"
          classList={{ "flex-col": vertical() }}
          data-dock-processes
        >
          <For each={rows()}>
            {(row) => (
              <button
                type="button"
                data-dock-process={row().process.key}
                // The live label *is* the accessible name, not a decoration on
                // top of a static one: at 28px the glyph says "a terminal" and
                // nothing else, so the name has to carry which one.
                aria-label={`${row().process.kind === "agent" ? "Agent" : "Terminal"}: ${row().label}`}
                use:tooltip={row().label}
                onClick={() => open(row().process)}
                class="relative shrink-0 p-1.5 rounded-md border border-transparent cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/60 active:bg-accent/80 transition-[background-color,border-color,color] duration-[var(--dur-tint)] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Show
                  when={row().process.kind === "agent"}
                  fallback={<TerminalSquare class="w-3.5 h-3.5" />}
                >
                  <Bot class="w-3.5 h-3.5" />
                </Show>
                {/* Absolutely positioned so the LED's arrival and departure
                    cost no geometry — §7.6 forbids a state change that shifts
                    an icon slot, and the LED comes and goes with the shell's
                    activity. */}
                <LedSlot
                  signal={row().signal}
                  silent
                  class="absolute bottom-0 right-0 pointer-events-none"
                />
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={menuItems()}
            onClose={() => setMenu(null)}
            returnFocusTo={grip}
          />
        )}
      </Show>
    </>
  );
}

// ── The drag ─────────────────────────────────────────────────────────────────

/// The drop zone and its preview, for the duration of a dock drag.
///
/// The sibling of `SidebarDockOverlay`, and separate from it for the reason
/// `DragPayload.kind` states: the two gestures resolve different sets of edges,
/// and one zone that accepted both would have to branch on the payload at every
/// step of the arithmetic. Mounted inside the workbench, covering it, drawing
/// only while the strip is in flight and never capturing the pointer —
/// `dragDrop` hit-tests by coordinate, so `pointer-events: none` costs nothing.
export function DockStripOverlay() {
  const { state, actions } = useAppStore();
  let host: HTMLDivElement | undefined;
  const [edge, setEdge] = createSignal<DockSide | null>(null);

  const dragging = createMemo(() => activeDrag()?.kind === "dock");

  function localPoint(at: Point) {
    const r = host?.getBoundingClientRect();
    if (!r) return { size: { width: 0, height: 0 }, point: { x: 0, y: 0 } };
    return {
      size: { width: r.width, height: r.height },
      point: { x: at.x - r.left, y: at.y - r.top },
    };
  }

  registerDropZone({
    id: "dock-strip",
    el: () => host,
    // The same priority the sidebar zone takes, and for the same reason: a
    // release over the workbench is a dock, never a pane split. The two never
    // compete — each refuses the other's payload — so they can share it.
    priority: 5,
    accepts: (p) => p.kind === "dock",
    over: (_p, at) => {
      const { size, point } = localPoint(at);
      const next = dockStripEdgeAt(size, point);
      setEdge(next);
      // `null` on "no change" as well as on the middle band: promising a move
      // that will not happen is worse than no label, which is the contract
      // `describeDockDrop` states for sidebars.
      if (!next || next === state.dockStripSide) return null;
      return `Dock to the ${next} edge`;
    },
    leave: () => setEdge(null),
    drop: (_p, at) => {
      const { size, point } = localPoint(at);
      const next = dockStripEdgeAt(size, point);
      if (next) actions.setDockStripSide(next);
      setEdge(null);
    },
  });

  onCleanup(() => setEdge(null));

  /// How long the preview draws the strip along its own axis. The real strip is
  /// content-sized, so this measures it rather than guessing — the whole point
  /// of an edge affordance is that the release produces the rectangle the user
  /// was shown (`dockPreviewRect`'s header says the same for sidebars).
  const stripLength = () => {
    const el = document.querySelector<HTMLElement>("[data-dock-strip]");
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(r.width, r.height);
  };

  return (
    <div
      ref={host}
      // Always mounted so the zone has a rectangle to measure; only *drawn*
      // during a dock drag.
      class="absolute inset-0 pointer-events-none z-30"
      aria-hidden="true"
    >
      <Show when={dragging()}>
        <For each={DOCK_SIDES}>
          {(candidate) => {
            const rect = () => {
              const r = host?.getBoundingClientRect();
              return dockStripPreviewRect(
                { width: r?.width ?? 0, height: r?.height ?? 0 },
                candidate,
                DOCK_STRIP_THICKNESS,
                stripLength(),
              );
            };
            return (
              <Show when={edge() === candidate}>
                {/* Semantic tokens only — the preview borrows the focus ring's
                    colour rather than introducing one, exactly as the sidebar
                    drop preview does. */}
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
