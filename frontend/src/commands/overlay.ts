import { createSignal, type Accessor } from "solid-js";

/// Tracks whether *any* modal surface is on screen.
///
/// This exists solely because of embedded browser tabs. A Tauri child webview
/// composites above the entire DOM — there is no z-index that puts a dialog,
/// popover or context menu over it. So every overlay has to actively push the
/// browser webview out of the way while it is open, and the browser pane
/// subscribes to this signal to know when.
///
/// Counted rather than boolean: overlays stack (the palette can open the
/// prompt, which can open a confirm), and the last one to close is the one
/// that should bring the webview back.

const [count, setCount] = createSignal(0);

/// True while at least one modal surface is open.
export function isOverlayOpen(): boolean {
  return count() > 0;
}

/// Register an overlay as open/closed. Idempotent per caller: pass the same
/// `open` value repeatedly and the count only moves on a transition.
///
/// Low-level and rarely what a new overlay should call directly — see
/// `createOverlay` below. This stays exported for the surfaces whose "open"
/// state is not a boolean signal of its own to wrap: `stacked-view` is a
/// derived condition (`currentView() !== "workbench"`, in `App.tsx`, with a
/// comment explaining why a non-modal view uses the modal mechanism), and the
/// worktree wizard's open state is "is there a request queued", which
/// `commands/worktree.ts` already tracks as `NewWorktreeRequest | null`. Both
/// call this at the exact point their own state transitions, which keeps the
/// registration co-located with the state even though neither is a plain
/// boolean `createOverlay` could own.
export function setOverlayOpen(key: string, open: boolean): void {
  const wasOpen = openKeys.has(key);
  if (open === wasOpen) return;
  if (open) openKeys.add(key);
  else openKeys.delete(key);
  setCount(openKeys.size);
}

const openKeys = new Set<string>();

/// A boolean open/closed signal that keeps the overlay count in sync by
/// construction, instead of by a `createEffect` someone has to remember to
/// write.
///
/// This is the fix for BR-O1. Before it, a new modal surface picked a
/// `createSignal(false)` for its open state, and *separately*, in `App.tsx`,
/// someone had to add `createEffect(() => setOverlayOpen("key", isOpen()))` —
/// a second file, a second edit, no compiler or runtime check that the two
/// were kept in sync. `App.tsx` grew one line per overlay the app ever
/// gained, and forgetting the line was silent: the surface rendered fine,
/// just behind the browser webview, which reads as "the dialog didn't open"
/// rather than as a registration bug.
///
/// `createOverlay(key)` collapses that into one declaration. `open`, `close`,
/// `toggle` and `set` all update `openKeys` in the same call that flips the
/// signal — there is no separate reactive step to drop, and no unregistered
/// state for a surface built on this to be in. A surface that reaches for
/// `createOverlay` instead of a bare `createSignal` cannot forget the second
/// half, because there is no second half.
///
/// What this does *not* guarantee: a new overlay author can still reach for
/// `createSignal` instead of this and quietly reintroduce the bug, the same
/// way a new tab kind could still hand-roll its persistence instead of
/// filling in a `TabKindSpec`. The fix is making the safe path the shortest
/// one to write, not making the unsafe path impossible.
export interface Overlay {
  isOpen: Accessor<boolean>;
  open(): void;
  close(): void;
  toggle(): void;
  set(open: boolean): void;
}

export function createOverlay(key: string): Overlay {
  const [isOpen, setIsOpen] = createSignal(false);
  const set = (open: boolean) => {
    setIsOpen(open);
    setOverlayOpen(key, open);
  };
  return {
    isOpen,
    open: () => set(true),
    close: () => set(false),
    toggle: () => set(!isOpen()),
    set,
  };
}
