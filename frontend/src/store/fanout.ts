/// Fan-out: one prompt, N worktrees, N agents, N diffs to compare.
///
/// Orca's central mechanism. The premise is that for a genuinely uncertain
/// change the cheapest way to find the right approach is to try several at
/// once, in isolation, and then read the diffs — and that the isolation is free
/// because git worktrees already exist.
///
/// ## What is here and what moved to Rust
///
/// **Here.** The run entity as this window renders it, leg *naming*
/// (`legBranchName`/`legWorktreePath` — pure, already tested, no reason to
/// duplicate), the diff stat each leg produced once it goes terminal, adopt
/// and discard, and the local persisted list of runs a repository has seen.
///
/// **Moved to `src-tauri/src/fanout/mod.rs`.** Spawning a leg, its worktree
/// creation, streaming its output, per-leg cancel, and the terminal
/// transition itself — everything that used to live in `runLeg` below and
/// die the moment this window closed, because it was a child process
/// streaming over a `tauri::ipc::Channel` **this webview** owned. A run's
/// lifetime is now the app's: `fanoutApi.startRun` hands a leg to the
/// supervisor and returns as soon as it is *registered*, not once every leg
/// finishes, and every state change this store applies after that is a
/// message the supervisor sent — `fanoutApi.subscribe`'s live tail, or
/// `reconcileFanoutRuns`'s reconnect query. This store is a **view**, in the
/// same sense `journal.ts` is a view over Rust's event log: nothing here
/// spawns a process or decides a leg's terminal state.
///
/// ## `interrupted`, after the move
///
/// Still exists, still means exactly what it always did: nobody chose it and
/// nothing went wrong. What changed is *when* it applies. `reviveRuns` still
/// applies it pessimistically to anything non-terminal at load time — that
/// default has to stay honest with zero information. `reconcileFanoutRuns`
/// is what can walk it back: for every run the supervisor confirms it is
/// still driving, the leg's *real* status (possibly `finished`, learned while
/// this window did not exist) replaces the guess. For a run the supervisor
/// has no record of — this process never started it, or the app itself
/// restarted since — there is nothing to ask, and `interrupted` is the
/// honest answer, exactly as before. See `fanout::mod.rs`'s header for why
/// "the app quitting" is still a horizon this feature cannot move past.
///
/// **Not here: automatic cleanup.** Adopting one leg does not delete the other
/// worktrees. Deleting a branch that took an agent four minutes to write,
/// because the user clicked "adopt" on a different one, is not a decision this
/// module gets to make silently. Removal is offered, per leg, explicitly.

import { createStore, produce } from "solid-js/store";
import { fanoutApi, type LegSnapshot, type RunSnapshot } from "@/api/fanout";
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
  /// The supervisor has no record of this leg. Distinct from `cancelled`
  /// because nobody chose it, and distinct from `failed` because nothing went
  /// wrong — the work simply has no process behind it that this app can
  /// vouch for. See the module comment.
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
  /// The agent's answer, as far as it got. Set wholesale from a supervisor
  /// snapshot or leg-status message (both carry the full buffer), appended to
  /// from a live `chunk` message — see `applyLegSnapshot` vs `appendLegAnswer`.
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
  /// The ref every leg branched from, if one was given. Persisted (not just
  /// threaded through a call) because `legStat` needs it to measure a leg
  /// correctly, and a leg can go terminal in a window that reconnected long
  /// after `startFanoutRun`'s own closure over this value is gone.
  baseRef: string | null;
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
    // A leg persisted mid-flight comes back as one with no known supervisor —
    // `reconcileFanoutRuns` is what can prove otherwise. Same repair
    // `parseMessage` makes for a streaming agent message, and for the same
    // reason: a pending state nobody can vouch for is a spinner that might
    // never stop.
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
        baseRef: typeof r.baseRef === "string" ? r.baseRef : null,
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

/// Runs this window is currently subscribed to, so a repeated
/// `reconcileFanoutRuns` call (the active repository changing back and forth,
/// or firing twice for the same repo) does not register a second `Channel`
/// for the same run — a `chunk` message would then append twice.
const subscribedRunIds = new Set<string>();

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

function appendLegAnswer(repo: string, runId: string, legId: string, text: string): void {
  setRuns(
    repo,
    (r) => r.id === runId,
    "legs",
    (l: RunLeg) => l.id === legId,
    produce((leg: RunLeg) => {
      leg.answer += text;
    }),
  );
  persist();
}

/// Launch a run. Returns the run id, or `null` when there is nothing to launch.
///
/// Resolves once the supervisor has **registered** the run, not once every
/// leg finishes — that guarantee belonged to the old window-owned
/// orchestration and is exactly what made a run unable to outlive the window
/// that awaited it. Progress after this point arrives through
/// `subscribeRun`'s live tail; the store updates as each leg moves, which is
/// what the surface renders from.
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
    baseRef: options.baseRef ?? null,
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

  try {
    // `run.started` is recorded by the supervisor itself now — see
    // `fanout::start_run` — so this call does not also write it, which would
    // double the journal entry.
    await fanoutApi.startRun({
      runId,
      repo: options.repo,
      prompt,
      secretBindings: aiSecretBindings(),
      legs: legs.map((leg) => ({
        id: leg.id,
        agentId: leg.agentId,
        agentName: leg.agentName,
        commandTemplate: leg.commandTemplate,
        branch: leg.branch,
        worktreePath: leg.worktreePath,
        prompt: legPrompt(prompt, options.baseRef),
      })),
    });
  } catch (e) {
    // The supervisor never took the run at all — every leg failed before a
    // single worktree was touched. Different shape from a single leg's
    // worktree failing (Rust reports that per-leg and keeps the rest going);
    // a rejected `startRun` means nothing was registered, so every leg here
    // failed identically.
    const error = message(e);
    for (const leg of legs) {
      patchLeg(options.repo, runId, leg.id, { status: "failed", error, endedAt: Date.now() });
    }
    return runId;
  }

  subscribeRun(options.repo, runId);
  return runId;
}

/// Attach to a run's live output and apply every message to the store.
/// Idempotent per run id — see `subscribedRunIds`.
function subscribeRun(repo: string, runId: string): void {
  if (subscribedRunIds.has(runId)) return;
  subscribedRunIds.add(runId);

  fanoutApi
    .subscribe(runId, (event) => {
      if (!fanoutRun(repo, runId)) return; // "Forget this run" raced the subscribe
      if (event.event === "snapshot") {
        for (const leg of event.data.run.legs) applyLegSnapshot(repo, runId, leg, false);
      } else if (event.event === "chunk") {
        appendLegAnswer(repo, runId, event.data.legId, event.data.text);
      } else {
        applyLegSnapshot(repo, runId, event.data.leg, true);
      }
    })
    .catch(() => {
      // The run vanished from the supervisor between deciding to subscribe
      // and asking — most likely it finished and this window is only now
      // catching up, or the app restarted. Either way `reviveRuns` already
      // set every non-terminal leg to `interrupted`, which is the honest
      // answer when there is nothing left to ask.
      subscribedRunIds.delete(runId);
    });
}

/// Apply one leg's full state from the supervisor. `live` distinguishes a
/// real-time `legStatus` message from the replay half of a `snapshot` — a
/// failure toast fires only for the former. A snapshot can carry a leg that
/// has been `failed` for an hour; announcing that as news every time a window
/// reconnects would be exactly the "five stacked toasts" problem the original
/// coalescing existed to prevent, just retriggered by reconnects instead of
/// fan-out size.
function applyLegSnapshot(repo: string, runId: string, snap: LegSnapshot, live: boolean): void {
  const before = fanoutRun(repo, runId)?.legs.find((l) => l.id === snap.id);
  const wasDone = before ? isLegDone(before.status) : false;

  patchLeg(repo, runId, snap.id, {
    status: snap.status,
    startedAt: snap.startedAt,
    endedAt: snap.endedAt,
    answer: snap.answer,
    error: snap.error,
  });

  if (live && !wasDone && snap.status === "failed") {
    const run = fanoutRun(repo, runId);
    if (run) noteLegFailure(run, { ...before, ...snap } as RunLeg, snap.error ?? "failed");
  }

  void maybeMeasureLeg(repo, runId, snap.id);
}

/// Measure a leg's diff once it goes terminal, the same way for every leg —
/// see `legStat`. Guarded on `stat === null` so a leg already measured (by an
/// earlier snapshot, or earlier in this same session) is not re-diffed on
/// every subsequent message the supervisor happens to still send about it.
async function maybeMeasureLeg(repo: string, runId: string, legId: string): Promise<void> {
  const run = fanoutRun(repo, runId);
  const leg = run?.legs.find((l) => l.id === legId);
  if (!run || !leg || !isLegDone(leg.status) || leg.stat) return;
  const stat = await legStat(leg.worktreePath, run.baseRef ?? undefined);
  patchLeg(repo, runId, legId, { stat });
}

/// Reconcile every run this window knows about for `repo` against what the
/// supervisor is actually tracking. Call once per repository — `App.tsx`
/// does it in the same effect that keeps the journal's ambient repo current,
/// keyed on the active repository changing.
///
/// This is the reconnect half of the feature: a window that (re)appears asks
/// "what is running?" and, for anything it gets back, both corrects the
/// locally-guessed status and re-subscribes for further live output —
/// including when the window doing the asking is not the one that started
/// the run. A run absent from the supervisor's answer is left exactly as
/// `reviveRuns` set it: `interrupted`.
///
/// **Known gap.** This only reconciles runs *this window already has a
/// record of* (its own `localStorage`). A run started entirely from a
/// different window, whose record therefore never reached this one's copy of
/// `voidlink-fanout-runs`, stays invisible here even though the supervisor is
/// still driving it — the same cross-window `localStorage` limitation
/// `journal/mod.rs`'s header describes for the event log generally. Fixing it
/// for fan-out specifically would mean either moving the run *list* into Rust
/// too (not just its liveness) or polling every open repository's runs on
/// every window, and neither is done here.
export async function reconcileFanoutRuns(repo: string): Promise<void> {
  let supervised: RunSnapshot[];
  try {
    supervised = await fanoutApi.runState(repo);
  } catch {
    // Could not reach the supervisor at all. Leave every run exactly as
    // `reviveRuns` decided — degrading to "no better information" rather
    // than guessing, the same policy `legStat`'s own catch uses.
    return;
  }
  const known = new Set(fanoutRuns(repo).map((r) => r.id));
  for (const run of supervised) {
    if (!known.has(run.id)) continue; // see "Known gap" above
    for (const leg of run.legs) applyLegSnapshot(repo, run.id, leg, false);
    subscribeRun(repo, run.id);
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
/// `false` (or a rejected call, swallowed here) means there was nothing to
/// cancel — the leg had already reached a terminal status, which is an
/// ordinary race between this click and the leg finishing on its own, not a
/// fault to surface. The supervisor is the single source of truth for
/// whether the cancel landed; this function does not guess.
export async function cancelFanoutLeg(legId: string): Promise<void> {
  try {
    await fanoutApi.cancelLeg(legId);
  } catch {
    // See above — a cancel racing the leg's own completion is normal.
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
  subscribedRunIds.delete(runId);
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
  subscribedRunIds.clear();
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

function firstLine(text: string, max = 60): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
