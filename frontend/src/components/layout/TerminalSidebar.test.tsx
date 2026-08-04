/// The sidebar's experimental entry, mounted.
///
/// The one property worth a render test rather than a unit test: *behind the
/// flag* has to mean the entry is not in the document, not that it is in the
/// document with `display: none`. Only mounting can tell those apart, and they
/// are the same screenshot.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import type { AppStore } from "@/store/layout";

import { TerminalSidebar } from "./TerminalSidebar";

function fakeStore(): AppStore {
  return {
    state: {
      panels: { sidebar: 256 },
      sidebarSections: { files: true, terminals: true, agents: true },
      activeWorktreeId: "wt1",
      terminalsByWorktree: {},
      workspaces: [],
      activeWorkspaceId: "ws1",
    },
    activeWorkspace: () => ({ id: "ws1", name: "api", worktrees: [] }),
    activeRepoPath: () => "/repos/api",
    activeTerminals: () => [],
    activeItem: () => null,
    actions: {
      toggleSidebarSection: vi.fn(),
      selectTerminal: vi.fn(),
      selectWorktree: vi.fn(),
      removeTerminal: vi.fn(),
      spawnTerminal: vi.fn(),
      setRepoRoot: vi.fn(),
      openCompareTab: vi.fn(),
      setPanelWidth: vi.fn(),
    },
  } as unknown as AppStore;
}

function mount() {
  // `files={false}` keeps the explorer — and its own Tauri traffic — out of a
  // test about one disclosure header.
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <TerminalSidebar files={false} />
    </AppStoreContext.Provider>
  ));
}

const entry = () => screen.queryByRole("button", { name: /agent dashboard/i });

beforeEach(() => {
  useSettings().updateExperimental({ agentDashboard: false, showIdleAgents: false });
});

describe("the Agent Dashboard sidebar entry", () => {
  /// Absent, not hidden. If this ever starts passing because the element is
  /// present-but-invisible, the flag has stopped gating the poll as well —
  /// `useAgentSessions` is what subscribes `processInfo` to terminals outside
  /// the active worktree, and it runs the moment the component mounts.
  it("is absent with the flag off", () => {
    mount();
    expect(entry()).toBeNull();
    // The section it sits under is unaffected, so this is not asserting an
    // empty render.
    expect(screen.getByRole("button", { name: /^terminals$/i })).toBeInTheDocument();
  });

  it("is present with the flag on", () => {
    useSettings().updateExperimental({ agentDashboard: true });
    mount();
    expect(entry()).toBeInTheDocument();
  });

  /// The nested flag does not gate the entry — only the Idle column. A user who
  /// turned the dashboard on and idle agents off still has a dashboard.
  it("is present with the dashboard on and idle agents off", () => {
    useSettings().updateExperimental({ agentDashboard: true, showIdleAgents: false });
    mount();
    expect(entry()).toBeInTheDocument();
  });
});
