import { describe, expect, it } from "vitest";
import { createOverlay, isOverlayOpen, setOverlayOpen } from "./overlay";

// Each test mints its own keys (via a counter) rather than reusing "a"/"b"
// across tests — `openKeys` is module-level shared state, so a leaked
// registration from one test would corrupt the next one's baseline.
let nextKey = 0;
const freshKey = (label: string) => `${label}-${nextKey++}`;

describe("setOverlayOpen / isOverlayOpen — the low-level primitive", () => {
  it("is closed with nothing registered", () => {
    // Not a global assertion (other suites may run in the same module
    // instance) — just that opening nothing does not flip it true.
    const key = freshKey("solo");
    expect(isOverlayOpen()).toBe(false);
    setOverlayOpen(key, true);
    expect(isOverlayOpen()).toBe(true);
    setOverlayOpen(key, false);
  });

  it("stacks: the last overlay to close is the one that reopens the browser", () => {
    const a = freshKey("stack-a");
    const b = freshKey("stack-b");
    setOverlayOpen(a, true);
    setOverlayOpen(b, true);
    expect(isOverlayOpen()).toBe(true);

    setOverlayOpen(a, false);
    // b is still open — the palette closing must not resurface the browser
    // out from under a switcher it opened.
    expect(isOverlayOpen()).toBe(true);

    setOverlayOpen(b, false);
    expect(isOverlayOpen()).toBe(false);
  });

  it("is idempotent: repeating the same value is a no-op on the count", () => {
    const key = freshKey("idempotent");
    setOverlayOpen(key, true);
    setOverlayOpen(key, true);
    setOverlayOpen(key, true);
    expect(isOverlayOpen()).toBe(true);

    // One close, not three, undoes it — proving the three `true` calls above
    // did not triple-register the key.
    setOverlayOpen(key, false);
    expect(isOverlayOpen()).toBe(false);
  });

  it("closing a key that was never opened does not go negative", () => {
    const key = freshKey("never-opened");
    setOverlayOpen(key, false);
    expect(isOverlayOpen()).toBe(false);
  });

  it("supports mount/cleanup-style registration (the BrainOverlay shape)", () => {
    // A surface that registers on mount and deregisters on cleanup — this is
    // the low-level call BrainOverlay makes directly, without `createOverlay`,
    // because its own open/closed state is "is this component mounted", not a
    // boolean signal to wrap.
    const key = freshKey("mount-style");
    const other = freshKey("mount-style-sibling");
    setOverlayOpen(other, true); // something else is already up

    const mount = () => setOverlayOpen(key, true);
    const cleanup = () => setOverlayOpen(key, false);

    mount();
    expect(isOverlayOpen()).toBe(true);
    cleanup();
    // The sibling is still open, so the count must not have hit zero.
    expect(isOverlayOpen()).toBe(true);

    setOverlayOpen(other, false);
    expect(isOverlayOpen()).toBe(false);
  });
});

describe("createOverlay — the registered-by-construction primitive", () => {
  it("starts closed and tracks its own isOpen", () => {
    const overlay = createOverlay(freshKey("basic"));
    expect(overlay.isOpen()).toBe(false);
    overlay.open();
    expect(overlay.isOpen()).toBe(true);
    overlay.close();
    expect(overlay.isOpen()).toBe(false);
  });

  it("open()/close() register with the shared overlay count", () => {
    const overlay = createOverlay(freshKey("registers"));
    overlay.open();
    expect(isOverlayOpen()).toBe(true);
    overlay.close();
    expect(isOverlayOpen()).toBe(false);
  });

  it("toggle() flips both isOpen and the shared count", () => {
    const overlay = createOverlay(freshKey("toggle"));
    overlay.toggle();
    expect(overlay.isOpen()).toBe(true);
    expect(isOverlayOpen()).toBe(true);
    overlay.toggle();
    expect(overlay.isOpen()).toBe(false);
    expect(isOverlayOpen()).toBe(false);
  });

  it("set() is the escape hatch toggle()/open()/close() are built on", () => {
    const overlay = createOverlay(freshKey("set"));
    overlay.set(true);
    expect(overlay.isOpen()).toBe(true);
    overlay.set(false);
    expect(overlay.isOpen()).toBe(false);
  });

  it("two independent overlays stack like two hand-registered keys would", () => {
    const palette = createOverlay(freshKey("palette"));
    const finder = createOverlay(freshKey("finder"));

    palette.open();
    finder.open();
    expect(isOverlayOpen()).toBe(true);

    palette.close();
    // finder is still up — the count must reflect the surface that is
    // actually still on screen, not just "something closed."
    expect(isOverlayOpen()).toBe(true);
    expect(finder.isOpen()).toBe(true);

    finder.close();
    expect(isOverlayOpen()).toBe(false);
  });

  it("re-opening after close is idempotent the same way the low-level call is", () => {
    const overlay = createOverlay(freshKey("reopen"));
    overlay.open();
    overlay.open();
    expect(isOverlayOpen()).toBe(true);
    overlay.close();
    expect(isOverlayOpen()).toBe(false);
  });
});
