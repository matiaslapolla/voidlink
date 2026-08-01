/// Everything the timeline decides that is not rendering.
///
/// Split out so it runs in the fast `unit` vitest project: grouping, labelling
/// and the filter predicate are where this surface can actually be *wrong*, and
/// none of them need a DOM to prove. The component is then thin enough that its
/// own render tests are about mounting and live updates rather than logic.

import type { Actor, JournalEvent } from "@/api/journal";

/// The actor filter, as the segmented control offers it.
export type ActorFilter = "all" | Actor;

export interface TimelineFilters {
  actor: ActorFilter;
  /// Free text, matched against the summary and the subject.
  query: string;
}

export const EMPTY_FILTERS: TimelineFilters = { actor: "all", query: "" };

/// How the log describes each actor in the UI. `system` is deliberately not
/// "VoidLink": these are things that were *observed*, most often work done
/// outside the app, and calling that "VoidLink" would be the same false
/// attribution the Rust side refuses to make.
export const ACTOR_LABELS: Record<Actor, string> = {
  user: "You",
  agent: "Agent",
  system: "Observed",
};

/// Whether an event's attribution is a heuristic rather than an observation.
///
/// Rust marks agent-credited git events `inferred` because they are guessed
/// from an overlapping turn. The UI has to show that difference — a reader who
/// cannot tell a guess from a fact will eventually act on one as the other.
export function isInferred(event: JournalEvent): boolean {
  return (
    !!event.data &&
    typeof event.data === "object" &&
    (event.data as Record<string, unknown>).attribution === "inferred"
  );
}

export function matchesFilters(event: JournalEvent, filters: TimelineFilters): boolean {
  if (filters.actor !== "all" && event.actor !== filters.actor) return false;
  const q = filters.query.trim().toLowerCase();
  if (!q) return true;
  return (
    event.summary.toLowerCase().includes(q) ||
    (event.subject?.toLowerCase().includes(q) ?? false)
  );
}

export interface DaySection {
  /// Stable across re-renders for the same calendar day, so `<For>` does not
  /// rebuild every section when one event arrives.
  key: string;
  label: string;
  /// Newest first within the day — see `groupByDay`.
  events: JournalEvent[];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/// `YYYY-MM-DD` in **local** time.
///
/// Local rather than UTC because a day boundary the user does not recognise is
/// worse than any timezone impurity: a commit at 9pm must appear under today,
/// not tomorrow. `toISOString` would do exactly the wrong thing here.
function dayKey(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function dayLabel(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  }
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: startOfDay(now) - startOfDay(ms) > 300 * 86_400_000 ? "numeric" : undefined,
  });
}

/// `HH:MM`, the only precision a timeline needs.
export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/// Group into day sections, newest day first and newest event first inside it.
///
/// Rust returns events oldest-first because that is the natural order of an
/// append-only file; a timeline reads the other way. Reversing here rather than
/// asking Rust for descending order keeps the log's own ordering unambiguous —
/// there is exactly one on-disk order, and presentation is presentation.
export function groupByDay(
  events: readonly JournalEvent[],
  now: number,
  filters: TimelineFilters = EMPTY_FILTERS,
): DaySection[] {
  const sections = new Map<string, DaySection>();
  // Walk backwards so each section's events come out newest-first without a
  // second sort per section.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!matchesFilters(event, filters)) continue;
    const key = dayKey(event.at);
    let section = sections.get(key);
    if (!section) {
      section = { key, label: dayLabel(event.at, now), events: [] };
      sections.set(key, section);
    }
    section.events.push(event);
  }
  // Insertion order is already newest-day-first, because the input was
  // ascending and we walked it in reverse.
  return [...sections.values()];
}

/// Merge freshly-appended events into a list, keeping it ascending and free of
/// duplicates.
///
/// Both guards earn their place. Ascending, because the live `journal-appended`
/// broadcast can arrive out of order relative to an in-flight initial query.
/// De-duplicated, because that same race delivers the *same* event twice — once
/// in the query result and once on the channel — and a timeline that shows a
/// commit twice reads as two commits.
export function mergeEvents(
  existing: readonly JournalEvent[],
  incoming: readonly JournalEvent[],
): JournalEvent[] {
  if (incoming.length === 0) return existing as JournalEvent[];
  const seen = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return existing as JournalEvent[];
  return [...existing, ...fresh].sort((a, b) => a.at - b.at);
}
