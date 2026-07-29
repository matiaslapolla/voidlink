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
}

export interface GitBranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommitSummary: string | null;
  lastCommitTime: number | null;
}

export interface GitFileStatus {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
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
  origin: "+" | "-" | " " | "~";
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
  status: "added" | "deleted" | "modified" | "renamed" | "copied";
  hunks: DiffHunk[];
  isBinary: boolean;
  additions: number;
  deletions: number;
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
