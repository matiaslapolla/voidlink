/// A shell that exits takes its tab with it — whatever it exited *with*.
///
/// This used to be conditional: a non-zero status kept the tab alive wearing
/// the red `failed` mark, so typing `exit` after a command that failed left the
/// tab sitting there holding a shell that no longer existed. The exit code is
/// the whole of what changed, so it is the whole of what this asserts: 0, 1 and
/// `null` (the platform could not report a status) must all end the same way.
///
/// `TerminalPane` is mocked, at the same boundary and for the same reason
/// `EditorApp.test.tsx` mocks Monaco: xterm needs a layout engine and a canvas
/// jsdom does not have, and nothing here is about the pane's insides. The stub
/// hands back the `onExit` prop `MainSurface` passed it, which is precisely the
/// seam under test — calling it is exactly what the real pane's `pty-exit`
/// listener does with the code Rust sent.
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createAppStore } from "@/store/layout";
import { AppStoreContext } from "@/store/LayoutContext";
import { mockTauri } from "@/test/tauri";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "@/store/migrate";

/// One entry per mounted pane. Getters rather than the values, so each reads
/// its prop when the test calls it rather than freezing whatever was passed on
/// the first render.
const mountedPanes: Array<() => ((exitCode: number | null) => void) | undefined> = [];

vi.mock("@/components/terminal/TerminalPane", () => ({
  TerminalPane: (props: { onExit?: (exitCode: number | null) => void }) => {
    mountedPanes.push(() => props.onExit);
    return null;
  },
}));

import { MainSurface } from "./MainSurface";

const WORKSPACE_ID = "88888888-8888-4888-8888-888888888888";
const WT_ID = "77777777-7777-4777-8777-777777777777";

/// Seed the workspace/worktree the store hydrates on construction — the same
/// shape `MainSurface.panegroup.browser.test.tsx` seeds.
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

async function mountWithTerminal() {
  mountedPanes.length = 0;
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

  const store = createAppStore({ persist: false });
  render(() => (
    <AppStoreContext.Provider value={store}>
      <MainSurface onOpenFile={() => {}} onOpenSettings={() => {}} onSearchInFiles={() => {}} />
    </AppStoreContext.Provider>
  ));

  const termId = await store.actions.spawnTerminal(WT_ID);
  if (!termId) throw new Error("terminal did not spawn");
  await waitFor(() => {
    expect(document.querySelector(`[data-pane-tab-id="${termId}"]`)).toBeTruthy();
  });
  const onExit = mountedPanes.at(-1)?.();
  if (!onExit) throw new Error("the pane was never handed an onExit");
  return { store, termId, onExit };
}

describe("a shell that exits closes its tab", () => {
  for (const exitCode of [0, 1, null]) {
    it(`removes the terminal for exit code ${exitCode}`, async () => {
      const { store, termId, onExit } = await mountWithTerminal();

      onExit(exitCode);

      await waitFor(() => {
        expect(store.state.terminalsByWorktree[WT_ID]).toHaveLength(0);
      });
      // And the pane really left the DOM, not just the store — the tab is gone
      // from the surface the user is looking at.
      expect(document.querySelector(`[data-pane-tab-id="${termId}"]`)).toBeNull();
    });
  }
});
