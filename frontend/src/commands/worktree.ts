import { createSignal } from "solid-js";
import { pushToast } from "@/commands/toast";
import { isGitWindow, requestWorktreeWizardOnMain } from "@/api/windows";

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
  // A wizard is already up. Silently dropping the second click made the
  // button look broken when the wizard was behind another window or simply
  // not where the user was looking.
  if (request()) {
    pushToast("The new-worktree wizard is already open", "info", 2500);
    return;
  }
  setRequest({
    id: nextId++,
    workspaceId: opts.workspaceId,
    repoRoot: opts.repoRoot,
    sourcePath: opts.sourcePath ?? opts.repoRoot,
  });
}

export function newWorktreeRequest() {
  return request();
}

export function clearNewWorktreeRequest(): void {
  setRequest(null);
}

/// The directory new worktrees land in, relative to the repository root.
/// Also the string the wizard offers to append to `.gitignore`.
export const WORKTREE_DIR = ".worktrees";

/// What creating a worktree on this branch name will actually do.
///
///   * `local`  — the branch exists here; check it out.
///   * `remote` — no local branch, but exactly one remote has one by that name.
///     `git worktree add <path> <branch>` DWIMs this into
///     `--track -b <branch> <path> <remote>/<branch>`, so the worktree lands on
///     a local branch tracking the remote — which is what "add a worktree for
///     `feature/x`" means when `feature/x` is a colleague's branch.
///   * `new`    — nothing by that name anywhere; branch off HEAD.
export type WorktreeBranchKind = "local" | "remote" | "new";

export interface WorktreeBranchClass {
  kind: WorktreeBranchKind;
  /// For `remote`, the full ref the new branch will track (`origin/feature/x`).
  trackingRef?: string;
}

/// Classify `branch` against the repository's branches.
///
/// The wizard used to ask for **local** branches only, so a branch that existed
/// solely on a remote read as brand new: it created a fresh branch off HEAD
/// under a name already taken upstream, silently, with no tracking. Pushing it
/// then either fails or opens a second head on someone else's work.
///
/// Ambiguity is resolved the way git resolves it — it only DWIMs when exactly
/// one remote has the name. Two remotes carrying `feature/x` is not a branch we
/// can pick for the user, so it falls through to `new` (git would refuse the
/// checkout, and branching off HEAD under a name we cannot resolve is the one
/// answer that does not pretend to know which remote was meant).
export function classifyWorktreeBranch(
  branch: string,
  branches: { name: string; isRemote: boolean }[],
): WorktreeBranchClass {
  const name = branch.trim();
  if (!name) return { kind: "new" };
  if (branches.some((b) => !b.isRemote && b.name === name)) return { kind: "local" };

  // Remote branches are listed as `<remote>/<branch>`; the branch name itself
  // may contain slashes, so match on the suffix rather than splitting.
  const matches = branches.filter(
    (b) => b.isRemote && b.name.endsWith(`/${name}`) && b.name.length > name.length + 1,
  );
  if (matches.length === 1) return { kind: "remote", trackingRef: matches[0].name };
  return { kind: "new" };
}

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
