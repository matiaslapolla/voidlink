import { For, Show, type JSX } from "solid-js";
import { dockStripReservation, type DockSide } from "@/store/layout";

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
///   • **A slot is never moved, only reordered.** See `AppShellSidebar`. Docked
///     mode does not break this: a floated panel and the dock strip are
///     *positioned* differently, in the same DOM position they always had, so
///     the environment mode is one more CSS change rather than a re-parent.
///
/// Docked mode adds one axis the flex row cannot express — the bottom edge is
/// perpendicular to it — so the strip is absolutely positioned inside the
/// workbench box rather than ordered into the row, and the row reserves its
/// lane with padding. One element, one DOM position, three edges.
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
  /// Take this slot out of the flex row and float it against `side()` instead.
  ///
  /// Docked mode's expanded panel: the dock strip is what the user is
  /// navigating from, and a panel that pushed the workbench sideways every time
  /// they glanced at the file tree would reflow the editor — and, under it,
  /// re-measure every terminal grid — on a gesture that is meant to be as cheap
  /// as a hover. Floating it costs the workbench nothing.
  ///
  /// **It is still the same element in the same DOM position.** This flips
  /// `position` and the insets on a slot that is already there, which is the
  /// no-remount contract this whole interface exists to keep (see the header
  /// above): a panel does not unmount because the environment mode changed, any
  /// more than it does because its edge did.
  float?: () => boolean;
}

/// The floating dock strip (`environmentMode: "docked"`).
///
/// Handed to the shell rather than rendered by it, because `AppShell` is
/// store-free on purpose — its own tests mount it with no provider at all. What
/// the shell owns is the *geometry*: where the strip is anchored, and how much
/// room the islands give up for it. `DockStrip` renders the buttons.
export interface AppShellDock {
  side: () => DockSide;
  /// The strip's thickness across its own axis, in px. Handed in because it is
  /// the dock's constant (`DOCK_STRIP_THICKNESS`), not the shell's — but the
  /// shell is what turns it into padding, per §5's "geometry lives here" rule.
  thickness: () => number;
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
  /// The dock strip, or `null` outside docked mode.
  dock?: AppShellDock | null;
  /// Fill the parent instead of the viewport. Stacked mode nests the workbench
  /// inside a view container, where `h-screen` would overflow past the title bar.
  fill?: boolean;
}

/// `--island-gap` in px, for the one piece of arithmetic that needs it as a
/// number rather than as a CSS value: the dock's reservation is `thickness +
/// gap`, and CSS cannot add a custom property to a JavaScript constant inside a
/// `padding` shorthand without a `calc()` per side.
///
/// The second reader of that token, and named so it is visible as one —
/// `Splitter.tsx`'s `islandGapPx()` is the first, and §5 says not to add a
/// third without noticing. It is the same 6px `index.css` declares.
const ISLAND_GAP_FALLBACK = 6;

/// The reservation, as the three padding properties that express it. A slot
/// with no dock on its edge gets `0`, which is what makes this safe to spread
/// unconditionally.
function paddingFor(room: { left: number; right: number; bottom: number }) {
  return {
    "padding-left": `${room.left}px`,
    "padding-right": `${room.right}px`,
    "padding-bottom": `${room.bottom}px`,
  };
}

/// Where the strip pins itself inside the workbench box. Centred along its own
/// axis at the side edges and at the bottom alike — a dock is a floating object
/// with a middle, not a column that fills its edge, which is the whole visual
/// difference between it and the rails it replaces.
function anchorFor(side: DockSide): Record<string, string> {
  if (side === "bottom") {
    return { bottom: "0", left: "50%", transform: "translateX(-50%)" };
  }
  return {
    top: "50%",
    transform: "translateY(-50%)",
    [side === "right" ? "right" : "left"]: "0",
  };
}

export function AppShell(props: AppShellProps) {
  /// The strip's lane, in px per edge — `0` on all three with no dock.
  ///
  /// Read by *both* consumers of the reservation, which is the point of hoisting
  /// it: the flex container turns it into padding, and every floated panel
  /// turns it into an offset. Those two have to agree, and they did not when the
  /// padding was the only expression of it — an absolutely positioned panel
  /// resolves `left: 0` against the container's **padding box**, so the lane the
  /// padding reserves is exactly the strip of space a floated panel was free to
  /// slide underneath. In docked mode every sidebar floats (`float`), so that was
  /// every opened panel overlapping the strip that opened it.
  const room = () =>
    props.dock
      ? dockStripReservation(props.dock.side(), props.dock.thickness(), ISLAND_GAP_FALLBACK)
      : { left: 0, right: 0, bottom: 0 };

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
        {/* `relative`, and the *only* positioning context in the shell: the
            dock strip and any floated panel are anchored to this box, which is
            the workbench's own rectangle — inside the inset, above the status
            bar. A dock anchored to the window instead would sit under the
            status bar at the bottom edge and outside the inset at the sides,
            which is D1's geometry broken from the one file that owns it.

            `padding` reserves the strip's lane so the islands stop short of it
            rather than sliding under it. It is padding on the flex container
            rather than a margin on each island for the same reason the inset
            is: one number, in one place, and no panel restating it (§5). */}
        <div
          class="relative flex flex-1 overflow-hidden min-h-0"
          style={{
            gap: "var(--island-gap)",
            // The gap between the strip and the first island is the same gap
            // that separates any two islands. `--island-gap` is 6px; it is read
            // as a number in `room()` rather than retyped because §5 permits
            // exactly this file to compose it.
            ...paddingFor(room()),
          }}
        >
          <For each={props.sidebars}>
            {(sidebar) => (
              <div
                class="island island-slot flex-shrink-0 flex"
                classList={{ absolute: sidebar.float?.() }}
                data-sidebar={sidebar.id}
                data-dock={sidebar.side()}
                data-float={sidebar.float?.() ? "" : undefined}
                style={
                  sidebar.float?.()
                    ? // Floated: pinned to its own edge, full height of the
                      // workbench, above the panes but below the window frame
                      // — `--z-panel` is the layer for "chrome the user
                      // opened, not an overlay that blocks them" (§6).
                      //
                      // Offset by the strip's lane on the two edges that can
                      // collide with it: its own, and the bottom. A panel and
                      // the dock never share space — see `room()`.
                      {
                        order: String(sidebar.order()),
                        top: "0",
                        bottom: `${room().bottom}px`,
                        [sidebar.side() === "right" ? "right" : "left"]:
                          `${sidebar.side() === "right" ? room().right : room().left}px`,
                        "z-index": "var(--z-panel)",
                      }
                    : { order: String(sidebar.order()) }
                }
              >
                {sidebar.content}
              </div>
            )}
          </For>
          <Show when={props.dock}>
            {(dock) => (
              <div
                class="absolute flex pointer-events-none"
                data-dock-slot={dock().side()}
                style={{
                  "z-index": "var(--z-panel)",
                  ...anchorFor(dock().side()),
                }}
              >
                {dock().content}
              </div>
            )}
          </Show>
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
