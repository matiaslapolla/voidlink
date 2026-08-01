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

import { For } from "solid-js";
import { STACKED_VIEWS, setStackedView, stackedView } from "@/commands/environment";
import { LedSlot, ledLabel } from "@/components/layout/StatusLed";
import { viewMark } from "@/store/activity";

export function ViewSwitcher() {
  /// The segment's tooltip and accessible name. A mark that only exists
  /// visually is not proactive for a screen-reader user (§10.10), and "Show the
  /// workbench" alone would not say that something over there wants attention.
  const label = (view: (typeof STACKED_VIEWS)[number]) => {
    const mark = viewMark(view.id);
    const base = `Show the ${view.label.toLowerCase()}`;
    return mark ? `${base} — ${ledLabel(mark)}` : base;
  };

  return (
    <div
      role="group"
      aria-label="Switch view"
      class="self-center flex items-center gap-0.5 rounded-md border border-border p-0.5 mx-1"
    >
      <For each={STACKED_VIEWS}>
        {(view) => (
          <button
            onClick={() => setStackedView(view.id)}
            aria-pressed={stackedView() === view.id}
            title={label(view)}
            aria-label={label(view)}
            class="flex items-center gap-1 px-1.5 h-[18px] rounded text-[11px] transition-colors"
            classList={{
              "bg-accent text-foreground": stackedView() === view.id,
              "text-muted-foreground hover:text-foreground hover:bg-accent/50":
                stackedView() !== view.id,
            }}
          >
            {view.label}
            {/* A `LedSlot` rather than a `<Show>`: the box is reserved at rest,
                so a mark arriving never re-lays-out the segmented control and
                shifts the button the user was about to click (§7.5.3 rule 3).
                `silent` because the button's own accessible name already says
                what the mark says. */}
            <LedSlot signal={viewMark(view.id)} silent />
          </button>
        )}
      </For>
    </div>
  );
}
