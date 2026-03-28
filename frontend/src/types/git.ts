// Phase 1 types
export interface GitRepoInfo {
  repoPath: string;
  currentBranch: string | null;
  headOid: string | null;
  isDetached: boolean;
  isClean: boolean;
  remoteUrl: string | null;
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

// Phase 2 types
export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string | null;
  isLocked: boolean;
  createdAt: number | null;
}

export interface CreateWorktreeInput {
  repoPath: string;
  branchName: string;
  baseRef?: string;
}

// Phase 3 types
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

export interface DiffExplanation {
  filePath: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  suggestions: string[];
}

// Phase 4 types
export interface AgentTaskInput {
  repoPath: string;
  objective: string;
  branchName?: string;
  baseRef?: string;
  constraints: string[];
  autoPr: boolean;
  githubBaseBranch?: string;
}

export interface AgentEvent {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: number;
}

export interface AgentTaskState {
  taskId: string;
  status: "pending" | "branching" | "implementing" | "testing" | "pr_creating" | "success" | "failed";
  branchName: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  stepsCompleted: string[];
  currentStep: string | null;
  events: AgentEvent[];
  error: string | null;
}

export interface PrDescription {
  title: string;
  body: string;
  labels: string[];
  migrationNotes: string | null;
  testPlan: string | null;
}

// Phase 5 types
export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
  ciStatus: string | null;
  reviewStatus: "pending" | "approved" | "changes_requested";
  url: string;
}

export interface ChecklistItem {
  id: string;
  category: "security" | "performance" | "correctness" | "style" | "testing";
  description: string;
  status: "unchecked" | "passed" | "flagged";
  aiNote: string | null;
}

export interface ReviewChecklist {
  prNumber: number;
  items: ChecklistItem[];
  overallRisk: "low" | "medium" | "high";
  aiSummary: string;
  generatedAt: number;
}

export interface MergeInput {
  repoPath: string;
  prNumber: number;
  method: "merge" | "squash" | "rebase";
  deleteBranch: boolean;
  deleteWorktree: boolean;
}

export interface AuditEntry {
  id: string;
  prNumber: number;
  action: string;
  actor: "human" | "ai-agent";
  timestamp: number;
  details: string;
  checklistSnapshot: string | null;
}
