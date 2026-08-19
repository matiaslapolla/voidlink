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

const confirmDialog = vi.fn(async () => true);
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmDialog(...(args as [])),
}));

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
    aheadBehind: null,
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
  confirmDialog.mockClear();
  confirmDialog.mockResolvedValue(true);
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

describe("a remote row's ahead/behind", () => {
  /// Every remote row is behind the disclosure — open it and hand back the
  /// screen.
  async function showRemotes(count: number) {
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`Remote \\(${count}\\)`) }));
  }

  /// CMP-F22. The counts exist now; the row has to say what they are against,
  /// because `↑2 ↓0` on `origin/feat` is otherwise ambiguous — the remote's own
  /// upstream? the default branch? — and the answer is not guessable from the
  /// row.
  it("names the local branch it counted against", async () => {
    mockTauri({
      git_list_branches: [
        branch({
          name: "origin/feat",
          isRemote: true,
          aheadBehind: { ahead: 2, behind: 0, against: "feat" },
        }),
      ],
    });
    mount();
    await showRemotes(1);
    expect(
      await screen.findByTitle("origin/feat is 2 ahead of and 0 behind local feat"),
    ).toBeInTheDocument();
    expect(screen.getByText("↑2")).toBeInTheDocument();
    // Both sides, even the zero: "you have pushed everything" is half of what
    // the row is being asked.
    expect(screen.getByText("↓0")).toBeInTheDocument();
  });

  /// A remote branch level with its local counterpart is a *measured* zero, and
  /// the chip has to render it — it is the answer someone opens this disclosure
  /// to get.
  it("renders a real ↑0 ↓0 for a remote level with its local branch", async () => {
    mockTauri({
      git_list_branches: [
        branch({
          name: "origin/main",
          isRemote: true,
          aheadBehind: { ahead: 0, behind: 0, against: "main" },
        }),
      ],
    });
    mount();
    await showRemotes(1);
    expect(await screen.findByText("↑0")).toBeInTheDocument();
    expect(screen.getByText("↓0")).toBeInTheDocument();
  });

  /// The other half of the decision: no local branch of that name means there
  /// is nothing to compare against, and `↑0 ↓0` there would claim to be in sync
  /// with a branch that does not exist.
  it("shows no chip at all for a remote with no local counterpart", async () => {
    mockTauri({
      git_list_branches: [
        branch({ name: "origin/spike", isRemote: true, aheadBehind: null }),
      ],
    });
    mount();
    await showRemotes(1);
    await screen.findByText("origin/spike");
    expect(screen.queryByText("↑0")).not.toBeInTheDocument();
    expect(screen.queryByText("↓0")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/ahead of and/)).not.toBeInTheDocument();
  });

  /// A local branch in sync has always drawn nothing, and the null/zero split
  /// must not turn every quiet local row into `↑0 ↓0`.
  it("still hides a zero on a local row", async () => {
    mockTauri({
      git_list_branches: [
        branch({
          name: "main",
          upstream: "origin/main",
          aheadBehind: { ahead: 0, behind: 0, against: "origin/main" },
        }),
      ],
    });
    mount();
    await screen.findByText("main");
    expect(screen.queryByText("↑0")).not.toBeInTheDocument();
    expect(screen.queryByText("↓0")).not.toBeInTheDocument();
  });

  /// ...but a local row that *has* something to report now says what it is
  /// reporting against, which it never used to.
  it("names the upstream on a local row that is ahead", async () => {
    mockTauri({
      git_list_branches: [
        branch({
          name: "main",
          upstream: "origin/main",
          aheadBehind: { ahead: 3, behind: 0, against: "origin/main" },
        }),
      ],
    });
    mount();
    expect(
      await screen.findByTitle("main is 3 ahead of and 0 behind origin/main"),
    ).toBeInTheDocument();
    expect(screen.getByText("↑3")).toBeInTheDocument();
    expect(screen.queryByText("↓0")).not.toBeInTheDocument();
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

describe("checking out a branch with a dirty tree", () => {
  /// Regression guard for the silent-auto-stash report: clicking a branch used
  /// to stash a dirty tree with no warning. `checkout` now probes with
  /// `allowStash: false` first; a `dirty: true` result must surface the same
  /// confirm dialog `FileTree`'s delete flow uses, and only *that* dialog's
  /// "yes" should trigger a second call with `allowStash: true`.
  function mockDirtyThenClean() {
    let calls = 0;
    mockTauri({
      git_list_branches: [branch({ name: "other" })],
      git_safe_checkout: ({ allowStash }: { allowStash?: boolean }) => {
        calls += 1;
        if (!allowStash) {
          // The current branch never moved — nothing was touched.
          return { branch: "main", autoStashed: null, dirty: true };
        }
        return { branch: "other", autoStashed: "voidlink-auto: pre-switch from main → other", dirty: false };
      },
    });
    return { callCount: () => calls };
  }

  it("probes with allowStash: false, then asks before stashing", async () => {
    mockDirtyThenClean();
    mount();

    await userEvent.click(await screen.findByRole("button", { name: "Checkout other" }));

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(tauriCalls("git_safe_checkout")[0].args.allowStash).toBe(false);
    // Confirmed by default (`confirmDialog` resolves `true`); the retry
    // carries `allowStash: true`.
    await waitFor(() => expect(tauriCalls("git_safe_checkout")).toHaveLength(2));
    expect(tauriCalls("git_safe_checkout")[1].args.allowStash).toBe(true);
  });

  it("stashes and switches only after the dialog is confirmed", async () => {
    const onCheckout = vi.fn();
    mockDirtyThenClean();
    render(() => (
      <AppStoreContext.Provider value={fakeStore()}>
        <BranchesPane repoPath={REPO} worktreeId="wt1" onCheckout={onCheckout} showTags={false} />
      </AppStoreContext.Provider>
    ));

    await userEvent.click(await screen.findByRole("button", { name: "Checkout other" }));
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    expect(tauriCalls("git_safe_checkout")).toHaveLength(2);
  });

  it("switches nothing and never retries when the dialog is cancelled", async () => {
    confirmDialog.mockResolvedValue(false);
    const onCheckout = vi.fn();
    mockDirtyThenClean();
    render(() => (
      <AppStoreContext.Provider value={fakeStore()}>
        <BranchesPane repoPath={REPO} worktreeId="wt1" onCheckout={onCheckout} showTags={false} />
      </AppStoreContext.Provider>
    ));

    await userEvent.click(await screen.findByRole("button", { name: "Checkout other" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));

    // Give any (wrongly-fired) retry a chance to land before asserting its
    // absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(tauriCalls("git_safe_checkout")).toHaveLength(1);
    expect(onCheckout).not.toHaveBeenCalled();
  });

  it("never probes with a stash-permitting default — allowStash is explicit", async () => {
    // A caller that forgets to pass `allowStash` gets Rust's safe default
    // (`false`), but the frontend must not rely on that: it always states its
    // intent. Regression guard for reintroducing a bare `safeCheckout(repo,
    // branch)` call on this path.
    mockDirtyThenClean();
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Checkout other" }));
    await waitFor(() => expect(tauriCalls("git_safe_checkout").length).toBeGreaterThan(0));
    expect(tauriCalls("git_safe_checkout")[0].args).toHaveProperty("allowStash");
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
