import { createSignal } from "solid-js";
import { isGitWindow, requestWorktreeWizardOnMain } from "@/api/windows";
import { setOverlayOpen } from "./overlay";

/// Cross-component request channel for the new-worktree flow, mirroring the
/// toast / prompt pattern: a module-level signal drives a single host mounted
/// at the app root. This keeps the rail (and the git sidebar's worktrees pane)
/// from having to own the wizard's state or import it directly.

export interface NewWorktreeRequest {
  id: number;
  workspaceId: string;
  /// The repository the worktree is created from — the workspace's main
  /// worktree path.
  repoRoot: string;
  /// The worktree whose working directory we copy env files and dependency
  /// directories *from*. Usually the same as `repoRoot`, but creating a
  /// worktree while sitting in another one should copy from what you can see.
  sourcePath: string;
}

const [request, setRequest] = createSignal<NewWorktreeRequest | null>(null);
let nextId = 1;

/// Ask the app to open the new-worktree wizard for `workspaceId`. No-op if a
/// request is already in flight — two overlapping wizards would race on the
/// same repo.
///
/// In the standalone git window this forwards to the workbench instead of
/// opening locally, and focuses it. The wizard registers the new worktree in
/// the layout store and spawns a terminal for the post-create command, and
/// neither of those exists here — see `requestWorktreeWizardOnMain`. Callers
/// do not need to know which window they are in.
export function requestNewWorktree(opts: {
  workspaceId: string;
  repoRoot: string;
  sourcePath?: string;
}): void {
  if (isGitWindow()) {
    void requestWorktreeWizardOnMain({
      repoRoot: opts.repoRoot,
      sourcePath: opts.sourcePath ?? opts.repoRoot,
    });
    return;
  }
  if (request()) return;
  setRequest({
    id: nextId++,
    workspaceId: opts.workspaceId,
    repoRoot: opts.repoRoot,
    sourcePath: opts.sourcePath ?? opts.repoRoot,
  });
  // The wizard is a modal surface like any other (see `commands/overlay.ts`),
  // but its "open" state is "is a request queued", not a plain boolean, so it
  // cannot be a `createOverlay`. Registering here — at the one place a
  // request is created — keeps it the same distance from the state change
  // that `createOverlay` gives boolean overlays for free.
  setOverlayOpen("worktree-wizard", true);
}

export function newWorktreeRequest() {
  return request();
}

export function clearNewWorktreeRequest(): void {
  setRequest(null);
  setOverlayOpen("worktree-wizard", false);
}

/// The directory new worktrees land in, relative to the repository root.
/// Also the string the wizard offers to append to `.gitignore`.
export const WORKTREE_DIR = ".worktrees";

/// Turn a branch name into a single path segment. Slashes in a branch name
/// (`feat/foo`) would otherwise nest directories, so they collapse like every
/// other unsafe character.
export function worktreeSlug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
}

/// Default path for a new worktree: `<repoRoot>/.worktrees/<slug>`.
///
/// Keeping worktrees inside the repository means one directory to find them
/// in and one to delete, and it survives moving the repo. It does rely on
/// `.worktrees/` being gitignored — the wizard checks that and offers to add
/// it, because an unignored directory here would flood `git status`.
///
/// Shared by the rail, the wizard and the git sidebar's worktrees pane so all
/// three agree on where a worktree lands.
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/\/+$/, "");
  return `${root}/${WORKTREE_DIR}/${worktreeSlug(branch)}`;
}
