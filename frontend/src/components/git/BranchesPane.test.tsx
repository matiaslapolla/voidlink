/// The branches pane, mounted.
///
/// From the 2026-07-30 audit's Track 7 remainder — BR-A5/A7/A8/B3/C6/D3/E2 are
/// all "the row does not say what is true", and none of them is reachable
/// without rendering the row. The Tauri boundary is faked so `@/api/git` runs
/// for real: a test here notices if `listBranches` starts sending the wrong
/// argument name, which module-level mocking could not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { resetToasts } from "@/commands/toast";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import type { AppStore } from "@/store/layout";
import type { GitBranchInfo } from "@/types/git";

import { BranchesPane, relativeAge } from "./GitSidebar";

const REPO = "/repos/api";

function fakeStore(): AppStore {
  return { actions: { openCompareTab: vi.fn(), openConflictTab: vi.fn() } } as unknown as AppStore;
}

function branch(over: Partial<GitBranchInfo> = {}): GitBranchInfo {
  return {
    name: "main",
    isHead: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    aheadBehindUnknown: false,
    lastCommitSummary: null,
    lastCommitTime: null,
    lossyName: false,
    symbolicTarget: null,
    ...over,
  };
}

function mount(props: { repoPath?: string } = {}) {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <BranchesPane
        repoPath={props.repoPath ?? REPO}
        worktreeId="wt1"
        onCheckout={() => {}}
        showTags={false}
      />
    </AppStoreContext.Provider>
  ));
}

beforeEach(() => {
  resetToasts();
  localStorage.clear();
});

describe("grouping local and remote rows", () => {
  /// BR-A7. The two kinds interleaved through one sort, so in any clone of any
  /// size the handful of branches you can act on were scattered through rows
  /// that only exist to be read.
  it("hides remote branches behind a labelled, counted disclosure", async () => {
    mockTauri({
      git_list_branches: [
        branch({ name: "main", isHead: true }),
        branch({ name: "origin/main", isRemote: true }),
        branch({ name: "origin/topic", isRemote: true }),
      ],
    });
    mount();

    await screen.findByText("Local (1)");
    const toggle = await screen.findByRole("button", { name: /Remote \(2\)/ });
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(await screen.findByText("origin/main")).toBeInTheDocument();
  });

  /// BR-B3. A remote row hardcodes 0/0 and no upstream in Rust, so with no
  /// label it draws exactly like a local branch that is in sync.
  it("marks a remote row as remote", async () => {
    mockTauri({
      git_list_branches: [branch({ name: "origin/main", isRemote: true })],
    });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Remote \(1\)/ }));
    expect(await screen.findByText("remote")).toBeInTheDocument();
  });
});

describe("what a row says", () => {
  /// BR-A8. `lastCommitSummary` and `lastCommitTime` cost a `find_commit` per
  /// branch per pulse and were rendered nowhere — leaving the pane unable to
  /// answer the one question a branch list is for: which of these is stale?
  it("shows the last commit and how long ago it was", async () => {
    const twoHoursAgo = Math.round(Date.now() / 1000) - 2 * 60 * 60;
    mockTauri({
      git_list_branches: [
        branch({ name: "main", lastCommitSummary: "fix the thing", lastCommitTime: twoHoursAgo }),
      ],
    });
    mount();
    expect(await screen.findByText(/fix the thing · 2h ago/)).toBeInTheDocument();
  });

  it("shows the upstream a branch tracks", async () => {
    mockTauri({ git_list_branches: [branch({ name: "main", upstream: "origin/main" })] });
    mount();
    expect(await screen.findByTitle("Tracking origin/main")).toBeInTheDocument();
  });

  /// BR-A5. A symbolic ref under `refs/heads/` is an alias. It rendered as an
  /// ordinary branch, so deleting it removed the alias while the user believed
  /// they had deleted the branch it names.
  it("says what a symbolic ref points at", async () => {
    mockTauri({ git_list_branches: [branch({ name: "stable", symbolicTarget: "v2" })] });
    mount();
    expect(await screen.findByTitle("Symbolic ref pointing at v2")).toBeInTheDocument();
  });

  /// BR-A4. A non-UTF-8 name used to be dropped from the list entirely. Listed
  /// is better — but only with every action off it, because the lossy string is
  /// not what git holds and two invalid names can flatten to the same one.
  it("lists a lossily-named branch with its actions disabled", async () => {
    mockTauri({ git_list_branches: [branch({ name: "caf�", lossyName: true })] });
    mount();
    const del = await screen.findByRole("button", { name: /^Delete caf/ });
    expect(del).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Rename caf/ })).toBeDisabled();
  });
});

describe("filtering", () => {
  /// BR-E2. The old matcher answered yes/no and its subsequence fallback let
  /// `main` match `feature/my-api-normalizer`, with no indication of which
  /// characters had matched even though `FuzzyText` was already imported.
  it("ranks a real match above a scattered subsequence one", async () => {
    mockTauri({
      git_list_branches: [
        branch({ name: "feature/my-api-normalizer" }),
        branch({ name: "main" }),
      ],
    });
    const { container } = mount();
    await screen.findByText("main");

    await userEvent.type(screen.getByLabelText("Filter branches"), "main");
    await waitFor(() => {
      const names = [...container.querySelectorAll("[aria-label^='Checkout']")].map(
        (el) => el.getAttribute("aria-label"),
      );
      expect(names[0]).toBe("Checkout main");
    });
  });

  it("highlights the characters that matched", async () => {
    mockTauri({ git_list_branches: [branch({ name: "release/2.0" })] });
    const { container } = mount();
    await screen.findByText("release/2.0");
    await userEvent.type(screen.getByLabelText("Filter branches"), "rel");
    await waitFor(() => {
      expect(container.querySelector("mark, .bg-primary\\/15")).toBeTruthy();
    });
  });
});

describe("staying honest across a refresh", () => {
  /// BR-C6. Solid keeps a resource's previous value while a refetch is in
  /// flight, so switching worktrees rendered the *old* repository's branches —
  /// under a header already showing the new repo. Checking out from that list
  /// would name a branch that may not exist here.
  it("does not render the previous repository's branches while switching", async () => {
    let release: (() => void) | null = null;
    mockTauri({
      git_list_branches: async ({ repoPath }: { repoPath: string }) => {
        if (repoPath === "/repos/other") {
          await new Promise<void>((r) => (release = r));
          return [branch({ name: "other-only" })];
        }
        return [branch({ name: "api-only" })];
      },
    });

    const [repo, setRepo] = (await import("solid-js")).createSignal(REPO);
    render(() => (
      <AppStoreContext.Provider value={fakeStore()}>
        <BranchesPane repoPath={repo()} worktreeId="wt1" onCheckout={() => {}} showTags={false} />
      </AppStoreContext.Provider>
    ));
    await screen.findByText("api-only");

    setRepo("/repos/other");
    await screen.findByText(/Loading branches/);
    expect(screen.queryByText("api-only")).not.toBeInTheDocument();

    release!();
    expect(await screen.findByText("other-only")).toBeInTheDocument();
  });

  /// BR-D3. The menu holds a branch *name*, captured on right-click, and a
  /// pulse is exactly when that name can stop meaning what it did.
  it("closes the context menu on a refs pulse", async () => {
    mockTauri({ git_list_branches: [branch({ name: "topic" })] });
    mount();
    const row = await screen.findByText("topic");

    await userEvent.pointer({ keys: "[MouseRight]", target: row });
    expect(await screen.findByText(/Merge topic into current/)).toBeInTheDocument();

    emitGitRefsChanged();
    await waitFor(() =>
      expect(screen.queryByText(/Merge topic into current/)).not.toBeInTheDocument(),
    );
  });

  /// BR-C5. `<For>` is keyed by reference and this list is rebuilt on every
  /// pulse, so an unchanged row's DOM was torn down and rebuilt — taking the
  /// focused button with it.
  it("keeps a row's DOM node across a pulse that changed nothing", async () => {
    mockTauri({ git_list_branches: () => [branch({ name: "topic" })] });
    mount();
    const before = await screen.findByText("topic");

    emitGitRefsChanged();
    await waitFor(() => expect(tauriCalls("git_list_branches").length).toBeGreaterThan(1));
    expect(screen.getByText("topic")).toBe(before);
  });
});

describe("relativeAge", () => {
  const now = 1_800_000_000_000;
  const at = (secondsAgo: number) => relativeAge(Math.round(now / 1000) - secondsAgo, now);

  it("reads in the largest unit that is still true", () => {
    expect(at(5)).toBe("just now");
    expect(at(90)).toBe("1m ago");
    expect(at(3 * 3600)).toBe("3h ago");
    expect(at(5 * 86400)).toBe("5d ago");
    expect(at(400 * 86400)).toBe("1y ago");
  });

  /// A commit stamped in the future is a real thing — a colleague's clock, a
  /// rebase with a fixed date — and "in 3 hours" reads as a bug.
  it("clamps a future timestamp rather than counting forwards", () => {
    expect(at(-3600)).toBe("just now");
  });
});
