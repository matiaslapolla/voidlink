/// Which two refs answer "what did this commit change?".
///
/// Shared because the two places that ask disagreed, and one of them was
/// broken. The commit graph used a literal `` `${oid}^` ``, which does not
/// resolve for a root commit — so clicking the first commit in a repository
/// errored with `parent 0 does not exist`, while the sidebar's history section
/// asked the same question about the same commit and got a different failure.
/// The same user action failing two different ways depending on which pane it
/// was clicked in is the sort of thing that reads as "the diff viewer never
/// works".

/// Git's empty tree.
///
/// A root commit has no parent to diff against, and using the commit itself as
/// the base reports that it changed nothing — the opposite of true for the
/// commit that created the repository. Diffing the empty tree against it says
/// what it actually added.
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// The base ref for a commit's own diff.
///
/// First parent for an ordinary commit. For a **merge** that means the diff
/// shows everything the merged branch brought in, which is the conventional
/// reading of "what did this merge change" — it is not git's combined-diff
/// view, and the distinction is worth knowing when a merge's file list looks
/// larger than expected.
export function commitDiffBase(parentOids: string[]): string {
  return parentOids[0] ?? EMPTY_TREE_OID;
}
