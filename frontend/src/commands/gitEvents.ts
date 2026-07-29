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

let pending: ReturnType<typeof setTimeout> | null = null;

/// Ask every git surface to refresh. Bursts collapse into one pulse.
export function emitGitRefsChanged(): void {
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }, GIT_REFRESH_COALESCE_MS);
}

/// Send any pending pulse immediately. For tests, and for a caller that is about
/// to tear the window down and still wants the other windows to hear it.
export function flushGitRefsChanged(): void {
  if (pending === null) return;
  clearTimeout(pending);
  pending = null;
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

/// Subscribe to ref-change pulses. Returns an unsubscribe fn; pass it to
/// SolidJS `onCleanup`. Use in any pane that owns a git-derived resource.
export function onGitRefsChanged(handler: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, handler);
  return () => window.removeEventListener(REFRESH_EVENT, handler);
}
