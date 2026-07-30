use std::collections::HashMap;

use git2::Sort;
use serde::{Deserialize, Serialize};

use super::repo::open_repo;

/// One node in the commit-graph DAG. Mirrors the frontend `GraphCommit`
/// type (serde renames to camelCase). `parent_oids` is what the lane
/// router in the UI uses to draw edges; `refs` are the branch/tag/remote
/// decorations pointing at this commit (rendered as chips).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub author_time: i64,
    /// Committer time. Distinct from `author_time`, and the one the rows are
    /// actually **ordered** by: `Sort::TIME` breaks topological ties on
    /// committer time. Showing author time next to a committer-time ordering
    /// meant that after a rebase or a cherry-pick the list read newest-first
    /// while its timestamps went up and down.
    pub commit_time: i64,
    pub parent_oids: Vec<String>,
    /// Ref decorations pointing at this commit, each with what kind of ref it
    /// is. The kind used to be inferred in the UI from whether the name
    /// contained a slash, which made every local `feature/x` a remote and left
    /// tags indistinguishable from branches.
    pub refs: Vec<RefDecoration>,
    /// True for the commit HEAD currently resolves to. The UI paints this
    /// dot with the `primary` token.
    pub is_head: bool,
}

/// A ref pointing at a commit, and what kind of ref it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefDecoration {
    /// Short name: `main`, `origin/main`, `v1.0`.
    pub name: String,
    /// `"branch"` | `"remote"` | `"tag"` | `"detached"`.
    pub kind: String,
    /// This is the ref HEAD is currently on. Exactly one decoration in the
    /// whole graph can have it. The UI used to apply HEAD styling to *every*
    /// chip on the HEAD commit, so `main`, `origin/main` and `v2.0` rendered
    /// identically there.
    pub is_head: bool,
}

/// Revwalk the repo (topological + time order) starting from HEAD and every
/// local/remote branch tip, returning up to `limit` commits with the parent
/// links + ref decorations needed to render a real commit graph.
///
/// Runs on a blocking thread via the `blocking_git!` wrapper in `mod.rs` so
/// it never stalls the UI thread on large histories.
pub(crate) fn git_commit_graph_impl(
    repo_path: String,
    limit: u32,
) -> Result<Vec<GraphCommit>, String> {
    let repo = open_repo(&repo_path)?;

    // ── Ref decorations ─────────────────────────────────────────────────
    // Build oid → [ref names] once up front. We peel every ref down to the
    // commit it ultimately points at (handles annotated tags), so a chip
    // lands on the right dot. HEAD's symbolic ref is skipped — that's
    // tracked separately via `is_head` so we don't double-label.
    // The branch HEAD is on, or `None` when HEAD is detached.
    let head_branch: Option<String> = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut decorations: HashMap<String, Vec<RefDecoration>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let kind = if r.is_tag() {
                "tag"
            } else if r.is_remote() {
                "remote"
            } else if r.is_branch() {
                "branch"
            } else {
                continue;
            };
            let Some(name) = r.shorthand() else { continue };
            // `origin/HEAD` is a symbolic pointer at the remote's default
            // branch, not a ref of its own. Matched on the last segment rather
            // than the whole string, which only caught the local `HEAD` — so
            // every clone painted a redundant `origin/HEAD` chip beside
            // `origin/main`.
            if name.is_empty() || name.rsplit('/').next() == Some("HEAD") {
                continue;
            }
            if let Ok(commit) = r.peel_to_commit() {
                decorations
                    .entry(commit.id().to_string())
                    .or_default()
                    .push(RefDecoration {
                        name: name.to_string(),
                        is_head: kind == "branch" && Some(name) == head_branch.as_deref(),
                        kind: kind.to_string(),
                    });
            }
        }
    }
    // A detached HEAD decorates nothing, so the commit you are sitting on was
    // marked only by a ring around its dot — no chip, nothing naming it, and
    // nothing distinguishing it from any other commit once you scrolled.
    if head_branch.is_none() {
        if let Some(oid) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
            decorations
                .entry(oid.id().to_string())
                .or_default()
                .push(RefDecoration {
                    name: "HEAD".to_string(),
                    kind: "detached".to_string(),
                    is_head: true,
                });
        }
    }

    for names in decorations.values_mut() {
        // Sorted and deduped on (kind, name), not name alone: a tag and a
        // branch sharing a name are two different refs and collapsing them lost
        // one of the two chips.
        names.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
        names.dedup_by(|a, b| a.kind == b.kind && a.name == b.name);
    }

    let head_oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());

    // ── Revwalk ─────────────────────────────────────────────────────────
    let mut revwalk = repo.revwalk().map_err(|e| e.message().to_string())?;
    // TOPOLOGICAL guarantees a commit appears before its parents — the lane
    // router depends on that child-before-parent ordering. TIME breaks ties
    // so the rows read newest-first like every other history view.
    revwalk
        .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|e| e.message().to_string())?;

    // Seed from HEAD plus every ref that can anchor a lane, so the graph shows
    // every line of work rather than the current branch's ancestry.
    //
    // Tags and stashes were missing, which had a visible consequence: the
    // decoration map above happily builds a chip for a tag, but a commit that
    // is *only* tagged — `v1` on a branch since deleted — was never walked, so
    // the chip could never render and the commit was simply absent from the
    // history. Same for both commits of every stash. `ORIG_HEAD` and friends
    // matter for the same reason: mid-rebase, the tip you started from is
    // reachable from nothing else, and losing sight of it is exactly when you
    // need to see it.
    //
    // Each push is best-effort: a bare or unborn repo simply yields fewer rows.
    let mut pushed = false;
    if revwalk.push_head().is_ok() {
        pushed = true;
    }
    for glob in [
        "refs/heads/*",
        "refs/remotes/*",
        "refs/tags/*",
        "refs/stash",
        "refs/notes/*",
    ] {
        if revwalk.push_glob(glob).is_ok() {
            pushed = true;
        }
    }
    // Not globs — single refs that only sometimes exist. `push_ref` fails
    // quietly when they do not.
    for name in ["ORIG_HEAD", "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"] {
        if revwalk.push_ref(name).is_ok() {
            pushed = true;
        }
    }
    // Other linked worktrees' HEADs. A worktree checked out on another branch
    // is usually covered by `refs/heads/*`, but a detached one is not, and its
    // commits vanished from the graph entirely.
    if let Ok(names) = repo.worktrees() {
        for wt_name in names.iter().flatten() {
            if let Ok(wt) = repo.find_worktree(wt_name) {
                if let Ok(wt_repo) = git2::Repository::open_from_worktree(&wt) {
                    if let Some(oid) = wt_repo.head().ok().and_then(|h| h.target()) {
                        if revwalk.push(oid).is_ok() {
                            pushed = true;
                        }
                    }
                }
            }
        }
    }
    if !pushed {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    // `take(limit)` counted errored and unreadable items against the budget, so
    // a single unreadable object made a 200-limit walk return 199 rows — and
    // the frontend's "is the list exactly `limit` long?" test for whether more
    // history exists then hid "Load more" permanently. Count what we *keep*.
    for item in revwalk {
        if out.len() >= limit as usize {
            break;
        }
        let oid = match item {
            Ok(o) => o,
            Err(_) => continue,
        };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let author = commit.author();
        let oid_str = oid.to_string();
        let refs = decorations.get(&oid_str).cloned().unwrap_or_default();
        out.push(GraphCommit {
            short_oid: oid_str.chars().take(7).collect(),
            summary: commit.summary().unwrap_or("").to_string(),
            author_name: author.name().unwrap_or("").to_string(),
            author_time: author.when().seconds(),
            commit_time: commit.time().seconds(),
            parent_oids: commit.parent_ids().map(|o| o.to_string()).collect(),
            is_head: head_oid == Some(oid),
            refs,
            oid: oid_str,
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    fn graph_of(root: &std::path::Path) -> Vec<GraphCommit> {
        git_commit_graph_impl(root.to_string_lossy().into_owned(), 200).unwrap()
    }

    /// The decoration map has always been able to build a tag chip, but the
    /// revwalk was seeded from branches and HEAD only — so a commit reachable
    /// *only* through a tag was never walked, the chip could never render, and
    /// the commit was simply missing from the history.
    #[test]
    fn a_commit_reachable_only_through_a_tag_is_still_in_the_graph() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let base = commit_all(&repo, "base");

        // A commit on a side branch, tagged, with the branch then deleted.
        let base_commit = repo.find_commit(base).unwrap();
        let default_branch = repo.head().unwrap().name().unwrap().to_string();
        repo.branch("doomed", &base_commit, false).unwrap();
        repo.set_head("refs/heads/doomed").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write_file(tmp.path(), "b.txt", "tagged\n");
        let tagged = commit_all(&repo, "only reachable by tag");
        let tagged_commit = repo.find_commit(tagged).unwrap();
        repo.tag_lightweight("v1", tagged_commit.as_object(), false)
            .unwrap();

        repo.set_head(&default_branch).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        repo.find_branch("doomed", git2::BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();

        let rows = graph_of(tmp.path());
        let row = rows
            .iter()
            .find(|c| c.oid == tagged.to_string())
            .expect("a tagged commit must appear in the graph");
        assert!(
            row.refs.iter().any(|r| r.name == "v1" && r.kind == "tag"),
            "and it must carry its tag chip: {:?}",
            row.refs
        );
    }

    /// `origin/HEAD` is a pointer at the remote's default branch, not a ref of
    /// its own. The old guard matched the whole string `"HEAD"`, so it caught
    /// the local one and let the remote one through — a redundant chip in
    /// every clone.
    #[test]
    fn origin_head_is_not_a_chip() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let oid = commit_all(&repo, "base");

        repo.reference(
            "refs/remotes/origin/main",
            oid,
            true,
            "test remote branch",
        )
        .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test remote head",
        )
        .unwrap();

        let rows = graph_of(tmp.path());
        let row = rows.iter().find(|c| c.oid == oid.to_string()).unwrap();
        assert!(
            row.refs.iter().any(|r| r.name == "origin/main"),
            "the real remote branch still gets a chip: {:?}",
            row.refs
        );
        assert!(
            !row.refs.iter().any(|r| r.name.ends_with("HEAD")),
            "origin/HEAD is not a branch: {:?}",
            row.refs
        );
    }

    /// Exactly one decoration in the whole graph is the ref HEAD is on.
    #[test]
    fn only_the_ref_head_is_on_is_marked_head() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let oid = commit_all(&repo, "base");
        let head = repo.head().unwrap().shorthand().unwrap().to_string();

        let commit = repo.find_commit(oid).unwrap();
        repo.tag_lightweight("v1", commit.as_object(), false).unwrap();
        repo.branch("sibling", &commit, false).unwrap();

        let rows = graph_of(tmp.path());
        let row = rows.iter().find(|c| c.oid == oid.to_string()).unwrap();
        let marked: Vec<_> = row.refs.iter().filter(|r| r.is_head).collect();
        assert_eq!(marked.len(), 1, "got {:?}", row.refs);
        assert_eq!(marked[0].name, head);
    }

    /// A detached HEAD decorated nothing: the commit you are sitting on was
    /// marked only by a ring around its dot, with no chip naming it.
    #[test]
    fn a_detached_head_gets_a_chip() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let oid = commit_all(&repo, "base");
        repo.set_head_detached(oid).unwrap();

        let rows = graph_of(tmp.path());
        let row = rows.iter().find(|c| c.oid == oid.to_string()).unwrap();
        assert!(
            row.refs.iter().any(|r| r.kind == "detached" && r.is_head),
            "got {:?}",
            row.refs
        );
    }

    /// One unreadable object used to eat a slot from `take(limit)`, so a
    /// 200-limit walk returned 199 rows — and the frontend's "is the list
    /// exactly `limit` long?" test for more history then hid "Load more"
    /// permanently. The budget counts rows kept, not items visited.
    #[test]
    fn the_limit_counts_rows_returned() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        for i in 0..8 {
            write_file(tmp.path(), "a.txt", &format!("{i}\n"));
            commit_all(&repo, &format!("c{i}"));
        }
        let rows = git_commit_graph_impl(tmp.path().to_string_lossy().into_owned(), 5).unwrap();
        assert_eq!(rows.len(), 5);
    }
}
