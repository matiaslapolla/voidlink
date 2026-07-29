/// Single cross-pane refresh primitive for git mutations. Any operation that
/// changes refs, HEAD, the index, or the working tree should call this after it
/// succeeds. The `voidlink:refresh-git` event is consumed by GitSidebar (and
/// its panes) to refetch repo info / status / branches / worktrees / history /
/// stashes / tags, and by MainSurface to reload open editors and the blame
/// overlay against the new HEAD. Routing everything through one helper keeps us
/// from ever forgetting a surface after a merge / rebase / reset.
const REFRESH_EVENT = "voidlink:refresh-git";

/// How long a burst is collected before the pulse goes out.
///
/// One pulse wakes ten-odd subscribers, each of which fires at least one git
/// command — so a click that legitimately emits three times (the mutation, its
/// `finally`, and the pane's own `onRefresh`) turned into thirty concurrent
/// commands against one repository, all of them now queueing behind the same
/// per-repo lock in Rust. 40ms is below the threshold where a refresh reads as
/// delayed and comfortably wider than a burst of synchronous emits.
export const GIT_REFRESH_COALESCE_MS = 40;

/// What a pulse carries: whether it originated in *another* window.
///
/// The cross-window bridge (`api/windows.ts`) re-broadcasts local pulses to the
/// other windows and converts remote ones back into local pulses. It used to tell
/// the two apart with a latch held across a synchronous dispatch — which the
/// coalescing here breaks, since the dispatch now happens after the latch is
/// released. Marking the pulse instead is the version that cannot ping-pong: a
/// remote-originated pulse is never re-published.
export interface GitRefsPulse {
  remote: boolean;
}

let pending: ReturnType<typeof setTimeout> | null = null;
/// True while every emit in the current burst came from another window.
let pendingRemoteOnly = true;

function schedule(remote: boolean): void {
  if (!remote) pendingRemoteOnly = false;
  if (pending !== null) return;
  pending = setTimeout(dispatchPulse, GIT_REFRESH_COALESCE_MS);
}

function dispatchPulse(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
  const remote = pendingRemoteOnly;
  pendingRemoteOnly = true;
  window.dispatchEvent(
    new CustomEvent<GitRefsPulse>(REFRESH_EVENT, { detail: { remote } }),
  );
}

/// Ask every git surface to refresh. Bursts collapse into one pulse.
export function emitGitRefsChanged(): void {
  schedule(false);
}

/// A pulse that came from another window. Identical for subscribers; the bridge
/// uses the flag to avoid publishing it straight back.
export function emitRemoteGitRefsChanged(): void {
  schedule(true);
}

/// Send any pending pulse immediately. For tests, and for a caller that is about
/// to tear the window down and still wants the other windows to hear it.
export function flushGitRefsChanged(): void {
  if (pending === null) return;
  dispatchPulse();
}

/// Subscribe to ref-change pulses. Returns an unsubscribe fn; pass it to
/// SolidJS `onCleanup`. Use in any pane that owns a git-derived resource.
///
/// The handler receives the pulse: panes ignore it (a refresh is a refresh), the
/// cross-window bridge reads `remote` to decide whether to re-publish.
export function onGitRefsChanged(handler: (pulse: GitRefsPulse) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<GitRefsPulse>).detail;
    handler(detail ?? { remote: false });
  };
  window.addEventListener(REFRESH_EVENT, listener);
  return () => window.removeEventListener(REFRESH_EVENT, listener);
}
