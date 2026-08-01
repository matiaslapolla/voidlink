/// Requests for actions that only the git sidebar knows how to perform.
///
/// Fetch, pull and "manage remotes" live in `GitSidebar` because that is where
/// their toasts, their in-flight gating and their conflict handling already
/// are. The palette and the keymap need to trigger them from outside.
///
/// They used to do that with a bare `window.dispatchEvent`, which had a hole
/// big enough to lose the feature in: `App.tsx` **unmounts** the sidebar when
/// it is collapsed (and again in stacked mode, where a different view renders),
/// so nothing was listening. Collapse the panel with `Mod+J`, press
/// `Mod+Shift+F`, and absolutely nothing happened — no fetch, no error, no
/// toast. The user believes they fetched, which is the worst possible outcome
/// for a command whose whole job is telling them their branch moved.
///
/// So a request is a value, not a shout. If no handler is registered the
/// request is *held* and replayed the moment one registers, and the caller is
/// told to reveal the panel.

export type GitSidebarAction = "fetch" | "pull" | "remotes";

type Handlers = Partial<Record<GitSidebarAction, () => void>>;

let handlers: Handlers = {};

/// At most one request waits at a time.
///
/// Queueing them would replay a burst of fetches at mount — and the user only
/// ever meant the last thing they asked for.
let pending: GitSidebarAction | null = null;

/// Called by the sidebar on mount. Returns an unregister fn for `onCleanup`.
///
/// Registering immediately drains a held request, which is what makes
/// "collapsed → press the shortcut → the panel opens and fetches" work as one
/// action rather than two.
export function registerGitSidebarActions(next: Handlers): () => void {
  handlers = next;
  if (pending) {
    const action = pending;
    pending = null;
    handlers[action]?.();
  }
  return () => {
    // Only clear if we are still the current registration: in stacked mode the
    // replacement view can mount before the old one cleans up, and a blind
    // reset would drop the live handlers on the floor.
    if (handlers === next) handlers = {};
  };
}

/// Ask the sidebar to perform `action`.
///
/// Returns `false` when nothing could handle it right now — the request is held
/// and the caller should reveal the git panel, which will deliver it.
export function requestGitSidebarAction(action: GitSidebarAction): boolean {
  const handler = handlers[action];
  if (handler) {
    handler();
    return true;
  }
  pending = action;
  return false;
}

/// Test seam. Nothing in the app calls it.
export function resetGitSidebarActions(): void {
  handlers = {};
  pending = null;
}
