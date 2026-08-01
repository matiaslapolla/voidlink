use std::collections::HashMap;

use git2::BranchType;

use super::repo::open_repo;
use super::{AheadBehind, GitBranchInfo};

/// The upstream this branch's config still names, when the ref it names is
/// gone.
///
/// Reads `branch.<name>.remote` and `branch.<name>.merge` — the two keys
/// `git branch --set-upstream-to` writes — and reassembles the short
/// remote-tracking name from them. Returns `None` when the branch genuinely
/// tracks nothing, which is what keeps the two cases apart.
fn configured_upstream(repo: &git2::Repository, name: &str) -> Option<String> {
    let cfg = repo.config().ok()?;
    let remote = cfg.get_string(&format!("branch.{name}.remote")).ok()?;
    let merge = cfg.get_string(&format!("branch.{name}.merge")).ok()?;
    let short = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
    // A `.remote` of `.` means "this repository" — the upstream is a local
    // branch and has no remote prefix.
    if remote == "." {
        Some(short.to_string())
    } else {
        Some(format!("{remote}/{short}"))
    }
}

/// Every local branch's tip, keyed by branch name.
///
/// Built once per listing, and only when remote rows are being listed at all,
/// because the alternative is a `find_branch` per remote row: a repository with
/// 500 remote-tracking branches would then do 500 ref lookups on every git
/// pulse to discover that a dozen of them have a local counterpart. This walks
/// `refs/heads/` — which is bounded by the number of branches *you* made, not
/// by the number your colleagues pushed — and every remote row after it is a
/// hash lookup.
fn local_tips(repo: &git2::Repository) -> HashMap<String, git2::Oid> {
    let mut tips = HashMap::new();
    let Ok(iter) = repo.branches(Some(BranchType::Local)) else {
        return tips;
    };
    for (branch, _) in iter.flatten() {
        // A name that is not valid UTF-8 cannot be matched against a remote
        // row's name anyway, and a symbolic ref has no tip of its own worth
        // counting against — `target()` returning None drops both.
        if let (Ok(Some(name)), Some(oid)) = (branch.name(), branch.get().target()) {
            tips.insert(name.to_string(), oid);
        }
    }
    tips
}

/// The branch name inside a remote-tracking ref's short name: `origin/feat` is
/// the branch `feat` on the remote `origin`.
///
/// Matched against the repository's configured remotes, longest prefix first,
/// rather than cut at a slash. Two things go wrong otherwise, and they pull in
/// opposite directions: taking the *last* segment turns `origin/feature/x` into
/// `x` and would compare a remote branch against an unrelated local one, while
/// cutting at the *first* slash breaks a remote whose own name contains one
/// (`git remote add fork/mirror …` is legal, and produces
/// `refs/remotes/fork/mirror/feat`).
///
/// The first-slash cut survives as a fallback for a ref under `refs/remotes/`
/// whose remote is no longer in config — a pruned remote leaves those behind,
/// and guessing the usual layout is better than refusing to compare at all.
fn remote_branch_short_name(remotes: &[String], name: &str) -> Option<String> {
    let mut best: Option<&str> = None;
    for remote in remotes {
        let Some(rest) = name
            .strip_prefix(remote.as_str())
            .and_then(|s| s.strip_prefix('/'))
        else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        // The longest matching remote leaves the shortest remainder.
        if best.is_none_or(|b| rest.len() < b.len()) {
            best = Some(rest);
        }
    }
    if let Some(rest) = best {
        return Some(rest.to_string());
    }
    match name.split_once('/') {
        Some((remote, rest)) if !remote.is_empty() && !rest.is_empty() => Some(rest.to_string()),
        _ => None,
    }
}

/// What a remote-tracking branch's ahead/behind is measured against: the local
/// branch of the same short name, per the 2026-08-01 decision on CMP-F22.
///
/// The question it answers is "have I pulled what is up there, and have I
/// pushed what is down here" — the local row's question from the other side, so
/// the counts are stated with the *remote* row as the subject: `ahead` is what
/// `origin/feat` has that local `feat` does not.
///
/// `None` when there is no local branch of that name. That is the common case
/// on any repository with more remote branches than you have checked out, and
/// it is also the case that must not be drawn as `↑0 ↓0`: the row would then
/// claim to be in sync with a branch that does not exist.
fn remote_ahead_behind(
    repo: &git2::Repository,
    tips: &HashMap<String, git2::Oid>,
    remotes: &[String],
    name: &str,
    remote_tip: Option<git2::Oid>,
) -> (Option<AheadBehind>, bool) {
    let Some(short) = remote_branch_short_name(remotes, name) else {
        return (None, false);
    };
    let (Some(&local_tip), Some(remote_tip)) = (tips.get(&short), remote_tip) else {
        return (None, false);
    };
    // Identical tips are a real, renderable `↑0 ↓0`, and the one case where the
    // answer is known without a walk. Worth the branch: a fetched repository
    // where nothing has moved has every counterpart pair on the same commit,
    // and this turns that pulse's cost from a merge-base search per row into a
    // pointer comparison.
    if local_tip == remote_tip {
        return (
            Some(AheadBehind {
                ahead: 0,
                behind: 0,
                against: short,
            }),
            false,
        );
    }
    match repo.graph_ahead_behind(remote_tip, local_tip) {
        Ok((ahead, behind)) => (
            Some(AheadBehind {
                ahead: ahead as u32,
                behind: behind as u32,
                against: short,
            }),
            false,
        ),
        // See repo.rs: a walk that cannot complete (shallow clone, missing
        // objects) must not be reported as 0/0 "in sync".
        Err(e) => {
            log::warn!("ahead/behind for {name} unavailable: {e}");
            (None, true)
        }
    }
}

pub(crate) fn git_list_branches_impl(
    repo_path: String,
    include_remote: bool,
) -> Result<Vec<GitBranchInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let mut branches = Vec::new();

    // Both are only used to compare a remote row against its local counterpart,
    // so neither is paid for by the workbench's default local-only listing.
    let (tips, remotes) = if include_remote {
        let names = repo
            .remotes()
            .map(|rs| rs.iter().flatten().map(|s| s.to_string()).collect())
            .unwrap_or_else(|_| Vec::new());
        (local_tips(&repo), names)
    } else {
        (HashMap::new(), Vec::new())
    };

    let branch_types = if include_remote {
        vec![BranchType::Local, BranchType::Remote]
    } else {
        vec![BranchType::Local]
    };

    for btype in branch_types {
        let iter = repo
            .branches(Some(btype))
            .map_err(|e| e.message().to_string())?;
        for item in iter {
            let (branch, _) = item.map_err(|e| e.message().to_string())?;
            // `branch.name()` yields `None` for a name that is not valid UTF-8,
            // and the row was then skipped: the branch was invisible, in a pane
            // whose entire job is telling you which branches exist. A repo
            // cloned from a filesystem that permits those names has them, and
            // "it isn't in the list" is indistinguishable from "it isn't in the
            // repo". Decode lossily instead and mark the row, so it is at least
            // *there* while every action that takes a name stays off it.
            let (name, lossy_name) = match branch.name_bytes() {
                Ok(bytes) => match std::str::from_utf8(bytes) {
                    Ok(s) => (s.to_string(), false),
                    Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true),
                },
                Err(e) => return Err(e.message().to_string()),
            };
            if name.is_empty() {
                continue;
            }
            // `repo.branches(Remote)` yields the symbolic ref
            // `refs/remotes/<remote>/HEAD`, which is a pointer at the remote's
            // default branch rather than a branch of its own. It is present in
            // every clone, and listing it produced a row that could never be
            // checked out: `safe_checkout` derives the local name `HEAD` from
            // it and libgit2 rejects that as an invalid branch name. Its
            // context menu still merged and rebased, silently operating on
            // whatever it pointed at under a misleading name.
            //
            // Matched on the last segment rather than the whole string so it
            // holds for any remote, not just `origin`.
            let is_remote = btype == BranchType::Remote;
            if is_remote && name.rsplit('/').next() == Some("HEAD") {
                continue;
            }
            let is_head = branch.is_head();

            let (upstream, ahead_behind, ahead_behind_unknown) = if !is_remote {
                if let Ok(up) = branch.upstream() {
                    let up_name = up.name().ok().flatten().map(|s| s.to_string());
                    let local_oid = branch.get().target();
                    let up_oid = up.get().target();
                    // See repo.rs: a walk that cannot complete (shallow clone,
                    // missing objects) must not be reported as 0/0 "in sync".
                    let (counts, unknown) = match (local_oid, up_oid, up_name.as_deref()) {
                        (Some(l), Some(u), Some(against)) => {
                            match repo.graph_ahead_behind(l, u) {
                                Ok((a, b)) => (
                                    Some(AheadBehind {
                                        ahead: a as u32,
                                        behind: b as u32,
                                        against: against.to_string(),
                                    }),
                                    false,
                                ),
                                Err(e) => {
                                    log::warn!("ahead/behind for {name} unavailable: {e}");
                                    (None, true)
                                }
                            }
                        }
                        _ => (None, false),
                    };
                    (up_name, counts, unknown)
                } else {
                    // `branch.upstream()` fails both for a branch that never
                    // tracked anything and for one whose remote-tracking ref
                    // has been deleted while `branch.<name>.remote`/`.merge`
                    // remain in config. Those are different facts and they
                    // used to render identically — no arrows, no `?`, exactly
                    // like a purely local branch.
                    //
                    // Config still naming an upstream means we know one was
                    // configured and cannot measure against it, which is what
                    // `aheadBehindUnknown` exists to say.
                    let configured = configured_upstream(&repo, &name);
                    let unknown = configured.is_some();
                    (configured, None, unknown)
                }
            } else {
                // A remote-tracking branch has no upstream of its own; what it
                // is counted against is the local branch of the same name.
                let (counts, unknown) =
                    remote_ahead_behind(&repo, &tips, &remotes, &name, branch.get().target());
                (None, counts, unknown)
            };

            let (last_commit_summary, last_commit_time) =
                if let Some(oid) = branch.get().target() {
                    if let Ok(commit) = repo.find_commit(oid) {
                        (
                            commit.summary().map(|s| s.to_string()),
                            Some(commit.time().seconds()),
                        )
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

            // A symbolic ref under `refs/heads/` is an alias, not a branch.
            // It listed as an ordinary row, so deleting it removed the alias
            // while the user believed they had deleted its target — and the row
            // said nothing at all about the indirection.
            let symbolic_target = branch
                .get()
                .symbolic_target()
                .map(|t| t.strip_prefix("refs/heads/").unwrap_or(t).to_string());

            branches.push(GitBranchInfo {
                name,
                is_head,
                is_remote,
                upstream,
                ahead_behind,
                ahead_behind_unknown,
                last_commit_summary,
                last_commit_time,
                lossy_name,
                symbolic_target,
            });
        }
    }

    // An unborn HEAD — `git init -b main`, or the first branch of an orphan
    // checkout — has no ref yet, so `repo.branches()` cannot see it. The header
    // says `main` while the pane listed zero branches, which in a fresh
    // repository is the entire pane. It is a real branch by every definition
    // the user has; it just has no commit on it yet.
    if repo.head().is_err() {
        if let Some(name) = unborn_head_name(&repo) {
            if !branches.iter().any(|b| !b.is_remote && b.name == name) {
                branches.push(GitBranchInfo {
                    name,
                    is_head: true,
                    is_remote: false,
                    upstream: None,
                    ahead_behind: None,
                    ahead_behind_unknown: false,
                    last_commit_summary: None,
                    last_commit_time: None,
                    lossy_name: false,
                    symbolic_target: None,
                });
            }
        }
    }

    branches.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(branches)
}

/// The branch name HEAD points at when no commit has been made yet.
fn unborn_head_name(repo: &git2::Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    let target = head.symbolic_target()?;
    Some(target.strip_prefix("refs/heads/")?.to_string())
}

/// Create a branch at `start_point` (default HEAD) WITHOUT switching to it.
/// Distinct from checkout-with-create: this just adds the ref.
pub(crate) fn git_create_branch_impl(
    repo_path: String,
    name: String,
    start_point: Option<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    super::opstate::ensure_no_operation(&repo, "create a branch")?;
    let start = start_point.as_deref().unwrap_or("HEAD");
    let target = repo
        .revparse_single(start)
        .map_err(|e| format!("could not resolve '{start}': {}", e.message()))?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    repo.branch(&name, &target, false)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Delete a local branch. Refuses the current HEAD. When the branch isn't fully
/// merged into its upstream/HEAD, returns a recognizable "not fully merged"
/// error unless `force` is set — the UI keys off that to offer a force path.
pub(crate) fn git_delete_branch_impl(
    repo_path: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    // Every sibling mutation has had this guard; delete did not, and delete is
    // the one that loses work. A rebase detaches HEAD, so `is_head()` below is
    // false for the branch *being rebased* — you could delete it mid-rebase,
    // and `git rebase --continue` would then fail with
    //   update_ref failed for ref 'refs/heads/<name>': unable to resolve reference
    // leaving the replayed commits reachable only from the reflog. The
    // workbench happened to disable the button; the git window did not, so the
    // UI was the only thing standing between the user and that.
    //
    // Refused for any in-progress operation rather than only for the branch
    // git is currently replaying: knowing which branch that is means parsing
    // `rebase-merge/head-name`, and "finish or abort first" is both easier to
    // act on and consistent with create, rename and checkout.
    super::opstate::ensure_no_operation(&repo, "delete a branch")?;
    // Same reasoning, one worktree over: deleting the branch another worktree
    // is mid-rebase on leaves the replayed commits reachable only from the
    // reflog, and this repo's own git dir shows no operation at all.
    super::opstate::ensure_branch_free(&repo, &name, "delete a branch")?;
    let mut branch = repo
        .find_branch(&name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    if branch.is_head() {
        return Err("cannot delete the current branch".to_string());
    }

    if !force {
        let tip = branch
            .get()
            .target()
            .ok_or_else(|| format!("branch '{name}' has no commit to check"))?;
        if !is_merged_anywhere(&repo, &name, tip) {
            // The marker is what the UI keys off to offer the force path. It is
            // a stable token rather than English prose, because matching on a
            // sentence breaks the moment libgit2 or a locale rewords it.
            return Err(format!(
                "[not-fully-merged] branch '{name}' is not merged into any other branch — force to delete anyway"
            ));
        }
    }

    branch.delete().map_err(|e| e.message().to_string())
}

/// Is this branch's tip already contained in some other branch?
///
/// The old test was "is HEAD a descendant of the tip", which answered a
/// different and much narrower question: a branch merged into a *different*
/// branch, or already pushed and merged upstream, reported as unmerged, and on a
/// detached or unborn HEAD *every* branch did. The force prompt therefore fired
/// constantly and taught users to click through it — which is how a real
/// unmerged branch eventually gets force-deleted.
///
/// So: merged means any other local or remote-tracking ref contains this tip.
fn is_merged_anywhere(repo: &git2::Repository, name: &str, tip: git2::Oid) -> bool {
    let Ok(refs) = repo.references() else {
        return false;
    };
    for reference in refs.flatten() {
        let Some(ref_name) = reference.name() else {
            continue;
        };
        let is_branchy = ref_name.starts_with("refs/heads/") || ref_name.starts_with("refs/remotes/");
        if !is_branchy {
            continue;
        }
        // Skip the branch itself (and its own remote-tracking counterpart, which
        // is just "this same branch, pushed" — not evidence of a merge).
        if is_own_counterpart(ref_name, name) {
            continue;
        }
        let Some(other) = reference.target() else {
            continue;
        };
        if other == tip || repo.graph_descendant_of(other, tip).unwrap_or(false) {
            return true;
        }
    }
    false
}

/// Is `ref_name` this same branch rather than a different one?
///
/// That means `refs/heads/<name>` itself, or `refs/remotes/<remote>/<name>` —
/// the branch pushed somewhere, which proves nothing about a merge.
///
/// The test used to be `ref_name.ends_with("/{name}")`, which matched *any* ref
/// whose last segment happened to agree. With `topic` unmerged but a local
/// `feature/topic` sitting on its exact tip, the real evidence of containment
/// was skipped and the force-delete prompt appeared for a branch that was fully
/// contained in another. That is precisely the harm `is_merged_anywhere`'s doc
/// comment says it exists to prevent: a prompt that cries wolf teaches you to
/// click through the one time it is telling the truth.
///
/// Splitting on the first `/` after the prefix keeps slashes in branch names
/// working: `refs/remotes/origin/feature/x` is remote `origin`, branch
/// `feature/x`.
fn is_own_counterpart(ref_name: &str, name: &str) -> bool {
    if ref_name == format!("refs/heads/{name}") {
        return true;
    }
    match ref_name.strip_prefix("refs/remotes/") {
        Some(rest) => match rest.split_once('/') {
            Some((remote, branch)) => !remote.is_empty() && branch == name,
            None => false,
        },
        None => false,
    }
}

pub(crate) fn git_rename_branch_impl(
    repo_path: String,
    old_name: String,
    new_name: String,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    // Renaming the branch a rebase is running on rewrites the ref its state
    // files point at, and `--continue` / `--abort` can then never find it again.
    super::opstate::ensure_no_operation(&repo, "rename a branch")?;
    // ...and the same check for every *other* worktree of this repository. The
    // guard above only sees the opened repo's git dir, but a linked worktree
    // keeps its rebase state under `.git/worktrees/<id>/`, so a rename here of
    // the branch it is replaying broke its `--continue` with nothing refusing.
    super::opstate::ensure_branch_free(&repo, &old_name, "rename a branch")?;
    let mut branch = repo
        .find_branch(&old_name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    branch
        .rename(&new_name, force)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_checkout_branch_impl(
    repo_path: String,
    branch: String,
    create: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    super::opstate::ensure_no_operation(&repo, "switch branches")?;

    if create {
        let head = repo
            .head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        repo.branch(&branch, &head, false)
            .map_err(|e| e.message().to_string())?;
    }

    switch_to_branch(&repo, &repo_path, &branch)
}

/// Point HEAD at `branch` and bring the working tree with it, atomically enough
/// that a failure leaves the repository where it started.
///
/// `checkout_tree` then `set_head` was two independent mutations: if `set_head`
/// failed, the working tree already held the *target* branch's content while HEAD
/// still named the old branch — every file then reads as modified, and the user
/// has no idea which branch they are on. Ordering it the other way round gives us
/// something to undo: HEAD moves first, and a failed checkout puts it back.
pub(crate) fn switch_to_branch(
    repo: &git2::Repository,
    repo_path: &str,
    branch: &str,
) -> Result<(), String> {
    let target_ref = format!("refs/heads/{branch}");
    let treeish = repo
        .revparse_single(&target_ref)
        .map_err(|e| format!("branch '{branch}': {}", e.message()))?;

    // What to restore if the checkout fails.
    let previous: Option<String> = repo
        .head()
        .ok()
        .and_then(|h| h.name().map(|n| n.to_string()));
    let previous_detached_at = if repo.head_detached().unwrap_or(false) {
        repo.head().ok().and_then(|h| h.target())
    } else {
        None
    };

    repo.set_head(&target_ref)
        .map_err(|e| e.message().to_string())?;

    let checkout = super::locking::retry_on_lock(repo_path, || {
        let mut builder = git2::build::CheckoutBuilder::new();
        builder.safe();
        repo.checkout_tree(&treeish, Some(&mut builder))
            .map_err(|e| e.message().to_string())
    });

    if let Err(e) = checkout {
        let restored = match (previous_detached_at, previous.as_deref()) {
            (Some(oid), _) => repo.set_head_detached(oid).is_ok(),
            (None, Some(name)) => repo.set_head(name).is_ok(),
            _ => false,
        };
        return Err(if restored {
            format!("could not switch to {branch}: {e} (HEAD left where it was)")
        } else {
            format!("could not switch to {branch}: {e} — and HEAD could not be restored, run `git checkout` by hand")
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh `git init` has a branch by every definition the user has — the
    /// header names it — but no ref yet, so the pane listed nothing at all.
    #[test]
    fn an_unborn_branch_is_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        let expected = unborn_head_name(&repo).expect("HEAD is symbolic before the first commit");

        let list = git_list_branches_impl(tmp.path().to_string_lossy().into_owned(), true).unwrap();
        let found = list
            .iter()
            .find(|b| b.name == expected)
            .expect("the branch the header names must be in the list");
        assert!(found.is_head);
        assert!(found.last_commit_time.is_none());
    }

    /// A tracking ref deleted out from under a branch (a pruned remote branch)
    /// used to render exactly like a branch that never tracked anything: no
    /// arrows, no `?`. `aheadBehindUnknown` exists to say "configured, but
    /// unmeasurable" and was never set.
    #[test]
    fn a_branch_whose_upstream_ref_is_gone_reports_unknown_not_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        commit_all(&repo, "base");

        let head = repo.head().unwrap().shorthand().unwrap().to_string();
        // Config naming an upstream whose ref does not exist.
        let mut cfg = repo.config().unwrap();
        cfg.set_str(&format!("branch.{head}.remote"), "origin").unwrap();
        cfg.set_str(&format!("branch.{head}.merge"), &format!("refs/heads/{head}"))
            .unwrap();

        let list = git_list_branches_impl(tmp.path().to_string_lossy().into_owned(), true).unwrap();
        let row = list.iter().find(|b| b.name == head).unwrap();
        assert_eq!(row.upstream.as_deref(), Some(format!("origin/{head}").as_str()));
        assert!(
            row.ahead_behind_unknown,
            "an upstream we cannot measure must not look like an in-sync branch"
        );
    }
    use crate::git::testfix::{commit_all, init_repo, write_file};

    // ─── CMP-F22: a remote row's ahead/behind ────────────────────────────
    //
    // The decision these cover: a remote-tracking branch is compared to the
    // LOCAL branch of the same short name, and a remote branch with no local
    // counterpart makes no claim at all rather than claiming `↑0 ↓0`.

    /// A commit on top of `parent`, reusing its tree and touching no ref. The
    /// ahead/behind walk counts commits, not contents, so a repeated tree is
    /// exactly as good as a real edit and much cheaper to set up.
    fn child_of(repo: &git2::Repository, parent: git2::Oid, message: &str) -> git2::Oid {
        let parent_commit = repo.find_commit(parent).unwrap();
        let tree = parent_commit.tree().unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        repo.commit(None, &sig, &sig, message, &tree, &[&parent_commit])
            .unwrap()
    }

    /// A repository with a remote configured and one commit, whose oid is
    /// returned: the base every ahead/behind case below diverges from.
    fn repo_with_remote(root: &std::path::Path) -> (git2::Repository, git2::Oid) {
        let repo = init_repo(root);
        write_file(root, "a.txt", "one\n");
        let base = commit_all(&repo, "base");
        repo.remote("origin", "https://example.invalid/x.git").unwrap();
        (repo, base)
    }

    fn set_ref(repo: &git2::Repository, name: &str, oid: git2::Oid) {
        repo.reference(name, oid, true, "test fixture").unwrap();
    }

    /// The row for `origin/<name>` from a full listing.
    fn remote_row(root: &std::path::Path, name: &str) -> GitBranchInfo {
        let list = git_list_branches_impl(root.to_string_lossy().into_owned(), true).unwrap();
        list.into_iter()
            .find(|b| b.is_remote && b.name == name)
            .unwrap_or_else(|| panic!("{name} must be listed"))
    }

    /// The remote has commits the local branch does not — the "you have not
    /// pulled" half of the question the chip answers.
    #[test]
    fn a_remote_ahead_of_its_local_counterpart_counts_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        let tip = child_of(&repo, child_of(&repo, base, "one"), "two");
        repo.branch("feat", &repo.find_commit(base).unwrap(), false).unwrap();
        set_ref(&repo, "refs/remotes/origin/feat", tip);

        let counts = remote_row(root, "origin/feat").ahead_behind.expect("a local feat exists");
        assert_eq!((counts.ahead, counts.behind), (2, 0));
        assert_eq!(counts.against, "feat", "the row must name what it compared to");
    }

    /// The local branch has commits the remote does not — "you have not pushed".
    #[test]
    fn a_remote_behind_its_local_counterpart_counts_down() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        let local_tip = child_of(&repo, base, "unpushed");
        repo.branch("feat", &repo.find_commit(local_tip).unwrap(), false).unwrap();
        set_ref(&repo, "refs/remotes/origin/feat", base);

        let counts = remote_row(root, "origin/feat").ahead_behind.unwrap();
        assert_eq!((counts.ahead, counts.behind), (0, 1));
    }

    /// Both sides moved. The two counts are independent, and a diverged pair is
    /// the state where reading one without the other is most misleading.
    #[test]
    fn a_diverged_remote_counts_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        let theirs = child_of(&repo, child_of(&repo, base, "theirs 1"), "theirs 2");
        let ours = child_of(&repo, base, "ours");
        repo.branch("feat", &repo.find_commit(ours).unwrap(), false).unwrap();
        set_ref(&repo, "refs/remotes/origin/feat", theirs);

        let counts = remote_row(root, "origin/feat").ahead_behind.unwrap();
        assert_eq!((counts.ahead, counts.behind), (2, 1));
    }

    /// The case the `Option` exists for, from the other side: level with its
    /// local counterpart is a *measured* zero, and it must survive as one so the
    /// row can say "you are in sync" rather than saying nothing.
    #[test]
    fn a_remote_level_with_its_local_counterpart_still_makes_a_claim() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        repo.branch("feat", &repo.find_commit(base).unwrap(), false).unwrap();
        set_ref(&repo, "refs/remotes/origin/feat", base);

        let counts = remote_row(root, "origin/feat")
            .ahead_behind
            .expect("identical tips are a real 0/0, not an absent comparison");
        assert_eq!((counts.ahead, counts.behind), (0, 0));
        assert_eq!(counts.against, "feat");
    }

    /// No local branch of that name: there is nothing to compare against, and
    /// `↑0 ↓0` here would claim to be in sync with a branch that does not exist.
    #[test]
    fn a_remote_with_no_local_counterpart_makes_no_claim() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        set_ref(&repo, "refs/remotes/origin/spike", base);

        let row = remote_row(root, "origin/spike");
        assert!(row.ahead_behind.is_none(), "no local spike, so no claim");
        assert!(
            !row.ahead_behind_unknown,
            "nothing failed to compute — there was simply nothing to compute",
        );
    }

    /// A branch name that itself contains slashes. Cutting the ref at the last
    /// slash would compare `origin/feature/x` against a local branch called
    /// `x` — a different branch, silently.
    #[test]
    fn a_slashed_branch_name_matches_its_local_counterpart() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        let tip = child_of(&repo, base, "theirs");
        repo.branch("feature/x", &repo.find_commit(base).unwrap(), false).unwrap();
        // The branch the naive last-segment split would have picked instead,
        // parked somewhere the counts would visibly differ.
        repo.branch("x", &repo.find_commit(tip).unwrap(), false).unwrap();
        set_ref(&repo, "refs/remotes/origin/feature/x", tip);

        let counts = remote_row(root, "origin/feature/x").ahead_behind.unwrap();
        assert_eq!(counts.against, "feature/x");
        assert_eq!((counts.ahead, counts.behind), (1, 0));
    }

    /// The name split, on its own. A remote whose *own* name contains a slash is
    /// legal, and cutting at the first slash gets it wrong in the direction the
    /// last-segment split gets right — which is why neither is used alone.
    #[test]
    fn the_remote_prefix_is_matched_not_guessed() {
        let remotes = vec!["origin".to_string(), "fork/mirror".to_string()];
        assert_eq!(
            remote_branch_short_name(&remotes, "origin/feat").as_deref(),
            Some("feat")
        );
        assert_eq!(
            remote_branch_short_name(&remotes, "origin/feature/x").as_deref(),
            Some("feature/x")
        );
        assert_eq!(
            remote_branch_short_name(&remotes, "fork/mirror/feature/x").as_deref(),
            Some("feature/x")
        );
        // A remote that is no longer in config still leaves refs behind: the
        // usual layout is a better guess than refusing to compare.
        assert_eq!(
            remote_branch_short_name(&remotes, "pruned/feat").as_deref(),
            Some("feat")
        );
        // Nothing to strip.
        assert_eq!(remote_branch_short_name(&remotes, "origin").as_deref(), None);
        assert_eq!(remote_branch_short_name(&remotes, "origin/").as_deref(), None);
    }

    /// A local row's counts must keep naming their upstream, which is what makes
    /// the two kinds of row readable side by side.
    #[test]
    fn a_local_rows_counts_name_its_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (repo, base) = repo_with_remote(root);
        let head = repo.head().unwrap().shorthand().unwrap().to_string();
        set_ref(&repo, &format!("refs/remotes/origin/{head}"), base);
        let mut branch = repo.find_branch(&head, BranchType::Local).unwrap();
        branch.set_upstream(Some(&format!("origin/{head}"))).unwrap();

        let list = git_list_branches_impl(root.to_string_lossy().into_owned(), true).unwrap();
        let row = list.iter().find(|b| !b.is_remote && b.name == head).unwrap();
        let counts = row.ahead_behind.as_ref().expect("an upstream that resolves");
        assert_eq!(counts.against, format!("origin/{head}"));
        assert_eq!((counts.ahead, counts.behind), (0, 0));
    }

    /// `is_own_counterpart` must recognise the branch itself and the branch
    /// pushed to a remote — and nothing else.
    #[test]
    fn only_the_branch_itself_and_its_pushed_copies_are_skipped() {
        assert!(is_own_counterpart("refs/heads/topic", "topic"));
        assert!(is_own_counterpart("refs/remotes/origin/topic", "topic"));
        assert!(is_own_counterpart("refs/remotes/fork/topic", "topic"));
        assert!(is_own_counterpart(
            "refs/remotes/origin/feature/x",
            "feature/x"
        ));

        // A different branch that merely ends in the same segment. This is the
        // one the old `ends_with("/{name}")` got wrong.
        assert!(!is_own_counterpart("refs/heads/feature/topic", "topic"));
        assert!(!is_own_counterpart("refs/heads/other", "topic"));
        assert!(!is_own_counterpart("refs/tags/topic", "topic"));
        // No remote segment at all.
        assert!(!is_own_counterpart("refs/remotes/topic", "topic"));
    }

    /// A branch fully contained in another local branch is merged, so deleting
    /// it must not raise the force prompt.
    #[test]
    fn a_branch_contained_in_a_slashed_sibling_counts_as_merged() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);

        write_file(root, "a.txt", "one\n");
        commit_all(&repo, "base");
        write_file(root, "a.txt", "two\n");
        let tip = commit_all(&repo, "on topic");

        let commit = repo.find_commit(tip).unwrap();
        repo.branch("topic", &commit, false).unwrap();
        // Same tip, name ending in "/topic" — evidence of containment that the
        // old suffix test threw away.
        repo.branch("feature/topic", &commit, false).unwrap();
        // Get off both branches so `is_head` does not short-circuit the test.
        repo.set_head_detached(tip).unwrap();

        assert!(
            is_merged_anywhere(&repo, "topic", tip),
            "feature/topic contains this tip",
        );
        git_delete_branch_impl(root.to_string_lossy().into_owned(), "topic".into(), false)
            .expect("no force prompt for a contained branch");
    }

    /// A symbolic ref under `refs/heads/` is an alias, not a branch. It listed
    /// as an ordinary row with nothing to say so, and deleting it removed the
    /// alias while the user believed they had deleted `v2`.
    #[test]
    fn a_symbolic_head_ref_reports_what_it_points_at() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);
        write_file(root, "a.txt", "one\n");
        let tip = commit_all(&repo, "base");
        repo.branch("v2", &repo.find_commit(tip).unwrap(), false).unwrap();
        repo.reference_symbolic("refs/heads/stable", "refs/heads/v2", false, "alias")
            .unwrap();

        let list = git_list_branches_impl(root.to_string_lossy().into_owned(), false).unwrap();
        let alias = list.iter().find(|b| b.name == "stable").expect("still listed");
        assert_eq!(alias.symbolic_target.as_deref(), Some("v2"));
        let real = list.iter().find(|b| b.name == "v2").unwrap();
        assert!(real.symbolic_target.is_none(), "a real branch points at nothing");
    }

    /// Deleting the branch another worktree is mid-rebase on leaves the
    /// replayed commits reachable only from the reflog — and this repository's
    /// own git dir shows no operation at all, so nothing refused it.
    #[test]
    fn delete_is_refused_for_a_branch_another_worktree_is_rebasing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);
        write_file(root, "a.txt", "one\n");
        let tip = commit_all(&repo, "base");
        repo.branch("topic", &repo.find_commit(tip).unwrap(), false).unwrap();

        let state = repo.path().join("worktrees").join("side").join("rebase-merge");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("head-name"), "refs/heads/topic\n").unwrap();

        let err = git_delete_branch_impl(root.to_string_lossy().into_owned(), "topic".into(), true)
            .expect_err("another worktree is replaying this branch");
        assert!(err.contains("another worktree"), "{err}");
        assert!(repo.find_branch("topic", BranchType::Local).is_ok(), "it survives");
    }

    /// The regression: mid-rebase HEAD is detached, so `is_head()` is false for
    /// the branch being replayed and delete used to sail straight through.
    #[test]
    fn delete_is_refused_while_an_operation_is_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);

        write_file(root, "a.txt", "one\n");
        commit_all(&repo, "base");
        write_file(root, "a.txt", "two\n");
        let tip = commit_all(&repo, "on topic");
        repo.branch("topic", &repo.find_commit(tip).unwrap(), false)
            .unwrap();
        repo.set_head_detached(tip).unwrap();

        // Exactly what a stopped rebase leaves behind.
        std::fs::create_dir_all(repo.path().join("rebase-merge")).unwrap();

        let err = git_delete_branch_impl(
            root.to_string_lossy().into_owned(),
            "topic".into(),
            // Force must not be an escape hatch either: it is about the merged
            // check, not about trampling a rebase.
            true,
        )
        .expect_err("a rebase in progress blocks the delete");
        assert!(err.contains("rebase"), "the error names the operation: {err}");
        assert!(
            repo.find_branch("topic", BranchType::Local).is_ok(),
            "the branch survives",
        );
    }
}
