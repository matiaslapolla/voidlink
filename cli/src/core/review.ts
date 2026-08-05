/**
 * Staleness review — the read-side counterpart to capture.
 *
 * The old system was write-only: entries went in and nothing ever read back.
 * This is the cheapest possible reader — it answers "what did I start and not
 * finish?" from frontmatter alone, with no index and no database.
 *
 * PURE — no IO, and no clock. `now` is injected so a review is a function of
 * its inputs and the tests don't drift into failing next quarter.
 */

import type { ParsedEntry } from "./parse.js";

export type FindingKind = "stale-entry" | "open-ticket" | "unfinished-decision";
export type Severity = "high" | "medium" | "low";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** Entry id, or ticket id for `open-ticket`. */
  ref: string;
  title: string;
  /** One line explaining why this surfaced. */
  detail: string;
  ageDays: number;
}

export interface ReviewThresholds {
  /** Days after which an untouched entry is stale. */
  staleEntryDays: number;
  /** Days after which a ticket with no `shipped` entry is overdue. */
  openTicketDays: number;
  /** Days a decision may sit without a follow-up `shipped` in the same project. */
  decisionFollowUpDays: number;
}

export const DEFAULT_THRESHOLDS: ReviewThresholds = {
  staleEntryDays: 90,
  openTicketDays: 30,
  decisionFollowUpDays: 30,
};

export interface ReviewInput {
  entries: readonly ParsedEntry[];
  /** The moment the review is taken against. Injected, never read from a clock. */
  now: Date;
  /**
   * Entry id -> ISO date of its last real modification, normally from
   * `git log -1 --format=%aI -- <path>`. Falling back to `created` would call a
   * revised entry stale on its original date, so a caller that can supply real
   * mtimes should.
   */
  lastTouched?: ReadonlyMap<string, string>;
  /**
   * Ticket id -> status string. A ticket whose status is in `CLOSED_STATUSES`
   * is finished and never reported. Absent means unknown, which is treated as
   * open — a missing status should nag, not hide.
   */
  ticketStatus?: ReadonlyMap<string, string>;
  thresholds?: Partial<ReviewThresholds>;
}

const CLOSED_STATUSES = new Set(["done", "shipped", "closed", "cancelled", "canceled"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between an ISO stamp and `now`. Unparseable dates yield 0. */
function ageInDays(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.floor((now.getTime() - then) / DAY_MS);
}

/** Escalate by how far past the threshold something is — 3x over is not the same as 1 day over. */
function severityFor(ageDays: number, threshold: number): Severity {
  if (ageDays >= threshold * 3) return "high";
  if (ageDays >= threshold * 2) return "medium";
  return "low";
}

/**
 * Run every staleness check. Findings come back sorted by severity, then by age
 * descending, so the top of the list is always the thing that has been ignored
 * longest and hardest.
 */
export function review(input: ReviewInput): Finding[] {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const { entries, now } = input;
  const lastTouched = input.lastTouched ?? new Map<string, string>();
  const ticketStatus = input.ticketStatus ?? new Map<string, string>();

  const findings: Finding[] = [];
  const shipped = entries.filter((e) => e.type === "shipped");

  // ── Entries nobody has touched in a long time ────────────────────────────
  for (const entry of entries) {
    const touched = lastTouched.get(entry.id) ?? entry.created;
    const age = ageInDays(touched, now);
    if (age < t.staleEntryDays) continue;
    findings.push({
      kind: "stale-entry",
      severity: severityFor(age, t.staleEntryDays),
      ref: entry.id,
      title: entry.title,
      detail: `${entry.type} untouched for ${age}d`,
      ageDays: age,
    });
  }

  // ── Tickets with no shipped entry against them ───────────────────────────
  const shippedTickets = new Set(shipped.map((e) => e.ticket).filter((x): x is string => !!x));
  const ticketFirstSeen = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.ticket) continue;
    const seen = ticketFirstSeen.get(entry.ticket);
    if (seen === undefined || entry.created < seen) ticketFirstSeen.set(entry.ticket, entry.created);
  }

  for (const [ticket, firstSeen] of ticketFirstSeen) {
    if (shippedTickets.has(ticket)) continue;
    const status = ticketStatus.get(ticket)?.toLowerCase();
    if (status !== undefined && CLOSED_STATUSES.has(status)) continue;

    const age = ageInDays(firstSeen, now);
    if (age < t.openTicketDays) continue;
    findings.push({
      kind: "open-ticket",
      severity: severityFor(age, t.openTicketDays),
      ref: ticket,
      title: ticket,
      detail:
        status === undefined
          ? `open ${age}d, no shipped entry and no status`
          : `open ${age}d with status "${status}", no shipped entry`,
      ageDays: age,
    });
  }

  // ── Decisions that never turned into anything ────────────────────────────
  for (const entry of entries) {
    if (entry.type !== "decision" || !entry.project) continue;
    const age = ageInDays(entry.created, now);
    if (age < t.decisionFollowUpDays) continue;

    // A follow-up is a shipped entry in the same project dated after the
    // decision. Same-project-but-earlier work didn't follow from it.
    const followed = shipped.some(
      (s) => s.project === entry.project && s.created > entry.created,
    );
    if (followed) continue;

    findings.push({
      kind: "unfinished-decision",
      severity: severityFor(age, t.decisionFollowUpDays),
      ref: entry.id,
      title: entry.title,
      detail: `decided ${age}d ago, nothing shipped in ${entry.project} since`,
      ageDays: age,
    });
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || b.ageDays - a.ageDays || (a.ref < b.ref ? -1 : 1),
  );
}
