/// The collapse/expand primitive.
///
/// **The technique is the point.** §7.3.2 bans animating `height` and names
/// `grid-template-rows: 0fr → 1fr` as the replacement, and MOTION-PLAN F11
/// found zero uses of it: every section in the app snapped. A `0fr → 1fr`
/// track is the one way to animate a region to its *content's* height without
/// measuring anything, without a `max-height` guess that either clips tall
/// content or adds a lag to short content, and without touching layout on the
/// main thread every frame the way an animated `height` does.
///
/// The child must be a single element and must carry `min-height: 0` —
/// otherwise the grid item refuses to shrink below its content and the track
/// animates while nothing moves. Both are handled here rather than asked of
/// callers, which is most of why this is a component and not a class.
///
/// §7.1 budget: sidebar collapse is a 5–50×/session surface, so `--dur-short`
/// with `--ease-in-out` — a toggle goes there and back along one path, which is
/// what that curve is for (§7.2).
///
/// **Not for keyboard-initiated collapse.** If a section is collapsed by a
/// keystroke rather than by clicking its header, §7.1 is absolute: pass
/// `instant` and it renders with no transition at all.
import { Show, type JSX } from "solid-js";
import { ChevronRight } from "lucide-solid";
import { cn } from "./cn";

export interface DisclosureProps {
  open: boolean;
  children: JSX.Element;
  /// Renders a header button that toggles `open`. Omit it and the component is
  /// just the animating region — for a section whose header is a whole row of
  /// its own controls and cannot be a single `<button>`.
  label?: string;
  onToggle?: () => void;
  /// Right-hand side of the header row: counts, a refresh button.
  headerActions?: JSX.Element;
  /// Skip the transition. For a collapse driven from the keyboard (§7.1) or
  /// during the first paint, where animating from nothing is a flash.
  instant?: boolean;
  class?: string;
  headerClass?: string;
  contentClass?: string;
}

export function Disclosure(props: DisclosureProps) {
  const contentId = `disclosure-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div class={props.class}>
      <Show when={props.label !== undefined}>
        <button
          type="button"
          data-motion="disclosure-header"
          aria-expanded={props.open}
          aria-controls={contentId}
          onClick={() => props.onToggle?.()}
          class={cn(
            "w-full flex items-center gap-1 px-2 density-section text-left cursor-pointer",
            "text-muted-foreground hover:text-foreground",
            "transition-[color,background-color] duration-[var(--dur-tint)] ease-out",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            props.headerClass,
          )}
        >
          {/* The chevron rotates rather than swapping glyphs: one element, one
              property, and it interpolates — a swap between two icons cannot,
              and reads as a flicker over `--dur-short`. */}
          <ChevronRight
            aria-hidden="true"
            class={cn(
              "w-3 h-3 shrink-0",
              !props.instant &&
                "transition-transform duration-[var(--dur-short)] ease-in-out",
              props.open && "rotate-90",
            )}
          />
          <span class="ui-section-label flex-1 truncate">{props.label}</span>
          {props.headerActions}
        </button>
      </Show>
      <div
        id={contentId}
        data-motion="disclosure"
        // `grid` + a single `1fr`/`0fr` row. `overflow: hidden` on the *item*
        // below, not here, so a focus ring inside the content is not clipped
        // while the section is open.
        class={cn(
          "grid",
          !props.instant &&
            "transition-[grid-template-rows] duration-[var(--dur-short)] ease-in-out",
        )}
        style={{ "grid-template-rows": props.open ? "1fr" : "0fr" }}
        // `inert` rather than unmounting: the content keeps its scroll position
        // and its state across a collapse, and a collapsed section must not
        // hold focusable controls a Tab can reach but nobody can see.
        inert={!props.open}
      >
        <div class={cn("min-h-0 overflow-hidden", props.contentClass)}>{props.children}</div>
      </div>
    </div>
  );
}
