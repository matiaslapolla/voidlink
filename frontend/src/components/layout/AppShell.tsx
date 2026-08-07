import { For, type JSX } from "solid-js";
import type { DockSide } from "@/store/layout";

/// The workbench shell, and the **only** place D1's island geometry is
/// composed (see `frontend/design-system/MASTER.md` §4).
///
/// Direction D1, "Recessed Canvas": the rail, both sidebars, the main surface
/// and the status bar are detached panels floating on a canvas that sits
/// *below* them. The canvas recedes; the islands do not rise — every reading
/// surface keeps exactly the lightness it had before.
///
/// Four properties are load-bearing and easy to lose:
///
///   • **Geometry lives here, not in the panels.** The inset, the gaps and the
///     radius are applied by this component (and by `MainSurface` for the
///     split tree). A panel that decided its own inset would make the
///     documented D4 fallback a four-wave rework instead of a one-wave one.
///   • **Islands have no border.** `.island` (in `index.css`) is radius plus
///     clipping and nothing else. The boundary budget is spent once, on the
///     tab card, per MASTER's no-card-in-card rule.
///   • **An empty slot must not leave a gap.** Zen passes nothing for every
///     sidebar, a detached panel renders nothing in the shell, and the right
///     sidebar renders nothing at all without a repo; `.island-slot:empty`
///     collapses those so the gap goes with them.
///   • **A slot is never moved, only reordered.** See `AppShellSidebar`.
///
/// The title bar stays flush above the inset: it is window chrome, it carries
/// the traffic lights, and an inset around it would read as a floating toolbar
/// rather than as the window's own edge.

/// One dockable panel's slot.
///
/// `side` and `order` are **accessors, deliberately**. The shell renders one
/// slot per sidebar exactly once, in a fixed DOM position, and a dock change
/// rewrites CSS `order` on an element that is already there. Nothing is moved
/// between two lists, nothing is unmounted, and in particular nothing about the
/// main surface — which owns the live PTYs — is disturbed by a panel changing
/// edge. Passing plain values instead would make the array itself reactive, the
/// `<For>` would rebuild its rows, and moving a sidebar across the window would
/// tear down and rebuild the tree beside it. That is the remount `App.tsx`'s
/// workbench comment exists to prevent, one layer up.
export interface AppShellSidebar {
  /// Stable across the panel's life; the shell only uses it as a `<For>` key
  /// and as a `data-sidebar` attribute for tests and for the drop zones.
  id: string;
  side: () => DockSide;
  /// Flex `order` for this slot. Left-edge panels are negative, right-edge
  /// panels positive, and the main surface sits at 0 — see `slotOrder`.
  order: () => number;
  /// Rendered once. A panel that is collapsed, hidden or detached renders
  /// nothing *from inside here*, which leaves the slot empty and collapses it.
  content: JSX.Element;
}

interface AppShellProps {
  /// `null` in stacked mode: the window's title bar lives above all three views
  /// there, so the workbench view must not draw a second one.
  titleBar: JSX.Element | null;
  /// Every dockable panel, in a stable list. The array is read once — see
  /// `AppShellSidebar` for why that matters.
  sidebars: AppShellSidebar[];
  main: JSX.Element;
  statusBar: JSX.Element;
  /// Fill the parent instead of the viewport. Stacked mode nests the workbench
  /// inside a view container, where `h-screen` would overflow past the title bar.
  fill?: boolean;
}

export function AppShell(props: AppShellProps) {
  return (
    <div
      class="flex flex-col w-full text-foreground bg-canvas overflow-hidden"
      classList={{ "h-screen": !props.fill, "h-full": props.fill }}
    >
      {props.titleBar}
      <div
        class="flex flex-col flex-1 min-h-0 overflow-hidden"
        style={{ padding: "var(--island-inset)", gap: "var(--island-gap)" }}
      >
        <div
          class="flex flex-1 overflow-hidden min-h-0"
          style={{ gap: "var(--island-gap)" }}
        >
          <For each={props.sidebars}>
            {(sidebar) => (
              <div
                class="island island-slot flex-shrink-0 flex"
                data-sidebar={sidebar.id}
                data-dock={sidebar.side()}
                style={{ order: String(sidebar.order()) }}
              >
                {sidebar.content}
              </div>
            )}
          </For>
          {/* Not an island: the pane groups *inside* `MainSurface` are the
              islands, so that a split reads as two panels rather than as one
              panel with a line down it. With a single group the group's island
              is exactly this rectangle, which is why an un-split workbench
              looks like the diagram in the directions spec.

              `order: 0` is what every sidebar's order is signed against: the
              workbench is the fixed point the panels arrange themselves around,
              and it never moves in the DOM either. */}
          <div
            class="flex-1 flex flex-col overflow-hidden min-w-0 relative"
            style={{ order: "0" }}
          >
            {props.main}
          </div>
        </div>
        <div class="island island-slot flex-shrink-0">{props.statusBar}</div>
      </div>
    </div>
  );
}
