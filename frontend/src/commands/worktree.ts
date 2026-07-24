import { createSignal } from "solid-js";

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
export function requestNewWorktree(opts: {
  workspaceId: string;
  repoRoot: string;
  sourcePath?: string;
}): void {
  if (request()) return;
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

/// Sibling path convention for a new worktree: `<repoParent>/<repoName>-<slug>`.
/// Lifted out of the git sidebar's worktrees pane so the rail, the wizard and
/// that pane all agree on where a worktree lands.
export function siblingWorktreePath(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/\/+$/, "");
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${root}-${slug || "wt"}`;
}
