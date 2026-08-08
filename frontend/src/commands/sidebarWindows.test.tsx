/// The detach lifecycle's state transitions, against the fake Tauri boundary.
///
/// The seam is `invoke` and the event bus (`test/tauri.ts`), not
/// `@/api/windows` — so `openSidebarWindow`'s label lookup, `close_panel_window`'s
/// argument shape and the dock-back event's payload are all under test rather
/// than replaced by a factory that agrees with itself.
///
/// A `.test.tsx` because the lifecycle is reactive: `useSidebarWindows` is
/// `onMount` + `onCleanup`, so it needs a real Solid root, and the render
/// project is where `setup.ts` installs the boundary.
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import {
  emitTauriEvent,
  closeCurrentWindow,
  lastInvokeArgs,
  mockTauri,
  setTauriWindowLabel,
  tauriCalls,
} from "@/test/tauri";
import { createAppStore, type AppStore, type SidebarId } from "@/store/layout";
import {
  canDetachSidebar,
  detachSidebar,
  dockSidebarBack,
  useSidebarWindows,
} from "./sidebarWindows";

/// Mount a workbench-side store with the lifecycle wired to it, run `body`,
/// then tear the root down. `useSidebarWindows` registers listeners on mount,
/// so the root has to outlive the assertions.
async function withWorkbench(
  body: (store: AppStore) => void | Promise<void>,
  opts: { detached?: SidebarId[]; onEditorHome?: () => void } = {},
): Promise<void> {
  let dispose = () => {};
  const store = createRoot((d) => {
    dispose = d;
    const s = createAppStore({ persist: false });
    for (const id of opts.detached ?? []) s.actions.setSidebarDetached(id, true);
    useSidebarWindows(s, { onEditorHome: opts.onEditorHome });
    return s;
  });
  // `onMount` and the `listen()` registrations inside it are async.
  await Promise.resolve();
  await Promise.resolve();
  try {
    await body(store);
  } finally {
    dispose();
  }
}

const railed = (store: AppStore, id: SidebarId): boolean => {
  switch (id) {
    case "explorer":
      return !store.state.sidebarSections.files;
    case "agents":
      return !store.state.sidebarSections.agents;
    case "git":
      return store.state.gitSidebarCollapsed;
    default:
      return false;
  }
};

describe("canDetachSidebar", () => {
  it("answers from the window table, not from a guess", () => {
    expect(canDetachSidebar("explorer")).toBe(true);
    expect(canDetachSidebar("git")).toBe(true);
    expect(canDetachSidebar("agents")).toBe(true);
    // Both write state only the workbench owns, so neither has a window. See
    // `SIDEBAR_WINDOW_LABEL` for the full reasoning.
    expect(canDetachSidebar("workspaces")).toBe(false);
    expect(canDetachSidebar("terminals")).toBe(false);
  });
});

describe("detachSidebar", () => {
  it("marks the panel detached before the window exists", async () => {
    mockTauri({ open_panel_window: true });
    await withWorkbench(async (store) => {
      const pending = detachSidebar(store, "explorer");
      // The flag lands synchronously — the shell's slot collapses when the user
      // asks, not a beat later when Tauri finishes building a webview.
      expect(store.state.detachedSidebars).toEqual(["explorer"]);
      await pending;
      expect(lastInvokeArgs("open_panel_window")).toEqual({ label: "panel-files" });
    });
  });

  it("puts the panel straight back when the window will not open", async () => {
    mockTauri({
      open_panel_window: () => {
        throw new Error("no such window");
      },
    });
    await withWorkbench(async (store) => {
      await detachSidebar(store, "explorer");
      expect(store.state.detachedSidebars).toEqual([]);
      // A failed detach is an undo, not a collapse: the user never saw a
      // window, so the panel comes back the way it was.
      expect(railed(store, "explorer")).toBe(false);
    });
  });

  it("routes the git panel to the git window rather than a panel window", async () => {
    mockTauri({ open_git_window: true });
    await withWorkbench(async (store) => {
      await detachSidebar(store, "git");
      expect(tauriCalls("open_git_window")).toHaveLength(1);
      expect(tauriCalls("open_panel_window")).toHaveLength(0);
    });
  });

  it("does nothing for a sidebar with no window", async () => {
    mockTauri({});
    await withWorkbench(async (store) => {
      await detachSidebar(store, "terminals");
      expect(store.state.detachedSidebars).toEqual([]);
      expect(tauriCalls()).toHaveLength(0);
    });
  });
});

describe("dockSidebarBack", () => {
  it("returns the panel collapsed, and closes its window", async () => {
    mockTauri({ close_panel_window: null });
    await withWorkbench(
      async (store) => {
        await dockSidebarBack(store, "explorer");
        expect(store.state.detachedSidebars).toEqual([]);
        expect(railed(store, "explorer")).toBe(true);
        // Visible at rail width, not hidden — `leftSidebarCollapsed` is what
        // takes the explorer off screen entirely, and coming home is not that.
        expect(store.state.leftSidebarCollapsed).toBe(false);
        expect(lastInvokeArgs("close_panel_window")).toEqual({ label: "panel-files" });
      },
      { detached: ["explorer"] },
    );
  });

  it("leaves the edge and the width alone, so one click restores them", async () => {
    mockTauri({ close_panel_window: null });
    await withWorkbench(
      async (store) => {
        store.actions.dockSidebar("explorer", "right");
        store.actions.setPanelWidth("sidebar", 320);
        await dockSidebarBack(store, "explorer");
        expect(store.state.dockSide.explorer).toBe("right");
        expect(store.state.panels.sidebar).toBe(320);
      },
      { detached: ["explorer"] },
    );
  });

  it("still homes the panel when the window is already gone", async () => {
    mockTauri({
      close_panel_window: () => {
        throw new Error("window not found");
      },
    });
    await withWorkbench(
      async (store) => {
        await dockSidebarBack(store, "explorer");
        expect(store.state.detachedSidebars).toEqual([]);
        expect(railed(store, "explorer")).toBe(true);
      },
      { detached: ["explorer"] },
    );
  });
});

describe("a window that closes itself", () => {
  it("docks its panel back collapsed, indistinguishably from the in-app route", async () => {
    mockTauri({});
    await withWorkbench(
      async (store) => {
        emitTauriEvent("voidlink://panel-dock-back", "explorer");
        expect(store.state.detachedSidebars).toEqual([]);
        expect(railed(store, "explorer")).toBe(true);
        // The workbench does not close a window that is already closing. That
        // second close is the re-entrancy the Rust side documents.
        expect(tauriCalls("close_panel_window")).toHaveLength(0);
      },
      { detached: ["explorer"] },
    );
  });

  it("accepts the git window's dock-back the same way", async () => {
    mockTauri({});
    await withWorkbench(
      async (store) => {
        emitTauriEvent("voidlink://panel-dock-back", "git");
        expect(store.state.detachedSidebars).toEqual([]);
        expect(railed(store, "git")).toBe(true);
      },
      { detached: ["git"] },
    );
  });

  it("leaves a sidebar that was never detached alone", async () => {
    // The git client can be opened *beside* the git sidebar without detaching
    // it, and it emits a dock-back on close either way. Closing it must not
    // fold away a panel the user never moved.
    mockTauri({});
    await withWorkbench(async (store) => {
      expect(store.state.gitSidebarCollapsed).toBe(false);
      emitTauriEvent("voidlink://panel-dock-back", "git");
      expect(store.state.detachedSidebars).toEqual([]);
      expect(store.state.gitSidebarCollapsed).toBe(false);
    });
  });

  it("repairs a pre-rename id rather than dropping it", async () => {
    mockTauri({});
    await withWorkbench(
      async (store) => {
        // A `panel-files` window from a build before the explorer's rename.
        emitTauriEvent("voidlink://panel-dock-back", "files");
        expect(store.state.detachedSidebars).toEqual([]);
        expect(railed(store, "explorer")).toBe(true);
      },
      { detached: ["explorer"] },
    );
  });

  it("ignores an id this build has never heard of", async () => {
    mockTauri({});
    await withWorkbench(
      async (store) => {
        emitTauriEvent("voidlink://panel-dock-back", "outline");
        expect(store.state.detachedSidebars).toEqual(["explorer"]);
      },
      { detached: ["explorer"] },
    );
  });

  it("re-homes the editor when its window closes", async () => {
    mockTauri({});
    let homed = 0;
    await withWorkbench(
      () => {
        emitTauriEvent("voidlink://editor-dock-back", undefined);
        expect(homed).toBe(1);
      },
      { onEditorHome: () => homed++ },
    );
  });
});

describe("boot reconciliation", () => {
  it("reopens a window a previous session left detached", async () => {
    mockTauri({ is_panel_window_open: false, open_panel_window: true });
    await withWorkbench(
      async (store) => {
        await Promise.resolve();
        await Promise.resolve();
        expect(lastInvokeArgs("open_panel_window")).toEqual({ label: "panel-files" });
        expect(store.state.detachedSidebars).toEqual(["explorer"]);
      },
      { detached: ["explorer"] },
    );
  });

  it("does not reopen a window that survived the reload", async () => {
    mockTauri({ is_panel_window_open: true });
    await withWorkbench(
      async () => {
        await Promise.resolve();
        await Promise.resolve();
        expect(tauriCalls("open_panel_window")).toHaveLength(0);
      },
      { detached: ["explorer"] },
    );
  });

  it("docks back — expanded — a panel this build cannot open", async () => {
    // The persisted blob names a window this build has no spec for, so both
    // calls reject. The slot must not stay collapsed for a window nobody can
    // see; and this is not a window the user closed, so it comes back whole.
    mockTauri({
      is_panel_window_open: () => {
        throw new Error("unknown panel window");
      },
      open_panel_window: () => {
        throw new Error("unknown panel window");
      },
    });
    await withWorkbench(
      async (store) => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(store.state.detachedSidebars).toEqual([]);
        expect(railed(store, "explorer")).toBe(false);
      },
      { detached: ["explorer"] },
    );
  });
});

describe("a detached window's own close handler", () => {
  it("emits the dock-back and lets the window go", async () => {
    mockTauri({});
    setTauriWindowLabel("panel-files");

    let received: unknown = null;
    let dispose = () => {};
    createRoot((d) => {
      dispose = d;
    });
    const off = await import("@/api/windows").then((m) =>
      m.onSidebarDockBack((id) => (received = id)),
    );

    // Stand in for the panel root's registration — the shape that matters is
    // that the handler is async and awaits its emit, so the fake's `await
    // handler(...)` before `destroy` is what proves the message got out first.
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { requestSidebarDockBack } = await import("@/api/windows");
    await getCurrentWindow().onCloseRequested(async () => {
      await requestSidebarDockBack("explorer");
    });

    await closeCurrentWindow();

    expect(received).toBe("explorer");
    // The emit is recorded before the destroy: the workbench heard it while the
    // webview was still alive, which is the whole reason the handler awaits.
    const order = tauriCalls().map((c) => c.command);
    expect(order.indexOf("emit:voidlink://panel-dock-back")).toBeLessThan(
      order.indexOf("destroy"),
    );

    off();
    dispose();
  });
});
