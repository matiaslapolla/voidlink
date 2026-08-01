/// `CompareTab`'s own toolbar, mounted — the per-tab diff-mode and
/// ignore-whitespace controls this file adds to close TODO row 6.
///
/// Two things are under test that a prop-level unit test cannot reach:
///
///   1. **The refetch is scoped to the tab that changed.** `ignoreWhitespace`
///      sits in the diff resource's key (see `CompareTab.tsx`), so flipping
///      one tab's toggle must produce exactly one new `git_diff_refs` call —
///      for *that* tab's refs — and leave a second, unrelated compare tab's
///      call count untouched. A global toggle would refetch both.
///   2. **The controls read and write the tab's own state**, not the global
///      `diffMode`/`ignoreWhitespace` prefs the working-tree diff toolbar
///      uses — there is no shared store here at all, only the harness below,
///      so a control that reached for global state would have nothing to
///      read and the test would fail to render rather than pass by accident.
///
/// No real `AppStore` is constructed. `useAppStore()` only has to return an
/// `actions` object the toolbar's buttons call — the harness below wires
/// those straight into a `createStore` holding the tab, the same shape
/// `store/layout/index.ts`'s `setCompareDiffMode` / `setCompareIgnoreWhitespace`
/// commit to. `CompareTab` mounts unaware of the difference.
import { describe, expect, it } from "vitest";
import { createStore, produce } from "solid-js/store";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import type { AppStore } from "@/store/layout";
import type { CompareTab as CompareTabState } from "@/store/layout";
import type { DiffResult, GitBranchInfo, RefList } from "@/types/git";

import { CompareTab } from "./CompareTab";

function compareTab(partial: Partial<CompareTabState> = {}): CompareTabState {
  return {
    id: "c1",
    baseRef: "main",
    headRef: "feature",
    useMergeBase: true,
    selectedFilePath: null,
    treeMode: "tree",
    treeFilter: "",
    treeWidth: 320,
    ...partial,
  };
}

const EMPTY_DIFF: DiffResult = { files: [], totalAdditions: 0, totalDeletions: 0 };
const EMPTY_REFS: RefList = { branches: [], tags: [], recentCommits: [], detachedHead: null };
const NO_BRANCHES: GitBranchInfo[] = [];

function mountDefaults() {
  mockTauri({
    git_list_refs: EMPTY_REFS,
    git_list_branches: NO_BRANCHES,
    git_diff_refs: EMPTY_DIFF,
  });
}

/// Wires `CompareTab`'s handful of store calls into a real `createStore`, so a
/// click that reaches `actions.setCompareIgnoreWhitespace` genuinely mutates
/// `props.tab` and genuinely re-runs the resource memo downstream of it — a
/// `vi.fn()` stub would prove the click happened without proving anything
/// refetched.
function mount(initial: CompareTabState, worktreeId = "wt-1") {
  const [tab, setTab] = createStore(initial);

  const actions = {
    setCompareRefs: (
      _wt: string,
      _id: string,
      patch: { baseRef?: string; headRef?: string; useMergeBase?: boolean },
    ) => setTab(produce((t) => Object.assign(t, patch))),
    setCompareSelectedFile: (_wt: string, _id: string, path: string | null) =>
      setTab("selectedFilePath", path),
    setCompareTreeMode: (_wt: string, _id: string, mode: CompareTabState["treeMode"]) =>
      setTab("treeMode", mode),
    setCompareTreeFilter: (_wt: string, _id: string, filter: string) =>
      setTab("treeFilter", filter),
    setCompareTreeWidth: (_wt: string, _id: string, width: number) =>
      setTab("treeWidth", width),
    setCompareDiffMode: (_wt: string, _id: string, mode: CompareTabState["diffMode"]) =>
      setTab("diffMode", mode),
    setCompareIgnoreWhitespace: (_wt: string, _id: string, value: boolean) =>
      setTab("ignoreWhitespace", value),
    // Unused by CompareTab, but the harness has to satisfy the `AppStore`
    // shape the component's `useAppStore()` call is typed against.
  } as unknown as AppStore["actions"];

  const store = { state: {}, actions } as unknown as AppStore;

  const result = render(() => (
    <AppStoreContext.Provider value={store}>
      <CompareTab repoPath="/repo" tab={tab} worktreeId={worktreeId} />
    </AppStoreContext.Provider>
  ));
  return { ...result, tab };
}

describe("per-tab diff-mode and ignore-whitespace controls", () => {
  it("starts at the shipped defaults with no persisted value", async () => {
    mountDefaults();
    mount(compareTab());

    await waitFor(() => expect(tauriCalls("git_diff_refs")).toHaveLength(1));
    expect(screen.getByLabelText("Inline (unified) view")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Split (side by side) view")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Toggle ignore whitespace")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("switches the pressed state on click, per control", async () => {
    mountDefaults();
    const user = userEvent.setup();
    mount(compareTab());
    await waitFor(() => expect(tauriCalls("git_diff_refs")).toHaveLength(1));

    await user.click(screen.getByLabelText("Split (side by side) view"));
    expect(screen.getByLabelText("Split (side by side) view")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Inline (unified) view")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(screen.getByLabelText("Toggle ignore whitespace"));
    expect(screen.getByLabelText("Toggle ignore whitespace")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("refetches this tab's diff when ignore-whitespace is toggled, with the flag in the request", async () => {
    mountDefaults();
    const user = userEvent.setup();
    mount(compareTab());
    await waitFor(() => expect(tauriCalls("git_diff_refs")).toHaveLength(1));
    expect(tauriCalls("git_diff_refs")[0].args).toMatchObject({ ignoreWhitespace: false });

    await user.click(screen.getByLabelText("Toggle ignore whitespace"));

    await waitFor(() => expect(tauriCalls("git_diff_refs")).toHaveLength(2));
    expect(tauriCalls("git_diff_refs")[1].args).toMatchObject({
      baseRef: "main",
      headRef: "feature",
      ignoreWhitespace: true,
    });
  });

  /// Diff mode is render-only — it never reaches the resource key — so
  /// toggling it must produce *no* new request at all. A control that somehow
  /// got folded into the same key as `ignoreWhitespace` would fail this.
  it("does not refetch when only the diff mode changes", async () => {
    mountDefaults();
    const user = userEvent.setup();
    mount(compareTab());
    await waitFor(() => expect(tauriCalls("git_diff_refs")).toHaveLength(1));

    await user.click(screen.getByLabelText("Split (side by side) view"));

    // Deliberately not `waitFor`: the assertion is that nothing further was
    // sent, and Solid's resource re-evaluates its key memo synchronously with
    // the store write above.
    expect(tauriCalls("git_diff_refs")).toHaveLength(1);
  });

  /// The scoping claim in TODO row 6: per-tab keying, not a shared global
  /// toggle, is supposed to mean a second open compare tab is untouched by
  /// the first tab's control. Two tabs on different ref pairs, sharing
  /// nothing but the mocked Tauri boundary, prove it directly — a global
  /// toggle would have driven both resources off the same key and produced a
  /// second call on *both*.
  it("leaves a second compare tab's diff untouched when the first tab's whitespace toggle flips", async () => {
    mountDefaults();
    const user = userEvent.setup();

    const { tab: tabA } = mount(compareTab({ id: "a", baseRef: "main", headRef: "feature-a" }));
    mount(compareTab({ id: "b", baseRef: "main", headRef: "feature-b" }), "wt-2");

    await waitFor(() => expect(tauriCalls("git_diff_refs")).toHaveLength(2));
    const callsForB = () =>
      tauriCalls("git_diff_refs").filter((c) => c.args.headRef === "feature-b");
    expect(callsForB()).toHaveLength(1);

    await user.click(screen.getAllByLabelText("Toggle ignore whitespace")[0]);

    await waitFor(() =>
      expect(
        tauriCalls("git_diff_refs").filter((c) => c.args.headRef === "feature-a"),
      ).toHaveLength(2),
    );
    // Tab B's own request count never moved.
    expect(callsForB()).toHaveLength(1);
    expect(tabA.ignoreWhitespace).toBe(true);
  });
});
