/// Who probably wrote this — where "probably" is the whole of the feature.
///
/// ## The claim this module is allowed to make
///
/// The journal never records authorship. It records *time*: Rust registers an
/// agent-active window for the life of a turn's child process
/// (`journal::agent_working`), and anything observed inside that window is
/// credited to the agent and stamped `attribution: "inferred"` in the record
/// itself. A person who edits a file while an agent turn is running produces
/// evidence indistinguishable from the agent having edited it.
///
/// So there is no honest hunk-level answer available here, and this module
/// deliberately has no way to express one. Two claims exist and both name their
/// evidence:
///
///   * **`worktree-mtime`** — file-level. The file's last-write time falls
///     inside an agent's turn window in this checkout. It says nothing about
///     *which lines*, and nothing about whether the agent or the user typed
///     them.
///   * **`commit`** — commit-level. The journal already holds a `git.commit`
///     event for this oid that Rust credited to an agent, already marked
///     inferred. This module only reads that credit across; it does not
///     manufacture a second, weaker one.
///
/// A hunk-level claim would need per-line evidence nothing in the system
/// collects. Rendering a guess at that resolution is worse than rendering
/// nothing, because precision reads as confidence — which is why
/// `Provenance["scope"]` has no `"hunk"` member rather than a comment asking
/// callers not to use it.
///
/// ## What is durably attributable, and what is not
///
/// Turn windows are only persisted for **fan-out legs** (`run.started` pairs
/// with a `run.leg.*` terminal event to bound an interval) and are readable
/// **live** from `journal_active_agents`. An ordinary agent-panel turn that has
/// already finished leaves no window in the log — turns are recorded on their
/// end, and in this build no `agent.turn.*` record is written at all. A file it
/// wrote is therefore un-attributable once the turn is over, and this module
/// answers `null` rather than reaching for the nearest agent it can find. The
/// commit path still covers it whenever the agent's work was committed.

import { fsApi } from "@/api/fs";
import { journalApi, type ActiveAgent, type JournalEvent } from "@/api/journal";
import { isInferred } from "@/components/timeline/timelineModel";

/// How long after a turn ends its checkout stays attributable to it.
///
/// The same five seconds Rust holds open in `journal::GRACE_MS`, and for the
/// same reason: a turn whose last act is a write exits before the write is
/// visible to anything polling. Diverging from Rust's number would make the
/// timeline and this surface disagree about one commit, which is exactly the
/// class of contradiction that makes a reader stop believing either.
export const PROVENANCE_GRACE_MS = 5_000;

/// How far back the journal is asked for run history.
///
/// A week rather than the log's full six-week retention: the question this
/// answers is "who touched what I am looking at now", and a working tree whose
/// changes are a month old is not a question about provenance. Bounding the
/// query is also what keeps it served from Rust's in-memory ring.
export const PROVENANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/// An interval during which an agent had a turn running in one checkout.
///
/// `to` is `null` while the turn is still running — an open interval, not an
/// unknown one. The distinction matters: a `null` end means "and still now",
/// and collapsing it to `Date.now()` at construction time would silently close
/// a window that is still open a second later.
export interface AgentWindow {
  agent: string;
  /// The checkout the turn ran in. For a fan-out leg this is the leg's own
  /// worktree, not the repository the run was started from.
  repo: string;
  from: number;
  to: number | null;
  runId?: string;
  source: "run-leg" | "live";
}

/// One inferred attribution, with the evidence it rests on.
///
/// Every field a surface needs to state the uncertainty is here, so no caller
/// has to reconstruct it — and `explainProvenance` below is the sentence, so no
/// caller has to invent one that overclaims.
export interface Provenance {
  agent: string;
  /// The resolution of the claim. There is no `"hunk"` — see the header.
  scope: "file" | "commit";
  basis: "worktree-mtime" | "commit";
  /// The moment the claim hangs on: the file's mtime, or the commit's.
  at: number;
  /// The interval the file's mtime was matched against. Absent for `commit`.
  window?: { from: number; to: number | null };
  /// The commit the credit was read from. Absent for `worktree-mtime`.
  commitOid?: string;
  runId?: string;
}

// ── Reading the log ──────────────────────────────────────────────────────────

/// `data` is `unknown` by contract (see `api/journal.ts`) and nothing may
/// depend on it being well-formed, so every read of it goes through here and a
/// malformed payload costs one dropped window rather than a thrown render.
function field(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/// Every turn interval the log and the live registry can prove, in no
/// particular order. Pure.
///
/// A leg's window opens at its **run's** start rather than the leg's own,
/// because a leg emits nothing until it reaches a terminal status — there is no
/// per-leg start event to read. That over-covers by the worktree-creation time
/// at the front, which is safe in the only direction that matters: the leg's
/// worktree did not exist before its run started, so nothing can fall into the
/// over-covered part.
///
/// A leg whose `run.started` has aged out of the queried window is dropped
/// entirely. An interval with an unknown start is not an interval, and
/// substituting one (the leg's end minus a guess, say) would invent evidence.
export function agentWindows(
  events: readonly JournalEvent[],
  active: readonly ActiveAgent[],
): AgentWindow[] {
  const runStartedAt = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "run.started") continue;
    const runId = field(event.data, "runId");
    if (runId !== null) runStartedAt.set(runId, event.at);
  }

  const windows: AgentWindow[] = [];
  for (const event of events) {
    // `startsWith` rather than a list of the four terminal kinds: the log's
    // kinds are an open hierarchy, and a `run.leg.*` invented next month is
    // still a leg ending.
    if (!event.kind.startsWith("run.leg.")) continue;
    const worktree = field(event.data, "worktree");
    const runId = field(event.data, "runId");
    if (worktree === null || runId === null) continue;
    const from = runStartedAt.get(runId);
    if (from === undefined) continue;
    windows.push({
      agent: event.actorName ?? "an agent",
      repo: worktree,
      from,
      to: event.at + PROVENANCE_GRACE_MS,
      runId,
      source: "run-leg",
    });
  }

  for (const agent of active) {
    windows.push({
      agent: agent.name,
      repo: agent.repo,
      from: agent.since,
      to: null,
      source: "live",
    });
  }

  return windows;
}

/// The window covering `at` in `repo`, if one does. Pure.
///
/// When several overlap, the **most recently started** one wins — the same
/// tie-break `journal::Inner::agent_in` applies in Rust, and for the same
/// reason: neither answer is knowable and the newer one is the better guess.
/// Two surfaces guessing differently about one file would be worse than either
/// guess.
export function windowCovering(
  windows: readonly AgentWindow[],
  repo: string,
  at: number,
): AgentWindow | null {
  let best: AgentWindow | null = null;
  for (const window of windows) {
    if (window.repo !== repo) continue;
    if (at < window.from) continue;
    if (window.to !== null && at > window.to) continue;
    if (best === null || window.from >= best.from) best = window;
  }
  return best;
}

/// The file-level claim, from a last-write time. Pure.
///
/// `modifiedMs` is unix **milliseconds**; `fs_stat_files` reports seconds and
/// the loader below converts. Passing seconds here lands every file in 1970 and
/// therefore in no window at all — a silent "nothing to say", which is why the
/// unit is in the parameter name.
export function fileProvenance(
  windows: readonly AgentWindow[],
  repo: string,
  modifiedMs: number,
): Provenance | null {
  const window = windowCovering(windows, repo, modifiedMs);
  if (!window) return null;
  return {
    agent: window.agent,
    scope: "file",
    basis: "worktree-mtime",
    at: modifiedMs,
    window: { from: window.from, to: window.to },
    runId: window.runId,
  };
}

/// The commit-level claim, read across from the log's own credit. Pure.
///
/// Only events Rust already marked inferred qualify. A `git.commit` with no
/// agent is a commit whose author the watcher genuinely did not know — see the
/// `Actor::System` comment in Rust — and promoting one here would manufacture
/// an attribution the log deliberately refused to make.
export function commitProvenance(
  events: readonly JournalEvent[],
  oid: string,
): Provenance | null {
  let latest: JournalEvent | null = null;
  for (const event of events) {
    if (event.kind !== "git.commit") continue;
    if (field(event.data, "oid") !== oid) continue;
    if (!event.actorName || !isInferred(event)) continue;
    if (latest === null || event.at >= latest.at) latest = event;
  }
  if (!latest) return null;
  return {
    agent: latest.actorName as string,
    scope: "commit",
    basis: "commit",
    at: latest.at,
    commitOid: oid,
  };
}

/// The sentence the surface shows on hover. Pure, and the reason it lives here
/// rather than in the component: the disclaimer is part of the claim, and a
/// component free to word it is a component free to drop it.
export function explainProvenance(provenance: Provenance): string {
  const named = `${provenance.agent} had a turn running`;
  if (provenance.basis === "commit") {
    return (
      `Credited to ${provenance.agent} because ${named} in this checkout when the ` +
      `commit appeared. Inferred from overlapping time, not from authorship — the ` +
      `claim covers the whole commit, not any particular line.`
    );
  }
  return (
    `This file was last written while ${named} in this checkout. Inferred from ` +
    `overlapping time, not from authorship: an edit you made yourself inside that ` +
    `window looks exactly the same. It says nothing about which lines changed.`
  );
}

// ── Loading ──────────────────────────────────────────────────────────────────

/// One journal read, shaped for both claims.
///
/// Deliberately **not** scoped by `repo`. Leg events carry no repository —
/// `fanout::leg_event` leaves it `None` and puts the leg's worktree in
/// `data.worktree` — so a repo-filtered query would return every git event and
/// no leg at all, which is precisely backwards. The filtering that matters
/// happens in `agentWindows`, on the field that actually names the checkout.
async function readJournal(now: number): Promise<JournalEvent[]> {
  return journalApi.query({
    kinds: ["run.", "git.commit"],
    since: now - PROVENANCE_WINDOW_MS,
  });
}

/// What the journal can say about a file in the working tree, or `null`.
///
/// `null` is the common and correct answer: most files were written by the
/// person reading the diff, and there is no evidence to the contrary. Callers
/// render nothing for it rather than an "unknown" chip — an absence of evidence
/// is not a fact worth a row.
export async function loadFileProvenance(
  repo: string,
  absPath: string,
  now: number = Date.now(),
): Promise<Provenance | null> {
  const [events, active, stamps] = await Promise.all([
    readJournal(now),
    journalApi.activeAgents(),
    fsApi.statFiles([absPath]),
  ]);
  const stamp = stamps[0];
  // A file with no mtime — deleted in the working tree, or a filesystem that
  // does not report one — has nothing to match against. Saying nothing is the
  // answer; falling back to "now" would attribute it to whoever happens to be
  // running at the moment the diff was opened.
  if (!stamp?.exists || stamp.modified === null) return null;
  return fileProvenance(agentWindows(events, active), repo, stamp.modified * 1000);
}

/// What the journal can say about one commit, or `null`.
export async function loadCommitProvenance(
  oid: string,
  now: number = Date.now(),
): Promise<Provenance | null> {
  return commitProvenance(await readJournal(now), oid);
}

/// Whether a ref is a full commit id, and therefore something the log could
/// hold a credit for.
///
/// The compare tab's head is a branch name most of the time and an oid when a
/// commit's own diff was opened (`commands/commitDiff.ts`). Only the second
/// case is answerable, and asking the log about `main` would silently answer
/// about nothing.
export function isCommitOid(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}
