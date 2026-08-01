/// The project brain, as a palette-invoked overlay.
///
/// Cut C2 of the 2026-07-29 audit: `brain` was one of ten tab kinds, and the
/// argument for cutting it is that a tab-strip slot is for something that
/// *reports state*. A vault entry reports nothing — it does not run, go dirty,
/// or fail — so it spent a slot and a persistence key saying nothing, next to
/// terminals and agent runs that had something to say.
///
/// The audit proposed demoting it onto `QuickPick`. That is the right shape for
/// *searching* notes and the wrong one for this surface, which also reads them
/// (a rendered markdown pane) and writes them (the quick-note form). A popover
/// list cannot hold either, so demoting onto one would have deleted two
/// capabilities under the name of a move. This is the same `BrainSurface`,
/// unchanged, in a large overlay panel instead of a tab.
///
/// What it browses changed later: a personal `brain-kb` vault at a configured
/// path became `<repoRoot>/.voidlink/brain`, one brain per project, so the
/// overlay follows whichever repo is open instead of a setting.
///
/// **No animation.** Opened and closed by a chord like every other overlay —
/// MASTER.md §7.1 puts a keyboard-initiated transition at 0ms, and §11 names
/// animating one as an anti-pattern. The scrim and panel match `QuickPick`'s so
/// the two read as the same class of surface.
import { Show, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { BrainSurface } from "@/components/brain/BrainSurface";

export function BrainOverlay(props: { repoPath: string; onClose: () => void }) {
  /// ESC closes. Captured at the document because focus is usually inside the
  /// surface's own search input or textarea by the time the user presses it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    props.onClose();
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[var(--z-overlay)] flex items-start justify-center pt-[8vh] bg-black/40"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Brain"
          class="w-[1100px] max-w-[92vw] h-[76vh] bg-popover border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span class="text-xs font-medium">Brain</span>
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-muted-foreground/70 tracking-wide">ESC</span>
              <button
                type="button"
                aria-label="Close Brain"
                onClick={props.onClose}
                class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div class="flex-1 min-h-0">
            <BrainSurface repoPath={props.repoPath} />
          </div>
        </div>
      </div>
    </Portal>
  );
}

/// Convenience wrapper for the one call site in `App.tsx`, so the open/close
/// signal and the repo path stay together.
export function BrainOverlayHost(props: {
  open: boolean;
  repoPath: string;
  onClose: () => void;
}) {
  return (
    <Show when={props.open}>
      <BrainOverlay repoPath={props.repoPath} onClose={props.onClose} />
    </Show>
  );
}
