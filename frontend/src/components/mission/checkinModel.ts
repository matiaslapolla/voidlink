/// The check-in: what happened in a window of time, across every repository.
///
/// Basecamp's automatic check-in, answered from the event log instead of from
/// people. The question it exists for is "what did the agent do while I was
/// asleep", and the reason it is buildable at all is that Rust records commits
/// it *observed* rather than commits VoidLink performed — so a turn that ran
/// overnight and committed shows up whether or not a window was open.
///
/// Pure, and deliberately in a `.ts` file: grouping and counting are where this
/// can be wrong, and none of it needs a DOM. See `docs/features/testing.md`.

import type { Actor, JournalEvent } from "@/api/journal";

/// How far back a check-in looks.
///
/// `cycle` is six weeks because that is what the log retains — offering a
/// window longer than retention would silently return a partial answer that
/// looks complete, which is the failure mode the retention constant exists to
/// avoid.
export type WindowKind = "today" | "since-yesterday" | "week" | "cycle";

export const WINDOW_LABELS: Record<WindowKind, string> = {
  today: "Today",
  "since-yesterday": "Since yesterday",
  week: "Last 7 days",
  cycle: "This cycle",
};

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/// The lower bound of a window, in local time.
///
/// `today` and `since-yesterday` snap to midnight rather than subtracting 24
/// hours: "today" at 9am must not mean "since 9am yesterday", which would put
/// yesterday evening's work under today's heading.
export function windowStart(kind: WindowKind, now: number): number {
  switch (kind) {
    case "today":
      return startOfDay(now);
    case "since-yesterday":
      return startOfDay(now) - DAY;
    case "week":
      return startOfDay(now) - 6 * DAY;
    case "cycle":
      return now - 42 * DAY;
  }
}

/// One actor's contribution inside one repository.
///
/// Split by *name* as well as by actor, so two agents working the same
/// repository are two lines. Collapsing them would produce "the agent made 9
/// commits" when two different agents made 4 and 5, which is exactly the
/// question a per-agent audit trail is supposed to answer.
export interface ActorLine {
  /// Stable key for `<For>`: `actor:name`.
  key: string;
  actor: Actor;
  /// The agent's roster name, or the actor's generic label.
  name: string;
  /// Turns that completed, however they completed.
  turns: number;
  turnsFailed: number;
  /// Commit subjects, newest last, in the order they were recorded.
  commits: string[];
  /// Commands that finished in a terminal.
  commands: number;
  /// Branch switches, resets, rebases — ref movement that was not a commit.
  refMoves: number;
  /// Everything else, so a total never silently loses events to a kind this
  /// build has not heard of. The open `kind` string demands this bucket exist.
  other: number;
  /// Every event attributed to this actor, so a section can drill in without a
  /// second pass over the log.
  events: JournalEvent[];
}

export interface RepoDigest {
  repo: string;
  /// Basename — the whole path is noise in a heading and available on hover.
  label: string;
  workspace: string | null;
  total: number;
  /// Busiest actor first; ties keep insertion order, which is first-seen.
  lines: ActorLine[];
}

export interface CheckinReport {
  since: number;
  until: number;
  total: number;
  /// Busiest repository first.
  repos: RepoDigest[];
}

/// The generic name for an actor with none of its own.
///
/// Matches `timelineModel.ACTOR_LABELS`, and `system` is "Observed" there for
/// the reason stated there: calling an unattributed change "VoidLink" would be
/// a claim the log refuses to make.
const GENERIC: Record<Actor, string> = {
  user: "You",
  agent: "An agent",
  system: "Observed",
};

export function repoLabel(repo: string): string {
  const parts = repo.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? repo;
}

function emptyLine(actor: Actor, name: string): ActorLine {
  return {
    key: `${actor}:${name}`,
    actor,
    name,
    turns: 0,
    turnsFailed: 0,
    commits: [],
    commands: 0,
    refMoves: 0,
    other: 0,
    events: [],
  };
}

/// Fold one event into its actor's line.
///
/// Matched by **prefix**, never by equality on the full kind, so a future
/// `agent.turn.finished.partial` still counts as a turn instead of falling into
/// `other`. Same reason the timeline never switches on `kind`.
function accumulate(line: ActorLine, event: JournalEvent): void {
  line.events.push(event);
  const kind = event.kind;
  if (kind.startsWith("agent.turn.")) {
    if (kind.startsWith("agent.turn.failed")) line.turnsFailed += 1;
    else line.turns += 1;
    return;
  }
  if (kind.startsWith("git.commit")) {
    line.commits.push(event.subject ?? event.summary);
    return;
  }
  if (kind.startsWith("terminal.command.")) {
    line.commands += 1;
    return;
  }
  if (kind.startsWith("git.branch.") || kind.startsWith("git.head.")) {
    line.refMoves += 1;
    return;
  }
  line.other += 1;
}

/// Digest `events` — already filtered to the window by the query — into a
/// report. `events` is expected ascending, as the log returns it.
///
/// Events with no repository are grouped under a synthetic `""` repo rather
/// than dropped: a total that does not match what the timeline shows for the
/// same window would read as a bug in one of the two surfaces.
export function summarizeCheckin(
  events: readonly JournalEvent[],
  since: number,
  until: number,
): CheckinReport {
  const repos = new Map<string, RepoDigest>();

  for (const event of events) {
    const repo = event.repo ?? "";
    let digest = repos.get(repo);
    if (!digest) {
      digest = {
        repo,
        label: repo ? repoLabel(repo) : "Elsewhere",
        workspace: event.workspace,
        total: 0,
        lines: [],
      };
      repos.set(repo, digest);
    }
    // A repository registered partway through the window has events both with
    // and without a workspace. The first non-null answer is the right one.
    digest.workspace ??= event.workspace;
    digest.total += 1;

    const name = event.actorName?.trim() || GENERIC[event.actor];
    const key = `${event.actor}:${name}`;
    let line = digest.lines.find((l) => l.key === key);
    if (!line) {
      line = emptyLine(event.actor, name);
      digest.lines.push(line);
    }
    accumulate(line, event);
  }

  const ordered = [...repos.values()].sort((a, b) => b.total - a.total);
  for (const digest of ordered) {
    digest.lines.sort((a, b) => b.events.length - a.events.length);
  }

  return {
    since,
    until,
    total: events.length,
    repos: ordered,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/// One sentence describing what an actor did. `null` when they did nothing
/// countable — which happens when every event they produced fell into `other`
/// and there is nothing honest to say beyond the raw count.
export function describeLine(line: ActorLine): string {
  const parts: string[] = [];
  if (line.commits.length) parts.push(plural(line.commits.length, "commit"));
  if (line.turns) parts.push(plural(line.turns, "turn"));
  if (line.turnsFailed) parts.push(`${plural(line.turnsFailed, "turn")} that failed`);
  if (line.commands) parts.push(plural(line.commands, "command"));
  if (line.refMoves) parts.push(plural(line.refMoves, "ref move"));
  if (line.other) parts.push(plural(line.other, "other event"));
  if (parts.length === 0) return "nothing recorded";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/// The report as prose, for the clipboard and for handing to an agent.
///
/// Markdown rather than plain text because both consumers want the structure,
/// and because a standup pasted into an issue tracker should already be
/// formatted. Commit subjects are quoted verbatim — a check-in that paraphrased
/// what was committed would be inventing history.
export function checkinProse(report: CheckinReport, windowLabel: string): string {
  if (report.total === 0) {
    return `**${windowLabel}** — nothing recorded.`;
  }
  const lines: string[] = [`**${windowLabel}** — ${plural(report.total, "event")}.`, ""];
  for (const digest of report.repos) {
    lines.push(`### ${digest.label}${digest.workspace ? ` · ${digest.workspace}` : ""}`);
    for (const line of digest.lines) {
      lines.push(`- **${line.name}** — ${describeLine(line)}`);
      for (const commit of line.commits) lines.push(`  - “${commit}”`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
