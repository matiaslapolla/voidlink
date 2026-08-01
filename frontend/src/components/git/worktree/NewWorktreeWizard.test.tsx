/// The new-worktree wizard's branch step, mounted.
///
/// From the 2026-07-30 audit's Track 5, WT-D4: the wizard classified a branch
/// name against **local** branches only, so a remote-only `origin/feature/x`
/// was treated as new and branched off HEAD instead of tracking — silently, at
/// the moment Create was pressed. `classifyWorktreeBranch` is unit-tested next
/// to itself; what needs the component mounted is that the wizard *asks for*
/// remotes, that it says what the name will do before the user commits, and
/// that the answer reaches `git worktree add` as `newBranch`.
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { resetToasts } from "@/commands/toast";
import {
  clearNewWorktreeRequest,
  newWorktreeRequest,
  requestNewWorktree,
} from "@/commands/worktree";
import type { AppStore } from "@/store/layout";

import { NewWorktreeWizard } from "./NewWorktreeWizard";

const REPO = "/repos/api";

function fakeStore(): AppStore {
  return {
    state: {},
    actions: {
      addWorktree: vi.fn(() => "wt-new"),
      selectWorktree: vi.fn(),
      spawnTerminal: vi.fn(async () => null),
      findTerminal: vi.fn(() => null),
    },
  } as unknown as AppStore;
}

const PLAN = {
  envFiles: [],
  depDirs: [],
  suggestedPostCreate: "",
  defaults: null,
  voidlinkGitignored: true,
  worktreesGitignored: true,
};

function mount() {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <NewWorktreeWizard />
    </AppStoreContext.Provider>
  ));
}

beforeEach(() => {
  resetToasts();
  clearNewWorktreeRequest();
  mockTauri({
    worktree_setup_plan: PLAN,
    worktree_apply_setup: { steps: [], pendingCommands: [] },
    worktree_save_defaults: null,
  });
});

/// The bug, at the point it is made: the classification query itself.
it("lists remote branches too when classifying the name", async () => {
  mockTauri({ git_list_branches: [] });
  mount();
  requestNewWorktree({ workspaceId: "ws1", repoRoot: REPO });

  await waitFor(() => expect(tauriCalls("git_list_branches")).toHaveLength(1));
  expect(lastInvokeArgs("git_list_branches")).toMatchObject({ includeRemote: true });
});

it("says a remote-only branch will be tracked, before Create is pressed", async () => {
  const user = userEvent.setup();
  mockTauri({
    git_list_branches: [
      { name: "main", isHead: true, isRemote: false, upstream: null, ahead: 0, behind: 0, aheadBehindUnknown: false, lastCommitSummary: null, lastCommitTime: null },
      { name: "origin/feature/x", isHead: false, isRemote: true, upstream: null, ahead: 0, behind: 0, aheadBehindUnknown: false, lastCommitSummary: null, lastCommitTime: null },
    ],
  });
  mount();
  requestNewWorktree({ workspaceId: "ws1", repoRoot: REPO });

  const input = await screen.findByPlaceholderText("feature/my-branch");
  await user.type(input, "feature/x");

  await screen.findByText(/tracking/);
  expect(screen.getByText("origin/feature/x")).toBeInTheDocument();
});

it("says an unknown name will branch off HEAD", async () => {
  const user = userEvent.setup();
  mockTauri({ git_list_branches: [] });
  mount();
  requestNewWorktree({ workspaceId: "ws1", repoRoot: REPO });

  const input = await screen.findByPlaceholderText("feature/my-branch");
  await user.type(input, "feature/brand-new");

  await screen.findByText(/from the current HEAD/);
});

/// The half that used to be wrong on the wire: `newBranch: true` under a name
/// a remote already carries creates a second head on someone else's work.
it("creates a remote-only branch as an existing one, so git tracks it", async () => {
  const user = userEvent.setup();
  mockTauri({
    git_list_branches: [
      { name: "origin/feature/x", isHead: false, isRemote: true, upstream: null, ahead: 0, behind: 0, aheadBehindUnknown: false, lastCommitSummary: null, lastCommitTime: null },
    ],
    git_add_worktree: { path: `${REPO}/.worktrees/feature-x`, branch: "feature/x", isMain: false },
  });
  mount();
  requestNewWorktree({ workspaceId: "ws1", repoRoot: REPO });

  const input = await screen.findByPlaceholderText("feature/my-branch");
  await user.type(input, "feature/x");
  await user.click(screen.getByText("Next"));
  await user.click(screen.getByText("Next"));
  await user.click(screen.getByText("Create worktree"));

  await waitFor(() => expect(tauriCalls("git_add_worktree")).toHaveLength(1));
  expect(lastInvokeArgs("git_add_worktree")).toMatchObject({
    branch: "feature/x",
    newBranch: false,
  });
  expect(newWorktreeRequest()).not.toBeNull();
});
