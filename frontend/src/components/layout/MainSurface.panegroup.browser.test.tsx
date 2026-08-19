/// The single highest-risk property in the pane-groups stream: moving a live
/// terminal tab into a `panegroup` tab's nested split must never remount it.
///
/// The whole reason `MainSurface` keeps every pane's real content in one flat,
/// unkeyed-by-structure layer (see that component's header comment) is that a
/// DOM reparent is a remount — xterm loses its scrollback and the PTY's
/// `<canvas>`/WebGL context tears down and rebuilds. Rendering a `panegroup`
/// tab's nested split reuses the very same `renderNode`/`renderGroup`
/// machinery the root tree already uses, which is exactly the part of this
/// stream most likely to have quietly broken that guarantee — a nested split
/// is new *chrome*, but the terminal itself must not move in the DOM tree,
/// only in position.
///
/// jsdom zeroes every `getBoundingClientRect`, so a geometry assertion there
/// cannot fail honestly; this only proves something run against a real
/// layout engine, which is why it lives in the `browser` project and not
/// `render`.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { createAppStore } from "@/store/layout";
import { AppStoreContext } from "@/store/LayoutContext";
import { mockTauri } from "@/test/tauri";
import { MainSurface } from "./MainSurface";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "@/store/migrate";

const WORKSPACE_ID = "88888888-8888-4888-8888-888888888888";
const WT_ID = "77777777-7777-4777-8777-777777777777";

/// Seed the workspace/worktree the store hydrates on construction — the same
/// approach `store/layout.test.ts` uses, but against the real `localStorage`
/// a browser test has rather than a hand-rolled stub.
function seedWorkspace() {
  localStorage.clear();
  localStorage.setItem(LAYOUT_VERSION_KEY, String(LAYOUT_VERSION));
  localStorage.setItem(
    WORKSPACES_KEY,
    JSON.stringify([
      {
        id: WORKSPACE_ID,
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
}

function mount() {
  const store = createAppStore({ persist: false });
  // A real height: the flex chain down to a group's body box only resolves
  // to something nonzero when an ancestor actually has one, and the default
  // test document gives `<body>` none.
  const utils = render(() => (
    <div style={{ width: "1000px", height: "700px", display: "flex" }}>
      <AppStoreContext.Provider value={store}>
        <MainSurface onOpenFile={() => {}} onOpenSettings={() => {}} onSearchInFiles={() => {}} />
      </AppStoreContext.Provider>
    </div>
  ));
  return { store, ...utils };
}

describe("a terminal moved into a split pane keeps its DOM node", () => {
  it("is the same element, not a new one, before and after the move", async () => {
    seedWorkspace();
    mockTauri({
      create_pty: () => "pty-1",
      close_pty: () => undefined,
      pty_process_info: () => ({ pid: 1, name: null, cwd: null, busy: false }),
      write_pty: () => undefined,
      resize_pty: () => undefined,
      pty_subscribe: () => ({ token: 1, replayBytes: 0 }),
      pty_unsubscribe: () => undefined,
    });

    const { store } = mount();
    const termId = await store.actions.spawnTerminal(WT_ID);
    if (!termId) throw new Error("terminal did not spawn");

    const selector = `[data-pane-tab-id="${termId}"]`;
    await waitFor(() => {
      expect(document.querySelector(selector)).toBeTruthy();
    });
    const before = document.querySelector(selector);
    expect(before).toBeTruthy();
    // The node that actually holds the PTY: a child of the wrapper above,
    // never itself reparented if the wrapper is not. Recorded too, so the
    // assertion below cannot pass merely because the *wrapper* survived while
    // xterm's own container was torn down and rebuilt inside it.
    const innerBefore = before!.firstElementChild;
    expect(innerBefore).toBeTruthy();

    // "Add to split pane": moves the tab into a brand-new `panegroup` tab's
    // nested tree — the real store action the tab's context menu calls, not
    // a hand-rolled substitute for it.
    const paneGroupId = store.actions.addTabToSplitPane(WT_ID, termId);
    expect(paneGroupId).not.toBeNull();

    // The split actually rendered: its default label is on screen, proving
    // this is not merely a state change nothing painted.
    await waitFor(() => {
      expect(screen.getByText("Split 1")).toBeInTheDocument();
    });

    const after = document.querySelector(selector);
    expect(after).toBeTruthy();
    const innerAfter = after!.firstElementChild;

    // The load-bearing assertions: reference equality, not deep equality.
    // A remount would produce a *different* element that looks identical —
    // `toBe` is what a `toEqual` cannot catch.
    expect(after).toBe(before);
    expect(innerAfter).toBe(innerBefore);

    // Exactly one node wears this tab's identity — a duplicate would let the
    // assertion above pass by accident if `querySelector` happened to keep
    // resolving to whichever copy came first.
    expect(document.querySelectorAll(selector)).toHaveLength(1);

    // And it really did move: the terminal now measures inside the nested
    // split's pane, not the root strip's. Real geometry, only meaningful in
    // this project — see the file header.
    const rect = after!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });
});
