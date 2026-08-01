/// Force-push, and the only place in the app it exists.
///
/// The audit (BR-F7) rated the absence of a force-push "safe by construction",
/// which it was — the button did not exist, so it could not be pressed by
/// mistake. Adding one beside Push, or in an overflow, or on a right-click,
/// would have thrown that away: a control that is always reachable gets found
/// while looking for something else, and gets pressed on a diverged branch by
/// someone who has not looked at the divergence.
///
/// So this component is reachable from exactly one place: a push that the
/// remote rejected as non-fast-forward. Three consequences, and each of them is
/// the design rather than a side effect of it.
///
///   1. **It only exists in the moment it is the answer.** The rejection *is*
///      the proof that the branches diverged. There is no idle state to
///      discover it in.
///   2. **"Fetch and rebase" is offered first.** It is the ordinary way out of
///      a divergence, it destroys nothing, and it is what most rejections
///      actually want. Force is second and styled as the lesser path.
///   3. **Force is disabled until a lease is held**, and holding one means a
///      fetch recent enough to still mean something. See `LEASE_TTL_MS`.
///
/// On the lease itself: libgit2 has no `--force-with-lease` primitive, so the
/// guarantee is assembled out of fetch → compare → push, with a real race
/// window that cannot be closed from here. `git/push.rs` documents its exact
/// shape. Nothing on this surface says "safe", because it is not — it is much
/// safer, which is a different word.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { gitApi } from "@/api/git";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { createGitSync } from "@/components/git/GitSyncControls";
import type { PushOutcome } from "@/types/git";

/// How long a lease stays good for.
///
/// The number is not about the remote. The remote can move a millisecond after
/// the fetch, and no expiry catches that — the re-check in Rust immediately
/// before the push is what covers it, as far as anything can.
///
/// The number is about the *user*. A lease is a claim: "the commits I am about
/// to make unreachable are commits I have looked at." That claim is worth
/// exactly what the user's memory of the fetch is worth, and the fetch behind
/// this lease happened at a moment they were present for.
///
/// Two minutes is one deliberate action, generously measured: the fetch lands,
/// the divergence is on screen, the confirm is read, the button is pressed.
/// Long enough for a slow network and an unhurried read of the confirm; short
/// enough that a window left open over lunch cannot be force-pushed from on the
/// way back. Past it the tracking ref has become a fact about the past rather
/// than something the user is holding in mind — and the cost of being wrong in
/// this direction is one click on Fetch, which is the cheapest mistake in the
/// whole interaction.
export const LEASE_TTL_MS = 120_000;

/// What a fetch established about the remote. Its age is not stored here — the
/// expiry timer started when it was taken is the only clock that matters, and a
/// second representation of "when" is a second thing to get out of step.
interface Lease {
  oid: string;
  /// Commits on the remote that this branch does not contain — precisely what
  /// forcing makes unreachable. `null` when git could not compute it (shallow
  /// clone, missing objects), in which case the confirm says so rather than
  /// claiming zero.
  discarded: number | null;
}

export function PushRecovery(props: {
  repoPath: string;
  worktreeId: string;
  /// The rejection. The caller only mounts this for `non-fast-forward`; the
  /// guard is repeated here so a future caller cannot widen it by accident.
  outcome: PushOutcome;
  /// Called once the branch is in sync again — the caller clears the error.
  onResolved: () => void;
}) {
  const sync = createGitSync({
    repoPath: () => props.repoPath,
    worktreeId: () => props.worktreeId,
    info: () => null,
  });

  const [lease, setLease] = createSignal<Lease | null>(null);
  const [leaseError, setLeaseError] = createSignal("");
  const [expired, setExpired] = createSignal(false);
  const [forcing, setForcing] = createSignal(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  /// Take the lease: fetch, then read what the fetch left in
  /// `refs/remotes/<remote>/<branch>`.
  ///
  /// Done on mount rather than behind a third button because the rejection
  /// already told us the branches diverged — asking the user to press "check"
  /// to learn what they were just told is ceremony. The button they press is
  /// still the one that acts.
  async function takeLease() {
    setLeaseError("");
    setExpired(false);
    clearTimeout(timer);
    try {
      await gitApi.fetch(props.repoPath, props.outcome.remote);
      const oid = await gitApi.remoteTrackingOid(
        props.repoPath,
        props.outcome.remote,
        props.outcome.branch,
      );
      if (!oid) {
        // No tracking ref means nothing to hold a lease on. Refusing here is
        // not a degraded mode — it is the absence of the thing that makes
        // force-with-lease different from force.
        setLeaseError(
          `${props.outcome.remote} has no branch named ${props.outcome.branch} — nothing to take a lease on.`,
        );
        return;
      }
      // `behind` is measured against the upstream, which on this path is the
      // branch about to be overwritten, so it is the count of commits that stop
      // being reachable.
      const info = await gitApi.repoInfo(props.repoPath).catch(() => null);
      setLease({
        oid,
        discarded: info && !info.aheadBehindUnknown ? info.behind : null,
      });
      timer = setTimeout(() => setExpired(true), LEASE_TTL_MS);
    } catch (e) {
      setLeaseError(e instanceof Error ? e.message : String(e));
    } finally {
      emitGitRefsChanged();
    }
  }

  // Gated on the failure class, not only in the markup: a panel that renders
  // nothing but still fetches would make an auth failure quietly talk to the
  // remote, and "force is unreachable here" would be true of the DOM only.
  onMount(() => {
    if (props.outcome.failure === "non-fast-forward") void takeLease();
  });

  const fresh = () => lease() !== null && !expired();

  /// Why force cannot be pressed, or `null` when it can. Shown as the button's
  /// title and as the line beneath it — a disabled control that does not say
  /// why reads as broken.
  const forceBlockedReason = (): string | null => {
    if (forcing()) return "Forcing…";
    if (sync.syncing()) return "Checking the remote…";
    if (leaseError()) return leaseError();
    if (!lease()) return "Checking the remote…";
    if (expired()) return "That check is stale now — fetch again to take a fresh lease";
    return null;
  };

  async function fetchAndRebase() {
    await sync.doPull("rebase");
    // A clean rebase leaves nothing to recover from. A conflicted one is
    // already routed into conflict tabs by `doPull`, and the banner takes over
    // from here, so this panel should get out of the way either way.
    props.onResolved();
  }

  async function forcePush() {
    const held = lease();
    // Re-checked at the click rather than only in `disabled`, because the
    // expiry timer and a click can land in either order.
    if (!held || expired() || forcing()) return;

    const { remote, branch } = props.outcome;
    const discarded =
      held.discarded === null
        ? "Commits that are on the remote and not in your branch"
        : held.discarded === 1
          ? "1 commit that is on the remote and not in your branch"
          : `${held.discarded} commits that are on the remote and not in your branch`;

    // Not "are you sure". The remote, the branch, the ref being overwritten and
    // what stops being reachable, plus the honest limit of the lease.
    const ok = await dialogConfirm(
      `Overwrite ${remote}/${branch} with your local ${branch}?\n\n` +
        `${discarded} stop being reachable on ${remote}. ${remote}/${branch} is at ${held.oid.slice(0, 7)} and will be moved to your branch tip.\n\n` +
        `The lease is re-checked against ${remote} immediately before the push and the force is refused if anything moved — but a push that lands in the moment between that check and this one is still overwritten.`,
      { title: `Force-push ${branch}`, kind: "warning" },
    );
    if (!ok) return;

    setForcing(true);
    try {
      await gitApi.pushForceWithLease(props.repoPath, remote, branch, held.oid);
      pushToast(`Force-pushed ${branch} to ${remote}`, "success", 3000);
      props.onResolved();
    } catch (e) {
      // A refusal here is the lease doing its job, so it gets a long, readable
      // toast rather than a truncated red line, and the panel stays up with a
      // freshly taken lease so the user can look at what moved.
      pushToast(e instanceof Error ? e.message : String(e), "error", 12000);
      setLease(null);
      void takeLease();
    } finally {
      setForcing(false);
      emitGitRefsChanged();
    }
  }

  return (
    <Show when={props.outcome.failure === "non-fast-forward"}>
      <div
        class="mt-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 space-y-1.5"
        data-testid="push-recovery"
      >
        <p class="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle class="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            {props.outcome.remote} rejected the push — {props.outcome.remote}/
            {props.outcome.branch} has commits your branch does not.
          </span>
        </p>
        <div class="flex items-center gap-1.5">
          <button
            onClick={() => void fetchAndRebase()}
            disabled={sync.syncing() || forcing()}
            class="flex-1 px-2 py-1 rounded-md text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sync.syncing() ? "Fetching…" : "Fetch and rebase"}
          </button>
          <button
            onClick={() => void forcePush()}
            disabled={!fresh() || forcing() || sync.syncing()}
            title={forceBlockedReason() ?? `Overwrite ${props.outcome.remote}/${props.outcome.branch}`}
            class="px-2 py-1 rounded-md text-[12px] border border-border text-muted-foreground hover:text-destructive hover:border-destructive/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Force push (with lease)
          </button>
        </div>
        <Show when={forceBlockedReason()}>
          {(reason) => (
            <p class="text-[11px] text-muted-foreground">
              {reason()}
              <Show when={expired()}>
                {" "}
                <button
                  onClick={() => void takeLease()}
                  class="underline underline-offset-2 hover:text-foreground transition-colors"
                >
                  Fetch again
                </button>
              </Show>
            </p>
          )}
        </Show>
      </div>
    </Show>
  );
}
