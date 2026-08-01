/// "Discard all changes", and the filter it used to ignore.
///
/// The audit's Track 2 "Lower". The changes list filters; the button reverted
/// every change in the repository. The confirm said "all changes" so it was not
/// lying, but the list in front of the user said something else and the list is
/// what they were reading — and this is the one action in the pane that cannot
/// be undone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { resetToasts } from "@/commands/toast";
import type { AppStore } from "@/store/layout";

import { ChangesPane } from "./GitSidebar";

const REPO = "/repos/api";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: () => Promise.resolve(true) }));

function fakeStore(): AppStore {
  return { actions: { openConflictTab: vi.fn(), openDiffTab: vi.fn() } } as unknown as AppStore;
}

const STATUS = [
  { path: "src/a.ts", status: "modified", staged: false },
  { path: "src/b.ts", status: "modified", staged: false },
  { path: "docs/c.md", status: "modified", staged: false },
];

function mount() {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <ChangesPane
        repoPath={REPO}
        worktreeId="wt1"
        status={STATUS}
        selectedFile={null}
        onRefresh={() => {}}
      />
    </AppStoreContext.Provider>
  ));
}

beforeEach(() => {
  resetToasts();
  localStorage.clear();
  mockTauri({
    git_discard_all: undefined,
    git_config_identity: null,
  });
});

const discardArgs = () => tauriCalls("git_discard_all")[0]?.args as { paths: string[] | null };

describe("discard all", () => {
  it("sends no path list when nothing is filtered, so Rust discards everything", async () => {
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Discard changes in the working tree" }),
    );
    await waitFor(() => expect(tauriCalls("git_discard_all")).toHaveLength(1));
    expect(discardArgs().paths).toBeNull();
  });

  it("limits the discard to the filtered files", async () => {
    mount();
    await userEvent.type(screen.getByLabelText(/Filter changed files|Filter files|Filter/), "src/");

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Discard changes in the files matching the filter",
      }),
    );
    await waitFor(() => expect(tauriCalls("git_discard_all")).toHaveLength(1));
    expect(discardArgs().paths?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  /// The button naming its own scope is half the fix — a control that says
  /// "in the working tree" while acting on two of three files is a mismatch you
  /// only notice afterwards.
  it("renames itself when a filter is active", async () => {
    mount();
    expect(
      await screen.findByRole("button", { name: "Discard changes in the working tree" }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Filter changed files|Filter files|Filter/), "src/");
    expect(
      await screen.findByRole("button", {
        name: "Discard changes in the files matching the filter",
      }),
    ).toBeInTheDocument();
  });
});
