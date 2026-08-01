/// Setup for the **browser** project only (`.browser.test.tsx`, mounted in a
/// real headless Chromium). The unit and render projects never load this
/// file.
///
/// One job, not two: the Tauri boundary. `setup.ts`'s other job — stubbing
/// `matchMedia`, `ResizeObserver` and `scrollIntoView` — does not exist here.
/// Those stand in for jsdom's missing implementations; a real browser has all
/// three natively, and re-stubbing them would silently replace working
/// geometry with the same fiction this project exists to get away from.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, vi } from "vitest";

/// The real cascade. `vitest.config.ts`'s browser project loads the Tailwind
/// Vite plugin so this compiles for real, and every geometry test in this
/// project depends on it: `overflow-auto` has to actually clip, `flex-1` has
/// to actually size the scroll container, or a windowing test would measure
/// nothing meaningful.
import "@/index.css";

/// Same fake, same reasoning as the render project — see `./tauri.ts`'s
/// header. A geometry test still crosses the Tauri boundary (a commit graph
/// still calls `gitApi.commitGraph`), and forking the fake per environment is
/// exactly the kind of duplication that rots the first time one drifts from
/// the other.
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

/// Handlers, recorded calls and listeners are per-test. A leak here shows up
/// as a *different* test failing, which is the worst kind of failure to read.
afterEach(async () => {
  const { resetTauri } = await import("./tauri");
  resetTauri();
});

/// Unmount between tests. `@solidjs/testing-library` only does this itself
/// when `globals: true`, which this config does not set.
afterEach(cleanup);
