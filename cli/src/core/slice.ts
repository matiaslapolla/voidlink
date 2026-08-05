/**
 * The brain slice — what a session needs to know about a project before it
 * starts.
 *
 * This is the half the old system never had. Capture was solved; recall was a
 * dashboard behind an OAuth login, which is a destination competing with the
 * terminal rather than something that meets you in it. A slice is injected by
 * the SessionStart hook, so recall costs nothing and happens whether or not
 * anyone remembers to go looking.
 *
 * PURE — no IO, no clock. `now` is injected.
 */

import { review } from "./review.js";
import type { ParsedEntry } from "./parse.js";

export interface Slice {
  project: string;
  /** Tickets referenced in this project with no shipped entry against them. */
  openTickets: { ref: string; ageDays: number }[];
  /** Most recent decisions, newest first. */
  recentDecisions: ParsedEntry[];
  /** Decisions old enough to have produced something, that didn't. */
  unfinishedDecisions: { ref: string; title: string; ageDays: number }[];
  /** Most recent notes and discoveries, newest first. */
  recentNotes: ParsedEntry[];
  /** Total entries recorded against this project. */
  total: number;
}

export interface SliceOptions {
  decisions?: number;
  notes?: number;
}

const DEFAULTS: Required<SliceOptions> = { decisions: 3, notes: 3 };

function newestFirst(a: ParsedEntry, b: ParsedEntry): number {
  if (a.created !== b.created) return a.created < b.created ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * An entry belongs to a project if its `project` field says so, or if it
 * carries the project name as a label — label-typed entries (note, discovery)
 * have no `project` field to set, so labelling is the only way they attach.
 */
function inProject(entry: ParsedEntry, project: string): boolean {
  const p = project.toLowerCase();
  return entry.project?.toLowerCase() === p || entry.labels.some((l) => l.toLowerCase() === p);
}

export function buildSlice(
  entries: readonly ParsedEntry[],
  project: string,
  now: Date,
  options: SliceOptions = {},
): Slice {
  const { decisions: nDecisions, notes: nNotes } = { ...DEFAULTS, ...options };
  const mine = entries.filter((e) => inProject(e, project)).sort(newestFirst);

  // Staleness is computed over the WHOLE vault, then filtered — a decision's
  // follow-up may be a shipped entry that carries the project field while the
  // decision only carries the label, and vice versa.
  const findings = review({ entries, now });
  const mineIds = new Set(mine.map((e) => e.id));
  const myTickets = new Set(mine.map((e) => e.ticket).filter((t): t is string => !!t));

  return {
    project,
    openTickets: findings
      .filter((f) => f.kind === "open-ticket" && myTickets.has(f.ref))
      .map((f) => ({ ref: f.ref, ageDays: f.ageDays })),
    recentDecisions: mine.filter((e) => e.type === "decision").slice(0, nDecisions),
    unfinishedDecisions: findings
      .filter((f) => f.kind === "unfinished-decision" && mineIds.has(f.ref))
      .map((f) => ({ ref: f.ref, title: f.title, ageDays: f.ageDays })),
    recentNotes: mine
      .filter((e) => e.type === "note" || e.type === "discovery")
      .slice(0, nNotes),
    total: mine.length,
  };
}

/**
 * Render a slice as terse markdown for injection into a session.
 *
 * Deliberately short. This is prepended to every session in the project, so
 * it competes for the same attention the actual task needs — a slice nobody
 * reads is worse than no slice, because it costs tokens to ignore. Returns
 * an empty string when there is nothing worth saying.
 */
export function renderSlice(slice: Slice): string {
  if (slice.total === 0) return "";

  const lines = [`## Brain — ${slice.project} (${slice.total} entries)`, ""];

  if (slice.openTickets.length > 0) {
    lines.push(
      `**Open tickets:** ${slice.openTickets.map((t) => `${t.ref} (${t.ageDays}d)`).join(", ")}`,
      "",
    );
  }

  if (slice.recentDecisions.length > 0) {
    lines.push("**Recent decisions**");
    for (const d of slice.recentDecisions) {
      lines.push(`- ${d.created.slice(0, 10)} — ${d.title}`);
    }
    lines.push("");
  }

  if (slice.unfinishedDecisions.length > 0) {
    lines.push("**Decided but nothing shipped since**");
    for (const d of slice.unfinishedDecisions) {
      lines.push(`- ${d.title} (${d.ageDays}d)`);
    }
    lines.push("");
  }

  if (slice.recentNotes.length > 0) {
    lines.push("**Recent notes**");
    for (const n of slice.recentNotes) {
      lines.push(`- ${n.created.slice(0, 10)} — ${n.title}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
