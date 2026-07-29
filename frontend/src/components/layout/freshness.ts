/// MASTER.md §7.5.4, made mechanical.
///
/// "Every git-derived or disk-derived value renders in exactly one of three
/// states, and the state is visible." The failure that rule exists to prevent
/// is an ahead/behind count from four minutes ago rendered exactly like one
/// from four milliseconds ago — the reader has no way to tell, so they trust
/// the wrong number and push onto a branch that moved.
///
/// A component that cannot say which of the three it is has a bug, so this
/// module makes it cheap to say: give it the resource's loading flag and the
/// timestamp of the last successful read, and it returns the state plus the
/// class and the tooltip that make the state visible.
import { createSignal, onCleanup, type Accessor } from "solid-js";

export type Freshness = "live" | "refreshing" | "stale";

/// How long a git-derived value stays trustworthy without a refresh.
///
/// The workbench re-reads on `voidlink:refresh-git`, which fires after every
/// local operation — so a value goes stale only when the *remote* could have
/// moved under it without anything local happening. Two minutes is short
/// enough that a stale ahead/behind is flagged before it misleads, and long
/// enough that a bar full of ghosted numbers isn't the resting state.
export const STALE_AFTER_MS = 120_000;

export interface FreshnessInput {
  /// The resource is in flight right now.
  loading: boolean;
  /// When the last successful read landed, or `null` if there has never been
  /// one. Never-read is not stale — it is simply not a value yet, and the
  /// caller renders nothing rather than a ghosted placeholder.
  readAt: number | null;
  now: number;
  staleAfterMs?: number;
}

export function freshnessOf(input: FreshnessInput): Freshness {
  // Refreshing outranks stale: the old value is still on screen underneath,
  // and saying "this is being fixed right now" is more useful than "this is
  // old" when both are true (§7.5.4 — never flash to a skeleton or a dash).
  if (input.loading) return "refreshing";
  if (input.readAt === null) return "live";
  const age = input.now - input.readAt;
  return age >= (input.staleAfterMs ?? STALE_AFTER_MS) ? "stale" : "live";
}

/// The class that makes the state visible. Applied to the *value*, never to
/// its container (§7.5.4).
///
/// `animate-pulse` here is a functional loop, not decoration: it runs only
/// while a read is genuinely in flight, and §7.4 exempts functional loops from
/// the reduced-motion zeroing precisely so the state survives. Stale is a
/// 60%-opacity ghost, which needs no motion at all.
export function freshnessClass(f: Freshness): string {
  switch (f) {
    case "refreshing":
      return "animate-pulse";
    case "stale":
      return "opacity-60";
    case "live":
      return "";
  }
}

/// The reason, for the `title`. §7.5.4 wants a stale value to be able to say
/// how old it is on hover rather than merely looking dim.
export function freshnessTitle(f: Freshness, readAt: number | null, now: number): string {
  if (f === "refreshing") return "Refreshing…";
  if (f === "live") return "";
  if (readAt === null) return "Never read";
  const mins = Math.floor((now - readAt) / 60_000);
  if (mins < 1) return "Last read less than a minute ago";
  return `Last read ${mins}m ago`;
}

/// A coarse clock, so a value can go stale on screen without anything
/// happening. 15s granularity: the tooltip reports whole minutes, so anything
/// finer would be a timer that wakes the app up to change nothing.
export function createFreshnessClock(intervalMs = 15_000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}
