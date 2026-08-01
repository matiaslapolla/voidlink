/// The operation banner, mounted.
///
/// From the 2026-07-30 audit's coverage backlog: operation detection → banner →
/// continue/abort wiring. Two of this component's shipped bugs are only
/// reachable with it mounted, and both are guarded here.
///
/// The Tauri boundary is faked, so `@/api/git` runs for real and this test
/// notices if `rebaseContinue` starts sending the wrong argument name. The one
/// thing stubbed is `AppStoreContext`, which is a *context* rather than a
/// module: the banner reaches it only to open a conflict tab, and supplying a
/// recording fake is how the test can assert that it did.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { resetToasts, useToasts } from "@/commands/toast";
import type { AppStore } from "@/store/layout";

import { OperationBanner } from "./OperationBanner";

const REPO = "/repos/api";

const openConflictTab = vi.fn();

/// The smallest store the banner actually touches. Everything else would be
/// scaffolding for a component that never reads it.
function fakeStore(): AppStore {
  return { actions: { openConflictTab } } as unknown as AppStore;
}

function mount(props: Partial<Parameters<typeof OperationBanner>[0]> = {}) {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <OperationBanner
        repoPath={REPO}
        worktreeId="wt1"
        operation="rebase"
        hasConflicts={false}
        {...props}
      />
    </AppStoreContext.Provider>
  ));
}

const messages = () => useToasts().toasts().map((t) => t.message);

beforeEach(() => {
  resetToasts();
  openConflictTab.mockReset();
  mockTauri({
    git_rebase_continue: { ok: true, conflicted: false, message: "" },
    git_rebase_abort: undefined,
    git_merge_abort: undefined,
    git_cherry_pick_continue: { ok: true, conflicted: false, message: "" },
    git_list_conflicts: [],
  });
});

describe("what the banner says", () => {
  it("names the operation in progress", () => {
    mount({ operation: "rebase" });
    expect(screen.getByText(/rebase in progress/i)).toBeInTheDocument();
  });

  it("says when there are conflicts to resolve", () => {
    mount({ hasConflicts: true });
    expect(screen.getByText(/conflicts/i)).toBeInTheDocument();
  });

  /// `git merge` has no `--continue`; finishing it is a commit. Offering a
  /// Continue button would be offering a command that does not exist.
  it("offers no Continue for a merge, and says what to do instead", () => {
    mount({ operation: "merge" });
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByText(/commit to finish/i)).toBeInTheDocument();
  });

  it("always offers Abort", () => {
    mount({ operation: "merge" });
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
  });
});

describe("continuing", () => {
  it("calls the command for the operation it is showing", async () => {
    const user = userEvent.setup();
    mount({ operation: "rebase" });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(tauriCalls("git_rebase_continue")).toHaveLength(1));
    expect(lastInvokeArgs("git_rebase_continue")).toEqual({ repoPath: REPO });
  });

  it("dispatches cherry-pick to its own command, not to rebase", async () => {
    const user = userEvent.setup();
    mount({ operation: "cherry-pick" });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(tauriCalls("git_cherry_pick_continue")).toHaveLength(1));
    expect(tauriCalls("git_rebase_continue")).toHaveLength(0);
  });

  /// Continuing with conflicts still on disk would fail in git and report a
  /// confusing error. Refusing and *opening the conflicts* is the useful
  /// version.
  it("refuses while conflicts remain, and opens them", async () => {
    mockTauri({ git_list_conflicts: ["src/a.ts"] });
    const user = userEvent.setup();
    mount({ operation: "rebase", hasConflicts: true });

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(tauriCalls("git_rebase_continue")).toHaveLength(0);
    await waitFor(() => expect(openConflictTab).toHaveBeenCalled());
    expect(messages().join(" ")).toMatch(/resolve all conflicts first/i);
  });

  it("says so when more conflicts appear mid-rebase", async () => {
    mockTauri({
      git_rebase_continue: { ok: true, conflicted: true, message: "" },
      git_list_conflicts: ["src/b.ts"],
    });
    const user = userEvent.setup();
    mount({ operation: "rebase" });

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(messages().join(" ")).toMatch(/more conflicts/i));
  });

  /// The bug this component's header is about. Props in Solid are live getters,
  /// and the `<Show>` above disposes this component the moment the operation
  /// ends — which is exactly when a successful continue returns. Reading
  /// `props.operation` afterwards yielded `undefined`, so a completing rebase
  /// toasted "undefined continued".
  it("names the operation in the success message, not undefined", async () => {
    const user = userEvent.setup();
    mount({ operation: "rebase" });

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(messages().join(" ")).toMatch(/rebase continued/i));
    expect(messages().join(" ")).not.toMatch(/undefined/);
  });

  it("surfaces a failure rather than reporting success", async () => {
    mockTauri({
      git_rebase_continue: { ok: false, conflicted: false, message: "nothing to commit" },
    });
    const user = userEvent.setup();
    mount({ operation: "rebase" });

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(messages().join(" ")).toMatch(/nothing to commit/i));
  });

  it("surfaces a thrown error", async () => {
    mockTauri({
      git_rebase_continue: () => {
        throw new Error("index.lock exists");
      },
    });
    const user = userEvent.setup();
    mount({ operation: "rebase" });

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(messages().join(" ")).toMatch(/index\.lock/i));
  });
});

describe("aborting", () => {
  it("calls the abort command for the operation it is showing", async () => {
    const user = userEvent.setup();
    mount({ operation: "merge" });
    await user.click(screen.getByRole("button", { name: "Abort" }));

    await waitFor(() => expect(tauriCalls("git_merge_abort")).toHaveLength(1));
    expect(tauriCalls("git_rebase_abort")).toHaveLength(0);
  });

  it("names the operation it aborted", async () => {
    const user = userEvent.setup();
    mount({ operation: "rebase" });
    await user.click(screen.getByRole("button", { name: "Abort" }));
    await waitFor(() => expect(messages().join(" ")).toMatch(/rebase aborted/i));
  });
});

/// Both buttons go through `createInFlight`. Without the gate, a double-click
/// sends two `--continue` invocations at one repository, and the second lands
/// in a state the first has already changed.
describe("the in-flight gate", () => {
  it("disables both buttons while a command is running", async () => {
    let release: (() => void) | undefined;
    mockTauri({
      git_rebase_continue: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, conflicted: false, message: "" });
        }),
    });
    const user = userEvent.setup();
    mount({ operation: "rebase" });

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled());
    expect(screen.getByRole("button", { name: /working/i })).toBeDisabled();

    release?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Abort" })).toBeEnabled());
  });
});
