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

import { gitApi } from "@/api/git";

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

/// The same answer, for a caller holding nothing but a SHA.
///
/// The terminal's SHA links and the editor's blame chip both take a bare hash
/// out of *text* — there is no commit object to read `parentOids` from — so
/// both built `` `${sha}^` `` by hand and both errored on a root commit with
/// `revspec '<sha>^' not found`. The audit recorded this as needing a new Rust
/// single-commit lookup; it does not. `git_log` already resolves an arbitrary
/// revision and returns `parentOids`, so asking it for one commit *is* the
/// lookup, and reusing it keeps one definition of what a commit's diff base is.
///
/// A failed lookup falls back to `` `${sha}^` ``. That is the old behaviour,
/// and it is the right fallback: if we cannot resolve the SHA at all then
/// neither can the compare tab, and it should say so in its own words rather
/// than silently opening a diff against the empty tree — which for an
/// unresolvable ref would render the entire repository as added.
export async function resolveCommitDiffBase(repoPath: string, sha: string): Promise<string> {
  try {
    const [commit] = await gitApi.log(repoPath, sha, 1);
    if (!commit) return `${sha}^`;
    return commitDiffBase(commit.parentOids);
  } catch {
    return `${sha}^`;
  }
}
