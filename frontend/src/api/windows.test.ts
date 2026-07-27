/// The window-role helpers decide which root `main.tsx` mounts and which side
/// of every cross-window protocol a module is on. They read Tauri's injected
/// metadata, which does not exist under vitest or in a plain browser — so the
/// thing worth testing is precisely that: the fallback, and that exactly one
/// role claims it.

import { afterEach, describe, expect, it } from "vitest";
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
  openEditorWindow,
  openGitWindow,
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
