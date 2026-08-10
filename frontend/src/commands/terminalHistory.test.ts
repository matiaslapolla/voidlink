import { describe, expect, it, beforeEach, vi } from "vitest";

// `repeatLastCommand` is the only export that reaches Tauri, and none of the
// cases below take that path — the buffer/recording rules are pure. Stubbed so
// importing the module cannot pull the real IPC in.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { forget, recordKeystroke, getMostRecentPtyId } from "./terminalHistory";

/// Reaches the private buffer the only way the module exposes it: type a line,
/// press Enter, and read back what was snapshotted as "last command".
async function lastCommandAfter(ptyId: string, ...inputs: string[]): Promise<string | null> {
  for (const input of inputs) recordKeystroke(ptyId, input);
  recordKeystroke(ptyId, "\r");
  const { invoke } = await import("@tauri-apps/api/core");
  const mocked = vi.mocked(invoke);
  mocked.mockClear();
  const { repeatLastCommand } = await import("./terminalHistory");
  const result = await repeatLastCommand();
  if (!result.ok) return null;
  const call = mocked.mock.calls[0]?.[1] as { data: string } | undefined;
  return call ? call.data.replace(/\r$/, "") : null;
}

beforeEach(() => {
  forget("pty-1");
});

describe("recordKeystroke", () => {
  it("records what the user typed", async () => {
    expect(await lastCommandAfter("pty-1", "git status")).toBe("git status");
  });

  it("ignores mouse-reporting sequences", async () => {
    // What lazygit / `vim -c 'set mouse=a'` / any pointer-tracking Ink app
    // sends on every pointer move. `\x1b` was already skipped by the character
    // loop, but the rest of the sequence is printable — so it used to be
    // appended to the command buffer, and a full-screen app never sends the
    // bare CR that would have reset it.
    recordKeystroke("pty-1", "npm test");
    recordKeystroke("pty-1", "\x1b[<35;40;12M");
    recordKeystroke("pty-1", "\x1b[<35;41;13M");
    expect(await lastCommandAfter("pty-1", "")).toBe("npm test");
  });

  it("ignores cursor keys and other escape-introduced input", async () => {
    recordKeystroke("pty-1", "ls");
    recordKeystroke("pty-1", "\x1b[A"); // up arrow
    recordKeystroke("pty-1", "\x1bOB"); // down arrow, application mode
    expect(await lastCommandAfter("pty-1", "")).toBe("ls");
  });

  it("caps the buffer so nothing unclassified can grow it without bound", async () => {
    // Not reachable through the ESC guard above; this is the backstop for any
    // other route that appends printable bytes forever.
    recordKeystroke("pty-1", "x".repeat(20_000));
    const recorded = await lastCommandAfter("pty-1", "");
    expect(recorded).not.toBeNull();
    expect(recorded!.length).toBeLessThanOrEqual(4096);
  });

  it("still resets on Ctrl-C and edits on backspace", async () => {
    recordKeystroke("pty-1", "rm -rf /");
    recordKeystroke("pty-1", "\x03");
    expect(await lastCommandAfter("pty-1", "echo hi")).toBe("echo hi");
    expect(await lastCommandAfter("pty-1", "abc", "\x7f")).toBe("ab");
  });

  it("tracks the most recently used pty", () => {
    recordKeystroke("pty-1", "a");
    recordKeystroke("pty-2", "b");
    expect(getMostRecentPtyId()).toBe("pty-2");
    forget("pty-2");
  });
});
