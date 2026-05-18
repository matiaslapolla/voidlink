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
}

export interface SafeCheckoutResult {
  branch: string;
  autoStashed: string | null;
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
