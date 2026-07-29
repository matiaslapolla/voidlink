/// The two new observables behind the terminal LED, tested without a PTY.
///
/// Both exist because `busy` — `tcgetpgrp(master_fd) != shell_pid` — answers the
/// wrong question. It is true for the entire lifetime of any TUI, so it cannot
/// tell "claude is thinking" from "claude is open", and it is sampled on a
/// 1500ms poll, so it cannot tell a real command from a tick-straddling `ls`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completionIsNews,
  noteTerminalOutput,
  resetTerminalWatchers,
  terminalOutputActive,
} from "./terminalWatch";

const PTY = "pty-1";

beforeEach(() => {
  vi.useFakeTimers();
  resetTerminalWatchers();
});

afterEach(() => {
  resetTerminalWatchers();
  vi.useRealTimers();
});

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
