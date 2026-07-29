import { createSignal } from "solid-js";

/// One in-flight gate per pane, shared by every git action that pane offers.
///
/// Twenty-odd destructive buttons had no guard at all: double-clicking "Undo
/// commit" soft-reset to HEAD~2, two fast Ctrl+Enters made two commits, and the
/// operation banner's Continue could be pressed while the previous continue was
/// still running. The three handlers that *did* guard each hand-rolled their own
/// boolean, which is how the other twenty came to be missing one.
///
/// So: one primitive. `busy()` drives `disabled` on the controls; `run()` is the
/// gate itself, and it must be the gate rather than the `disabled` attribute —
/// keyboard shortcuts and event listeners invoke handlers directly, never
/// through the button.
///
/// Deliberately *not* a queue. A second click on a git mutation while the first
/// is in flight means the user did not see the first take effect; running it
/// twice is what caused the damage.
export interface InFlight {
  /// True while an action is running. Bind to `disabled`.
  busy: () => boolean;
  /// Run `action` unless one is already running. Returns the action's value, or
  /// `undefined` when it was skipped — so a caller can tell the difference.
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
}

export function createInFlight(): InFlight {
  const [busy, setBusy] = createSignal(false);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busy()) return undefined;
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  }

  return { busy, run };
}

/// Collapse concurrent calls of one async function into a single execution.
///
/// A single `emitGitRefsChanged()` wakes a dozen panes at once and several of
/// them refetch the same command; on top of that a burst of mutations can land
/// while a refetch is still in flight. Callers here share the pending promise
/// instead of starting a second identical round-trip.
export function dedupeConcurrent<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    pending = fn().finally(() => {
      pending = null;
    });
    return pending;
  };
}
