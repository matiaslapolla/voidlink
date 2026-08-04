import { describe, expect, it } from "vitest";
import { ACTIVITY_SIGNALS, type ActivitySignal } from "@/components/layout/activitySignal";
import {
  AGENT_IDLE_MS,
  assignColumn,
  boardIsEmpty,
  buildAgentBoard,
  columnForSignal,
  needsYouCount,
  type AgentSession,
} from "./agentBoard";

const NOW = 1_700_000_000_000;

function session(partial: Partial<AgentSession> = {}): AgentSession {
  return {
    tabId: "t1",
    worktreeId: "wt1",
    worktreeLabel: "main",
    label: "Terminal 1",
    agent: "claude",
    signal: "working",
    lastActivityAt: NOW,
    ...partial,
  };
}

describe("columnForSignal", () => {
  it("maps each signal to the column the brief names", () => {
    expect(columnForSignal("waiting")).toBe("needsYou");
    expect(columnForSignal("working")).toBe("working");
    expect(columnForSignal("finished")).toBe("done");
    expect(columnForSignal("failed")).toBe("done");
    expect(columnForSignal("idle")).toBe("idle");
  });

  /// The board is a view over one vocabulary, so every member of it has to
  /// have an answer here — including "this one is not an agent state".
  it("answers for every member of the signal set", () => {
    for (const signal of ACTIVITY_SIGNALS) {
      expect(() => columnForSignal(signal), signal).not.toThrow();
    }
    expect(columnForSignal("dirty")).toBeNull();
    expect(columnForSignal("stale")).toBeNull();
    expect(columnForSignal(undefined)).toBeNull();
  });
});

describe("the idle threshold", () => {
  it("leaves an agent quiet for 29 minutes in Working", () => {
    const s = session({ signal: "working", lastActivityAt: NOW - 29 * 60 * 1000 });
    expect(assignColumn(s, NOW)).toBe("working");
  });

  it("moves an agent quiet for 31 minutes to Idle", () => {
    const s = session({ signal: "working", lastActivityAt: NOW - 31 * 60 * 1000 });
    expect(assignColumn(s, NOW)).toBe("idle");
  });

  it("moves at exactly the threshold, not a millisecond later", () => {
    expect(assignColumn(session({ lastActivityAt: NOW - AGENT_IDLE_MS }), NOW)).toBe("idle");
    expect(assignColumn(session({ lastActivityAt: NOW - AGENT_IDLE_MS + 1 }), NOW)).toBe(
      "working",
    );
  });

  /// A review queue that empties itself on a timer loses work, and an
  /// unanswered question does not stop being unanswered.
  it("never ages a session out of Needs You or Done", () => {
    const ancient = NOW - 10 * AGENT_IDLE_MS;
    expect(assignColumn(session({ signal: "waiting", lastActivityAt: ancient }), NOW)).toBe(
      "needsYou",
    );
    expect(assignColumn(session({ signal: "finished", lastActivityAt: ancient }), NOW)).toBe(
      "done",
    );
    expect(assignColumn(session({ signal: "failed", lastActivityAt: ancient }), NOW)).toBe(
      "done",
    );
  });
});

describe("buildAgentBoard", () => {
  it("puts agents from several worktrees on one board", () => {
    const board = buildAgentBoard({
      now: NOW,
      showIdle: true,
      sessions: [
        session({ tabId: "a", worktreeId: "wt1", worktreeLabel: "main", signal: "waiting" }),
        session({ tabId: "b", worktreeId: "wt2", worktreeLabel: "feat/x", signal: "waiting" }),
        session({ tabId: "c", worktreeId: "wt3", worktreeLabel: "feat/y", signal: "working" }),
      ],
    });
    expect(board.needsYou.map((s) => s.worktreeId)).toEqual(["wt1", "wt2"]);
    expect(board.working.map((s) => s.worktreeId)).toEqual(["wt3"]);
    expect(needsYouCount(board)).toBe(2);
  });

  it("leaves the Idle column empty when showIdleAgents is off", () => {
    const sessions = [
      session({ tabId: "a", signal: "idle" }),
      session({ tabId: "b", signal: "working", lastActivityAt: NOW - 2 * AGENT_IDLE_MS }),
      session({ tabId: "c", signal: "waiting" }),
    ];
    const shown = buildAgentBoard({ sessions, now: NOW, showIdle: true });
    expect(shown.idle.map((s) => s.tabId).sort()).toEqual(["a", "b"]);

    const hidden = buildAgentBoard({ sessions, now: NOW, showIdle: false });
    expect(hidden.idle).toEqual([]);
    // …and the other columns are untouched, so hiding Idle never moves a card.
    expect(hidden.needsYou.map((s) => s.tabId)).toEqual(["c"]);
  });

  /// The plain-shell case from Feature A, one layer up: a `zsh` tab is not a
  /// row on this board at all.
  it("drops sessions whose foreground process is not an agent", () => {
    const board = buildAgentBoard({
      now: NOW,
      showIdle: true,
      sessions: [
        session({ tabId: "shell", agent: null, signal: "working" }),
        session({ tabId: "agent", agent: "codex", signal: "working" }),
      ],
    });
    expect(board.working.map((s) => s.tabId)).toEqual(["agent"]);
  });

  it("drops signals that belong to no column", () => {
    const board = buildAgentBoard({
      now: NOW,
      showIdle: true,
      sessions: [
        session({ tabId: "a", signal: "dirty" }),
        session({ tabId: "b", signal: undefined }),
      ],
    });
    expect(boardIsEmpty(board)).toBe(true);
  });

  it("orders a column most-recently-active first", () => {
    const board = buildAgentBoard({
      now: NOW,
      showIdle: false,
      sessions: [
        session({ tabId: "old", signal: "waiting", lastActivityAt: NOW - 5000 }),
        session({ tabId: "new", signal: "waiting", lastActivityAt: NOW - 10 }),
      ],
    });
    expect(board.needsYou.map((s) => s.tabId)).toEqual(["new", "old"]);
  });

  it("is empty for no sessions at all", () => {
    expect(boardIsEmpty(buildAgentBoard({ sessions: [], now: NOW, showIdle: true }))).toBe(true);
  });
});

/// A guard on the coupling the module's header promises: the board reads the
/// one vocabulary and does not invent a parallel one.
describe("the vocabulary coupling", () => {
  it("assigns every agent-reachable signal to a column", () => {
    const agentReachable: ActivitySignal[] = [
      "waiting",
      "working",
      "running",
      "finished",
      "failed",
      "notify",
      "idle",
    ];
    for (const signal of agentReachable) {
      expect(columnForSignal(signal), signal).not.toBeNull();
    }
  });
});
