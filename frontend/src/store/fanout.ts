/// Fan-out: one prompt, N worktrees, N agents, N diffs to compare.
///
/// Orca's central mechanism. The premise is that for a genuinely uncertain
/// change the cheapest way to find the right approach is to try several at
/// once, in isolation, and then read the diffs — and that the isolation is free
/// because git worktrees already exist.
///
/// ## What is here and what is deliberately not
///
/// **Here.** The run entity, leg lifecycle, concurrent execution, per-leg
/// cancel, the diff stat each leg produced, and every state change recorded to
/// the event log so a run is legible in the timeline and in a check-in.
///
/// **Not here: durability across a window close.** A leg is a child process
/// spawned by `agentApi.streamQuery`, whose output streams over a
/// `tauri::ipc::Channel` owned by *this webview*. Close the window and the
/// channel dies with it. A run therefore survives a reload as a **record** —
/// its legs marked `interrupted` — and not as work that carries on. Making
/// fan-out outlive its window means moving the orchestration into Rust, which
/// is a real piece of work and not a flag; pretending otherwise would produce
/// the worst outcome, which is a user who believes an overnight run is
/// progressing when nothing is running at all.
///
/// **Not here: automatic cleanup.** Adopting one leg does not delete the other
/// worktrees. Deleting a branch that took an agent four minutes to write,
/// because the user clicked "adopt" on a different one, is not a decision this
/// module gets to make silently. Removal is offered, per leg, explicitly.

import { createStore, produce } from "solid-js/store";
import { agentApi } from "@/api/agent";
import { gitApi } from "@/api/git";
import { STORAGE_KEYS, readJson, writeJson } from "@/store/layout/persistence";
import { record } from "@/store/journal";
import { aiSecretBindings } from "@/store/settings";
import { dismissToastSource, pushToast } from "@/commands/toast";

export type LegStatus =
  | "pending"
  | "preparing"
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  /// The window that was running this leg went away. Distinct from `cancelled`
  /// because nobody chose it, and distinct from `failed` because nothing went
  /// wrong — the work simply stopped existing. See the module comment.
  | "interrupted";

/// A leg is terminal when nothing further will happen to it on its own.
export function isLegDone(status: LegStatus): boolean {
  return status !== "pending" && status !== "preparing" && status !== "running";
}

export interface RunLeg {
  id: string;
  /// The agent roster entry driving this leg.
  agentId: string;
  agentName: string;
  commandTemplate: string;
  /// The worktree this leg works in, and the branch it works on.
  worktreePath: string;
  branch: string;
  status: LegStatus;
  startedAt: number | null;
  endedAt: number | null;
  /// The agent's answer, as far as it got.
  answer: string;
  /// Why it failed, when it did.
  error: string | null;
  /// What the leg produced, measured once it finished. `null` until then, and
  /// `null` for a leg that never got to run.
  ///
  /// `paths` is what makes the comparison matrix possible: counts alone say how
  /// *much* each leg did, and the question a fan-out actually poses is whether
  /// they did the same thing. Two legs both reporting "3 files" is a different
  /// situation depending on whether it is the same three.
  stat: LegStat | null;
}

/// What one leg changed.
export interface LegStat {
  files: number;
  additions: number;
  deletions: number;
  /// Repo-relative paths, sorted. Absent on runs persisted before the matrix
  /// existed — `reviveLeg` fills an empty array rather than dropping the stat,
  /// so an old run still shows its counts and simply has nothing to compare.
  paths: string[];
}

export interface FanoutRun {
  id: string;
  /// The repository the run was launched from — its main checkout.
  repo: string;
  prompt: string;
  createdAt: number;
  legs: RunLeg[];
  /// The leg whose work was merged, if any. A run can only be adopted once;
  /// adopting a second would merge two competing answers to one question.
  adoptedLegId: string | null;
}

type RunsByRepo = Record<string, FanoutRun[]>;

/// How many runs are kept per repository.
///
/// A run holds N answers and N diff stats, which is not large, but it is also
/// not interesting a month later — the *events* are the durable record, and
/// they are in the log. This is a working set.
const KEEP_RUNS = 20;

function reviveLeg(raw: unknown): RunLeg | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.worktreePath !== "string" || !r.worktreePath) return null;
  const status = typeof r.status === "string" ? (r.status as LegStatus) : "interrupted";
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
    agentId: typeof r.agentId === "string" ? r.agentId : "",
    agentName: typeof r.agentName === "string" ? r.agentName : "agent",
    commandTemplate: typeof r.commandTemplate === "string" ? r.commandTemplate : "",
    worktreePath: r.worktreePath,
    branch: typeof r.branch === "string" ? r.branch : "",
    // A leg persisted mid-flight comes back as one whose window is gone. Same
    // repair `parseMessage` makes for a streaming agent message, and for the
    // same reason: a pending state for a process that died with the app is a
    // spinner nothing will ever stop.
    status: isLegDone(status) ? status : "interrupted",
    startedAt: typeof r.startedAt === "number" ? r.startedAt : null,
    endedAt: typeof r.endedAt === "number" ? r.endedAt : null,
    answer: typeof r.answer === "string" ? r.answer : "",
    error: typeof r.error === "string" ? r.error : null,
    stat: reviveStat(r.stat),
  };
}

/// A stat, defensively. An old run has counts but no `paths`; keeping the
/// counts and defaulting the paths is strictly better than dropping the whole
/// stat, which would make a finished leg read as "not measured".
function reviveStat(raw: unknown): LegStat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    files: num(r.files),
    additions: num(r.additions),
    deletions: num(r.deletions),
    paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : [],
  };
}

export function reviveRuns(raw: unknown): RunsByRepo {
  if (!raw || typeof raw !== "object") return {};
  const out: RunsByRepo = {};
  for (const [repo, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const runs: FanoutRun[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      const legs = (Array.isArray(r.legs) ? r.legs : [])
        .map(reviveLeg)
        .filter((l): l is RunLeg => l !== null);
      // A run with no legs cannot be read, compared or adopted.
      if (legs.length === 0) continue;
      runs.push({
        id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
        repo,
        prompt: typeof r.prompt === "string" ? r.prompt : "",
        createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
        legs,
        adoptedLegId: typeof r.adoptedLegId === "string" ? r.adoptedLegId : null,
      });
    }
    if (runs.length) out[repo] = runs;
  }
  return out;
}

const [runs, setRuns] = createStore<RunsByRepo>(
  reviveRuns(readJson<unknown>(STORAGE_KEYS.fanoutRuns, {})),
);

function persist(): void {
  writeJson(STORAGE_KEYS.fanoutRuns, runs);
}

export function fanoutRuns(repo: string): FanoutRun[] {
  return runs[repo] ?? [];
}

export function fanoutRun(repo: string, runId: string): FanoutRun | undefined {
  return fanoutRuns(repo).find((r) => r.id === runId);
}

/// Turn ids in flight, keyed by leg id, so a cancel has something to name.
const turnIds = new Map<string, string>();

// ── Naming ───────────────────────────────────────────────────────────────────

/// A branch name for a leg: `fanout/<slug>/<agent>`.
///
/// Pure and exported, because a name collision is the kind of failure that only
/// shows up on the second run of the day and only for the user whose agents are
/// named the same thing. The run's short id disambiguates two runs of the same
/// prompt; the index disambiguates two legs on the same agent.
export function legBranchName(prompt: string, runId: string, agentName: string, index: number): string {
  return `fanout/${slug(prompt) || "run"}-${runId.slice(0, 6)}/${slug(agentName) || `leg${index + 1}`}`;
}

/// A worktree directory name for a leg. Sibling of the repository, because a
/// worktree *inside* the repository is a worktree git will then try to track.
export function legWorktreePath(repo: string, branch: string): string {
  const parent = repo.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]*$/, "");
  const base = repo.split(/[/\\]/).filter(Boolean).pop() ?? "repo";
  return `${parent}/${base}-${slug(branch.replace(/^fanout\//, "")) || "leg"}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface LegSpec {
  agentId: string;
  agentName: string;
  commandTemplate: string;
}

export interface StartRunOptions {
  repo: string;
  prompt: string;
  legs: LegSpec[];
  /// The ref every leg branches from. Defaults to the repository's HEAD.
  baseRef?: string;
  now?: number;
}

function patchLeg(repo: string, runId: string, legId: string, patch: Partial<RunLeg>): void {
  setRuns(
    repo,
    (r) => r.id === runId,
    "legs",
    (l: RunLeg) => l.id === legId,
    produce((leg: RunLeg) => Object.assign(leg, patch)),
  );
  persist();
}

/// Launch a run. Returns the run id, or `null` when there is nothing to launch.
///
/// Legs start concurrently and independently: one leg failing to get a worktree
/// must not stop the others, because the entire premise is that you do not know
/// which approach will work. The returned promise settles when every leg has,
/// so a caller can await the whole run — but the store updates as each leg
/// moves, which is what the surface renders from.
export async function startFanoutRun(options: StartRunOptions): Promise<string | null> {
  const prompt = options.prompt.trim();
  if (!prompt || options.legs.length === 0) return null;

  const now = options.now ?? Date.now();
  const runId = crypto.randomUUID();
  const legs: RunLeg[] = options.legs.map((spec, index) => {
    const branch = legBranchName(prompt, runId, spec.agentName, index);
    return {
      id: crypto.randomUUID(),
      agentId: spec.agentId,
      agentName: spec.agentName,
      commandTemplate: spec.commandTemplate,
      branch,
      worktreePath: legWorktreePath(options.repo, branch),
      status: "pending",
      startedAt: null,
      endedAt: null,
      answer: "",
      error: null,
      stat: null,
    };
  });

  const run: FanoutRun = {
    id: runId,
    repo: options.repo,
    prompt,
    createdAt: now,
    legs,
    adoptedLegId: null,
  };

  setRuns(
    produce((s) => {
      const list = (s[options.repo] ??= []);
      list.unshift(run);
      // Newest first, so trimming drops the oldest.
      if (list.length > KEEP_RUNS) list.length = KEEP_RUNS;
    }),
  );
  persist();

  record({
    kind: "run.started",
    actor: "user",
    repo: options.repo,
    subject: prompt,
    summary: `Fanned “${firstLine(prompt)}” out to ${legs.length} agent${legs.length === 1 ? "" : "s"}`,
    data: { runId, legs: legs.map((l) => ({ agent: l.agentName, branch: l.branch })) },
  });

  await Promise.all(legs.map((leg) => runLeg(run, leg, options.baseRef)));
  return runId;
}

async function runLeg(run: FanoutRun, leg: RunLeg, baseRef?: string): Promise<void> {
  const { repo, id: runId } = run;

  patchLeg(repo, runId, leg.id, { status: "preparing", startedAt: Date.now() });
  try {
    await gitApi.addWorktree(repo, leg.worktreePath, leg.branch, true);
  } catch (e) {
    const error = message(e);
    patchLeg(repo, runId, leg.id, { status: "failed", error, endedAt: Date.now() });
    recordLeg(run, leg, "failed", `could not create a worktree: ${error}`);
    noteLegFailure(run, leg, error);
    return;
  }

  const turnId = crypto.randomUUID();
  turnIds.set(leg.id, turnId);
  patchLeg(repo, runId, leg.id, { status: "running" });

  let answer = "";
  try {
    const result = await agentApi.streamQuery({
      repoPath: leg.worktreePath,
      commandTemplate: leg.commandTemplate,
      prompt: legPrompt(run.prompt, baseRef),
      secretBindings: aiSecretBindings(),
      turnId,
      agentName: leg.agentName,
      onChunk: (text) => {
        answer += text;
        patchLeg(repo, runId, leg.id, { answer });
      },
    });

    const stat = await legStat(leg.worktreePath, baseRef);
    if (result.cancelled) {
      patchLeg(repo, runId, leg.id, {
        status: "cancelled",
        endedAt: Date.now(),
        answer,
        stat,
      });
      recordLeg(run, leg, "cancelled", "was stopped");
      return;
    }
    patchLeg(repo, runId, leg.id, {
      status: "finished",
      endedAt: Date.now(),
      answer,
      stat,
    });
    recordLeg(
      run,
      leg,
      "finished",
      stat
        ? `${stat.files} file${stat.files === 1 ? "" : "s"}, +${stat.additions} −${stat.deletions}`
        : "finished",
    );
  } catch (e) {
    const error = message(e);
    patchLeg(repo, runId, leg.id, {
      status: "failed",
      endedAt: Date.now(),
      answer,
      error,
    });
    recordLeg(run, leg, "failed", error);
    noteLegFailure(run, leg, error);
  } finally {
    turnIds.delete(leg.id);
  }
}

/// Tell the user a leg died, without telling them N times.
///
/// A fan-out is the exact shape MASTER §7.5.5 does not cover: it assigns an
/// interruption *level* per event and says nothing about rate, so five legs
/// failing produced five stacked toasts describing one bad prompt. The attention
/// budget did not grow by a factor of five.
///
/// Keyed on the run rather than the leg, so the count is the useful number —
/// "this run is failing, 4 times" rather than four notices each naming a
/// worktree the reader has never seen. The full detail is one click away in
/// Mission Control and permanently in the journal, which is where per-leg
/// errors belong.
///
/// No Retry affordance here, deliberately: there is no per-leg retry verb yet
/// (re-running a leg means deciding what happens to the worktree and branch it
/// already made), and a button that reruns the *whole* run would be a different
/// and more expensive action than the word implies.
function noteLegFailure(run: FanoutRun, leg: RunLeg, error: string): void {
  pushToast(
    `${leg.agentName} failed on “${firstLine(run.prompt)}” — ${firstLine(error)}`,
    "error",
    6000,
    undefined,
    `run:${run.id}`,
  );
}

/// What each leg is actually asked.
///
/// The instruction to *make the change* rather than describe it is the whole
/// difference between a fan-out and asking the same question three times. The
/// leg's value is its diff; its prose is a secondary artefact.
function legPrompt(prompt: string, baseRef?: string): string {
  return [
    "You are working in an isolated git worktree created for this task. Make the change directly in the files — do not describe what you would do. Leave the work uncommitted in the working tree unless committing is part of the task.",
    baseRef ? `You branched from \`${baseRef}\`.` : "",
    `## Task\n${prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/// What a leg produced, measured the same way for every leg.
///
/// Against the base ref when there is one, otherwise the working tree — a leg
/// that committed its work would show an empty working-tree diff, and reporting
/// "0 files changed" for the leg that did the most work is the single most
/// misleading thing this surface could do.
async function legStat(worktreePath: string, baseRef?: string): Promise<LegStat | null> {
  try {
    const diff = baseRef
      ? await gitApi.diffRefs(worktreePath, baseRef, "HEAD", true)
      : await gitApi.diffWorking(worktreePath, false);
    const working = baseRef ? await gitApi.diffWorking(worktreePath, false) : null;
    const files = new Set<string>();
    let additions = diff.totalAdditions;
    let deletions = diff.totalDeletions;
    for (const f of diff.files) files.add(f.newPath ?? f.oldPath ?? "");
    if (working) {
      additions += working.totalAdditions;
      deletions += working.totalDeletions;
      for (const f of working.files) files.add(f.newPath ?? f.oldPath ?? "");
    }
    files.delete("");
    return {
      files: files.size,
      additions,
      deletions,
      // Sorted here rather than at render time so every consumer sees one
      // order, and a diff of two legs' paths is a diff of two sorted lists.
      paths: [...files].sort(),
    };
  } catch {
    // A stat we could not take is `null`, which the surface renders as "not
    // measured" — not as zero.
    return null;
  }
}

/// Stop one leg. The others keep going, which is the point.
///
/// Takes only the leg id — a turn in flight is unique across every run, so
/// asking the caller for the repo and run as well would be three parameters
/// where the first two are never checked, which is an invitation to pass the
/// wrong one and see nothing happen.
export async function cancelFanoutLeg(legId: string): Promise<void> {
  const turnId = turnIds.get(legId);
  if (!turnId) return;
  try {
    await agentApi.cancelTurn(turnId);
  } catch {
    // The turn had already ended. `runLeg` will settle it either way.
  }
}

// ── Adopting ─────────────────────────────────────────────────────────────────

/// Merge a leg's branch into the repository's current branch.
///
/// Does **not** touch the other legs' worktrees. See the module comment: the
/// losing branches are somebody's four minutes of work, and removing them is an
/// explicit act, not a side effect of picking a winner.
export async function adoptFanoutLeg(
  repo: string,
  runId: string,
  legId: string,
): Promise<{ ok: boolean; error?: string }> {
  const run = fanoutRun(repo, runId);
  const leg = run?.legs.find((l) => l.id === legId);
  if (!run || !leg) return { ok: false, error: "That leg is no longer in the run." };
  if (run.adoptedLegId) {
    // Two answers to one question, merged on top of each other, is not a state
    // anybody asked for and is painful to unpick.
    return { ok: false, error: "This run has already been adopted." };
  }

  try {
    await gitApi.merge(repo, leg.branch, false);
  } catch (e) {
    return { ok: false, error: message(e) };
  }

  setRuns(repo, (r) => r.id === runId, "adoptedLegId", legId);
  persist();
  record({
    kind: "run.adopted",
    actor: "user",
    repo,
    subject: leg.branch,
    summary: `Adopted ${leg.agentName}'s answer to “${firstLine(run.prompt)}”`,
    data: { runId, legId, branch: leg.branch, agent: leg.agentName },
  });
  return { ok: true };
}

/// Remove a leg's worktree. Explicit, per leg, never automatic.
export async function discardFanoutLeg(
  repo: string,
  runId: string,
  legId: string,
): Promise<{ ok: boolean; error?: string }> {
  const leg = fanoutRun(repo, runId)?.legs.find((l) => l.id === legId);
  if (!leg) return { ok: false, error: "That leg is no longer in the run." };
  try {
    await gitApi.removeWorktree(repo, leg.worktreePath, true);
  } catch (e) {
    return { ok: false, error: message(e) };
  }
  record({
    kind: "run.leg.discarded",
    actor: "user",
    repo,
    subject: leg.branch,
    summary: `Discarded ${leg.agentName}'s worktree for “${firstLine(leg.branch)}”`,
    data: { runId, legId, branch: leg.branch },
  });
  return { ok: true };
}

export function removeFanoutRun(repo: string, runId: string): void {
  // A complaint about a run the user has just deleted is not news. Without
  // this, dismissing the run leaves its failure toast counting up on screen
  // against a run that no longer exists.
  dismissToastSource(`run:${runId}`);
  setRuns(
    produce((s) => {
      const list = s[repo];
      if (!list) return;
      s[repo] = list.filter((r) => r.id !== runId);
    }),
  );
  persist();
}

/// Test seam.
export function resetFanout(): void {
  turnIds.clear();
  setRuns(produce((s) => {
    for (const key of Object.keys(s)) delete s[key];
  }));
  persist();
}

// ── Reading ──────────────────────────────────────────────────────────────────

/// How a run is doing, in one object, so the surface does not recount.
export interface RunProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
  /// True while any leg could still change on its own.
  active: boolean;
}

export function runProgress(run: FanoutRun): RunProgress {
  let done = 0;
  let running = 0;
  let failed = 0;
  for (const leg of run.legs) {
    if (isLegDone(leg.status)) done += 1;
    else running += 1;
    if (leg.status === "failed") failed += 1;
  }
  return { total: run.legs.length, done, running, failed, active: running > 0 };
}

/// Legs ordered for comparison: finished first, largest change first.
///
/// Largest first is a deliberate default and not a claim about quality — it is
/// the ordering under which the leg that did the most is the one you read
/// first, which is what you want when deciding whether any of them did enough.
export function compareLegs(a: RunLeg, b: RunLeg): number {
  const rank = (l: RunLeg) => (l.status === "finished" ? 0 : isLegDone(l.status) ? 2 : 1);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const size = (l: RunLeg) => (l.stat ? l.stat.additions + l.stat.deletions : -1);
  const bySize = size(b) - size(a);
  if (bySize !== 0) return bySize;
  return a.agentName.localeCompare(b.agentName);
}

function recordLeg(run: FanoutRun, leg: RunLeg, outcome: string, detail: string): void {
  record({
    kind: `run.leg.${outcome}`,
    actor: "agent",
    actorName: leg.agentName,
    repo: run.repo,
    subject: leg.branch,
    summary: `${leg.agentName} ${outcome} on “${firstLine(run.prompt)}” — ${detail}`,
    data: { runId: run.id, legId: leg.id, branch: leg.branch, worktree: leg.worktreePath },
  });
}

function firstLine(text: string, max = 60): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
