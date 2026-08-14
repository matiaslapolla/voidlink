/// The workspace detach lifecycle, against the fake Tauri boundary.
///
/// The seam is `invoke` and the event bus (`test/tauri.ts`), not
/// `@/api/windows` — so the command names, the argument shapes and the event
/// payloads are under test rather than replaced by a factory that agrees with
/// itself. Same arrangement, and for the same reasons, as
/// `sidebarWindows.test.tsx` beside it.
///
/// A `.test.tsx` because the lifecycle is reactive: `useWorkspaceWindows` is
/// `onMount` + `onCleanup`, so it needs a real Solid root.
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import {
  emitTauriEvent,
  lastInvokeArgs,
  mockTauri,
  setTauriWindowLabel,
  tauriCalls,
} from "@/test/tauri";
import { createAppStore, type AppStore } from "@/store/layout";
import {
  adoptWorkspaceHandoff,
  detachWorkspace,
  dockWorkspaceBack,
  handoffFor,
  useWorkspaceWindows,
} from "./workspaceWindows";

/// Mount a workbench-side store with the lifecycle wired to it, run `body`,
/// then tear the root down. The listeners live for the root's lifetime, so it
/// has to outlive the assertions.
async function withWorkbench(
  body: (store: AppStore, workspaceId: string) => void | Promise<void>,
  opts: { detached?: "the-workspace" | "a-workspace-that-is-gone" } = {},
): Promise<void> {
  let dispose = () => {};
  const store = createRoot((d) => {
    dispose = d;
    return createAppStore({ persist: false });
  });
  // A first run seeds exactly one workspace ("Main"), which is the one every
  // assertion below is about.
  const id = store.state.workspaces[0].id;
  if (opts.detached === "the-workspace") {
    store.actions.setWorkspaceDetached(id, true);
  } else if (opts.detached === "a-workspace-that-is-gone") {
    store.actions.setWorkspaceDetached("no-such-workspace", true);
  }
  createRoot(() => useWorkspaceWindows(store));
  // `onMount` and the `listen()` registrations inside it are async.
  await Promise.resolve();
  await Promise.resolve();
  try {
    await body(store, id);
  } finally {
    dispose();
  }
}

describe("detachWorkspace", () => {
  it("marks the workspace detached before the window exists", async () => {
    mockTauri({ open_workspace_window: true });
    await withWorkbench(async (store, id) => {
      const pending = detachWorkspace(store, id);
      // The flag lands synchronously — the rail changes when the user asks, not
      // a beat later when Tauri finishes building a webview.
      expect(store.state.detachedWorkspaces).toEqual([id]);
      await pending;
      expect(lastInvokeArgs("open_workspace_window")).toEqual({
        workspaceId: id,
        name: "Main",
      });
    });
  });

  it("puts the workspace straight back when the window will not open", async () => {
    mockTauri({
      open_workspace_window: () => {
        throw new Error("no such window");
      },
    });
    await withWorkbench(async (store, id) => {
      await detachWorkspace(store, id);
      expect(store.state.detachedWorkspaces).toEqual([]);
      // And the user is still standing in it: a failed detach is an undo, not a
      // hand-off to a window that never appeared.
      expect(store.state.activeWorkspaceId).toBe(id);
    });
  });

  it("does nothing for a workspace this window has never heard of", async () => {
    mockTauri({});
    await withWorkbench(async (store) => {
      await detachWorkspace(store, "no-such-workspace");
      expect(store.state.detachedWorkspaces).toEqual([]);
      expect(tauriCalls("open_workspace_window")).toHaveLength(0);
    });
  });
});

describe("dockWorkspaceBack", () => {
  it("selects the workspace again, and closes its window", async () => {
    mockTauri({ close_workspace_window: null });
    await withWorkbench(
      async (store, id) => {
        await dockWorkspaceBack(store, id);
        expect(store.state.detachedWorkspaces).toEqual([]);
        // Unlike a returning *panel*, which comes back collapsed: a workspace
        // coming home is the thing the user was just working in, and leaving it
        // unselected would strand them with their window gone.
        expect(store.state.activeWorkspaceId).toBe(id);
        expect(lastInvokeArgs("close_workspace_window")).toEqual({ workspaceId: id });
      },
      { detached: "the-workspace" },
    );
  });

  it("still homes the workspace when the window is already gone", async () => {
    mockTauri({
      close_workspace_window: () => {
        throw new Error("window not found");
      },
    });
    await withWorkbench(
      async (store, id) => {
        await dockWorkspaceBack(store, id);
        expect(store.state.detachedWorkspaces).toEqual([]);
        expect(store.state.activeWorkspaceId).toBe(id);
      },
      { detached: "the-workspace" },
    );
  });
});

describe("a window that closes itself", () => {
  it("homes its workspace, indistinguishably from the in-app route", async () => {
    mockTauri({});
    await withWorkbench(
      async (store, id) => {
        emitTauriEvent("voidlink://workspace-dock-back", id);
        expect(store.state.detachedWorkspaces).toEqual([]);
        expect(store.state.activeWorkspaceId).toBe(id);
        // The workbench does not close a window that is already closing. That
        // second close is the re-entrancy `close_satellite` documents.
        expect(tauriCalls("close_workspace_window")).toHaveLength(0);
      },
      { detached: "the-workspace" },
    );
  });

  it("leaves a workspace that was never detached alone", async () => {
    mockTauri({});
    await withWorkbench(async (store, id) => {
      emitTauriEvent("voidlink://workspace-dock-back", id);
      expect(store.state.detachedWorkspaces).toEqual([]);
    });
  });

  it("ignores an id for a workspace this window does not have", async () => {
    mockTauri({});
    await withWorkbench(
      async (store, id) => {
        emitTauriEvent("voidlink://workspace-dock-back", "someone-elses-workspace");
        expect(store.state.detachedWorkspaces).toEqual([id]);
      },
      { detached: "the-workspace" },
    );
  });
});

describe("boot reconciliation", () => {
  it("reopens a window a previous session left detached", async () => {
    mockTauri({ is_workspace_window_open: false, open_workspace_window: true });
    await withWorkbench(
      async (store, id) => {
        await Promise.resolve();
        await Promise.resolve();
        expect(lastInvokeArgs("open_workspace_window")).toEqual({
          workspaceId: id,
          name: "Main",
        });
        expect(store.state.detachedWorkspaces).toEqual([id]);
      },
      { detached: "the-workspace" },
    );
  });

  it("does not reopen a window that survived the reload", async () => {
    mockTauri({ is_workspace_window_open: true });
    await withWorkbench(
      async () => {
        await Promise.resolve();
        await Promise.resolve();
        expect(tauriCalls("open_workspace_window")).toHaveLength(0);
      },
      { detached: "the-workspace" },
    );
  });

  it("drops a workspace id that no longer names a workspace", async () => {
    // The persisted blob describes a detachment whose workspace has since been
    // removed. There is nothing to put in a window and nothing to dock back to,
    // so the flag goes rather than the boot — and no window is asked for.
    mockTauri({});
    await withWorkbench(
      async (store) => {
        await Promise.resolve();
        expect(store.state.detachedWorkspaces).toEqual([]);
        expect(tauriCalls("open_workspace_window")).toHaveLength(0);
        expect(tauriCalls("is_workspace_window_open")).toHaveLength(0);
      },
      { detached: "a-workspace-that-is-gone" },
    );
  });

  it("homes a workspace whose window this environment cannot open", async () => {
    mockTauri({
      is_workspace_window_open: () => {
        throw new Error("unknown workspace window");
      },
      open_workspace_window: () => {
        throw new Error("unknown workspace window");
      },
    });
    await withWorkbench(
      async (store, id) => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(store.state.detachedWorkspaces).toEqual([]);
        expect(store.state.activeWorkspaceId).toBe(id);
      },
      { detached: "the-workspace" },
    );
  });
});

describe("the handoff", () => {
  it("carries the live ptyId, which is the one thing disk cannot", async () => {
    mockTauri({ pty_set_owner: null });
    let dispose = () => {};
    const store = createRoot((d) => {
      dispose = d;
      return createAppStore({ persist: false });
    });
    try {
      const id = store.state.workspaces[0].id;
      const wtId = store.state.workspaces[0].worktrees[0].id;
      // Seeded through the adopt action rather than by spawning: a first-run
      // workspace has no folder, so `spawnTerminal` has nowhere to root a shell
      // and would answer `null`. What is under test here is the *projection* —
      // that a handoff is keyed by worktree and carries the process id — not how
      // the session got into the store.
      store.actions.adoptTerminalSessions(wtId, [
        { id: "tab-1", ptyId: "pty-live-1", label: "zsh", cwd: "/repo" },
      ]);

      const handoff = handoffFor(store, id);
      expect(handoff.workspaceId).toBe(id);
      expect(handoff.terminals[wtId]).toHaveLength(1);
      expect(handoff.terminals[wtId][0]).toEqual({
        id: "tab-1",
        ptyId: "pty-live-1",
        label: "zsh",
        cwd: "/repo",
      });
    } finally {
      dispose();
    }
  });

  it("says nothing about a workspace it does not have", async () => {
    mockTauri({});
    let dispose = () => {};
    const store = createRoot((d) => {
      dispose = d;
      return createAppStore({ persist: false });
    });
    try {
      expect(handoffFor(store, "no-such-workspace")).toEqual({
        workspaceId: "no-such-workspace",
        terminals: {},
      });
    } finally {
      dispose();
    }
  });
});

/// The riskiest assumption in the whole feature, and the one this slice had to
/// prove first: a second window takes over a **running** session rather than
/// starting a new one beside it.
describe("reattaching in a workspace window", () => {
  it("adopts the live sessions without spawning a single shell", async () => {
    mockTauri({ pty_set_owner: null });
    setTauriWindowLabel("workspace-ws-1");
    let dispose = () => {};
    const store = createRoot((d) => {
      dispose = d;
      // `persist: false`, exactly as `App` creates it for a scoped window — and
      // that is what keeps `restoreTerminalSessions` (which *does* call
      // `create_pty`, correctly, on boot) from running here at all.
      return createAppStore({ persist: false });
    });
    try {
      const wtId = store.state.workspaces[0].worktrees[0].id;
      await adoptWorkspaceHandoff(store, {
        workspaceId: store.state.workspaces[0].id,
        terminals: {
          [wtId]: [
            { id: "tab-1", ptyId: "pty-live-1", label: "zsh", cwd: "/repo" },
            { id: "tab-2", ptyId: "pty-live-2", label: "vite", cwd: "/repo" },
          ],
        },
      });

      // The sessions are the *same processes*, under the same tab ids.
      expect(store.state.terminalsByWorktree[wtId].map((t) => t.ptyId)).toEqual([
        "pty-live-1",
        "pty-live-2",
      ]);
      expect(store.state.terminalsByWorktree[wtId].map((t) => t.id)).toEqual([
        "tab-1",
        "tab-2",
      ]);
      // Not marked `restored`: that flag means "the scrollback is gone and this
      // is a fresh shell wearing the old tab's name", which is the opposite of
      // what happened.
      expect(store.state.terminalsByWorktree[wtId].some((t) => t.restored)).toBe(false);

      // The whole point. A single `create_pty` here would be two shells per tab
      // — the user's real one still running invisibly behind a new empty one.
      expect(tauriCalls("create_pty")).toHaveLength(0);

      // And Rust is told, so closing `main` does not reap them out from under
      // this window.
      expect(lastInvokeArgs("pty_set_owner")).toEqual({
        sessionIds: ["pty-live-1", "pty-live-2"],
        label: "workspace-ws-1",
      });
    } finally {
      dispose();
    }
  });

  // The other half — that the adopted `ptyId` is the one that actually reaches
  // `pty_subscribe` when a pane renders it — is
  // `workspaceReattach.browser.test.tsx`. It has to be a browser test: xterm
  // does not load under jsdom at all, which is the same reason every other
  // terminal test in this repo is one.
});
