/// The git sidebar, mounted — for the first time.
///
/// This is the surface the 2026-07-30 audit put the most findings on and the
/// only one of them that had never been rendered in a test. Roughly a hundred
/// fixes shipped through this file having been read rather than run, and three
/// of them are only observable with it mounted:
///
///   * **A file that is staged and then edited again is two rows, not one.**
///     Git reports `MM` as two `GitFileStatus` entries with the same path and
///     opposite `staged` flags, and they do opposite things — `Space` unstages
///     the first and stages the second. Everything that used to key on a path
///     had to move to `section + path` (`changesNav.ts`'s `rowKey`), because a
///     path stopped being unique in this list.
///   * **A refresh must not blank the list.** `refreshAll` refetches two
///     resources; a `<Show>` gated on the wrong thing turns every filesystem
///     pulse into a flash of the clean-tree empty state.
///   * **A section that throws must lose only itself.** Solid resources
///     rethrow when read, and this file reads them straight inside JSX.
///
/// Two providers, and only two. `AppStoreContext` is a real
/// `createAppStore({ persist: false })` rather than a hand-written fake: the
/// sidebar reads `state.gitSections`, `state.gitSectionOrder`, `state.panels`
/// and four `actions`, and a fake of that surface would be a second
/// implementation of the store to keep in step. `useSettings` needs no
/// provider — it is a module singleton. Everything below is declared through
/// the Tauri stub, so `@/api/git` and `@/store/*` run for real.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore, type AppStore, type GitSectionKey } from "@/store/layout";
import { resetToasts, useToasts } from "@/commands/toast";
import type { GitFileStatus, GitRepoInfo } from "@/types/git";

import { GitSidebar } from "./GitSidebar";

const REPO = "/repos/api";

function repoInfo(partial: Partial<GitRepoInfo> = {}): GitRepoInfo {
  return {
    repoPath: REPO,
    currentBranch: "main",
    headOid: "0000000",
    isDetached: false,
    isClean: false,
    remoteUrl: "git@example.com:acme/api.git",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    aheadBehindUnknown: false,
    operation: null,
    hasConflicts: false,
    ...partial,
  };
}

function entry(
  path: string,
  staged: boolean,
  status: GitFileStatus["status"] = "modified",
): GitFileStatus {
  return { path, status, staged };
}

/// Every command a full mount reaches for, answered with the boring case. A
/// test that cares about one of them overrides just that one — `mockTauri`
/// merges — which keeps each test's fixture the size of what it is actually
/// about.
function baseHandlers() {
  return {
    git_repo_info: repoInfo(),
    git_file_status: [] as GitFileStatus[],
    git_stash_list: [],
    git_config_identity: { name: "Ada Lovelace", email: "ada@example.com" },
    git_list_branches: [],
    git_list_refs: { branches: [], tags: [], recentCommits: [], detachedHead: null },
    git_stack_current: null,
    git_log: [],
  };
}

/// Sections open by default. Named here rather than re-derived, because most
/// tests below want *only* Changes and the cheapest way to say that is to
/// toggle the rest off before mounting.
const DEFAULT_OPEN: GitSectionKey[] = ["changes", "branches", "stack", "history", "openedDiffs"];

interface MountOptions {
  /// Which sections to leave open. Defaults to Changes alone: the other four
  /// each mount their own resources and none of them is what most of these
  /// tests are about.
  sections?: GitSectionKey[];
}

function mountSidebar(options: MountOptions = {}) {
  const store: AppStore = createAppStore({ persist: false });
  const open = options.sections ?? ["changes"];
  for (const key of DEFAULT_OPEN) {
    if (!open.includes(key)) store.actions.toggleGitSection(key);
  }
  for (const key of open) {
    if (!store.state.gitSections[key]) store.actions.toggleGitSection(key);
  }
  const worktreeId = store.state.activeWorktreeId;
  const utils = render(() => (
    <AppStoreContext.Provider value={store}>
      <GitSidebar repoPath={REPO} worktreeId={worktreeId} />
    </AppStoreContext.Provider>
  ));
  return { ...utils, store, worktreeId };
}

/// The sidebar paints its header before `git_file_status` resolves, so a test
/// that asserts on rows immediately races the resource. Waiting on the branch
/// name is waiting on the first round-trip having landed.
async function settled() {
  await waitFor(() => expect(screen.getByLabelText("Refresh")).toBeInTheDocument());
}

const messages = () => useToasts().toasts().map((t) => t.message);

/// How many rows a section header claims, or `null` when the header is not
/// rendered at all. The count and the header's presence are two different
/// facts and several tests below turn on the difference — "Conflicts (0)"
/// above an empty section was itself a finding.
///
/// Read off the header rather than by counting rows because that is what a
/// user reads: the number is the claim, the rows are the evidence.
///
/// Not `getByText`: these headers wrap their number in a `<span>` for tabular
/// figures, and testing-library's text matcher sees only an element's *direct*
/// text nodes — so "Staged (12)" is three nodes and no string matcher ever
/// sees it whole. Scoped to the listbox by role rather than to a class.
function sectionCount(label: string): number | null {
  const pattern = new RegExp(`^${label} \\((\\d+)\\)$`);
  const list = screen.getByRole("listbox", { name: "Changed files" });
  for (const el of list.querySelectorAll<HTMLElement>("*")) {
    const found = (el.textContent ?? "").replace(/\s+/g, " ").trim().match(pattern);
    if (found) return Number(found[1]);
  }
  return null;
}

beforeEach(() => {
  resetToasts();
  mockTauri(baseHandlers());
});

afterEach(() => {
  // `createAppStore` hydrates from localStorage even when it does not write,
  // and `useSettings` is a module singleton that does. Left alone, a test that
  // saves a repo identity leaks into the next one.
  localStorage.clear();
});

// ─── The whole thing, once ───────────────────────────────────────────────────

describe("mounting the sidebar", () => {
  /// The test that did not exist. Every default-open section renders its own
  /// body, and none of them renders the error boundary's fallback — which is
  /// what a missing command, a rethrowing resource or a shape mismatch between
  /// `@/api/git` and the payload would all show up as.
  it("renders every default section without any of them falling over", async () => {
    mockTauri({ git_file_status: [entry("src/a.ts", false)] });
    mountSidebar({ sections: DEFAULT_OPEN });
    await settled();

    for (const label of ["Changes", "Branches", "Stack", "History", "Opened Diffs"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  it("shows the current branch and the repository's dirty marker", async () => {
    mountSidebar();
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.getByText(/• changes/)).toBeInTheDocument();
  });

  /// A collapsed section unmounts its pane, so a collapsed Stashes section had
  /// no way to say it held anything — twelve stashes looked exactly like zero,
  /// and stashed work is precisely the kind that gets forgotten.
  it("counts stashes while the section is collapsed", async () => {
    mockTauri({ git_stash_list: [{}, {}, {}] });
    mountSidebar({ sections: ["changes"] });
    await settled();

    const header = screen.getByRole("button", { name: /^Stashes/ });
    // Inside the header, so it is part of its accessible name too — a screen
    // reader hears the count rather than a bare "Stashes".
    await waitFor(() => expect(within(header).getByText("3")).toBeInTheDocument());
  });

  /// …and stops paying for that count once the section is open and listing
  /// them itself. The badge's whole justification is that nothing else knows.
  it("does not count them again once the section is open", async () => {
    mockTauri({ git_stash_list: [{}, {}, {}] });
    mountSidebar({ sections: ["changes", "stashes"] });
    await settled();
    await waitFor(() => expect(tauriCalls("git_stash_list").length).toBeGreaterThan(0));

    // One call, from `StashesPane` itself — not a second from the badge.
    expect(tauriCalls("git_stash_list")).toHaveLength(1);
  });
});

// ─── The confirmed status bug ────────────────────────────────────────────────

/// `MM` — staged, then edited again. Git reports it as two entries with one
/// path, and the two rows do opposite things. This is the finding that forced
/// `rowKey` to be `section + path`, and every assertion here fails against a
/// list keyed by path alone.
describe("a file that is staged and re-modified", () => {
  const MM: GitFileStatus[] = [entry("src/a.ts", true), entry("src/a.ts", false)];

  it("appears in both sections at once", async () => {
    mockTauri({ git_file_status: MM });
    mountSidebar();
    await settled();

    await waitFor(() => expect(screen.getAllByText("src/a.ts")).toHaveLength(2));
    // The two counters are the honest form of the assertion: one row each,
    // rather than two rows in one section and none in the other.
    expect(sectionCount("Staged")).toBe(1);
    expect(sectionCount("Changes")).toBe(1);
  });

  /// The two rows offer opposite controls, and the accessible names are what
  /// tells them apart. A single row would offer only one of these.
  it("offers Unstage on one row and Stage on the other", async () => {
    mockTauri({ git_file_status: MM });
    mountSidebar();
    await settled();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unstage src/a.ts" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Stage src/a.ts" })).toBeInTheDocument();
  });

  it("stages from the unstaged row and unstages from the staged one", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: MM, git_stage_files: undefined, git_unstage_files: undefined });
    mountSidebar();
    await settled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stage src/a.ts" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Stage src/a.ts" }));
    await waitFor(() => expect(tauriCalls("git_stage_files")).toHaveLength(1));
    expect(lastInvokeArgs("git_stage_files")).toMatchObject({ paths: ["src/a.ts"] });
    // The other row's control is a different command, not the same one twice.
    expect(tauriCalls("git_unstage_files")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Unstage src/a.ts" }));
    await waitFor(() => expect(tauriCalls("git_unstage_files")).toHaveLength(1));
  });

  /// The bug `rowKey`'s header describes, exactly: with the cursor keyed by
  /// path, every lookup found the *staged* row, so `Space` on the unstaged row
  /// unstaged the other one.
  it("Space acts on the row the cursor is on, not on the first row with that path", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: MM, git_stage_files: undefined, git_unstage_files: undefined });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getAllByText("src/a.ts")).toHaveLength(2));

    const list = screen.getByRole("listbox", { name: "Changed files" });
    list.focus();
    // Row 1 of 2 is the staged one — `flattenChanges` renders conflicted,
    // staged, unstaged in that order.
    await user.keyboard("{ArrowDown} ");
    await waitFor(() => expect(tauriCalls("git_unstage_files")).toHaveLength(1));
    expect(tauriCalls("git_stage_files")).toHaveLength(0);

    // …and down one more is the unstaged row, whose Space does the opposite.
    await user.keyboard("{ArrowDown} ");
    await waitFor(() => expect(tauriCalls("git_stage_files")).toHaveLength(1));
  });

  /// The other half of the same finding: with one key for two rows, both drew
  /// the focus ring at once and the list claimed two active descendants.
  it("puts the cursor on exactly one of the two rows", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: MM });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getAllByText("src/a.ts")).toHaveLength(2));

    screen.getByRole("listbox", { name: "Changed files" }).focus();
    await user.keyboard("{ArrowDown}");

    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
  });

  /// `Backspace` discards, and only the unstaged section offers it — the mouse
  /// UI puts no discard control on a staged row, so a keyboard binding that
  /// discarded staged work would destroy something the visible interface said
  /// was safe.
  it("refuses to discard from the staged row", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: MM });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getAllByText("src/a.ts")).toHaveLength(2));

    screen.getByRole("listbox", { name: "Changed files" }).focus();
    await user.keyboard("{ArrowDown}{Backspace}");
    expect(tauriCalls("git_discard_file")).toHaveLength(0);
  });

  /// Highlighting on path alone lit both rows together, saying two diff tabs
  /// were open when one was.
  it("highlights only the side whose diff is actually open", async () => {
    mockTauri({ git_file_status: MM });
    const { store, worktreeId } = mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getAllByText("src/a.ts")).toHaveLength(2));

    store.actions.openDiffTab(worktreeId, "src/a.ts", true);
    await waitFor(() => {
      const pressed = screen
        .getAllByRole("button", { name: "Open diff for src/a.ts" })
        .filter((b) => b.getAttribute("aria-pressed") === "true");
      expect(pressed).toHaveLength(1);
    });
  });
});

// ─── Refresh ────────────────────────────────────────────────────────────────

describe("refreshing", () => {
  /// The list must survive its own refetch. A filesystem watcher pulses this
  /// constantly, and a list that empties for a frame each time is a list that
  /// flickers between the files and the clean-tree empty state.
  it("keeps the rows on screen while the refetch is in flight", async () => {
    const user = userEvent.setup();
    let release: ((v: GitFileStatus[]) => void) | undefined;
    let calls = 0;
    mockTauri({
      git_file_status: () => {
        calls += 1;
        if (calls === 1) return [entry("src/a.ts", false)];
        return new Promise<GitFileStatus[]>((resolve) => {
          release = resolve;
        });
      },
    });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Refresh"));
    await waitFor(() => expect(calls).toBe(2));

    // Mid-flight. The row is still there and the "working tree matches HEAD"
    // empty state — a *different sentence* from "no match", deliberately — is
    // not.
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.queryByText(/matches HEAD/)).not.toBeInTheDocument();

    release?.([entry("src/a.ts", false), entry("src/b.ts", false)]);
    await waitFor(() => expect(screen.getByText("src/b.ts")).toBeInTheDocument());
  });

  /// `refreshAll` is wrapped in `dedupeConcurrent` because a mutation calls
  /// `props.onRefresh()` *and* emits the shared pulse this same handler
  /// answers — two callers, one round-trip.
  it("shares one round-trip between callers that ask at once", async () => {
    const user = userEvent.setup();
    let release: ((v: GitFileStatus[]) => void) | undefined;
    let calls = 0;
    mockTauri({
      git_file_status: () => {
        calls += 1;
        if (calls === 1) return [];
        return new Promise<GitFileStatus[]>((resolve) => {
          release = resolve;
        });
      },
    });
    mountSidebar();
    await settled();

    const button = screen.getByLabelText("Refresh");
    await user.click(button);
    await waitFor(() => expect(calls).toBe(2));
    await user.click(button);
    await user.click(button);

    expect(calls).toBe(2);
    release?.([]);
  });

  /// The palette's "Refresh git status" and every cross-pane refresh (hunk
  /// staging, for one) fan out through a window event rather than a reference
  /// to this component.
  it("answers the shared refresh event", async () => {
    mountSidebar();
    await settled();
    await waitFor(() => expect(tauriCalls("git_file_status")).toHaveLength(1));

    window.dispatchEvent(new Event("voidlink:refresh-git"));
    await waitFor(() => expect(tauriCalls("git_file_status")).toHaveLength(2));
  });

  /// …and stops answering once it is gone. The panel unmounts whenever it is
  /// collapsed, and a listener that outlives it refetches into a disposed
  /// owner.
  it("stops answering it after unmount", async () => {
    const { unmount } = mountSidebar();
    await settled();
    await waitFor(() => expect(tauriCalls("git_file_status")).toHaveLength(1));

    unmount();
    window.dispatchEvent(new Event("voidlink:refresh-git"));
    await new Promise((r) => setTimeout(r, 20));
    expect(tauriCalls("git_file_status")).toHaveLength(1);
  });
});

// ─── Failure ────────────────────────────────────────────────────────────────

describe("when a section cannot be read", () => {
  /// Per-section boundaries rather than one around the lot: a repo state that
  /// breaks Branches should not take Changes with it.
  ///
  /// `git_list_refs` is the failure that reaches the boundary. `BranchesPane`
  /// reads it inside a memo whose result goes straight into JSX, and a Solid
  /// resource *rethrows* when read — so this is the shape the boundary exists
  /// for, and it is the shape the whole aside used to take on.
  it("renders the boundary for the failing section only", async () => {
    mockTauri({
      git_file_status: [entry("src/a.ts", false)],
      git_list_refs: () => {
        throw new Error("not a git repository");
      },
    });
    mountSidebar({ sections: ["changes", "branches"] });
    await settled();

    await waitFor(() =>
      expect(screen.getByText("Branches could not be read")).toBeInTheDocument(),
    );
    // The message itself, not a generic apology — it is the only thing on
    // screen that says what to fix.
    expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
    // Changes is untouched: still listing files, still offering its controls.
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stage src/a.ts" })).toBeInTheDocument();
  });

  it("retries through the same refresh pulse everything else uses", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockTauri({
      git_list_refs: () => {
        if (fail) throw new Error("index.lock exists");
        return { branches: [], tags: [], recentCommits: [], detachedHead: null };
      },
    });
    mountSidebar({ sections: ["branches"] });
    await waitFor(() => expect(screen.getByText(/index\.lock/)).toBeInTheDocument());

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByText("Branches could not be read")).not.toBeInTheDocument(),
    );
  });

  /// The boundary is the last resort, not the first. A pane that *can* say
  /// something more specific about its own failure should — and the branch
  /// list does, because "could not list branches" is a smaller and more
  /// actionable claim than "Branches could not be read", and it leaves the
  /// section's own actions on screen.
  it("lets a pane that handles its own failure keep its section", async () => {
    mockTauri({
      git_list_branches: () => {
        throw new Error("bad ref");
      },
    });
    mountSidebar({ sections: ["branches"] });

    await waitFor(() => expect(screen.getByText(/Could not list branches/)).toBeInTheDocument());
    expect(screen.queryByText("Branches could not be read")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New branch" })).toBeInTheDocument();
  });

  /// The header deliberately has *no* boundary: losing it means losing the
  /// refresh button that fixes the problem. So `repoInfo` goes through
  /// accessors that turn an error into "no data plus a message" instead of
  /// rethrowing into JSX.
  it("survives the repo state itself failing, and says so", async () => {
    mockTauri({
      git_repo_info: () => {
        throw new Error("HEAD is unborn");
      },
      git_file_status: [entry("src/a.ts", false)],
    });
    mountSidebar();

    await waitFor(() => expect(screen.getByText("git state unavailable")).toBeInTheDocument());
    // The controls that would let a user recover are still there…
    expect(screen.getByLabelText("Refresh")).toBeInTheDocument();
    // …and the rest of the sidebar rendered rather than going white.
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    // A dash, not a branch name invented from nothing.
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

// ─── The rest of the change list ────────────────────────────────────────────

describe("the change list", () => {
  it("puts a conflicted file in its own section and nowhere else", async () => {
    mockTauri({ git_file_status: [entry("src/c.ts", false, "conflicted")] });
    mountSidebar();
    await settled();

    await waitFor(() => expect(sectionCount("Conflicts")).toBe(1));
    // A conflict row is an `option`, not a button — it belongs to the same
    // listbox as every other row, because the three lists are one keyboard
    // surface.
    expect(screen.getByRole("option", { name: /src\/c\.ts/ })).toBeInTheDocument();
    expect(screen.getByTitle("Resolve conflict in src/c.ts")).toBeInTheDocument();
    expect(sectionCount("Staged")).toBeNull();
    expect(sectionCount("Changes")).toBe(0);
  });

  /// A conflicted file is `staged: true` in git's eyes, and the staged list
  /// filters it out explicitly — a conflicted file listed as ready to commit
  /// is a file you commit with conflict markers in it.
  it("keeps a conflicted file out of the staged list even when git calls it staged", async () => {
    mockTauri({ git_file_status: [entry("src/c.ts", true, "conflicted")] });
    mountSidebar();
    await settled();

    await waitFor(() => expect(sectionCount("Conflicts")).toBe(1));
    expect(sectionCount("Staged")).toBeNull();
  });

  /// Two emptinesses, two sentences. A clean tree is good news; a filter that
  /// matched nothing is a typo, and sharing one line between them makes the
  /// second unfixable.
  it("says the tree is clean rather than that nothing matched", async () => {
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getByText(/matches HEAD/)).toBeInTheDocument());
  });

  it("says nothing matched rather than that the tree is clean", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: [entry("src/a.ts", false)] });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox", { name: /filter changed files/i }), "zzz");
    await waitFor(() => expect(screen.getByText(/No changed file matches/)).toBeInTheDocument());
    expect(screen.queryByText(/matches HEAD/)).not.toBeInTheDocument();
  });

  /// The header counts the *filtered* rows, so it has to be gated on them too.
  /// Gating on the unfiltered list rendered "Conflicts (0)" above an empty
  /// section — a header asserting there are no conflicts while a real one
  /// exists.
  it("hides the Conflicts header when the filter excludes every conflict", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: [entry("src/c.ts", false, "conflicted")] });
    mountSidebar();
    await settled();
    await waitFor(() => expect(sectionCount("Conflicts")).toBe(1));

    await user.type(screen.getByRole("textbox", { name: /filter changed files/i }), "zzz");
    await waitFor(() => expect(sectionCount("Conflicts")).toBeNull());
  });

  /// A path that survived a lossy UTF-8 decode is not the byte string git
  /// holds, so every command that takes one would fail on it. Listing the row
  /// fixed the file being invisible; leaving its buttons live would have
  /// traded that for three buttons that error.
  it("lists a lossy path but turns its actions off", async () => {
    mockTauri({
      git_file_status: [{ ...entry("src/bad?.ts", false), lossyPath: true }],
    });
    mountSidebar();
    await settled();

    await waitFor(() => expect(screen.getByText("src/bad?.ts")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Stage src/bad?.ts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open diff for src/bad?.ts" })).toBeDisabled();
  });

  /// The filter box and the list are one keyboard surface: `ArrowDown` out of
  /// the box lands on the first row rather than making the user reach for the
  /// mouse to cross between them.
  it("moves from the filter box into the list", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: [entry("src/a.ts", false)] });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());

    const box = screen.getByRole("textbox", { name: /filter changed files/i });
    box.focus();
    await user.keyboard("{ArrowDown}");

    const list = screen.getByRole("listbox", { name: "Changed files" });
    expect(list).toHaveFocus();
    expect(list.getAttribute("aria-activedescendant")).toBeTruthy();
  });
});

// ─── The header ─────────────────────────────────────────────────────────────

describe("the upstream pill", () => {
  it("opens a three-dot compare against the upstream it names", async () => {
    const user = userEvent.setup();
    mockTauri({ git_repo_info: repoInfo({ ahead: 1, behind: 12 }) });
    const { store, worktreeId } = mountSidebar();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Compare with upstream" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Compare with upstream" }));

    const tabs = store.state.compareTabsByWorktree[worktreeId] ?? [];
    expect(tabs).toHaveLength(1);
    // Merge-base, because the pill shows the *symmetric* difference: at ↑1 ↓12
    // a two-dot diff renders upstream's twelve commits as deletions of your
    // colleagues' work.
    expect(tabs[0]).toMatchObject({
      baseRef: "origin/main",
      headRef: "main",
      useMergeBase: true,
    });
  });

  /// No upstream means there is nothing to compare *against*. The old fallback
  /// invented "main", which is a ref that may not exist here and is the wrong
  /// answer even when it does.
  it("says so rather than inventing a ref when there is no upstream", async () => {
    const user = userEvent.setup();
    mockTauri({ git_repo_info: repoInfo({ upstream: null, ahead: 3 }) });
    const { store, worktreeId } = mountSidebar();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Compare with upstream" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Compare with upstream" }));
    expect(messages().join(" ")).toMatch(/no upstream/i);
    expect(store.state.compareTabsByWorktree[worktreeId] ?? []).toHaveLength(0);
  });

  /// An operation in progress is the one repository state that changes what
  /// every other control means, so it gets a banner above all of them.
  it("raises the operation banner when a rebase is in progress", async () => {
    mockTauri({ git_repo_info: repoInfo({ operation: "rebase", hasConflicts: true }) });
    mountSidebar();
    await waitFor(() => expect(screen.getByText(/rebase in progress/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
  });
});

// ─── Section order ──────────────────────────────────────────────────────────

/// Seven sections in a 320px column: whichever two you actually use should be
/// reachable without scrolling past the five you don't. Arrows rather than
/// drag, because a drag needs a pointer, a drop target and a preview and two
/// buttons need none of them.
describe("reordering the sections", () => {
  it("moves a section down and disables the arrow at the end of the list", async () => {
    const user = userEvent.setup();
    const { store } = mountSidebar({ sections: DEFAULT_OPEN });
    await settled();

    const before = [...store.state.gitSectionOrder];
    await user.click(screen.getByRole("button", { name: "Move Changes section down" }));
    expect(store.state.gitSectionOrder[0]).toBe(before[1]);
    expect(store.state.gitSectionOrder[1]).toBe("changes");

    // The first section cannot move up, and says so rather than silently doing
    // nothing.
    const first = SECTION_LABEL[store.state.gitSectionOrder[0]];
    expect(screen.getByRole("button", { name: `Move ${first} section up` })).toBeDisabled();
  });

  it("collapses a section and unmounts its body", async () => {
    const user = userEvent.setup();
    mockTauri({ git_file_status: [entry("src/a.ts", false)] });
    mountSidebar();
    await settled();
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Changes" }));
    expect(screen.queryByText("src/a.ts")).not.toBeInTheDocument();
  });
});

const SECTION_LABEL: Record<GitSectionKey, string> = {
  changes: "Changes",
  branches: "Branches",
  worktrees: "Worktrees",
  stack: "Stack",
  stashes: "Stashes",
  history: "History",
  openedDiffs: "Opened Diffs",
};
