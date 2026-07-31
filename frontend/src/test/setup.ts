/// Setup for the **render** project only (`.test.tsx` in jsdom). The unit
/// project never loads this file.
///
/// Two jobs: the jsdom gaps that would otherwise be a bug once per test file
/// instead of once here, and the Tauri boundary.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, vi } from "vitest";

/// The Tauri boundary, faked for every render test at once.
///
/// These live here rather than in each test file because `vi.mock` is hoisted
/// to the top of whatever module it appears in — declaring them once in the
/// setup means a test file that mounts something needs no `vi.mock` at all, and
/// the seam sits at the process boundary rather than at whichever `@/api/*`
/// module the author happened to think of. See `./tauri.ts` for the argument
/// and the usage.
///
/// The factories are async and import lazily: hoisting puts them above every
/// import in this file, so a top-level `import { fakeInvoke }` would not be
/// initialised yet when the factory runs.
vi.mock("@tauri-apps/api/core", async () => {
  const { fakeInvoke, MockChannel } = await import("./tauri");
  return { invoke: fakeInvoke, Channel: MockChannel };
});

vi.mock("@tauri-apps/api/event", async () => {
  const { fakeListen, fakeEmit } = await import("./tauri");
  return { listen: fakeListen, emit: fakeEmit, once: fakeListen };
});

vi.mock("@tauri-apps/api/window", async () => {
  const { fakeCurrentWindow } = await import("./tauri");
  return { getCurrentWindow: fakeCurrentWindow };
});

vi.mock("@tauri-apps/api/webview", async () => {
  const { fakeCurrentWindow } = await import("./tauri");
  return { getCurrentWebview: fakeCurrentWindow };
});

/// Handlers, recorded calls and listeners are per-test. A leak here shows up as
/// a *different* test failing, which is the worst kind of failure to read.
afterEach(async () => {
  const { resetTauri } = await import("./tauri");
  resetTauri();
});

/// Unmount between tests. `@solidjs/testing-library` only does this itself when
/// `globals: true`, which this config does not set — an explicit import is
/// worth more than the two characters it saves, and a leaked mount shows up as
/// a *different* test failing.
afterEach(cleanup);

/// jsdom implements neither of these, and both are called by code paths that
/// have nothing to do with what a test is asserting: `matchMedia` by every
/// reduced-motion check, `ResizeObserver` by anything measuring a pane.
/// Unstubbed, they throw during mount and the failure names the wrong thing.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver;
}

/// `scrollIntoView` is unimplemented in jsdom and is called by every list that
/// keeps a cursor visible.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
