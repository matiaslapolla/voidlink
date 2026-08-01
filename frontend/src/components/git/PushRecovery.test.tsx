/// Force-push, and the three things that keep it from being an ordinary button.
///
/// BR-F7. The audit called the absence of a force-push "safe by construction",
/// and the decision that unblocked it kept the construction: force is reachable
/// only from a non-fast-forward rejection, it is the *second* offer, and it is
/// disabled until a fetch recent enough to hold a lease has landed. Each of
/// those is a claim a test can falsify, so each has one here.
///
/// The Tauri boundary is faked, so `@/api/git` runs for real — these tests
/// notice if `pushForceWithLease` starts sending the wrong argument name, which
/// on this path would mean forcing without a lease.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { resetToasts, useToasts } from "@/commands/toast";
import type { AppStore } from "@/store/layout";
import type { PushOutcome } from "@/types/git";

const confirmDialog = vi.fn(async () => true);
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmDialog(...(args as [])),
}));

const { PushRecovery, LEASE_TTL_MS } = await import("./PushRecovery");

const REPO = "/repos/api";
const REMOTE_TIP = "1111111111111111111111111111111111111111";

function fakeStore(): AppStore {
  return {
    actions: { openConflictTab: vi.fn(), openDiffTab: vi.fn(), openFileTab: vi.fn() },
  } as unknown as AppStore;
}

function rejection(failure: PushOutcome["failure"]): PushOutcome {
  return {
    ok: false,
    failure,
    message: "origin rejected the push",
    remote: "origin",
    branch: "feat",
  };
}

const onResolved = vi.fn();

function mount(outcome: PushOutcome = rejection("non-fast-forward")) {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <PushRecovery
        repoPath={REPO}
        worktreeId="wt1"
        outcome={outcome}
        onResolved={onResolved}
      />
    </AppStoreContext.Provider>
  ));
}

const forceButton = () => screen.getByRole("button", { name: /Force push/ });

beforeEach(() => {
  resetToasts();
  onResolved.mockClear();
  confirmDialog.mockClear();
  confirmDialog.mockResolvedValue(true);
  mockTauri({
    git_fetch: undefined,
    git_remote_tracking_oid: REMOTE_TIP,
    git_repo_info: { behind: 3, aheadBehindUnknown: false },
    git_push_force_with_lease: undefined,
    git_pull: { ok: true, conflicted: false, message: "" },
  });
});

describe("where force-push is reachable from", () => {
  /// The load-bearing negative. A push that failed on credentials, on the
  /// network, or on a hook is not a push force would fix, and the panel must
  /// not appear for any of them — that is the entire difference between this
  /// design and a force button in an overflow menu.
  it.each(["auth", "other"] as const)("renders nothing for a %s failure", async (failure) => {
    mount(rejection(failure));
    expect(screen.queryByTestId("push-recovery")).not.toBeInTheDocument();
    // And it does not go looking at the remote either.
    expect(tauriCalls("git_fetch")).toHaveLength(0);
  });

  it("appears for a non-fast-forward rejection, naming the branch that diverged", async () => {
    mount();
    expect(await screen.findByTestId("push-recovery")).toHaveTextContent(
      /origin\/feat has commits your branch does not/,
    );
  });

  /// Fetch-and-rebase is the first offer and the default one; force is the
  /// second. Asserted on DOM order because that is what "first" means to
  /// someone reading the panel or tabbing through it.
  it("offers Fetch and rebase before Force push", async () => {
    const { container } = mount();
    await screen.findByTestId("push-recovery");
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels[0]).toMatch(/Fetch and rebase/);
    expect(labels[1]).toMatch(/Force push/);
  });
});

describe("the lease gate", () => {
  it("keeps force disabled until the fetch that takes the lease has landed", async () => {
    let releaseFetch: () => void = () => {};
    mockTauri({ git_fetch: () => new Promise<void>((r) => (releaseFetch = () => r())) });

    mount();
    await screen.findByTestId("push-recovery");
    expect(forceButton()).toBeDisabled();

    releaseFetch();
    await waitFor(() => expect(forceButton()).toBeEnabled());
    expect(lastInvokeArgs("git_remote_tracking_oid")).toMatchObject({
      repoPath: REPO,
      remote: "origin",
      branch: "feat",
    });
  });

  /// The freshness rule, which is what "with lease" means on this surface. It
  /// is not about the remote — the remote can move a millisecond after the
  /// fetch, and Rust re-checks for that. It is about the lease still describing
  /// something the user looked at.
  it("disables force again once the lease goes stale, and says so", async () => {
    vi.useFakeTimers();
    try {
      mount();
      // Let the fetch and the tracking-ref read settle without the clock.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(forceButton()).toBeEnabled();

      await vi.advanceTimersByTimeAsync(LEASE_TTL_MS + 1);
      expect(forceButton()).toBeDisabled();
      expect(screen.getByTestId("push-recovery")).toHaveTextContent(/stale/i);
      expect(screen.getByRole("button", { name: "Fetch again" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays disabled, with the reason, when the remote has no such branch to lease", async () => {
    mockTauri({ git_remote_tracking_oid: null });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("push-recovery")).toHaveTextContent(
        /origin has no branch named feat/,
      ),
    );
    expect(forceButton()).toBeDisabled();
    expect(tauriCalls("git_push_force_with_lease")).toHaveLength(0);
  });
});

describe("forcing", () => {
  it("names the remote, the branch and what stops being reachable before doing it", async () => {
    mount();
    await waitFor(() => expect(forceButton()).toBeEnabled());
    await userEvent.click(forceButton());

    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    const [message, opts] = confirmDialog.mock.calls[0] as unknown as [string, { title: string }];
    expect(message).toContain("origin/feat");
    expect(message).toContain("3 commits");
    expect(message).toContain(REMOTE_TIP.slice(0, 7));
    expect(opts.title).toBe("Force-push feat");
    // Never claims the window is closed.
    expect(message).not.toMatch(/\bsafe\b/i);
    expect(message).toMatch(/still overwritten/);
  });

  it("sends the leased oid, so Rust can refuse if the remote moved", async () => {
    mount();
    await waitFor(() => expect(forceButton()).toBeEnabled());
    await userEvent.click(forceButton());
    await waitFor(() => expect(tauriCalls("git_push_force_with_lease")).toHaveLength(1));
    expect(lastInvokeArgs("git_push_force_with_lease")).toEqual({
      repoPath: REPO,
      remote: "origin",
      branch: "feat",
      expectedRemoteOid: REMOTE_TIP,
    });
    expect(onResolved).toHaveBeenCalled();
  });

  it("does nothing when the confirm is declined", async () => {
    confirmDialog.mockResolvedValue(false);
    mount();
    await waitFor(() => expect(forceButton()).toBeEnabled());
    await userEvent.click(forceButton());
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(tauriCalls("git_push_force_with_lease")).toHaveLength(0);
  });

  /// A refusal from the lease check is the feature working, so it is surfaced
  /// in full and the panel re-takes the lease rather than closing — the user
  /// needs to see what moved before deciding again.
  it("surfaces a refusal and takes a fresh lease instead of giving up", async () => {
    mockTauri({
      git_push_force_with_lease: () => {
        throw new Error("Refused: origin/feat moved after the fetch.");
      },
    });
    mount();
    await waitFor(() => expect(forceButton()).toBeEnabled());
    const fetchesBefore = tauriCalls("git_fetch").length;

    await userEvent.click(forceButton());

    await waitFor(() =>
      expect(useToasts().toasts().some((t) => t.message.includes("moved after the fetch"))).toBe(true),
    );
    expect(onResolved).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(tauriCalls("git_fetch").length).toBeGreaterThan(fetchesBefore),
    );
  });
});
