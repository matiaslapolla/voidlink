/// The riskiest assumption of the detachable-workspace stream, proven against a
/// real pane: a second window **attaches to a running session** rather than
/// starting a new one beside it.
///
/// `commands/workspaceWindows.test.tsx` covers the store half — that a handoff
/// lands as sessions carrying the live `ptyId` and that nothing spawns. This
/// covers the half that only exists once something renders: that the id which
/// arrived over the wire is the id `pty_subscribe` is called with, and that no
/// `create_pty` happens anywhere along the way. Two shells per tab — the user's
/// real one still running invisibly behind a fresh empty one — is the failure
/// this exists to make impossible to ship.
///
/// A browser test because xterm does not load under jsdom at all, which is why
/// every other terminal test in this repo is one too.
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createAppStore } from "@/store/layout";
import { AppStoreContext } from "@/store/LayoutContext";
import { lastInvokeArgs, mockTauri, setTauriWindowLabel, tauriCalls } from "@/test/tauri";
import { MainSurface } from "@/components/layout/MainSurface";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "@/store/migrate";
import { adoptWorkspaceHandoff } from "./workspaceWindows";

const WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";
const WT_ID = "66666666-6666-4666-8666-666666666666";
/// A session that is **already running** in the workbench when this window
/// opens. Nothing here creates it; the point is that nothing here re-creates it.
const LIVE_PTY = "pty-already-running";

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

describe("a workspace window reattaching to a live PTY", () => {
  it("subscribes to the session it was handed and creates none", async () => {
    seedWorkspace();
    setTauriWindowLabel(`workspace-${WORKSPACE_ID}`);
    mockTauri({
      pty_set_owner: () => undefined,
      pty_subscribe: () => ({ token: 1, replayBytes: 0 }),
      pty_unsubscribe: () => undefined,
      pty_process_info: () => ({ pid: 1, name: null, cwd: null, busy: false }),
      write_pty: () => undefined,
      resize_pty: () => undefined,
      pty_set_paused: () => undefined,
    });

    // Scoped exactly as `App` builds it for a `workspace-<id>` window. The
    // `persist: false` is load-bearing here and not hygiene: it is what keeps
    // `restoreTerminalSessions` — which calls `create_pty`, correctly, on a real
    // boot — from running in a window whose shells are already alive.
    const store = createAppStore({ persist: false, workspaceId: WORKSPACE_ID });

    await adoptWorkspaceHandoff(store, {
      workspaceId: WORKSPACE_ID,
      terminals: {
        [WT_ID]: [{ id: "tab-1", ptyId: LIVE_PTY, label: "zsh", cwd: "/repo" }],
      },
    });
    store.actions.selectTerminal(WT_ID, "tab-1");

    const mounted = render(() => (
      <div style={{ width: "1000px", height: "700px", display: "flex" }}>
        <AppStoreContext.Provider value={store}>
          <MainSurface onOpenFile={() => {}} onOpenSettings={() => {}} />
        </AppStoreContext.Provider>
      </div>
    ));

    await waitFor(() => {
      expect(tauriCalls("pty_subscribe").length).toBeGreaterThan(0);
    });

    // The handed-off process, not a new one.
    expect(lastInvokeArgs("pty_subscribe")).toMatchObject({ sessionId: LIVE_PTY });
    // The whole point of the slice, in one assertion.
    expect(tauriCalls("create_pty")).toHaveLength(0);

    mounted.unmount();
  });
});
