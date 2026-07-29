import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/// The module talks to `window`, and the test environment is `node`. A bare
/// EventTarget is all the surface it uses, so stub one rather than pull in a DOM.
class FakeWindow extends EventTarget {}

let emitGitRefsChanged: typeof import("./gitEvents").emitGitRefsChanged;
let emitRemoteGitRefsChanged: typeof import("./gitEvents").emitRemoteGitRefsChanged;
let onGitRefsChanged: typeof import("./gitEvents").onGitRefsChanged;
let flushGitRefsChanged: typeof import("./gitEvents").flushGitRefsChanged;
let COALESCE_MS: number;

beforeEach(async () => {
  vi.useFakeTimers();
  (globalThis as { window?: unknown }).window = new FakeWindow();
  // Fresh module per test: the coalescing timer is module state.
  vi.resetModules();
  const mod = await import("./gitEvents");
  emitGitRefsChanged = mod.emitGitRefsChanged;
  emitRemoteGitRefsChanged = mod.emitRemoteGitRefsChanged;
  onGitRefsChanged = mod.onGitRefsChanged;
  flushGitRefsChanged = mod.flushGitRefsChanged;
  COALESCE_MS = mod.GIT_REFRESH_COALESCE_MS;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe("emitGitRefsChanged", () => {
  it("collapses a burst into a single pulse", () => {
    let pulses = 0;
    const off = onGitRefsChanged(() => (pulses += 1));

    // One click legitimately emits several times: the mutation, its `finally`,
    // and the pane's own onRefresh. Each pulse fans out to ten-odd git commands.
    emitGitRefsChanged();
    emitGitRefsChanged();
    emitGitRefsChanged();
    expect(pulses).toBe(0);

    vi.advanceTimersByTime(COALESCE_MS);
    expect(pulses).toBe(1);

    off();
  });

  it("still pulses again for a later, separate mutation", () => {
    let pulses = 0;
    const off = onGitRefsChanged(() => (pulses += 1));

    emitGitRefsChanged();
    vi.advanceTimersByTime(COALESCE_MS);
    emitGitRefsChanged();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(pulses).toBe(2);

    off();
  });

  it("flush sends a pending pulse immediately and only once", () => {
    let pulses = 0;
    const off = onGitRefsChanged(() => (pulses += 1));

    emitGitRefsChanged();
    flushGitRefsChanged();
    expect(pulses).toBe(1);

    // The cancelled timer must not fire a second time.
    vi.advanceTimersByTime(COALESCE_MS * 2);
    expect(pulses).toBe(1);

    off();
  });

  it("marks a pulse that came from another window", () => {
    // The cross-window bridge re-publishes local pulses and must never
    // re-publish remote ones — that is an infinite ping-pong between windows.
    // It used to tell them apart with a latch held across a synchronous
    // dispatch, which coalescing breaks.
    const seen: boolean[] = [];
    const off = onGitRefsChanged((pulse) => seen.push(pulse.remote));

    emitRemoteGitRefsChanged();
    vi.advanceTimersByTime(COALESCE_MS);
    emitGitRefsChanged();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(seen).toEqual([true, false]);

    off();
  });

  it("treats a burst containing any local emit as local", () => {
    // A remote pulse arriving mid-burst must not stop our own mutation from
    // reaching the other windows.
    const seen: boolean[] = [];
    const off = onGitRefsChanged((pulse) => seen.push(pulse.remote));

    emitRemoteGitRefsChanged();
    emitGitRefsChanged();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(seen).toEqual([false]);

    off();
  });

  it("unsubscribing stops the handler", () => {
    let pulses = 0;
    const off = onGitRefsChanged(() => (pulses += 1));
    off();

    emitGitRefsChanged();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(pulses).toBe(0);
  });
});
