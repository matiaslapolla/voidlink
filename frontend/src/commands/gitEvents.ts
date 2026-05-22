/// Single cross-pane refresh primitive for git mutations. Any operation that
/// changes refs, HEAD, the index, or the working tree should call this after it
/// succeeds. The `voidlink:refresh-git` event is consumed by GitSidebar (and
/// its panes) to refetch repo info / status / branches / worktrees / history /
/// stashes / tags, and by MainSurface to reload open editors and the blame
/// overlay against the new HEAD. Routing everything through one helper keeps us
/// from ever forgetting a surface after a merge / rebase / reset.
export function emitGitRefsChanged(): void {
  window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
}

/// Subscribe to ref-change pulses. Returns an unsubscribe fn; pass it to
/// SolidJS `onCleanup`. Use in any pane that owns a git-derived resource.
export function onGitRefsChanged(handler: () => void): () => void {
  window.addEventListener("voidlink:refresh-git", handler);
  return () => window.removeEventListener("voidlink:refresh-git", handler);
}
