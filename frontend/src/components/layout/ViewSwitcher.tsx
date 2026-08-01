/// Workbench | Editor | Git, for stacked mode.
///
/// Replaces the "Editor ↗" / "Git ↗" buttons when the three surfaces share one
/// window. Those two carry a dashed border and an up-right arrow because they
/// leave the window; these don't, so they read as a segmented control instead —
/// the affordance should say where the click lands before it happens.
///
/// It is also the last stop in the escalation chain (§7.5.3 rule 1). A view
/// that is not in front hides its panes, its strips, its rail and its status
/// bar all at once, so every surface the other rules escalate to is covered:
/// a terminal that finishes while the user is reading a diff has nowhere left
/// to report except the segment that would take them back to it.
///
/// **The thumb.** The active segment used to change colour and nothing else
/// (MOTION-PLAN F17). A sliding pill encodes the *direction of travel* the same
/// way the tab strip's shared indicator does — it says which segment you left,
/// not only which one you are on — and it is the same mechanism: one persistent
/// element positioned by `translateX`, measured off the active button, rather
/// than a background that is destroyed in one place and created in another.
///
/// It survives §7.1's frequency gate on the same grounds as F15: it carries
/// information rather than decorating a state change. Everything else here
/// stays at `--dur-tint`.

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { STACKED_VIEWS, setStackedView, stackedView } from "@/commands/environment";
import { StatusLed, ledLabel } from "@/components/layout/StatusLed";
import { viewMark } from "@/store/activity";

export function ViewSwitcher() {
  let groupRef: HTMLDivElement | undefined;
  const [thumb, setThumb] = createSignal<{ left: number; width: number } | null>(null);
  /// No transition until the thumb has been placed once — otherwise it slides
  /// in from the group's left edge on first paint.
  const [instant, setInstant] = createSignal(true);

  /// The segment's tooltip and accessible name. A mark that only exists
  /// visually is not proactive for a screen-reader user (§10.10), and "Show the
  /// workbench" alone would not say that something over there wants attention.
  const label = (view: (typeof STACKED_VIEWS)[number]) => {
    const mark = viewMark(view.id);
    const base = `Show the ${view.label.toLowerCase()}`;
    return mark ? `${base} — ${ledLabel(mark)}` : base;
  };

  function measure() {
    const host = groupRef;
    if (!host) return;
    const el = host.querySelector<HTMLElement>(`[data-view="${CSS.escape(stackedView())}"]`);
    setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }

  onMount(() => {
    measure();
    requestAnimationFrame(() => setInstant(false));
    if (!groupRef) return;
    // Segment widths move when a label's text metrics change (the text-size
    // preference) and when the group itself is re-laid-out.
    const ro = new ResizeObserver(() => measure());
    ro.observe(groupRef);
    for (const child of Array.from(groupRef.children)) ro.observe(child);
    onCleanup(() => ro.disconnect());
  });

  createEffect(() => {
    void stackedView();
    queueMicrotask(measure);
  });

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label="Switch view"
      // `relative` makes the buttons' `offsetParent` this element, so
      // `measure()` reads coordinates already in the thumb's space.
      class="relative self-center flex items-center gap-0.5 rounded-md border border-border p-0.5 mx-1"
    >
      {/* The thumb, painted *under* the segments — it is a background, and a
          label drawn behind its own background is unreadable. `bg-accent` is
          exactly the fill the active segment used to carry, so nothing about
          the control's appearance at rest changed. */}
      <span
        aria-hidden="true"
        data-motion="view-switcher-thumb"
        class={[
          "pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded bg-accent",
          instant()
            ? ""
            : "transition-[transform,width,opacity] duration-[var(--dur-short)] ease-out",
        ].join(" ")}
        style={{
          opacity: thumb() ? 1 : 0,
          width: `${thumb()?.width ?? 0}px`,
          transform: `translateX(${thumb()?.left ?? 0}px)`,
        }}
      />
      <For each={STACKED_VIEWS}>
        {(view) => (
          <button
            data-view={view.id}
            data-motion="view-switcher-segment"
            onClick={() => setStackedView(view.id)}
            aria-pressed={stackedView() === view.id}
            title={label(view)}
            aria-label={label(view)}
            // `relative` so the segment stacks above the thumb. The *active*
            // segment's fill is the thumb's job now; the hover tint stays on
            // the button, and only inactive segments take it — a hover fill on
            // the active segment would paint over the thumb it is sitting on.
            class="relative flex items-center px-1.5 h-[18px] rounded text-label transition-[color,background-color] duration-[var(--dur-tint)] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            classList={{
              "text-foreground": stackedView() === view.id,
              "text-muted-foreground hover:text-foreground hover:bg-accent/50":
                stackedView() !== view.id,
            }}
          >
            {view.label}
            {/* The mark is an **overlay**, not a slot in the flex row.
                Reserving an 8px box in-flow (a `LedSlot` after the label) held
                that box open on all three segments at all times, and since the
                marks are almost always absent what it actually rendered was a
                permanent blank gutter to the right of every label — the
                control read as three mis-padded buttons rather than as a
                segmented control.
                Taking it out of flow keeps §7.5.3 rule 3 intact for the reason
                the slot existed: an absolutely-positioned mark changes no
                sibling's geometry when it arrives, so the button the user was
                about to click still does not move. It is nudged half over the
                segment's top-right corner, which is where a badge belongs and
                is clear of the label's own box.
                `silent` because the button's accessible name already says it. */}
            <Show when={viewMark(view.id)}>
              {(signal) => (
                <StatusLed
                  signal={signal()}
                  silent
                  class="pointer-events-none absolute -top-0.5 -right-0.5"
                />
              )}
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
