/// Workbench | Editor | Git, for stacked mode.
///
/// Replaces the "Editor ↗" / "Git ↗" buttons when the three surfaces share one
/// window. Those two carry a dashed border and an up-right arrow because they
/// leave the window; these don't, so they read as a segmented control instead —
/// the affordance should say where the click lands before it happens.

import { For } from "solid-js";
import { STACKED_VIEWS, setStackedView, stackedView } from "@/commands/environment";

export function ViewSwitcher() {
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
            title={`Show the ${view.label.toLowerCase()}`}
            class="px-1.5 h-[18px] rounded text-[11px] transition-colors"
            classList={{
              "bg-accent text-foreground": stackedView() === view.id,
              "text-muted-foreground hover:text-foreground hover:bg-accent/50":
                stackedView() !== view.id,
            }}
          >
            {view.label}
          </button>
        )}
      </For>
    </div>
  );
}
