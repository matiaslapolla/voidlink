/// The dock's placement must not be collateral damage of an environment-mode
/// change.
///
/// The two live in different stores and different storage keys on purpose —
/// `environmentMode` is a *setting* (`voidlink-settings`), the strip's edge is
/// *layout* (`voidlink-git-prefs`, beside `dockSide` and `dockOrder`) — and that
/// split is the whole reason a round trip through another mode is lossless. It
/// is also exactly the kind of property that holds by construction today and
/// quietly stops holding the first time somebody "simplifies" the edge into
/// `settings.ui`, where the mode switch would sit right next to it.
///
/// Written against `persistPrefs`/`loadPrefs` and a real `createAppStore`
/// hydration rather than against the store's persist effects, for the reason
/// `durability.test.ts` writes its fixtures with `writeJson`: the `unit`
/// project runs without `vite-plugin-solid`, so what it resolves is Solid's
/// non-browser build and `createEffect` never fires. Hydration *is* synchronous
/// and is the half that matters here anyway — the question is whether a boot in
/// docked mode finds the edge the last one left.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "@/store/migrate";

vi.mock("@/api/terminal", () => ({
  terminalApi: {
    createPty: async () => "pty-1",
    closePty: async () => {},
    writePty: async () => {},
    processInfo: async () => null,
  },
}));

import { createAppStore } from "./index";
import { loadPrefs, parsePrefs, persistPrefs } from "./prefs";
import { STORAGE_KEYS, flushWrites } from "./persistence";

const WT_ID = "77777777-7777-4777-8777-777777777777";

/// The settings blob's key. Written here as the literal rather than imported,
/// deliberately: this test is *about* the two keys being different, and reading
/// both from the same constant would make it pass even if they were merged.
const SETTINGS_KEY = "voidlink-settings";

function installLocalStorage() {
  const backing = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k) => backing.get(k) ?? null,
    key: (i) => [...backing.keys()][i] ?? null,
    removeItem: (k) => void backing.delete(k),
    setItem: (k, v) => void backing.set(k, String(v)),
  };
  (globalThis as { localStorage: Storage }).localStorage = stub;
  backing.set(LAYOUT_VERSION_KEY, String(LAYOUT_VERSION));
  backing.set(
    WORKSPACES_KEY,
    JSON.stringify([
      {
        id: "88888888-8888-4888-8888-888888888888",
        name: "Main",
        repoRoot: "/repo",
        worktrees: [
          { id: WT_ID, path: "/repo", branch: "main", isMain: true, isSynthetic: false },
        ],
        activeWorktreeId: WT_ID,
        isRepo: true,
      },
    ]),
  );
  return backing;
}

/// What flipping the environment mode actually does to disk: rewrites the
/// settings blob, and nothing else.
function setMode(mode: string) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ui: { environmentMode: mode } }));
}

/// One boot, in a root of its own, reading whatever is on disk right now.
function boot() {
  return createRoot((dispose) => {
    const store = createAppStore({ persist: false });
    dispose();
    return store;
  });
}

let backing: Map<string, string>;

beforeEach(() => {
  backing = installLocalStorage();
});

describe("switching environmentMode in and out of docked", () => {
  it("leaves the strip on the edge the user left it on", () => {
    setMode("docked");
    expect(boot().state.dockStripSide).toBe("left");

    // The user drags the strip to the floor.
    persistPrefs({ ...loadPrefs(), dockStripSide: "bottom" });
    flushWrites();

    // Away and back. Three hops, not one: a single flip could pass on a shell
    // that simply never re-reads the key.
    setMode("stacked");
    setMode("detached");
    setMode("docked");

    expect(loadPrefs().dockStripSide).toBe("bottom");
    expect(boot().state.dockStripSide).toBe("bottom");
  });

  it("keeps the edge in the layout key, where a mode change cannot reach it", () => {
    persistPrefs({ ...loadPrefs(), dockStripSide: "right" });
    flushWrites();

    const before = backing.get(STORAGE_KEYS.gitPrefs);
    expect(before).toContain('"dockStripSide":"right"');

    setMode("docked");
    // Byte-identical: the mode's writer cannot reach this blob at all.
    expect(backing.get(STORAGE_KEYS.gitPrefs)).toBe(before);
    expect(backing.get(SETTINGS_KEY) ?? "").not.toContain("dockStripSide");
    expect(STORAGE_KEYS.gitPrefs).not.toBe(SETTINGS_KEY);
  });

  it("does not disturb the sidebars' own arrangement either", () => {
    // The strip's edge and the five sidebars' edges are neighbours in one blob,
    // and the strip is a new writer of it — so the regression worth naming is
    // the one where writing the new field re-serialises the old ones wrong.
    const prefs = loadPrefs();
    persistPrefs({
      ...prefs,
      dockStripSide: "bottom",
      dockSide: { ...prefs.dockSide, git: "left" },
      dockOrder: ["git", "workspaces", "explorer", "terminals", "agents"],
    });
    flushWrites();

    setMode("docked");
    setMode("detached");

    const store = boot();
    expect(store.state.dockStripSide).toBe("bottom");
    expect(store.state.dockSide.git).toBe("left");
    expect(store.state.dockOrder[0]).toBe("git");
  });

  it("starts a first run in docked mode on the left, and repairs a broken edge to it", () => {
    // No layout blob at all — a fresh install that picks docked mode before it
    // has ever touched the shell.
    setMode("docked");
    expect(boot().state.dockStripSide).toBe("left");

    // And a blob naming an edge this build cannot place: repaired, not
    // rejected, so the rest of the arrangement survives with it.
    backing.set(
      STORAGE_KEYS.gitPrefs,
      JSON.stringify({ dockStripSide: "top", dockSide: { git: "left" } }),
    );
    const repaired = boot();
    expect(repaired.state.dockStripSide).toBe("left");
    expect(repaired.state.dockSide.git).toBe("left");
  });

  it("round-trips the edge through the parser unchanged", () => {
    for (const side of ["left", "right", "bottom"] as const) {
      const once = parsePrefs({ dockStripSide: side });
      expect(once.dockStripSide).toBe(side);
      expect(parsePrefs(once).dockStripSide).toBe(side);
    }
  });
});
