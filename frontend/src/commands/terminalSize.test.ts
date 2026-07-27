import { describe, expect, it, beforeEach, vi } from "vitest";

// The suite runs in the `node` environment (see vitest.config.ts) — a
// deliberate choice there, so rather than pull in a DOM we hand this one
// module the one browser API it uses. The module itself treats a missing or
// throwing localStorage as "no stored guess", so this shim is for exercising
// the persistence path, not for making the module work.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

/// The module reads localStorage at import time, so each case re-imports it
/// with the storage already staged.
async function freshModule() {
  vi.resetModules();
  return import("./terminalSize");
}

beforeEach(() => {
  localStorage.clear();
});

describe("terminalSize", () => {
  it("has no pane guess before any terminal has reported one", async () => {
    const { lastGridSize, sizeForPty } = await freshModule();
    expect(lastGridSize()).toBeNull();
    expect(sizeForPty("pty-1")).toBeNull();
  });

  it("records a size per PTY and as the pane guess", async () => {
    const { rememberGridSize, lastGridSize, sizeForPty } = await freshModule();
    rememberGridSize("pty-1", 177, 50);
    expect(sizeForPty("pty-1")).toEqual({ cols: 177, rows: 50 });
    expect(lastGridSize()).toEqual({ cols: 177, rows: 50 });
    // A second PTY doesn't disturb the first — the map is what makes a
    // remounted pane adopt *its own* shell's winsize rather than a neighbour's.
    rememberGridSize("pty-2", 80, 24);
    expect(sizeForPty("pty-1")).toEqual({ cols: 177, rows: 50 });
    expect(lastGridSize()).toEqual({ cols: 80, rows: 24 });
  });

  it("ignores sizes a PTY could never have", async () => {
    const { rememberGridSize, lastGridSize } = await freshModule();
    rememberGridSize("pty-1", 0, 24);
    rememberGridSize("pty-1", -5, 24);
    rememberGridSize("pty-1", 80, 0);
    rememberGridSize("pty-1", 80.5, 24);
    expect(lastGridSize()).toBeNull();
  });

  it("forgets a dead PTY without dropping the pane guess", async () => {
    const { rememberGridSize, forgetPtySize, lastGridSize, sizeForPty } = await freshModule();
    rememberGridSize("pty-1", 120, 40);
    forgetPtySize("pty-1");
    expect(sizeForPty("pty-1")).toBeNull();
    // Still the best guess for the *next* pane, which is the whole reason the
    // spawn-time seed exists.
    expect(lastGridSize()).toEqual({ cols: 120, rows: 40 });
  });

  it("restores the pane guess after a restart", async () => {
    const first = await freshModule();
    first.rememberGridSize("pty-1", 160, 45);

    // Cold launch: the first terminal and every restored session are spawned
    // before any pane mounts, so an in-memory-only guess would be null exactly
    // when it matters most.
    const second = await freshModule();
    expect(second.lastGridSize()).toEqual({ cols: 160, rows: 45 });
    // Sizes are per-run facts about live shells; those must not come back.
    expect(second.sizeForPty("pty-1")).toBeNull();
  });

  it("ignores a corrupted stored guess", async () => {
    localStorage.setItem("voidlink-terminal-grid", '{"cols":"wide","rows":null}');
    expect((await freshModule()).lastGridSize()).toBeNull();
    localStorage.setItem("voidlink-terminal-grid", "not json");
    expect((await freshModule()).lastGridSize()).toBeNull();
  });
});
