/// The window-role helpers decide which root `main.tsx` mounts and which side
/// of every cross-window protocol a module is on. They read Tauri's injected
/// metadata, which does not exist under vitest or in a plain browser — so the
/// thing worth testing is precisely that: the fallback, and that exactly one
/// role claims it.

import { afterEach, describe, expect, it, vi } from "vitest";

/// An in-memory stand-in for Tauri's event bus. Tauri delivers a global emit to
/// every window *including the sender*, so the fake does the same — that echo is
/// exactly what the `source` guard exists to drop, and a bus that quietly did
/// not deliver it would make the guard untestable.
const bus = new Map<string, Set<(e: { payload: unknown }) => void>>();

vi.mock("@tauri-apps/api/event", () => ({
  emit: async (event: string, payload?: unknown) => {
    for (const fn of [...(bus.get(event) ?? [])]) fn({ payload });
  },
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    let set = bus.get(event);
    if (!set) bus.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  },
}));

import {
  EDITOR_WINDOW_LABEL,
  GIT_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
  currentWindowLabel,
  focusEditorWindow,
  focusMainWindow,
  isEditorWindow,
  isEditorWindowOpen,
  isGitWindow,
  isGitWindowOpen,
  isMainWindow,
  isStackedRouting,
  onBlameEnabled,
  onThemeChange,
  openEditorWindow,
  openGitWindow,
  publishBlameEnabled,
  publishThemeChange,
  setStackedViewRouter,
} from "./windows";

describe("window roles outside Tauri", () => {
  it("falls back to the workbench label", () => {
    expect(currentWindowLabel()).toBe(MAIN_WINDOW_LABEL);
  });

  it("reports the workbench, and only the workbench", () => {
    expect(isMainWindow()).toBe(true);
    expect(isGitWindow()).toBe(false);
    expect(isEditorWindow()).toBe(false);
  });

  it("keeps the three labels distinct", () => {
    // These must match `src-tauri/src/window.rs`; two roles sharing a label
    // would have one window silently mounting the other's root.
    const labels = [MAIN_WINDOW_LABEL, GIT_WINDOW_LABEL, EDITOR_WINDOW_LABEL];
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/// Stacked mode has no satellite windows: the workbench hosts the other two as
/// views. Rather than have every "show the editor" call site check the mode,
/// the workbench installs a router here and these functions redirect to it — so
/// what matters is that a routed call switches views and issues no IPC at all.
/// Without a router installed they invoke, which under vitest means rejecting,
/// since there is no Tauri to answer.
describe("stacked view routing", () => {
  afterEach(() => setStackedViewRouter(null));

  function recordingRouter() {
    const calls: string[] = [];
    setStackedViewRouter({
      showWorkbench: () => calls.push("workbench"),
      showEditor: () => calls.push("editor"),
      showGit: () => calls.push("git"),
    });
    return calls;
  }

  it("reports whether a router is installed", () => {
    expect(isStackedRouting()).toBe(false);
    recordingRouter();
    expect(isStackedRouting()).toBe(true);
    setStackedViewRouter(null);
    expect(isStackedRouting()).toBe(false);
  });

  it("routes show/focus calls to the view switcher instead of invoking", async () => {
    const calls = recordingRouter();

    await expect(openEditorWindow()).resolves.toBe(true);
    await expect(openGitWindow()).resolves.toBe(true);
    await focusEditorWindow();
    await focusMainWindow();

    expect(calls).toEqual(["editor", "git", "editor", "workbench"]);
  });

  it("reports no satellite as open, so the workbench never closes itself", async () => {
    recordingRouter();
    await expect(isEditorWindowOpen()).resolves.toBe(false);
    await expect(isGitWindowOpen()).resolves.toBe(false);
  });

  it("falls back to IPC when no router is installed", async () => {
    // No Tauri under vitest, so "went to IPC" shows up as a rejection. The
    // point is that it tried, rather than silently reporting success.
    await expect(openEditorWindow()).rejects.toThrow();
  });
});

/// Theme and blame-enabled live in `localStorage` and used to propagate by
/// nothing at all: the editor window hydrated once at module eval and, because
/// it is reused rather than recreated, kept that theme for the rest of the
/// session. Switching to light in the workbench left it dark forever.
///
/// Two properties matter and both are easy to break silently: the payload has to
/// carry `source` (or the sender re-applies its own emit), and a *remote* payload
/// has to reach the handler (or there is no propagation, which is where we
/// started). Under vitest every role reports `main`, so the remote half is
/// simulated by injecting a payload with a foreign source.
describe("preference broadcasts", () => {
  /// The wire name. Hardcoded on purpose — it is a cross-window contract, and a
  /// rename that only touched the module would leave two windows on two
  /// channels with no error anywhere.
  const THEME_EVENT = "voidlink://theme-changed";
  const BLAME_EVENT = "voidlink://blame-enabled";

  function inject(event: string, payload: unknown) {
    for (const fn of [...(bus.get(event) ?? [])]) fn({ payload });
  }

  afterEach(() => bus.clear());

  it("round-trips the theme id with the sending window's label", async () => {
    const seen: unknown[] = [];
    await (async () => {
      // Subscribe raw, below the `source` guard, to see the payload on the wire.
      const set = bus.get(THEME_EVENT) ?? new Set();
      bus.set(THEME_EVENT, set);
      set.add((e) => seen.push(e.payload));
    })();

    await publishThemeChange("monokai");

    expect(seen).toEqual([{ source: MAIN_WINDOW_LABEL, value: "monokai" }]);
  });

  it("drops its own echo", async () => {
    const applied: string[] = [];
    await onThemeChange((id) => applied.push(id));

    await publishThemeChange("dracula");

    // Tauri delivered it back to us; the guard is what keeps a window from
    // re-applying (and, if the handler republished, ping-ponging forever).
    expect(applied).toEqual([]);
  });

  it("re-applies a theme published by another window", async () => {
    // Stand-in for the real subscriber: `bridgeThemeAcrossWindows` hands the id
    // to `setTheme`, which writes `<html>`. Here we only assert it arrives.
    let current = "dark";
    await onThemeChange((id) => { current = id; });

    inject(THEME_EVENT, { source: EDITOR_WINDOW_LABEL, value: "solarized-light" });

    expect(current).toBe("solarized-light");
  });

  it("carries blame-enabled on the same shape, both values", async () => {
    const applied: boolean[] = [];
    await onBlameEnabled((v) => applied.push(v));

    inject(BLAME_EVENT, { source: GIT_WINDOW_LABEL, value: true });
    inject(BLAME_EVENT, { source: GIT_WINDOW_LABEL, value: false });

    // `false` must survive: a truthiness check here would make blame
    // impossible to turn off from another window.
    expect(applied).toEqual([true, false]);

    const seen: unknown[] = [];
    const set = bus.get(BLAME_EVENT)!;
    set.add((e) => seen.push(e.payload));
    await publishBlameEnabled(false);
    expect(seen).toEqual([{ source: MAIN_WINDOW_LABEL, value: false }]);
  });

  it("ignores a malformed payload rather than applying undefined", async () => {
    const applied: string[] = [];
    await onThemeChange((id) => applied.push(id));

    inject(THEME_EVENT, null);
    inject(THEME_EVENT, undefined);

    expect(applied).toEqual([]);
  });
});
