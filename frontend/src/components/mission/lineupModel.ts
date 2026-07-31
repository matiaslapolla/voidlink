/// The Lineup: one row per checkout, across every workspace.
///
/// Basecamp's Lineup, and the answer to the question nothing in this app could
/// answer before — *what is happening across all my work*. The rail shows
/// badges for the worktrees of the workspace you are looking at; this shows
/// every workspace at once, whether or not it is open.
///
/// Three sources feed one row and they are deliberately different in kind:
///
///   - **The registry** (`RepoIdentity[]`) says which checkouts exist. It comes
///     from the frontend's own workspace model, so a repository with no history
///     at all still gets a row — "nothing has happened here" is an answer.
///   - **The log** says what last happened. Historic, durable, possibly weeks
///     old.
///   - **`journal_active_agents`** says what is happening *right now*. Live
///     state, not derived from the log, because turns are recorded on their end
///     and a log of closed intervals cannot tell you about an open one.
///
/// Pure. See `docs/features/testing.md` for why this is a `.ts` file.

import type { ActiveAgent, JournalEvent, RepoIdentity } from "@/api/journal";
import { repoLabel } from "./checkinModel";

export interface LineupRow {
  /// The worktree path, and the row's key.
  repo: string;
  label: string;
  worktreeId: string | null;
  isMain: boolean;
  /// The agents currently working here, longest-running first.
  active: ActiveAgent[];
  /// The most recent event in this checkout, or `null` if the log has none.
  last: JournalEvent | null;
  /// Events in the window the caller queried, for the row's "3 commits today".
  commits: number;
  turns: number;
  events: number;
}

export interface LineupGroup {
  workspaceId: string;
  workspaceName: string;
  rows: LineupRow[];
  /// Whether any row in the group has an agent running. Drives the group's own
  /// liveness mark, so a collapsed workspace still says something is happening
  /// inside it.
  busy: boolean;
}

/// Build the grouped rows.
///
/// `events` is expected ascending, as the log returns it, and is expected to
/// already be windowed by the caller's query — this function counts what it is
/// given and does not filter by time. Keeping the window in the query rather
/// than here means the count and the rows can never disagree about which window
/// they describe.
export function buildLineup(
  repos: readonly RepoIdentity[],
  events: readonly JournalEvent[],
  active: readonly ActiveAgent[],
): LineupGroup[] {
  const rows = new Map<string, LineupRow>();
  for (const identity of repos) {
    rows.set(identity.path, {
      repo: identity.path,
      label: repoLabel(identity.path),
      worktreeId: identity.worktreeId ?? null,
      isMain: !!identity.isMain,
      active: [],
      last: null,
      commits: 0,
      turns: 0,
      events: 0,
    });
  }

  for (const event of events) {
    const row = event.repo ? rows.get(event.repo) : undefined;
    // An event whose repository is not in the registry is genuinely orphaned —
    // a workspace the user removed, most often. It belongs in the timeline, not
    // in a lineup of checkouts that exist, so it is dropped here rather than
    // synthesising a row for a directory nobody has open.
    if (!row) continue;
    row.events += 1;
    if (event.kind.startsWith("git.commit")) row.commits += 1;
    if (event.kind.startsWith("agent.turn.")) row.turns += 1;
    // Ascending input, so the last write wins and is the newest.
    row.last = event;
  }

  for (const agent of active) {
    rows.get(agent.repo)?.active.push(agent);
  }
  for (const row of rows.values()) {
    row.active.sort((a, b) => a.since - b.since);
  }

  const groups = new Map<string, LineupGroup>();
  for (const identity of repos) {
    let group = groups.get(identity.workspaceId);
    if (!group) {
      group = {
        workspaceId: identity.workspaceId,
        workspaceName: identity.workspaceName,
        rows: [],
        busy: false,
      };
      groups.set(identity.workspaceId, group);
    }
    const row = rows.get(identity.path);
    if (!row) continue;
    group.rows.push(row);
    if (row.active.length) group.busy = true;
  }

  for (const group of groups.values()) {
    group.rows.sort(compareRows);
  }
  // Workspaces with something running first, then by name. A busy workspace
  // scrolled below the fold is the one failure this surface exists to prevent.
  return [...groups.values()].sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? -1 : 1;
    return a.workspaceName.localeCompare(b.workspaceName);
  });
}

/// Busy first, then main checkout, then most recently active, then by name.
///
/// Exported for its own test because this ordering *is* the surface: a lineup
/// sorted by anything else is a list you have to read all of.
export function compareRows(a: LineupRow, b: LineupRow): number {
  const aBusy = a.active.length > 0;
  const bBusy = b.active.length > 0;
  if (aBusy !== bBusy) return aBusy ? -1 : 1;
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
  const aAt = a.last?.at ?? 0;
  const bAt = b.last?.at ?? 0;
  if (aAt !== bAt) return bAt - aAt;
  return a.label.localeCompare(b.label);
}

/// "4m", "3h", "2d" — how long ago, at the coarsest useful precision.
///
/// Coarse on purpose. A lineup is read at a glance, and "1h" carries every bit
/// of the decision "2 minutes vs an hour ago" that "1h 3m 12s" does.
export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/// The row's one-line status, in the order a reader cares about it.
///
/// Live work outranks history: a checkout with an agent in it says so even if
/// the log's last entry is a commit from ten seconds ago.
export function rowStatus(row: LineupRow, now: number): string {
  if (row.active.length === 1) {
    return `${row.active[0].name} working — ${ago(row.active[0].since, now)}`;
  }
  if (row.active.length > 1) {
    return `${row.active.length} agents working`;
  }
  if (!row.last) return "Nothing recorded";
  return `${row.last.summary} — ${ago(row.last.at, now)} ago`;
}
