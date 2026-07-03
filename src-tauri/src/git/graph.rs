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
    pub parent_oids: Vec<String>,
    /// Ref decorations pointing at this commit: local branch names
    /// ("main"), remote-tracking names ("origin/main"), and tag names
    /// ("v1.0"). Empty for the vast majority of commits.
    pub refs: Vec<String>,
    /// True for the commit HEAD currently resolves to. The UI paints this
    /// dot with the `primary` token.
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
    let mut decorations: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            if !(r.is_branch() || r.is_remote() || r.is_tag()) {
                continue;
            }
            let Some(name) = r.shorthand() else { continue };
            if name.is_empty() || name == "HEAD" {
                continue;
            }
            if let Ok(commit) = r.peel_to_commit() {
                decorations
                    .entry(commit.id().to_string())
                    .or_default()
                    .push(name.to_string());
            }
        }
    }
    for names in decorations.values_mut() {
        names.sort();
        names.dedup();
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

    // Seed from HEAD plus every branch tip so the graph shows every lane,
    // not just the current branch's ancestry. Each push is best-effort:
    // a bare/unborn repo simply yields fewer (or zero) rows.
    let mut pushed = false;
    if revwalk.push_head().is_ok() {
        pushed = true;
    }
    if revwalk.push_glob("refs/heads/*").is_ok() {
        pushed = true;
    }
    if revwalk.push_glob("refs/remotes/*").is_ok() {
        pushed = true;
    }
    if !pushed {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for item in revwalk.take(limit as usize) {
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
            author_time: commit.time().seconds(),
            parent_oids: commit.parent_ids().map(|o| o.to_string()).collect(),
            is_head: head_oid.map_or(false, |h| h == oid),
            refs,
            oid: oid_str,
        });
    }

    Ok(out)
}
