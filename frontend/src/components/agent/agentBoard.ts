/// The Agent Dashboard as *data*: which agent sessions exist across the active
/// workspace's worktrees, and which column each one falls in.
///
/// Pure. No Solid, no DOM, no clock of its own — `now` is a parameter, which is
/// the only way the thirty-minute idle threshold is testable without waiting
/// thirty minutes. See `docs/features/testing.md` for why this is a `.ts` file
/// beside the `.tsx` that renders it.
///
/// **There is no state machine here.** Column assignment is a total function
/// over the `ActivitySignal` set that `components/layout/activitySignal.ts`
/// already defines and `store/terminalWatch.ts` already derives. A second
/// vocabulary — "running", "blocked", "review" — would be a third place the
/// same PTY is interpreted, and the two would drift the first time one of them
/// learned something the other did not. If a column needs a state the signal
/// set does not have, the signal set is what changes.
import type { ActivitySignal } from "@/components/layout/activitySignal";

/// How long an agent must be quiet, without having reported completion, before
/// the board files it under Idle.
///
/// Thirty minutes. Long enough that an agent you are actively working with
/// never falls out of the column you left it in — a permission prompt you took
/// a coffee break over is still Needs You when you come back — and short enough
/// that yesterday's abandoned session is not sitting in Working forever. One
/// named constant because the number appears in the derivation, in the column's
/// own description and in the tests, and three copies of thirty minutes is two
/// copies too many.
export const AGENT_IDLE_MS = 30 * 60 * 1000;

/// The four columns, in board order. Left to right is *decreasing* claim on the
/// user's attention, which is also the order the signal precedence puts them in.
export const AGENT_COLUMNS = ["needsYou", "working", "done", "idle"] as const;

export type AgentColumn = (typeof AGENT_COLUMNS)[number];

export const AGENT_COLUMN_LABELS: Record<AgentColumn, string> = {
  needsYou: "Needs You",
  working: "Working",
  done: "Done",
  idle: "Idle",
};

/// One agent session on the board. Everything the card renders and everything
/// the click needs, and nothing else — no accessors, no store handles, so the
/// whole board is a value that can be snapshotted across a window boundary.
export interface AgentSession {
  /// The terminal *tab* id. What `actions.selectTerminal` takes.
  tabId: string;
  /// The worktree that owns the tab. What `actions.selectWorktree` takes.
  worktreeId: string;
  /// The worktree's display label, so a card can say where it is.
  worktreeLabel: string;
  /// The tab's label ("Terminal 2").
  label: string;
  /// The agent binary's normalised name (`claude`, `codex`), or `null` if the
  /// foreground process is not on the roster — in which case this is not an
  /// agent session and `buildAgentBoard` drops it.
  agent: string | null;
  /// The one mark the session is carrying, precedence already applied.
  /// `undefined` is a plain shell: nothing to report, nothing to show.
  signal: ActivitySignal | undefined;
  /// When this session last did anything observable — output, a completion, a
  /// state change. The clock the idle threshold is measured against.
  lastActivityAt: number;
}

/// Which column a signal belongs to, or `null` for a signal that puts a session
/// on no column at all.
///
/// The mapping the brief states, and it is exhaustive over `ActivitySignal` on
/// purpose: a signal added to the vocabulary tomorrow fails to compile here
/// until somebody decides where it goes, rather than silently vanishing off the
/// board.
export function columnForSignal(signal: ActivitySignal | undefined): AgentColumn | null {
  switch (signal) {
    case "waiting":
      return "needsYou";
    // `running` joins `working`: it is chrome work on the agent's tab — a diff
    // or a draft being fetched for it — and still "something is in flight",
    // which is what the column means.
    case "working":
    case "running":
      return "working";
    // `notify` joins the two result states: it is what a completion the user
    // was away for turns into, the same event as `finished` seen from a
    // different chair.
    case "finished":
    case "failed":
    case "notify":
      return "done";
    case "idle":
      return "idle";
    // Buffer states. They belong to an editor tab, not to an agent session, and
    // a shell cannot raise them — but the switch is exhaustive so that saying
    // so is a decision rather than an omission.
    case "dirty":
    case "stale":
    case undefined:
      return null;
  }
}

export interface AgentBoardInput {
  /// Every terminal session in every worktree of the active workspace, agent or
  /// not. Filtering is this module's job, so the caller never has to know what
  /// counts as an agent.
  sessions: readonly AgentSession[];
  /// Now, in ms. A parameter, so the threshold is testable.
  now: number;
  /// `experimental.showIdleAgents`. When false the Idle column is empty — and
  /// the sessions in it are *dropped*, not hidden, so nothing downstream counts
  /// them.
  showIdle: boolean;
}

export type AgentBoard = Record<AgentColumn, AgentSession[]>;

function emptyBoard(): AgentBoard {
  return { needsYou: [], working: [], done: [], idle: [] };
}

/// Build the board.
///
/// Two rules beyond the signal mapping:
///
///   • A session quiet for `AGENT_IDLE_MS` moves to Idle **unless it has
///     reported a result**. A finished or failed run stays in Done however long
///     ago it happened, because Done is a list of things to review and a review
///     queue that empties itself on a timer is a review queue that loses work.
///     Needs You is likewise immune: an unanswered question does not stop being
///     unanswered.
///   • Agents from every worktree land on one board. That is the entire point —
///     the question the dashboard answers is "which one needs me", and it is
///     unanswerable if you have to visit each worktree to ask it.
export function buildAgentBoard(input: AgentBoardInput): AgentBoard {
  const board = emptyBoard();
  for (const session of input.sessions) {
    if (!session.agent) continue;
    const column = assignColumn(session, input.now);
    if (!column) continue;
    if (column === "idle" && !input.showIdle) continue;
    board[column].push(session);
  }
  for (const column of AGENT_COLUMNS) board[column].sort(compareSessions);
  return board;
}

/// The column one session lands in, threshold applied. Exported because it is
/// the rule worth testing directly, and because a card's tooltip explains its
/// own placement with it.
export function assignColumn(session: AgentSession, now: number): AgentColumn | null {
  const base = columnForSignal(session.signal);
  if (!base) return null;
  // `needsYou` and `done` are terminal states of the user's attention, not of
  // the process, so they do not age out.
  if (base === "needsYou" || base === "done") return base;
  return now - session.lastActivityAt >= AGENT_IDLE_MS ? "idle" : base;
}

/// Stable order within a column: most recently active first, then by label, so
/// two sessions that went quiet in the same millisecond do not swap places
/// between renders.
function compareSessions(a: AgentSession, b: AgentSession): number {
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  return a.label.localeCompare(b.label);
}

/// How many sessions are waiting on the user, across every worktree. The number
/// behind the sidebar's "Needs You" count.
export function needsYouCount(board: AgentBoard): number {
  return board.needsYou.length;
}

/// Is there anything at all on the board? Distinguishes "no agents running"
/// from "agents running, none in this column", which are different empty states.
export function boardIsEmpty(board: AgentBoard): boolean {
  return AGENT_COLUMNS.every((c) => board[c].length === 0);
}
