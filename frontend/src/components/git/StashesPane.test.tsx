/// The stashes pane, mounted.
///
/// From the 2026-07-30 audit's Track 5. Everything here is about **identity**:
/// a stash has a position and an oid, the position moves under you, and the
/// pane had one action left addressing it by position alone (WT-S2). The other
/// half is conflict routing (WT-S5) and the in-flight gate (WT-S6), neither of
/// which is observable without the component mounted.
///
/// The Tauri boundary is faked, so `@/api/git` runs for real — a test here
/// notices if `stashApply` starts sending the wrong argument name. The two
/// things stubbed are `AppStoreContext` (a context, not a module, and the
/// recording fake is how we assert a compare tab was opened) and the native
/// confirm dialog, which has no jsdom equivalent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { resetToasts } from "@/commands/toast";
import type { AppStore } from "@/store/layout";

const confirmDialog = vi.fn(async () => true);
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmDialog(...(args as [])),
}));

const { StashesPane } = await import("./GitSidebar");

const REPO = "/repos/api";

const openCompareTab = vi.fn();
const openConflictTab = vi.fn();
const openFileTab = vi.fn();

function fakeStore(): AppStore {
  return {
    state: {},
    actions: { openCompareTab, openConflictTab, openFileTab },
  } as unknown as AppStore;
}

function mount() {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <StashesPane repoPath={REPO} worktreeId="wt1" />
    </AppStoreContext.Provider>
  ));
}

/// Two stashes, the newer at index 0 — which is the shape every identity bug
/// here needs, because it is the shape a push creates.
const STACK = [
  { index: 0, message: "newer work", oid: "a".repeat(40) },
  { index: 1, message: "older work", oid: "b".repeat(40) },
];

beforeEach(() => {
  resetToasts();
  confirmDialog.mockClear();
  openCompareTab.mockClear();
  openConflictTab.mockClear();
  mockTauri({ git_stash_list: STACK });
});

describe("opening a stash diff", () => {
  /// WT-S2. A compare tab stores its two refs and re-resolves them on every
  /// refresh, so `stash@{1}^1..stash@{1}` was a live pointer at position 1
  /// rather than a snapshot of a stash. Addressing by oid is what makes it a
  /// snapshot.
  it("addresses the stash by oid, not by position", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("older work");

    await user.click(screen.getByText("older work"));

    expect(openCompareTab).toHaveBeenCalledTimes(1);
    const [, opts] = openCompareTab.mock.calls[0];
    expect(opts.baseRef).toBe(`${"b".repeat(40)}^1`);
    expect(opts.headRef).toBe("b".repeat(40));
    expect(opts.baseRef).not.toContain("stash@");
    expect(opts.headRef).not.toContain("stash@");
  });

  /// The oid is unreadable in a tab strip, so the position and message ride
  /// along as a label. It is a snapshot of what was clicked and is allowed to
  /// go stale — unlike the refs, which are not.
  it("labels the tab with the stash the user actually clicked", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("newer work");

    await user.click(screen.getByText("newer work"));

    expect(openCompareTab.mock.calls[0][1].label).toBe("stash@{0} newer work");
  });
});

describe("applying a stash", () => {
  it("sends the position and the oid together, so Rust can refuse a shifted stack", async () => {
    const user = userEvent.setup();
    mockTauri({ git_stash_apply: { ok: true, conflicted: false, message: "" } });
    mount();
    await screen.findByText("older work");

    await user.click(screen.getAllByLabelText("Apply stash")[1]);

    await waitFor(() => expect(tauriCalls("git_stash_apply")).toHaveLength(1));
    expect(lastInvokeArgs("git_stash_apply")).toMatchObject({
      repoPath: REPO,
      index: 1,
      oid: "b".repeat(40),
    });
  });

  /// WT-S5. A conflicting apply leaves markers and a conflicted index; the pane
  /// used to show a red toast with libgit2's message and no route anywhere.
  it("opens the merge editor when the apply stops on conflicts", async () => {
    const user = userEvent.setup();
    mockTauri({
      git_stash_apply: { ok: false, conflicted: true, message: "conflicts" },
      git_list_conflicts: ["src/a.ts", "src/b.ts"],
    });
    mount();
    await screen.findByText("newer work");

    await user.click(screen.getAllByLabelText("Apply stash")[0]);

    await waitFor(() => expect(openConflictTab).toHaveBeenCalledTimes(2));
    expect(openConflictTab.mock.calls.map((c) => c[1])).toEqual([
      `${REPO}/src/a.ts`,
      `${REPO}/src/b.ts`,
    ]);
  });

  it("does not open the merge editor when the apply is clean", async () => {
    const user = userEvent.setup();
    mockTauri({ git_stash_apply: { ok: true, conflicted: false, message: "" } });
    mount();
    await screen.findByText("newer work");

    await user.click(screen.getAllByLabelText("Apply stash")[0]);

    await waitFor(() => expect(tauriCalls("git_stash_apply")).toHaveLength(1));
    expect(openConflictTab).not.toHaveBeenCalled();
    expect(tauriCalls("git_list_conflicts")).toHaveLength(0);
  });
});

describe("dropping a stash", () => {
  /// WT-S6. The confirm used to be awaited *outside* the in-flight gate, so
  /// every other button in the pane stayed live underneath the dialog — and
  /// every one of them shifts the stack the pending answer is about.
  it("holds the in-flight gate while the confirm is open", async () => {
    const user = userEvent.setup();
    let release!: (ok: boolean) => void;
    confirmDialog.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    mockTauri({ git_stash_drop: null });
    mount();
    await screen.findByText("newer work");

    await user.click(screen.getAllByLabelText("Drop stash")[0]);

    await waitFor(() =>
      expect(screen.getAllByLabelText("Apply stash")[0]).toBeDisabled(),
    );

    release(false);
    await waitFor(() =>
      expect(screen.getAllByLabelText("Apply stash")[0]).not.toBeDisabled(),
    );
    expect(tauriCalls("git_stash_drop")).toHaveLength(0);
  });

  it("drops by position and oid once confirmed", async () => {
    const user = userEvent.setup();
    mockTauri({ git_stash_drop: null });
    mount();
    await screen.findByText("newer work");

    await user.click(screen.getAllByLabelText("Drop stash")[0]);

    await waitFor(() => expect(tauriCalls("git_stash_drop")).toHaveLength(1));
    expect(lastInvokeArgs("git_stash_drop")).toMatchObject({
      index: 0,
      oid: "a".repeat(40),
    });
  });
});
