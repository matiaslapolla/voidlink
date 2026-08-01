/// Transient notices, and the budget that keeps them from becoming the UI.
///
/// ## Why there is a budget at all
///
/// MASTER §7.5.5 picks an interruption *level* per event — ambient, transient,
/// blocking — and says nothing about **rate**. That was fine while one thing
/// happened at a time. It stopped being fine the moment fan-out and triggers
/// arrived: one prompt now runs N agents in N worktrees, and N legs failing
/// produces N stacked toasts describing one event. The attention budget did not
/// grow by a factor of N; only the traffic did.
///
/// So a toast may declare a `source`, and two toasts from the same source
/// collapse into one carrying a count. `source` is a *cause*, not a category —
/// `run:${runId}`, not `"agent"` — because the thing being counted is "how many
/// times did this one operation shout", and a category key would merge two
/// unrelated failures into a number that means nothing.
///
/// A toast with no `source` never coalesces. That is the default on purpose:
/// coalescing is a claim that two messages are the *same* news, and only the
/// call site knows whether that is true.
///
/// ## The ceiling
///
/// Independently of coalescing, at most `MAX_VISIBLE` toasts are on screen. Past
/// that the least severe and oldest is evicted, so a burst of successes can
/// never push a failure off the stack. Without a ceiling, ten distinct sources
/// failing at once still buries the screen — coalescing alone solves the "one
/// thing shouting N times" case, not the "N things shouting once" case.

import { createSignal } from "solid-js";

/// An affordance rendered inside the toast. MASTER.md §7.5.5: a transient
/// notice for a failure carries Retry, and one for a reversible effect carries
/// Undo — a toast that only says what went wrong makes the user go and find the
/// control again. Invoking it dismisses the toast.
export interface ToastAction {
  label: string;
  run: () => void;
}

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  ttlMs: number;
  /// Optional affordance rendered inside the toast — Retry on a failure, Undo
  /// on a reversible action (MASTER §7.5.5: "Undo beats confirm", and a
  /// failure toast with no way to act on it is just an obituary). Running it
  /// dismisses the toast.
  action?: ToastAction;
  /// Coalescing key. See the header: a cause, not a category.
  source?: string;
  /// How many pushes this toast represents. `1` for everything that has not
  /// coalesced, which is almost everything — the viewport only renders the
  /// number when it is above one.
  count: number;
}

/// How many toasts may be on screen at once.
///
/// Four is the point at which the stack stops being readable at a glance in the
/// bottom-right corner at the sizes this app uses. It is a display limit, not a
/// judgement about how many things may be wrong.
export const MAX_VISIBLE = 4;

/// Eviction order when the ceiling is hit: least severe goes first, and among
/// equals the oldest. A run of successes must never be able to push a failure
/// off the stack.
const SEVERITY: Record<ToastKind, number> = { info: 0, success: 1, warning: 2, error: 3 };

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

/// Live dismissal timers, so a coalesced toast can have its TTL refreshed
/// rather than inheriting the first push's deadline — five failures over four
/// seconds should leave the count on screen for the full window after the
/// *last* one, not vanish mid-burst.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

// ─── The pure part ───────────────────────────────────────────────────────
//
// Split out so the two rules that matter — what coalesces, and what gets
// evicted — are testable without a DOM, a clock, or a mounted viewport.

/// Fold `incoming` into `list`.
///
/// Returns the new list and the id that ended up carrying the message, which is
/// an existing toast's id when it coalesced and `incoming.id` otherwise. The
/// caller needs that to know which timer to reset.
///
/// Coalescing requires the same `source` **and** the same `kind`: a run that
/// warns and then fails is telling you two different things, and merging them
/// would let the more severe news inherit the less severe icon.
export function foldToast(
  list: readonly Toast[],
  incoming: Toast,
): { list: Toast[]; id: number } {
  if (incoming.source !== undefined) {
    const existing = list.find((t) => t.source === incoming.source && t.kind === incoming.kind);
    if (existing) {
      // The newest message and the newest action win. The message because the
      // latest failure is the one whose detail is still relevant; the action
      // because a Retry captured three failures ago may close over stale state.
      const merged: Toast = {
        ...existing,
        message: incoming.message,
        action: incoming.action,
        ttlMs: incoming.ttlMs,
        count: existing.count + 1,
      };
      return { list: list.map((t) => (t.id === existing.id ? merged : t)), id: existing.id };
    }
  }
  return { list: enforceCeiling([...list, incoming]), id: incoming.id };
}

/// Trim to `MAX_VISIBLE`, dropping least-severe-then-oldest first.
///
/// Never drops the toast that was just added, even when it is the least severe
/// thing on screen: a notice that appears and is instantly evicted is
/// indistinguishable from a notice that was never raised, and the call site has
/// no way to find out.
export function enforceCeiling(list: readonly Toast[]): Toast[] {
  if (list.length <= MAX_VISIBLE) return [...list];
  const newest = list[list.length - 1];
  const candidates = list.slice(0, -1);
  // Ascending by severity, then by age (list order is insertion order), so the
  // front of this array is what goes first.
  const doomed = new Set(
    [...candidates]
      .sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || a.id - b.id)
      .slice(0, list.length - MAX_VISIBLE)
      .map((t) => t.id),
  );
  return list.filter((t) => t.id === newest.id || !doomed.has(t.id));
}

// ─── The stateful part ───────────────────────────────────────────────────

/// Raise a transient notice.
///
/// `source` is the coalescing key and the only argument here that is not
/// obvious: give one when a single operation can raise this notice repeatedly
/// (a fan-out leg, a watcher, a retry loop), and leave it off for anything a
/// person just did once.
export function pushToast(
  message: string,
  kind: ToastKind = "info",
  ttlMs = 3500,
  action?: ToastAction,
  source?: string,
) {
  const incoming: Toast = { id: nextId++, message, kind, ttlMs, action, source, count: 1 };
  let carrier = incoming.id;
  setToasts((cur) => {
    const { list, id } = foldToast(cur, incoming);
    carrier = id;
    // Anything the fold dropped has a timer that will fire against an id that
    // is no longer in the list. Harmless, but it leaks a handle per eviction,
    // and this runs for the life of the process.
    for (const t of cur) if (!list.some((n) => n.id === t.id)) clearTimer(t.id);
    return list;
  });

  clearTimer(carrier);
  // The bare global rather than `window.setTimeout`: this module is otherwise
  // pure state and belongs in the `unit` project, which runs in node.
  timers.set(
    carrier,
    setTimeout(() => {
      timers.delete(carrier);
      setToasts((cur) => cur.filter((t) => t.id !== carrier));
    }, ttlMs),
  );
  return carrier;
}

export function dismissToast(id: number) {
  clearTimer(id);
  setToasts((cur) => cur.filter((t) => t.id !== id));
}

/// Drop every toast from one source at once — for "the run was cancelled, its
/// complaints are no longer news".
export function dismissToastSource(source: string) {
  setToasts((cur) => {
    for (const t of cur) if (t.source === source) clearTimer(t.id);
    return cur.filter((t) => t.source !== source);
  });
}

export function useToasts() {
  return { toasts };
}

/// Test seam: drop everything, including pending timers.
export function resetToasts() {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
  setToasts([]);
}

function clearTimer(id: number) {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    timers.delete(id);
  }
}
