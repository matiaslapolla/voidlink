export interface GitRepoInfo {
  repoPath: string;
  currentBranch: string | null;
  headOid: string | null;
  isDetached: boolean;
  isClean: boolean;
  remoteUrl: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** ahead/behind could not be computed (shallow clone, missing objects). When
   * true, the 0/0 above means "unknown", not "in sync". */
  aheadBehindUnknown: boolean;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  hasConflicts: boolean;
}

export interface SafeCheckoutResult {
  branch: string;
  autoStashed: string | null;
}

export interface PullResult {
  ok: boolean;
  conflicted: boolean;
  message: string;
}

/// Result of a conflict-capable operation (merge/rebase/cherry-pick/revert).
export interface OpResult {
  ok: boolean;
  conflicted: boolean;
  message: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  isLocked: boolean;
  isDetached: boolean;
  /** The worktree currently open in this view. At most one is true. */
  isCurrent: boolean;
  /** Has uncommitted changes. */
  isDirty: boolean;
  /** Commits ahead of upstream (0 when no upstream / detached). */
  ahead: number;
  /** Commits behind upstream (0 when no upstream / detached). */
  behind: number;
  /** The dirty flag could not be read (directory gone, status failed/timed out).
   * `isDirty: false` must not be read as "clean" when this is true. */
  statusUnknown: boolean;
  /** Git would remove this entry on `git worktree prune` — almost always
   * because its directory no longer exists, so it cannot be opened. */
  isPrunable: boolean;
  /** Why git calls it prunable, when it says. */
  prunableReason: string | null;
  /** A bare repository entry: no working tree, so it can never be opened,
   * removed, or dirty. */
  isBare: boolean;
}

/**
 * Ahead/behind counts for one ref, and what they were measured against.
 *
 * Nullable on the row rather than a pair of numbers, because "nothing to
 * compare against" and "compared, and level" are different facts that
 * `ahead: 0, behind: 0` cannot tell apart — and a remote-tracking branch with
 * no local counterpart would otherwise render as in sync with a branch that
 * does not exist.
 */
export interface AheadBehind {
  /** Commits this row's own ref has that `against` does not. */
  ahead: number;
  /** Commits `against` has that this row's own ref does not. */
  behind: number;
  /**
   * The ref the counts are measured against: the upstream for a local branch,
   * the local branch of the same short name for a remote-tracking one. Carried
   * because `↑2 ↓0` on a remote row is ambiguous without it.
   */
  against: string;
}

export interface GitBranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  /** The counts, when there is something to count against. See `AheadBehind`. */
  aheadBehind: AheadBehind | null;
  /** See `GitRepoInfo.aheadBehindUnknown`. */
  aheadBehindUnknown: boolean;
  lastCommitSummary: string | null;
  lastCommitTime: number | null;
  /**
   * `name` survived a lossy UTF-8 conversion, so it is not the byte string git
   * holds and no command that takes a name can find this branch. The row is
   * listed — being invisible was the bug — but every mutation on it is off.
   */
  lossyName: boolean;
  /**
   * The ref this row is an alias for, when it is a symbolic ref under
   * `refs/heads/` rather than a branch. Deleting it removes the alias, not the
   * branch it names.
   */
  symbolicTarget: string | null;
}

export interface GitFileStatus {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
  /** See `GitBranchInfo.lossyName` — same fact, about a path. */
  lossyPath?: boolean;
}

export interface GitCommitInfo {
  oid: string;
  summary: string;
  body: string | null;
  authorName: string;
  authorEmail: string;
  time: number;
  parentOids: string[];
}

export interface DiffLine {
  /**
   * `"\\"` is `\ No newline at end of file` — libgit2 emits that annotation as
   * a diff line like any other, and it is not one. It has no line numbers and
   * belongs to the line above it.
   */
  origin: "+" | "-" | " " | "~" | "\\";
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /// Mirrors the `Delta` arms `collect_diff` maps in `src-tauri/src/git/diff.rs`.
  ///
  /// The narrow five-arm version was a lie the shared `StatusBadge` was typed
  /// against: it branches on `untracked`, `typechange` and `conflicted` too,
  /// and `git_file_status` emits them.
  status:
    | "added"
    | "deleted"
    | "modified"
    | "renamed"
    | "copied"
    | "untracked"
    | "typechange"
    | "conflicted";
  hunks: DiffHunk[];
  isBinary: boolean;
  additions: number;
  deletions: number;
  /// Blob oid of the old side — the content this diff was computed against.
  /// `null` for an added or untracked file.
  ///
  /// Round-tripped back to Rust with a hunk patch so it can refuse when the
  /// file has moved since the diff was drawn. Never read by the UI; it exists
  /// so hunk-level staging cannot apply a patch to content nobody looked at.
  oldBlobOid: string | null;
  /// Rust stopped storing this file's lines partway through, against the
  /// budget in `collect_diff`. `additions`/`deletions` are still the true
  /// totals — only the content stops — so a truncated file's tree row is
  /// honest and only the pane needs to say what it is not showing.
  ///
  /// Optional because a `FileDiff` is also constructed on this side (hunk
  /// staging round-trips one back to Rust), where there is nothing to
  /// truncate.
  truncated?: boolean;
}

export interface DiffResult {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface RecentCommit {
  oid: string;
  shortOid: string;
  summary: string;
  time: number;
}

export interface RefList {
  branches: string[];
  tags: string[];
  recentCommits: RecentCommit[];
  /// The commit HEAD sits on when it is detached, and `null` otherwise.
  ///
  /// A detached HEAD is named by no listed ref, so mid-bisect or after
  /// checking out a tag the position the user is standing on was the one thing
  /// the picker could not offer.
  detachedHead: RecentCommit | null;
}

export interface BlameLine {
  line: number;
  commitOid: string;
  shortOid: string;
  authorName: string;
  authorEmail: string;
  time: number;
  summary: string;
  uncommitted: boolean;
}

export interface ConflictVersions {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string;
}

export interface StashEntry {
  index: number;
  message: string;
  oid: string;
}

export interface RemoteInfo {
  name: string;
  url: string | null;
  pushUrl: string | null;
}

// ─── Worktree setup (new-worktree wizard) ───────────────────────────────────

/// A `.env*`-shaped file found in the source worktree. `gitignored` decides
/// whether it is checked by default: a committed `.env.example` is already
/// in the new worktree, an ignored `.env.local` is not.
export interface EnvFileCandidate {
  relPath: string;
  size: number;
  gitignored: boolean;
}

export type DepAction = "symlink" | "copy" | "install" | "skip";

/// A dependency directory we know how to populate, inferred from a lockfile
/// or manifest at the worktree root.
export interface DepDirCandidate {
  dir: string;
  manager: string;
  detectedFrom: string;
  installCommand: string;
  defaultAction: DepAction;
  existsInSource: boolean;
}

/// Per-repo answers saved at `<repoRoot>/.voidlink/worktree.json`.
export interface WorktreeDefaults {
  envFiles: string[];
  depActions: Record<string, DepAction>;
  postCreateCommand: string;
  warnedNotGitignored: boolean;
}

/// Who a commit is attributed to. Mirrors `CommitIdentity` in
/// `src-tauri/src/git/staging.rs`.
export interface CommitIdentity {
  name: string;
  email: string;
}

export interface WorktreeSetupPlan {
  envFiles: EnvFileCandidate[];
  depDirs: DepDirCandidate[];
  suggestedPostCreate: string;
  defaults: WorktreeDefaults | null;
  voidlinkGitignored: boolean;
  worktreesGitignored: boolean;
}

export interface SetupStep {
  label: string;
  ok: boolean;
  error: string | null;
}

export interface WorktreeSetupReport {
  steps: SetupStep[];
  pendingCommands: string[];
}

// ─── Git configuration ───────────────────────────────────────────────────────

/// Where a config entry came from. Mirrors `git2::ConfigLevel`, with XDG
/// folded into `global` and Windows' ProgramData into `system` — a user does
/// not distinguish those, and the write scopes don't either.
export type ConfigLevel = "system" | "global" | "local" | "worktree" | "app" | "unknown";

/// The scopes voidlink will write. No `system`: it needs elevation and is not
/// a per-user concern.
export type ConfigScope = "local" | "global";

export interface ConfigEntry {
  key: string;
  value: string;
  level: ConfigLevel;
}

/// The files a write would actually land in, resolved by libgit2. `local` is
/// null when no repository is open. Never compose these in the frontend — the
/// whole point is that the path shown is the path written.
export interface ConfigScopePaths {
  local: string | null;
  global: string;
}

/// The cascade plus the resolved targets. `entries` includes shadowed
/// duplicates: the same key can appear at more than one level, which is how
/// "set here" is told apart from "set here, overriding global".
export interface ConfigSnapshot {
  entries: ConfigEntry[];
  scopes: ConfigScopePaths;
}
