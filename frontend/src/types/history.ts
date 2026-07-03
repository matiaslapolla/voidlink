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
  /// Full oids of this commit's parents. Drives lane/edge routing. Two or
  /// more parents means a merge commit.
  parentOids: string[];
  /// Ref decorations pointing at this commit: local branch names ("main"),
  /// remote-tracking names ("origin/main"), and tag names ("v1.0").
  refs: string[];
  /// True for the commit HEAD currently resolves to.
  isHead: boolean;
}
