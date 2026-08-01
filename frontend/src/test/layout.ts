/// A fake layout engine, for the surfaces that need one.
///
/// jsdom computes no geometry: every `getBoundingClientRect()` is a box of
/// zeroes and every `clientHeight` is 0. That is fine for most components and
/// fatal for the virtualized ones — `@tanstack/solid-virtual` asks the scroll
/// element how tall it is, is told zero, and renders no rows at all. The
/// component is not broken; the environment cannot answer the question it asks.
///
/// This is the documented gap that the Vitest **browser** project (track A1) is
/// meant to close properly, by running against a real engine. Until then a test
/// that needs rows can opt into these stubs. **Opt-in, never global**: giving
/// every element a nonzero height app-wide would paper over real bugs in
/// components that legitimately measure themselves, and the failure would then
/// show up somewhere else entirely.
///
/// What this does *not* do is make geometry assertions meaningful. Positions
/// here are arithmetic over numbers this file invented. Assert on *which rows
/// exist*, never on where they landed.
import { afterEach, beforeEach, vi } from "vitest";

export interface FakeViewport {
  width?: number;
  height?: number;
}

/// Call inside a `describe`: every test in it measures `width × height`, every
/// test outside it still measures zero.
///
/// Installed per-test rather than once, because the teardown has to run per-test
/// too — a single install with an `afterEach` restore would hold for the first
/// test in the block and silently stop applying to the rest, which reads as
/// "virtualized rows render once and then never again".
export function stubLayout(viewport: FakeViewport = {}) {
  beforeEach(() => {
    const restore = applyLayout(viewport);
    afterEach(restore);
  });
}

/// The one-shot form, for a single test that needs geometry. Returns its own
/// undo.
export function applyLayout(viewport: FakeViewport = {}) {
  const width = viewport.width ?? 800;
  const height = viewport.height ?? 600;

  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });

  const props: Array<[string, number]> = [
    ["clientHeight", height],
    ["clientWidth", width],
    ["offsetHeight", height],
    ["offsetWidth", width],
  ];
  const saved = props.map(([name]) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    return [name, descriptor] as const;
  });
  for (const [name, value] of props) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => value,
    });
  }

  return () => {
    rect.mockRestore();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  };
}
