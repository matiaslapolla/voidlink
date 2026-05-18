//! Restack: replay a branch's unique commits onto its parent's current tip.
//!
//! Strategy: in-memory cherry-pick. We never touch the working tree or HEAD
//! until we know all commits replay cleanly. On conflict we return the list
//! of paths *without* mutating the repo — so there is no half-done state
//! that needs a "git rebase --continue" equivalent. The user resolves by
//! using their terminal, or by skipping the branch.
//!
//! This keeps Wave C atomic. If we later want a `git rebase --continue`-style
//! flow, we'll layer it on top of this primitive without changing the
//! happy-path contract.

use std::collections::HashSet;

use git2::{Commit, MergeOptions, Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

use super::discovery;
use crate::git::repo::open_repo;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestackResult {
    pub branch: String,
    pub outcome: RestackOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestackOutcome {
    /// Branch already up-to-date relative to its parent's tip.
    Skipped { reason: String },
    /// Branch successfully rewritten. `newTip` is the new branch tip OID.
    Restacked {
        new_tip: String,
        old_tip: String,
        commits_replayed: u32,
    },
    /// In-memory cherry-pick produced conflicts in `paths`. Nothing was
    /// modified — the branch ref still points at `oldTip`.
    Conflict {
        old_tip: String,
        conflicting_commit: String,
        paths: Vec<String>,
    },
}

// ─── Public entrypoints ──────────────────────────────────────────────────────

pub(crate) fn restack_one_impl(repo_path: String, branch: String) -> Result<RestackResult, String> {
    let repo = open_repo(&repo_path)?;
    restack_branch(&repo, &branch)
}

pub(crate) fn restack_all_impl(
    repo_path: String,
    branches: Vec<String>,
) -> Result<Vec<RestackResult>, String> {
    let repo = open_repo(&repo_path)?;

    // Working tree must be clean before we start touching branch refs — if it
    // isn't, restacking the HEAD branch would silently drop user work.
    if has_uncommitted_changes(&repo)? {
        return Err(
            "working tree has uncommitted changes — commit or stash before restacking".into(),
        );
    }

    let mut out = Vec::with_capacity(branches.len());
    for branch in branches {
        let result = restack_branch(&repo, &branch)?;
        let stop = matches!(result.outcome, RestackOutcome::Conflict { .. });
        out.push(result);
        // Stop on first conflict — downstream branches have just had their
        // parent tip move underneath them, so their results would be both
        // misleading and likely to conflict too.
        if stop {
            break;
        }
    }
    Ok(out)
}

// ─── Core ────────────────────────────────────────────────────────────────────

fn restack_branch(repo: &Repository, branch_name: &str) -> Result<RestackResult, String> {
    // Single-branch restack also enforces clean-tree precondition. If called
    // via restack_all_impl we've already checked, but the duplicate check is
    // cheap and keeps the single-branch entrypoint self-contained.
    if has_uncommitted_changes(repo)? {
        return Err(
            "working tree has uncommitted changes — commit or stash before restacking".into(),
        );
    }

    let parent_name = read_parent(repo, branch_name)?
        .ok_or_else(|| format!("branch `{}` has no recorded parent", branch_name))?;

    let branch_tip = revparse_commit(repo, branch_name)?;
    let parent_tip = revparse_commit(repo, &parent_name)?;
    let stored_base = read_parentbase(repo, branch_name)?;

    // Fast no-op: we already restacked at this parent tip. Nothing changed.
    if stored_base.as_deref() == Some(&parent_tip.id().to_string()) {
        return Ok(RestackResult {
            branch: branch_name.to_string(),
            outcome: RestackOutcome::Skipped {
                reason: "parentbase matches parent tip".into(),
            },
        });
    }

    // Already on top: parent_tip is an ancestor of branch_tip → nothing to do.
    let merge_base = repo
        .merge_base(branch_tip.id(), parent_tip.id())
        .map_err(|e| e.message().to_string())?;
    if merge_base == parent_tip.id() {
        // Sync the stored parentbase so future runs short-circuit here too.
        write_parentbase(repo, branch_name, &parent_tip.id().to_string())?;
        return Ok(RestackResult {
            branch: branch_name.to_string(),
            outcome: RestackOutcome::Skipped {
                reason: "branch already on parent".into(),
            },
        });
    }

    // Walk commits reachable from branch but not from merge_base, oldest first.
    // These are the commits unique to `branch` that we need to replay on top of
    // the new parent tip.
    let commits_to_replay = walk_commits(repo, branch_tip.id(), merge_base)?;
    if commits_to_replay.is_empty() {
        // Defensive: walk produced no commits even though merge_base != parent.
        // This shouldn't happen given the checks above, but if it does we have
        // nothing to do.
        return Ok(RestackResult {
            branch: branch_name.to_string(),
            outcome: RestackOutcome::Skipped {
                reason: "no commits to replay".into(),
            },
        });
    }

    // Replay each commit on top of an accumulator. Start the accumulator at
    // the parent's current tip — that's the new base.
    let committer = repo
        .signature()
        .map_err(|e| format!("repo has no signature: {}", e.message()))?;
    let mut head_for_replay: Commit<'_> = parent_tip.clone();

    for oid in &commits_to_replay {
        let cherry = repo
            .find_commit(*oid)
            .map_err(|e| e.message().to_string())?;
        let mut merge_opts = MergeOptions::new();
        let mut index = repo
            .cherrypick_commit(&cherry, &head_for_replay, 0, Some(&mut merge_opts))
            .map_err(|e| e.message().to_string())?;

        if index.has_conflicts() {
            let paths = conflict_paths(&index);
            return Ok(RestackResult {
                branch: branch_name.to_string(),
                outcome: RestackOutcome::Conflict {
                    old_tip: branch_tip.id().to_string(),
                    conflicting_commit: cherry.id().to_string(),
                    paths,
                },
            });
        }

        let tree_oid = index
            .write_tree_to(repo)
            .map_err(|e| e.message().to_string())?;
        let tree = repo
            .find_tree(tree_oid)
            .map_err(|e| e.message().to_string())?;

        let new_oid = repo
            .commit(
                None, // don't update a ref yet; we set the branch at the end
                &cherry.author(),
                &committer,
                cherry.message().unwrap_or(""),
                &tree,
                &[&head_for_replay],
            )
            .map_err(|e| e.message().to_string())?;
        head_for_replay = repo
            .find_commit(new_oid)
            .map_err(|e| e.message().to_string())?;
    }

    let new_tip = head_for_replay.id();
    let old_tip = branch_tip.id();

    // Update the branch ref to the new tip. If the branch is checked out,
    // also bring the working tree forward. `force` is safe here because we
    // verified the working tree was clean before starting — there is no user
    // edit to clobber. `safe` mode declines to create new files when the
    // current index doesn't track them yet, which would leave the working
    // tree stale relative to the new commit; force avoids that pitfall.
    move_branch_ref(repo, branch_name, new_tip)?;
    if is_head_branch(repo, branch_name)? {
        let obj = repo
            .find_object(new_tip, None)
            .map_err(|e| e.message().to_string())?;
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        repo.checkout_tree(&obj, Some(&mut co))
            .map_err(|e| e.message().to_string())?;
        repo.set_head(&format!("refs/heads/{}", branch_name))
            .map_err(|e| e.message().to_string())?;
    }

    write_parentbase(repo, branch_name, &parent_tip.id().to_string())?;

    Ok(RestackResult {
        branch: branch_name.to_string(),
        outcome: RestackOutcome::Restacked {
            new_tip: new_tip.to_string(),
            old_tip: old_tip.to_string(),
            commits_replayed: commits_to_replay.len() as u32,
        },
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn has_uncommitted_changes(repo: &Repository) -> Result<bool, String> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(false).include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    Ok(!statuses.is_empty())
}

fn revparse_commit<'r>(repo: &'r Repository, refish: &str) -> Result<Commit<'r>, String> {
    repo.revparse_single(refish)
        .map_err(|e| format!("`{}` not found: {}", refish, e.message()))?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())
}

fn walk_commits(repo: &Repository, from: Oid, hide: Oid) -> Result<Vec<Oid>, String> {
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)
        .map_err(|e| e.message().to_string())?;
    walk.push(from).map_err(|e| e.message().to_string())?;
    walk.hide(hide).map_err(|e| e.message().to_string())?;
    let mut out = Vec::new();
    for step in walk {
        let oid = step.map_err(|e| e.message().to_string())?;
        out.push(oid);
    }
    Ok(out)
}

fn conflict_paths(index: &git2::Index) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    if let Ok(conflicts) = index.conflicts() {
        for conflict in conflicts.flatten() {
            // A conflict has up-to-three entries (ancestor / our / their).
            // Any non-None entry's path identifies the file.
            for side in [&conflict.ancestor, &conflict.our, &conflict.their] {
                if let Some(e) = side {
                    let path = String::from_utf8_lossy(&e.path).to_string();
                    seen.insert(path);
                }
            }
        }
    }
    let mut v: Vec<String> = seen.into_iter().collect();
    v.sort();
    v
}

fn move_branch_ref(repo: &Repository, branch_name: &str, new_tip: Oid) -> Result<(), String> {
    let mut branch = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    let reference = branch.get_mut();
    reference
        .set_target(new_tip, "voidlink: restack")
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

fn is_head_branch(repo: &Repository, branch_name: &str) -> Result<bool, String> {
    match repo.head() {
        Ok(head) if head.is_branch() => Ok(head.shorthand() == Some(branch_name)),
        Ok(_) => Ok(false),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(false),
        Err(e) => Err(e.message().to_string()),
    }
}

fn read_parent(repo: &Repository, branch: &str) -> Result<Option<String>, String> {
    discovery::read_config_string_pub(repo, &format!("branch.{}.parent", branch))
}

fn read_parentbase(repo: &Repository, branch: &str) -> Result<Option<String>, String> {
    discovery::read_config_string_pub(repo, &format!("branch.{}.parentbase", branch))
}

fn write_parentbase(repo: &Repository, branch: &str, oid: &str) -> Result<(), String> {
    let mut cfg = repo.config().map_err(|e| e.message().to_string())?;
    cfg.set_str(&format!("branch.{}.parentbase", branch), oid)
        .map_err(|e| e.message().to_string())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use std::path::Path;

    fn init_repo(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        repo
    }

    fn commit_all(repo: &Repository, msg: &str) -> Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    fn write_file(root: &Path, name: &str, contents: &str) {
        fs::write(root.join(name), contents).unwrap();
    }

    fn ensure_main(repo: &Repository) {
        let head = repo.head().unwrap().shorthand().unwrap().to_string();
        if head != "main" {
            let commit = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("main", &commit, false).unwrap();
            let obj = repo.revparse_single("refs/heads/main").unwrap();
            let mut co = git2::build::CheckoutBuilder::new();
            co.safe();
            repo.checkout_tree(&obj, Some(&mut co)).unwrap();
            repo.set_head("refs/heads/main").unwrap();
        }
    }

    fn checkout(repo: &Repository, branch: &str) {
        let obj = repo
            .revparse_single(&format!("refs/heads/{}", branch))
            .unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.safe();
        repo.checkout_tree(&obj, Some(&mut co)).unwrap();
        repo.set_head(&format!("refs/heads/{}", branch)).unwrap();
    }

    fn set_parent_cfg(repo: &Repository, branch: &str, parent: &str) {
        let mut cfg = repo.config().unwrap();
        cfg.set_str(&format!("branch.{}.parent", branch), parent)
            .unwrap();
        let parent_oid = repo
            .revparse_single(parent)
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();
        cfg.set_str(&format!("branch.{}.parentbase", branch), &parent_oid)
            .unwrap();
    }

    #[test]
    fn restack_when_parent_unchanged_returns_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let repo = init_repo(root);
        write_file(root, "a", "1\n");
        commit_all(&repo, "init");
        ensure_main(&repo);
        let main_commit = repo
            .revparse_single("main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        repo.branch("feat", &main_commit, false).unwrap();
        checkout(&repo, "feat");
        set_parent_cfg(&repo, "feat", "main");
        write_file(root, "b", "1\n");
        commit_all(&repo, "feat work");

        let result =
            restack_one_impl(root.to_string_lossy().to_string(), "feat".into()).unwrap();
        match result.outcome {
            RestackOutcome::Skipped { .. } => {}
            other => panic!("expected Skipped, got {:?}", other),
        }
    }

    #[test]
    fn restack_replays_when_parent_advances() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let repo = init_repo(root);
        write_file(root, "a", "1\n");
        commit_all(&repo, "init");
        ensure_main(&repo);

        // Create feat off main, add a commit.
        let main_commit = repo
            .revparse_single("main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        repo.branch("feat", &main_commit, false).unwrap();
        checkout(&repo, "feat");
        set_parent_cfg(&repo, "feat", "main");
        write_file(root, "feat-file", "feat\n");
        let feat_old_tip = commit_all(&repo, "feat work");

        // Advance main.
        checkout(&repo, "main");
        write_file(root, "main-file", "main update\n");
        let new_main_tip = commit_all(&repo, "main moves");

        // Restack feat onto new main tip.
        checkout(&repo, "feat");
        let result =
            restack_one_impl(root.to_string_lossy().to_string(), "feat".into()).unwrap();
        let (new_tip, replayed) = match result.outcome {
            RestackOutcome::Restacked {
                new_tip,
                commits_replayed,
                ..
            } => (new_tip, commits_replayed),
            other => panic!("expected Restacked, got {:?}", other),
        };
        assert_eq!(replayed, 1, "should replay exactly one commit");
        assert_ne!(new_tip, feat_old_tip.to_string(), "branch should move");

        // New feat tip's parent should be the new main tip.
        let new_feat_commit = repo
            .find_commit(Oid::from_str(&new_tip).unwrap())
            .unwrap();
        let parent0 = new_feat_commit.parent_id(0).unwrap();
        assert_eq!(
            parent0, new_main_tip,
            "restacked commit should sit on top of new main tip"
        );

        // parentbase was updated.
        let cfg = repo.config().unwrap();
        let stored_base = cfg.get_string("branch.feat.parentbase").unwrap();
        assert_eq!(stored_base, new_main_tip.to_string());

        // Working tree on HEAD branch has been brought forward — both main-file
        // and feat-file should exist.
        assert!(root.join("main-file").exists());
        assert!(root.join("feat-file").exists());
    }

    #[test]
    fn restack_all_stops_on_first_conflict_but_keeps_prior_results() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let repo = init_repo(root);
        write_file(root, "shared", "1\n");
        commit_all(&repo, "init");
        ensure_main(&repo);

        // Build: main → step-1 → step-2. step-1 edits shared. main also edits
        // shared in a conflicting way; restacking step-1 conflicts; step-2
        // should not be processed.
        let main_commit = repo
            .revparse_single("main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        repo.branch("step-1", &main_commit, false).unwrap();
        checkout(&repo, "step-1");
        set_parent_cfg(&repo, "step-1", "main");
        write_file(root, "shared", "step-1 version\n");
        commit_all(&repo, "step-1 edits shared");

        let s1_commit = repo
            .revparse_single("step-1")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        repo.branch("step-2", &s1_commit, false).unwrap();
        checkout(&repo, "step-2");
        set_parent_cfg(&repo, "step-2", "step-1");
        write_file(root, "other", "step-2\n");
        commit_all(&repo, "step-2 unrelated");

        // Make main conflict with step-1's edit of `shared`.
        checkout(&repo, "main");
        write_file(root, "shared", "main version (conflict)\n");
        commit_all(&repo, "main edits shared too");

        // Drive restack from a clean HEAD on main so the working tree is fine.
        let results = restack_all_impl(
            root.to_string_lossy().to_string(),
            vec!["step-1".into(), "step-2".into()],
        )
        .unwrap();
        assert_eq!(results.len(), 1, "should stop after first conflict");
        match &results[0].outcome {
            RestackOutcome::Conflict { paths, .. } => {
                assert!(
                    paths.iter().any(|p| p == "shared"),
                    "conflict paths should include `shared`, got {:?}",
                    paths
                );
            }
            other => panic!("expected Conflict, got {:?}", other),
        }
        // step-1 ref must be unchanged since we abort on conflict.
        let s1_after = repo
            .revparse_single("step-1")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();
        assert_eq!(s1_after, s1_commit.id(), "step-1 should not have moved");
    }

    #[test]
    fn restack_refuses_when_working_tree_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let repo = init_repo(root);
        write_file(root, "a", "1\n");
        commit_all(&repo, "init");
        ensure_main(&repo);
        let main_commit = repo
            .revparse_single("main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        repo.branch("feat", &main_commit, false).unwrap();
        checkout(&repo, "feat");
        set_parent_cfg(&repo, "feat", "main");
        write_file(root, "x", "x\n");
        commit_all(&repo, "feat work");

        // Dirty the working tree.
        write_file(root, "a", "modified\n");
        let err =
            restack_one_impl(root.to_string_lossy().to_string(), "feat".into()).unwrap_err();
        assert!(
            err.contains("working tree"),
            "expected working-tree error, got: {}",
            err
        );
    }
}
