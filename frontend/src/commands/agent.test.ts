/// The per-turn busy/cancel/retry state machine.
///
/// Busy used to be one module-level boolean, which with a single slide-over was
/// invisible and with N agent tabs is simply wrong: one thread thinking blocked
/// every other thread from being asked anything. The invariant this file pins
/// down is that `(worktree, tab)` is the unit of everything — busy, the turn id
/// cancel needs, and the trailing turn retry replaces — so the interesting cases
/// are all about one pair not disturbing another.
///
/// The transport, the git commands and the roster are stubbed. What is under
/// test is the bookkeeping, not the prompt: `assembleContext` has its own
/// grounding contract and every git call it makes is already `try`-guarded, so
/// stubbing them to reject exercises the same path a repo-less worktree takes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamQuery = vi.fn();
const cancelTurn = vi.fn();

vi.mock("@/api/agent", () => ({
  agentApi: {
    streamQuery: (opts: unknown) => streamQuery(opts),
    cancelTurn: (turnId: string) => cancelTurn(turnId),
  },
}));

/// Every context source rejects, so `assembleContext` folds in nothing and the
/// prompt is just the question. Its audit list is then empty, which is why the
/// assertions below never look at one.
vi.mock("@/api/git", () => ({
  gitApi: {
    repoInfo: () => Promise.reject(new Error("stub")),
    fileStatus: () => Promise.reject(new Error("stub")),
    log: () => Promise.reject(new Error("stub")),
    diffWorking: () => Promise.reject(new Error("stub")),
  },
}));

vi.mock("@/store/settings", () => ({ aiSecretBindings: () => [] }));

vi.mock("@/store/activity", () => ({
  noteRunning: vi.fn(),
  noteFinished: vi.fn(),
}));

import {
  agentBusy,
  agentRetryable,
  agentThread,
  askAgent,
  cancelAgentTurn,
  clearAgentThread,
  dropAgentThread,
  parseThreads,
  retryAgentTurn,
} from "./agent";

const WT = "wt-1";
const A = "tab-a";
const B = "tab-b";

const ask = (tabId: string, question: string) =>
  askAgent({
    wtId: WT,
    tabId,
    repoPath: "/repo",
    commandTemplate: "claude -p",
    question,
    openFiles: [],
    activePath: null,
  });

const retry = (tabId: string) =>
  retryAgentTurn({
    wtId: WT,
    tabId,
    repoPath: "/repo",
    commandTemplate: "claude -p",
    openFiles: [],
    activePath: null,
  });

/// A turn the test can settle by hand, so "in flight" is a state the assertions
/// can stand in rather than a race to win.
function deferredTurn() {
  let resolve!: (v: { cancelled: boolean; exitCode: number | null }) => void;
  let reject!: (e: unknown) => void;
  let emit!: (text: string) => void;
  let turnId = "";
  const started = new Promise<void>((ready) => {
    streamQuery.mockImplementationOnce((opts: {
      turnId: string;
      onChunk: (t: string) => void;
    }) => {
      turnId = opts.turnId;
      emit = opts.onChunk;
      ready();
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    });
  });
  return {
    started,
    emit: (text: string) => emit(text),
    turnId: () => turnId,
    finish: () => resolve({ cancelled: false, exitCode: 0 }),
    cancelled: () => resolve({ cancelled: true, exitCode: 143 }),
    fail: (message: string) => reject(new Error(message)),
  };
}

beforeEach(() => {
  streamQuery.mockReset();
  cancelTurn.mockReset();
  cancelTurn.mockResolvedValue(true);
  clearAgentThread(WT, A);
  clearAgentThread(WT, B);
});

afterEach(() => {
  dropAgentThread(WT, A);
  dropAgentThread(WT, B);
});

describe("a turn in flight", () => {
  it("marks only its own thread busy", async () => {
    const turn = deferredTurn();
    const running = ask(A, "what changed?");
    await turn.started;

    expect(agentBusy(WT, A)).toBe(true);
    expect(agentBusy(WT, B)).toBe(false);

    turn.finish();
    await running;
    expect(agentBusy(WT, A)).toBe(false);
  });

  it("does not stop another thread from being asked", async () => {
    const first = deferredTurn();
    const firstRunning = ask(A, "first");
    await first.started;

    const second = deferredTurn();
    const secondRunning = ask(B, "second");
    await second.started;

    expect(agentBusy(WT, A)).toBe(true);
    expect(agentBusy(WT, B)).toBe(true);
    expect(streamQuery).toHaveBeenCalledTimes(2);

    second.finish();
    await secondRunning;
    // The second thread settling leaves the first exactly where it was.
    expect(agentBusy(WT, B)).toBe(false);
    expect(agentBusy(WT, A)).toBe(true);

    first.finish();
    await firstRunning;
  });

  it("refuses a second question on the same thread", async () => {
    const turn = deferredTurn();
    const running = ask(A, "first");
    await turn.started;

    await ask(A, "second");
    expect(streamQuery).toHaveBeenCalledTimes(1);
    // The refused question is not pushed either: a message with no turn behind
    // it would sit in the thread forever looking like it had been asked.
    expect(agentThread(WT, A).filter((m) => m.role === "user")).toHaveLength(1);

    turn.finish();
    await running;
  });

  it("grows the assistant message in place as chunks land", async () => {
    const turn = deferredTurn();
    const running = ask(A, "summarize");
    await turn.started;

    // The bubble exists before the first chunk, so the pending state has
    // somewhere to live.
    expect(agentThread(WT, A).at(-1)).toMatchObject({
      role: "assistant",
      content: "",
      status: "streaming",
    });

    turn.emit("Two ");
    expect(agentThread(WT, A).at(-1)?.content).toBe("Two ");
    turn.emit("files changed.");
    expect(agentThread(WT, A).at(-1)?.content).toBe("Two files changed.");
    // One turn, not one message per chunk.
    expect(agentThread(WT, A)).toHaveLength(2);

    turn.finish();
    await running;
    expect(agentThread(WT, A).at(-1)).toMatchObject({
      content: "Two files changed.",
      status: "done",
    });
  });
});

describe("cancel", () => {
  it("kills the turn by id and clears busy for that thread only", async () => {
    const first = deferredTurn();
    const firstRunning = ask(A, "long one");
    await first.started;
    const second = deferredTurn();
    const secondRunning = ask(B, "other one");
    await second.started;

    await cancelAgentTurn(WT, A);
    expect(cancelTurn).toHaveBeenCalledWith(first.turnId());
    expect(cancelTurn).toHaveBeenCalledTimes(1);

    // Rust resolves the turn as a *success* with `cancelled: true`; the busy
    // flag clears on that, not on the cancel call.
    first.cancelled();
    await firstRunning;
    expect(agentBusy(WT, A)).toBe(false);
    expect(agentBusy(WT, B)).toBe(true);

    second.finish();
    await secondRunning;
  });

  it("keeps the partial answer and marks it cancelled", async () => {
    const turn = deferredTurn();
    const running = ask(A, "long one");
    await turn.started;
    turn.emit("Half an ans");

    await cancelAgentTurn(WT, A);
    turn.cancelled();
    await running;

    expect(agentThread(WT, A).at(-1)).toMatchObject({
      role: "assistant",
      content: "Half an ans",
      status: "cancelled",
    });
    expect(agentRetryable(WT, A)).toBe(true);
  });

  it("is a no-op on a thread with nothing in flight", async () => {
    await cancelAgentTurn(WT, A);
    expect(cancelTurn).not.toHaveBeenCalled();
  });
});

describe("retry", () => {
  it("drops exactly the failed turn and re-sends the same question", async () => {
    const first = deferredTurn();
    const firstRunning = ask(A, "which commit introduced X?");
    await first.started;
    first.fail("claude: command not found");
    await firstRunning;

    expect(agentThread(WT, A).at(-1)).toMatchObject({
      role: "error",
      status: "failed",
    });
    expect(agentRetryable(WT, A)).toBe(true);

    const second = deferredTurn();
    const secondRunning = retry(A);
    await second.started;

    // The user message stays; the failed turn is gone and replaced by the new
    // one, so the thread is still one question and one answer.
    const thread = agentThread(WT, A);
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({
      role: "user",
      content: "which commit introduced X?",
    });
    expect(thread[1]).toMatchObject({ role: "assistant", status: "streaming" });

    second.emit("Commit deadbeef.");
    second.finish();
    await secondRunning;
    expect(agentRetryable(WT, A)).toBe(false);
  });

  it("reassembles context rather than reusing the failed turn's prompt", async () => {
    const first = deferredTurn();
    const firstRunning = ask(A, "status?");
    await first.started;
    first.fail("boom");
    await firstRunning;

    const second = deferredTurn();
    const secondRunning = retry(A);
    await second.started;
    second.emit("Clean.");
    second.finish();
    await secondRunning;

    // Two independent invocations, each with its own turn id — a retry that
    // reused the first turn's id could not be cancelled.
    expect(streamQuery).toHaveBeenCalledTimes(2);
    const ids = streamQuery.mock.calls.map((c) => (c[0] as { turnId: string }).turnId);
    expect(new Set(ids).size).toBe(2);
  });

  it("does nothing on a thread whose last turn succeeded", async () => {
    const turn = deferredTurn();
    const running = ask(A, "fine question");
    await turn.started;
    turn.emit("An answer.");
    turn.finish();
    await running;

    expect(agentRetryable(WT, A)).toBe(false);
    await retry(A);
    expect(streamQuery).toHaveBeenCalledTimes(1);
  });

  it("does nothing while a turn is in flight", async () => {
    const turn = deferredTurn();
    const running = ask(A, "in flight");
    await turn.started;

    await retry(A);
    expect(streamQuery).toHaveBeenCalledTimes(1);

    turn.finish();
    await running;
  });
});

describe("persisted threads", () => {
  it("drops a malformed message rather than the thread", () => {
    const parsed = parseThreads({
      "wt-1": {
        "tab-a": [
          { role: "user", content: "kept" },
          { role: "wizard", content: "unknown role" },
          { role: "assistant", content: 42 },
          { role: "assistant", content: "also kept", status: "done", ms: 120 },
        ],
      },
    });
    expect(parsed["wt-1"]["tab-a"].map((m) => m.content)).toEqual(["kept", "also kept"]);
  });

  it("resolves a turn persisted mid-stream to cancelled", () => {
    const parsed = parseThreads({
      "wt-1": { "tab-a": [{ role: "assistant", content: "half", status: "streaming" }] },
    });
    // Otherwise a reloaded tab renders a pending state for a process that died
    // with the app, and Retry would never appear.
    expect(parsed["wt-1"]["tab-a"][0].status).toBe("cancelled");
  });

  it("survives a blob that is the wrong shape entirely", () => {
    expect(parseThreads(null)).toEqual({});
    expect(parseThreads("nope")).toEqual({});
    expect(parseThreads({ "wt-1": { "tab-a": "not an array" } })).toEqual({ "wt-1": {} });
  });
});
