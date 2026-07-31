/// Setup for the **render** project only (`.test.tsx` in jsdom). The unit
/// project never loads this file.
///
/// Three things, each of which is a bug that would otherwise show up once per
/// test file instead of once here.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, vi } from "vitest";

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
