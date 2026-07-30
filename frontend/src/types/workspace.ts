/// One working directory inside a workspace. For a git repository these map
/// 1:1 onto `git worktree list` entries (the repo's own working directory is
/// the `isMain` one). For a plain folder — or a workspace whose repo hasn't
/// been picked yet — we invent a single `isSynthetic` main worktree so the
/// rest of the app never has to special-case "workspace without worktrees".
///
/// The id is ours, not git's: it keys every per-worktree tab collection in the
/// layout store and must stay stable across reloads even when the worktree is
/// moved or its branch is renamed. Worktrees are matched back to git by
/// canonicalised `path`, never by id.
export interface Worktree {
  id: string;
  /// Absolute path of the working directory. Empty string only for a brand-new
  /// workspace that has no folder selected yet.
  path: string;
  /// Short branch name (no `refs/heads/` prefix), or null for a detached HEAD
  /// or a non-repo folder.
  branch: string | null;
  /// The repository's own working directory — git lists it first and it can
  /// never be removed. Synthetic worktrees are always main.
  isMain: boolean;
  /// True when we invented this entry rather than reading it from
  /// `git worktree list`. Drives the "this isn't a repo" affordances.
  isSynthetic: boolean;
  /// Status badges, refreshed from `git_list_worktrees` on hydration. They are
  /// display-only and deliberately not persisted — a stale badge after a
  /// restart is worse than no badge.
  isDirty: boolean;
  ahead: number;
  behind: number;
  isLocked: boolean;
  isDetached: boolean;
  /// The dirty flag could not be read — an unmounted volume, a deleted
  /// directory, a `git status` that timed out. Carried all the way here
  /// because `isDirty: false` must not render as "clean": the rail and the
  /// worktree switcher were showing a confident no-badge for a worktree whose
  /// state nobody knows, and the removal flow then discards work on that
  /// basis.
  statusUnknown: boolean;
  /// Git would prune this entry — its directory is gone. Opening it produces a
  /// workspace pointing at nothing.
  isPrunable: boolean;
}

/// A workspace is a repository (or a plain folder) that owns N worktrees.
/// `repoRoot` stays the main worktree's path so existing repo-scoped code
/// (file tree, git sidebar) keeps a single obvious anchor.
export interface Workspace {
  id: string;
  name: string;
  repoRoot: string | null;
  worktrees: Worktree[];
  /// Which worktree this workspace shows when it becomes active. Always the
  /// id of one of `worktrees`.
  activeWorktreeId: string;
  /// Set to true once `git_list_worktrees` succeeds for `repoRoot`. Until then
  /// we can't tell "not a repo" from "not looked at yet", so the rail keeps the
  /// new-worktree button disabled with an explanatory tooltip rather than
  /// silently doing nothing.
  isRepo: boolean;
}

/// Persisted shape. Badges are dropped on the way out (see `Worktree`), so a
/// reload starts from a neutral state and hydration fills it back in.
export interface PersistedWorktree {
  id: string;
  path: string;
  branch: string | null;
  isMain: boolean;
  isSynthetic: boolean;
}

export interface PersistedWorkspace {
  id: string;
  name: string;
  repoRoot: string | null;
  worktrees: PersistedWorktree[];
  activeWorktreeId: string;
  isRepo: boolean;
}

/// Build a worktree with neutral badges. `id` is injectable so the store
/// migration can reuse an existing workspace id (see `store/migrate.ts`).
export function makeWorktree(init: {
  id?: string;
  path: string;
  branch?: string | null;
  isMain?: boolean;
  isSynthetic?: boolean;
}): Worktree {
  return {
    id: init.id ?? crypto.randomUUID(),
    path: init.path,
    branch: init.branch ?? null,
    isMain: init.isMain ?? false,
    isSynthetic: init.isSynthetic ?? false,
    isDirty: false,
    ahead: 0,
    behind: 0,
    isLocked: false,
    statusUnknown: false,
    isPrunable: false,
    isDetached: false,
  };
}

export function makeWorkspace(name: string, repoRoot: string | null = null): Workspace {
  const main = makeWorktree({ path: repoRoot ?? "", isMain: true, isSynthetic: true });
  return {
    id: crypto.randomUUID(),
    name,
    repoRoot,
    worktrees: [main],
    activeWorktreeId: main.id,
    isRepo: false,
  };
}

/// True for names the app invented — the `Workspace N` counter and the
/// initial `Main`. Auto names are safe to replace with a repository name when
/// a folder is picked; anything the user typed is theirs and stays.
export function isAutoWorkspaceName(name: string): boolean {
  return /^(workspace(\s+\d+)?|main)$/i.test(name.trim());
}

/// The name a repository goes by. The remote wins when there is one, since
/// `~/dev/wt/feature-x` checkouts and renamed clones both lie about the
/// project's identity; otherwise the root folder's basename.
export function repoDisplayName(repoRoot: string, remoteUrl?: string | null): string {
  const remote = remoteUrl?.trim();
  if (remote) {
    const name = remote
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .split(/[/:]/)
      .pop();
    if (name) return name;
  }
  return repoRoot.replace(/\/+$/, "").split("/").pop() || "Workspace";
}

/// Display label for a worktree in the rail. Branch name when we have one,
/// otherwise the directory name; detached HEADs say so explicitly rather than
/// showing a bare path the user can't act on.
export function worktreeLabel(wt: Worktree): string {
  if (wt.branch) return wt.branch;
  if (wt.isDetached) return "(detached)";
  const base = wt.path.replace(/\/+$/, "").split("/").pop();
  return base || "(no folder)";
}

export interface TerminalSession {
  id: string;
  ptyId: string;
  label: string;
  cwd: string;
  /// True for a session session-restore recreated on boot: the tab id, label
  /// and cwd are the ones you left, the PTY behind them is brand new and the
  /// scrollback is gone. Surfaced in the tab's tooltip so the empty terminal
  /// is never mistaken for a shell that lost its output.
  restored?: boolean;
}
