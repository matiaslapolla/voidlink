import type { JSX } from "solid-js";

/// The workbench shell, and the **only** place D1's island geometry is
/// composed (see `docs/specs/2026-07-29-ui-directions.md`).
///
/// Direction D1, "Recessed Canvas": the rail, both sidebars, the main surface
/// and the status bar are detached panels floating on a canvas that sits
/// *below* them. The canvas recedes; the islands do not rise — every reading
/// surface keeps exactly the lightness it had before.
///
/// Three properties are load-bearing and easy to lose:
///
///   • **Geometry lives here, not in the panels.** The inset, the gaps and the
///     radius are applied by this component (and by `MainSurface` for the
///     split tree). A panel that decided its own inset would make the
///     documented D4 fallback a four-wave rework instead of a one-wave one.
///   • **Islands have no border.** `.island` (in `index.css`) is radius plus
///     clipping and nothing else. The boundary budget is spent once, on the
///     tab card, per MASTER's no-card-in-card rule.
///   • **An empty slot must not leave a gap.** Zen passes `null` for the rail
///     and both sidebars, and the right sidebar renders nothing at all without
///     a repo; `.island-slot:empty` collapses those so the gap goes with them.
///
/// The title bar stays flush above the inset: it is window chrome, it carries
/// the traffic lights, and an inset around it would read as a floating toolbar
/// rather than as the window's own edge.
interface AppShellProps {
  /// `null` in stacked mode: the window's title bar lives above all three views
  /// there, so the workbench view must not draw a second one.
  titleBar: JSX.Element | null;
  /// Far-left vertical column listing workspaces and their worktrees. Replaces
  /// the old full-width `tabBar` slot — the tab strip is per-worktree now and
  /// lives inside `main`.
  rail: JSX.Element;
  sidebar: JSX.Element;
  main: JSX.Element;
  rightSidebar: JSX.Element;
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
          <div class="island island-slot flex-shrink-0 flex">{props.rail}</div>
          <div class="island island-slot flex-shrink-0 flex">{props.sidebar}</div>
          {/* Not an island: the pane groups *inside* `MainSurface` are the
              islands, so that a split reads as two panels rather than as one
              panel with a line down it. With a single group the group's island
              is exactly this rectangle, which is why an un-split workbench
              looks like the diagram in the directions spec. */}
          <div class="flex-1 flex flex-col overflow-hidden min-w-0 relative">
            {props.main}
          </div>
          <div class="island island-slot flex-shrink-0 flex">{props.rightSidebar}</div>
        </div>
        <div class="island island-slot flex-shrink-0">{props.statusBar}</div>
      </div>
    </div>
  );
}
