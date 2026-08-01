/// The observables behind the terminal LED, tested without a PTY.
///
/// The first two exist because `busy` — `tcgetpgrp(master_fd) != shell_pid` —
/// answers the wrong question. It is true for the entire lifetime of any TUI, so
/// it cannot tell "claude is thinking" from "claude is open", and it is sampled
/// on a 1500ms poll, so it cannot tell a real command from a tick-straddling
/// `ls`.
///
/// The third is shell integration, which exists because the poll cannot answer
/// the question at all: it sees a foreground process go away and never how it
/// went, so `failed` was unreachable from a terminal until the shell started
/// saying `$?` out loud. Those tests end at the parser — a test runner cannot
/// drive a real zsh, so that the shell emits the marks at the right moments is
/// the snippets' claim (`shell-integration/`), not this file's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

/// The two transports are stubbed; nothing under test is. The PTY poll is the
/// *input* to the rules being exercised (an integrated shell has to be able to
/// go busy and idle for the stand-down rule to mean anything), and the journal
/// is the output side whose contents these tests assert on.
const processInfo = vi.fn<(id: string) => Promise<PtyProcessInfo>>();
const appended: { kind: string; summary: string; data?: unknown }[] = [];

vi.mock("@/api/terminal", () => ({
  terminalApi: { processInfo: (id: string) => processInfo(id) },
}));

vi.mock("@/api/journal", () => ({
  JOURNAL_APPENDED_EVENT: "voidlink://journal-appended",
  journalApi: {
    append: (events: { kind: string; summary: string; data?: unknown }[]) => {
      appended.push(...events);
      return Promise.resolve();
    },
    registerRepos: () => Promise.resolve(),
  },
}));

import type { PtyProcessInfo } from "@/api/terminal";
import { resetActivity, signalsOf } from "@/store/activity";
import { flushJournal, resetJournal } from "@/store/journal";
import {
  completionIsNews,
  noteSemanticPrompt,
  noteTerminalAltScreen,
  noteTerminalOutput,
  resetTerminalWatchers,
  shellsWithIntegration,
  terminalIsIntegrated,
  terminalOutputActive,
  watchTerminal,
} from "./terminalWatch";

const PTY = "pty-1";
const TAB = "tab-1";

const idle: PtyProcessInfo = { pid: null, name: null, cwd: null, busy: false };
const busy = (name: string, pid = 42): PtyProcessInfo => ({
  pid,
  name,
  cwd: null,
  busy: true,
});

beforeEach(() => {
  vi.useFakeTimers();
  resetTerminalWatchers();
  resetActivity();
  // The journal's queue is module-level and batched on a trailing window, so a
  // test that recorded without flushing would otherwise leave its events for
  // the next one to find.
  resetJournal();
  appended.length = 0;
  processInfo.mockReset();
  processInfo.mockResolvedValue(idle);
});

afterEach(() => {
  resetTerminalWatchers();
  vi.useRealTimers();
});

/// Run `body` with a shell being watched against `TAB`, and dispose after.
/// `watchTerminal` needs a reactive owner — it releases the poll on cleanup.
async function withWatchedShell(body: () => Promise<void> | void): Promise<void> {
  let dispose = () => {};
  createRoot((d) => {
    dispose = d;
    watchTerminal(TAB, PTY);
  });
  try {
    await body();
  } finally {
    dispose();
  }
}

/// Everything the journal was handed, after the batching window drains.
async function journal() {
  flushJournal();
  await Promise.resolve();
  return appended;
}

describe("the output-rate window", () => {
  it("starts silent", () => {
    expect(terminalOutputActive(PTY)).toBe(false);
  });

  it("goes active once enough bytes land inside the window", () => {
    // One chunk over the threshold is the `yes | head -c 1000000` case.
    noteTerminalOutput(PTY, 4096);
    expect(terminalOutputActive(PTY)).toBe(true);
  });

  it("accumulates several small chunks inside the window", () => {
    // A progress spinner: a few dozen bytes at a time, well over the threshold
    // across half a second.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(40);
      noteTerminalOutput(PTY, 40);
    }
    expect(terminalOutputActive(PTY)).toBe(true);
  });

  /// The case the whole thing exists for: a TUI sitting at its prompt. A cursor
  /// blink or an echoed keystroke every few seconds is not work.
  it("stays silent for a trickle spread across many windows", () => {
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(900);
      noteTerminalOutput(PTY, 8);
    }
    expect(terminalOutputActive(PTY)).toBe(false);
  });

  it("flips back to idle after the silence threshold", () => {
    noteTerminalOutput(PTY, 4096);
    expect(terminalOutputActive(PTY)).toBe(true);

    // Just under the deadline: still working.
    vi.advanceTimersByTime(1400);
    expect(terminalOutputActive(PTY)).toBe(true);

    vi.advanceTimersByTime(200);
    expect(terminalOutputActive(PTY)).toBe(false);
  });

  it("postpones the silence deadline on any output, including a trickle", () => {
    noteTerminalOutput(PTY, 4096);
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(1000);
      // Below the rate threshold, so it could not *start* working — but it is
      // not silence either, and treating it as silence would make a slow build
      // flicker between working and idle.
      noteTerminalOutput(PTY, 4);
      expect(terminalOutputActive(PTY)).toBe(true);
    }
    vi.advanceTimersByTime(1600);
    expect(terminalOutputActive(PTY)).toBe(false);
  });

  it("keeps shells independent", () => {
    noteTerminalOutput(PTY, 4096);
    expect(terminalOutputActive("pty-2")).toBe(false);
    expect(terminalOutputActive(PTY)).toBe(true);
  });
});

describe("busy-edge hysteresis", () => {
  /// A 20ms command that happens to straddle a poll tick is seen busy exactly
  /// once. It used to be badged "finished" for a full interval — a badge to
  /// dismiss for something the user never waited for.
  it("suppresses a command seen on only one poll", () => {
    expect(completionIsNews({ samples: 1, wasFullScreen: false })).toBe(false);
  });

  it("reports a command seen across two or more polls", () => {
    expect(completionIsNews({ samples: 2, wasFullScreen: false })).toBe(true);
    expect(completionIsNews({ samples: 12, wasFullScreen: false })).toBe(true);
  });

  /// Quitting `vim` while unfocused used to raise a green "finished" mark. You
  /// closed an editor; nothing completed. The alternate screen buffer is how we
  /// know it was a full-screen app rather than a command.
  it("never reports a full-screen app exiting, however long it ran", () => {
    expect(completionIsNews({ samples: 400, wasFullScreen: true })).toBe(false);
  });

  it("reports nothing for a span with no samples at all", () => {
    expect(completionIsNews({ samples: 0, wasFullScreen: false })).toBe(false);
  });
});

/// The hole this closes: a command that fails *inside* a live shell. The poll
/// below sees a foreground process go away and nothing else, so before shell
/// integration `noteFinished(tabId, true)` was hardcoded and `failed` — the top
/// of §7.5.3's precedence chain — was unreachable from a terminal.
///
/// What these prove is the mapping from a mark to a signal. What they cannot
/// prove is that a real zsh emits the mark; that is `shell-integration/`'s job.
describe("shell integration", () => {
  /// Runs a command that takes `durationMs` and ends with `exitCode`, the way
  /// an integrated shell reports it.
  function runCommand(durationMs: number, exitCode: number | null) {
    noteSemanticPrompt(PTY, { kind: "command-start" });
    vi.advanceTimersByTime(durationMs);
    noteSemanticPrompt(PTY, { kind: "command-end", exitCode });
  }

  it("raises `failed` for a non-zero exit — the whole point", async () => {
    await withWatchedShell(() => {
      runCommand(40_000, 101);
      expect(signalsOf(TAB)).toContain("failed");
    });
  });

  it("raises `notify`, not `failed`, for a clean exit the user missed", async () => {
    await withWatchedShell(() => {
      runCommand(40_000, 0);
      expect(signalsOf(TAB)).toEqual(["notify"]);
    });
  });

  /// An unknown status is the pre-integration state of the world. It must land
  /// exactly where the poll's statusless completion already landed, and nowhere
  /// near the red mark.
  it("treats a bare D as a completion, never as a failure", async () => {
    await withWatchedShell(() => {
      runCommand(40_000, null);
      expect(signalsOf(TAB)).toEqual(["notify"]);
    });
  });

  it("clears `working` when the command ends", async () => {
    await withWatchedShell(() => {
      noteTerminalOutput(PTY, 8192);
      runCommand(40_000, 1);
      expect(signalsOf(TAB)).not.toContain("working");
    });
  });

  it("says nothing about a command nobody waited for", async () => {
    await withWatchedShell(async () => {
      // A `grep` that found nothing. Exits 1, in five milliseconds.
      runCommand(5, 1);
      expect(signalsOf(TAB)).toEqual([]);
      expect(await journal()).toEqual([]);
    });
  });

  /// We attached mid-command — a pane rebuilt after a worktree switch, or the
  /// replay gate opening between `C` and `D`.
  it("says nothing about a D it has no C for", async () => {
    await withWatchedShell(async () => {
      noteSemanticPrompt(PTY, { kind: "command-end", exitCode: 1 });
      expect(signalsOf(TAB)).toEqual([]);
      expect(await journal()).toEqual([]);
    });
  });

  /// `:cq` — the deliberate way to leave vim with a non-zero status. Without
  /// this it would raise the one signal that cannot be dismissed by looking.
  it("never reports a full-screen app exiting, however it exited", async () => {
    await withWatchedShell(() => {
      noteSemanticPrompt(PTY, { kind: "command-start" });
      noteTerminalAltScreen(PTY, true);
      vi.advanceTimersByTime(600_000);
      noteTerminalAltScreen(PTY, false);
      noteSemanticPrompt(PTY, { kind: "command-end", exitCode: 1 });
      expect(signalsOf(TAB)).toEqual([]);
    });
  });

  it("records the failure in the log, with the status", async () => {
    await withWatchedShell(async () => {
      runCommand(40_000, 101);
      const events = await journal();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("terminal.command.failed");
      expect(events[0].summary).toContain("exit 101");
      expect(events[0].data).toMatchObject({ exitCode: 101, durationMs: 40_000 });
    });
  });

  it("records a clean run under the finished kind", async () => {
    await withWatchedShell(async () => {
      runCommand(40_000, 0);
      const events = await journal();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("terminal.command.finished");
    });
  });

  /// `D` carries a status and nothing else — the command's *name* is still the
  /// poll's to know, which is why the two sources cooperate rather than one
  /// replacing the other.
  it("names the command from what the poll saw running", async () => {
    await withWatchedShell(async () => {
      noteSemanticPrompt(PTY, { kind: "command-start" });
      processInfo.mockResolvedValue(busy("cargo"));
      await vi.advanceTimersByTimeAsync(40_000);
      noteSemanticPrompt(PTY, { kind: "command-end", exitCode: 101 });
      const events = await journal();
      expect(events[0].summary).toBe("cargo failed (exit 101)");
      expect(events[0].data).toMatchObject({ process: "cargo" });
    });
  });

  /// The two clocks are independent: the poll can sample idle in the gap
  /// between the command exiting and the shell writing its `D`. Losing the name
  /// there would leave the record saying "a command failed" for something we
  /// knew the name of one tick earlier.
  it("keeps the name when the poll sees idle before the shell reports", async () => {
    await withWatchedShell(async () => {
      noteSemanticPrompt(PTY, { kind: "command-start" });
      processInfo.mockResolvedValue(busy("cargo"));
      await vi.advanceTimersByTimeAsync(40_000);
      // The process is gone and the poll notices first.
      processInfo.mockResolvedValue(idle);
      await vi.advanceTimersByTimeAsync(1600);
      noteSemanticPrompt(PTY, { kind: "command-end", exitCode: 101 });
      const events = await journal();
      expect(events[0].summary).toBe("cargo failed (exit 101)");
    });
  });

  it("only counts shells that have actually emitted a mark", async () => {
    expect(terminalIsIntegrated(PTY)).toBe(false);
    expect(shellsWithIntegration()).toBe(0);
    await withWatchedShell(() => {
      // The cheapest possible evidence: a prompt was drawn.
      noteSemanticPrompt(PTY, { kind: "prompt-start" });
      expect(terminalIsIntegrated(PTY)).toBe(true);
      expect(shellsWithIntegration()).toBe(1);
    });
    // The shell went away with the pane.
    expect(shellsWithIntegration()).toBe(0);
  });
});

/// The two sources must never both report one command. The badge would survive
/// it — `failed` outranks `notify` — but the log would carry a
/// `terminal.command.failed` and a `terminal.command.finished` for one
/// `cargo build`, and the notifier would fire two banners saying opposite
/// things.
describe("who owns the completion", () => {
  /// Drive the poll through a busy span long enough to clear its hysteresis,
  /// then back to idle.
  async function pollThroughACommand() {
    processInfo.mockResolvedValue(busy("cargo"));
    await vi.advanceTimersByTimeAsync(5000);
    processInfo.mockResolvedValue(idle);
    await vi.advanceTimersByTimeAsync(2000);
  }

  it("is the poll, in a shell with no integration — unchanged", async () => {
    await withWatchedShell(async () => {
      await pollThroughACommand();
      // Statusless, so the only claim available is that it finished.
      expect(signalsOf(TAB)).toEqual(["notify"]);
      const events = await journal();
      expect(events.map((e) => e.kind)).toEqual(["terminal.command.finished"]);
    });
  });

  it("is the shell, once it has proved it emits marks", async () => {
    await withWatchedShell(async () => {
      noteSemanticPrompt(PTY, { kind: "prompt-start" });
      await pollThroughACommand();
      // The poll watched the same span go by and stood down: no second event,
      // and no `notify` for a command whose real status it never saw.
      expect(signalsOf(TAB)).toEqual([]);
      expect(await journal()).toEqual([]);
    });
  });

  it("still lets the poll turn `working` off in an integrated shell", async () => {
    await withWatchedShell(async () => {
      noteSemanticPrompt(PTY, { kind: "prompt-start" });
      processInfo.mockResolvedValue(busy("cargo"));
      await vi.advanceTimersByTimeAsync(1500);
      noteTerminalOutput(PTY, 8192);
      expect(signalsOf(TAB)).toContain("working");

      processInfo.mockResolvedValue(idle);
      await vi.advanceTimersByTimeAsync(2000);
      expect(signalsOf(TAB)).not.toContain("working");
    });
  });
});
