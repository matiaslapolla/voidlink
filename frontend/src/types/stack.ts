export interface StackBranch {
  name: string;
  parent: string;
  isHead: boolean;
  aheadOfParent: number;
  behindParent: number;
  lastKnownParentTip: string | null;
  prNumber: number | null;
}

export interface Stack {
  trunk: string;
  /// Ordered from the branch closest to trunk up to the topmost.
  branches: StackBranch[];
  needsRestack: boolean;
}

/// Tagged-union result of a single-branch restack. Mirrors the Rust
/// `RestackOutcome` (serde tag = "kind").
export type RestackOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "restacked"; newTip: string; oldTip: string; commitsReplayed: number }
  | {
      kind: "conflict";
      oldTip: string;
      conflictingCommit: string;
      paths: string[];
    };

export interface RestackResult {
  branch: string;
  outcome: RestackOutcome;
}

/// Per-branch outcome of `git_stack_submit`. Mirrors Rust `SubmitOutcome`
/// (serde tag = "kind"). All non-Failed variants carry a usable PR URL.
export type SubmitOutcome =
  | { kind: "created"; number: number; url: string }
  | { kind: "updated"; number: number; url: string }
  | { kind: "noChange"; number: number; url: string }
  | { kind: "failed"; reason: string };

export interface SubmitResult {
  branch: string;
  outcome: SubmitOutcome;
}
