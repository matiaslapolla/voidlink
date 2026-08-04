/// Every agent session in the active workspace, as one reactive list.
///
/// The dashboard's question — "which agent needs me right now?" — is
/// cross-worktree, and nothing in the app was cross-worktree before it. The
/// pane layer and the tab strip both subscribe to `watchTerminal` for
/// `activeTerminals()` only, which is exactly right for them and exactly wrong
/// here: a shell in the worktree you are *not* looking at is the one the
/// dashboard exists to tell you about.
///
/// So this subscribes to every terminal in every worktree of the active
/// workspace. Three things make that affordable rather than reckless:
///
///   • It is behind the experimental flag, fully. `useAgentSessions` is only
///     called from a component that is only mounted when
///     `experimental.agentDashboard` is on, so with the flag off not one extra
///     `processInfo` runs. The flag is not a `display: none`.
///   • The watcher is refcounted and keyed by `ptyId`, so the terminals the
///     pane layer already watches cost nothing extra — there is still exactly
///     one poll per shell per interval, which is the constraint the poll was
///     moved into `terminalWatch.ts` to keep.
///   • `mapArray` gives each session its own reactive root, so a shell that
///     closes releases its refcount immediately rather than when the whole
///     board unmounts.
///
/// The `now` tick is the other half. The idle threshold is a *duration*, and
/// nothing in Solid re-runs a computation because time passed — so the board
/// needs a clock, and one board-level interval is the right shape for it. It is
/// not a second per-terminal poll: it fires once for the whole workspace and
/// does no IPC at all.
import { createMemo, createSignal, mapArray, onCleanup, type Accessor } from "solid-js";
import { useAppStore } from "@/store/LayoutContext";
import { tabMark } from "@/store/activity";
import { agentCliName } from "@/store/agentCli";
import { terminalLastActivity, watchTerminal } from "@/store/terminalWatch";
import { terminalSignal } from "@/components/layout/activitySignal";
import { worktreeLabel } from "@/types/workspace";
import type { AgentSession } from "@/components/agent/agentBoard";

/// How often the board re-reads the wall clock.
///
/// Ten seconds. The only thing that depends on it is a thirty-minute threshold
/// and the "last active" line on a card, so anything under a minute is already
/// finer than the data — ten is the granularity at which a card's relative time
/// does not visibly lag, and it costs one timer for the whole window.
const BOARD_TICK_MS = 10_000;

/// A monotonic-enough now, republished every `BOARD_TICK_MS`. Only live while
/// something is subscribed.
function useBoardClock(): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), BOARD_TICK_MS);
  onCleanup(() => clearInterval(timer));
  return now;
}

interface SessionRow {
  tabId: string;
  ptyId: string;
  worktreeId: string;
  worktreeLabel: string;
  label: string;
}

/// Every terminal in every worktree of the active workspace, flattened.
///
/// Deliberately the *active workspace* and not every open one: cross-workspace
/// aggregation is a different product question ("what is my whole machine
/// doing") and would put rows on the board the user has no navigation to.
function useSessionRows(): Accessor<SessionRow[]> {
  const { state, activeWorkspace } = useAppStore();
  return createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) return [];
    const rows: SessionRow[] = [];
    for (const wt of ws.worktrees) {
      const label = worktreeLabel(wt);
      for (const term of state.terminalsByWorktree[wt.id] ?? []) {
        rows.push({
          tabId: term.id,
          ptyId: term.ptyId,
          worktreeId: wt.id,
          worktreeLabel: label,
          label: term.label,
        });
      }
    }
    return rows;
  });
}

/// The live session list. Must be called inside a reactive owner — every
/// subscription it takes is released on that owner's cleanup.
export function useAgentSessions(): Accessor<AgentSession[]> {
  const now = useBoardClock();
  const rows = useSessionRows();

  const watched = mapArray(rows, (row) => {
    // One root per session, courtesy of `mapArray`. `watchTerminal`'s cleanup
    // runs when this row leaves the list, so a closed shell stops being polled
    // the moment it closes rather than when the board unmounts.
    const watch = watchTerminal(row.tabId, row.ptyId);
    return (at: number): AgentSession => {
      return {
        tabId: row.tabId,
        worktreeId: row.worktreeId,
        worktreeLabel: row.worktreeLabel,
        label: row.label,
        agent: watch.agent() ? agentCliName(watch.processName()) : null,
        // The one vocabulary, resolved exactly as the tab strip resolves it:
        // the escalating signals in `store/activity.ts` plus the focus-local
        // `idle`. The board does not get its own answer to "what is this
        // shell doing" — that is the whole point of Feature A.
        signal: tabMark(
          row.tabId,
          terminalSignal({
            working: watch.working(),
            agent: watch.agent(),
            waiting: watch.waiting(),
            // Focused so a quiet agent resolves to `idle` rather than to
            // nothing: on the board, "this agent is here and quiet" is a card
            // in the Idle column, not an absence. In a tab strip the same
            // absence is right, because the row itself is already the
            // evidence the shell exists.
            focused: true,
          }),
        ),
        // Falls back to `at` rather than to 0: a shell that has never written
        // a byte has not been idle since the epoch, it has just started, and
        // dating it to 1970 would file it under Idle on its first tick.
        lastActivityAt: terminalLastActivity(row.ptyId) ?? at,
      };
    };
  });

  return createMemo(() => {
    const at = now();
    return watched().map((build) => build(at));
  });
}
