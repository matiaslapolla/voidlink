/// The project board, as a palette-invoked overlay.
///
/// **Why an overlay and not a tab kind.** The obvious shape for a board is a
/// thirteenth `TabKind`, and that is what this slice was scoped as. The brain
/// is the precedent it was told to copy, and the brain is not a tab: cut C2 of
/// the 2026-07-29 audit took it off the strip on the rule that *a tab-strip
/// slot is for something that reports state*. A terminal goes busy, a compare
/// goes dirty, an agent run fails. A board of cards does none of that — it
/// would hold a slot, a persistence key, a `ClosedTab` variant and a snapshot
/// field while having nothing to say, next to the tabs that do.
///
/// So it is here, beside the brain, reached the same two ways (the palette,
/// and the tab bar's `+` menu) and dismissed the same way. Should a board ever
/// grow something to report — a card whose check failed, an agent working one
/// — that is the argument for promoting it, and `TAB_SPECS` is where it goes.
///
/// **No animation.** Opened and closed by a chord like every other overlay —
/// MASTER.md §7.1 puts a keyboard-initiated transition at 0ms, and §11 names
/// animating one as an anti-pattern. The scrim and panel match `BrainOverlay`'s
/// so the two read as the same class of surface.
import { Show, onCleanup } from "solid-js";
import { X } from "lucide-solid";
import { Portal } from "solid-js/web";
import { BoardSurface } from "@/components/board/BoardSurface";

export function BoardOverlay(props: {
  repoPath: string;
  onClose: () => void;
  onOpenCard?: (repoRelativePath: string) => void;
}) {
  /// ESC closes. Captured at the document because focus is usually inside the
  /// new-card input by the time the user presses it.
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
          aria-label="Board"
          class="w-[1100px] max-w-[92vw] h-[76vh] material-structural border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span class="text-body font-medium">Board</span>
            <div class="flex items-center gap-2">
              <span class="text-micro text-muted-foreground/70 tracking-wide">ESC</span>
              <button
                type="button"
                aria-label="Close Board"
                onClick={props.onClose}
                class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div class="flex-1 min-h-0">
            <BoardSurface repoPath={props.repoPath} onOpenCard={props.onOpenCard} />
          </div>
        </div>
      </div>
    </Portal>
  );
}

/// Convenience wrapper for the one call site in `App.tsx`, so the open/close
/// signal and the repo path stay together.
export function BoardOverlayHost(props: {
  open: boolean;
  repoPath: string;
  onClose: () => void;
  onOpenCard?: (repoRelativePath: string) => void;
}) {
  return (
    <Show when={props.open}>
      <BoardOverlay repoPath={props.repoPath} onClose={props.onClose} onOpenCard={props.onOpenCard} />
    </Show>
  );
}
