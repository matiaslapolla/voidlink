/// A ref pointing at a commit, and what kind of ref it is.
export interface RefDecoration {
  /// Short name: `main`, `origin/main`, `v1.0`.
  name: string;
  kind: "branch" | "remote" | "tag" | "detached";
  /// This is the ref HEAD is on. At most one decoration in the whole graph.
  isHead: boolean;
}

/// A single node in the commit-graph DAG. Mirrors the Rust `GraphCommit`
/// struct 1:1 (serde renames it to camelCase on the wire).
export interface GraphCommit {
  /// Full 40-char commit oid.
  oid: string;
  /// First 7 chars of the oid — what the row renders.
  shortOid: string;
  summary: string;
  authorName: string;
  /// Author time as a unix timestamp (seconds).
  authorTime: number;
  /// Committer time, and the one the rows are **ordered** by. Displaying
  /// author time beside a committer-time ordering made a rebased history read
  /// newest-first with timestamps that went up and down.
  commitTime: number;
  /// Full oids of this commit's parents. Drives lane/edge routing. Two or
  /// more parents means a merge commit.
  parentOids: string[];
  /// Ref decorations pointing at this commit, each with its kind. The kind
  /// used to be guessed in the UI from whether the name contained a slash,
  /// which made every local `feature/x` a remote.
  refs: RefDecoration[];
  /// True for the commit HEAD currently resolves to.
  isHead: boolean;
}
