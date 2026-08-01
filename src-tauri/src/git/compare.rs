use git2::{DiffOptions, Object, Tree};

use super::diff::{collect_diff, detect_renames};
use super::repo::open_repo;
use super::DiffResult;

/// Diff any two refs. Both `base_ref` and `head_ref` go through `revparse_single`,
/// so they accept branches (`main`, `feature/x`), tags (`v1.2.0`), commit SHAs,
/// and revision expressions like `HEAD~3` or `origin/main^`.
///
/// When `use_merge_base` is true, the left side is the merge-base of the two
/// commits — i.e. "what changed on head since it diverged from base" (the
/// `base...head` form). When false, the left side is `base` directly (the
/// `base..head` form).
pub(crate) fn git_diff_refs_impl(
    repo_path: String,
    base_ref: String,
    head_ref: String,
    use_merge_base: bool,
    ignore_whitespace: bool,
) -> Result<DiffResult, String> {
    // Prefixed, because the frontend routes this string. A failure to open the
    // repository at all — a lock held by another process, a directory that
    // moved — used to come back as a bare libgit2 message, indistinguishable
    // from a mistyped ref, so it lit up whichever picker happened to have the
    // words "base" or "head" in its error and offered a Retry that hits the
    // same lock. `repo:` is neither side, and the UI says so.
    let repo = open_repo(&repo_path).map_err(|e| format!("repo: {e}"))?;

    let base_obj = resolve_ref(&repo, &base_ref).map_err(|e| format!("base: {e}"))?;
    let head_obj = resolve_ref(&repo, &head_ref).map_err(|e| format!("head: {e}"))?;

    // Peeled to a *tree*, not to a commit.
    //
    // A tree is a perfectly good side of a diff, and requiring a commit made
    // one ordinary action impossible: showing what a root commit introduced.
    // The sidebar asks for that with git's empty-tree oid as the base, which
    // resolves fine and then failed here with
    //   the git_object of id '4b825dc…' can not be successfully peeled into a
    //   commit (git_object_t=1)
    // so clicking the first commit in any repository always errored.
    let left_tree: Tree = if use_merge_base {
        // Merge-base is only defined between commits, so this one branch does
        // still need them — and degrades to a two-dot diff rather than failing
        // when either side is not one.
        match (base_obj.peel_to_commit(), head_obj.peel_to_commit()) {
            (Ok(base_commit), Ok(head_commit)) => {
                match repo.merge_base(base_commit.id(), head_commit.id()) {
                    Ok(oid) => repo
                        .find_commit(oid)
                        .map_err(|e| e.message().to_string())?
                        .tree()
                        .map_err(|e| e.message().to_string())?,
                    // No common ancestor (unrelated histories) — fall back to a
                    // direct diff against base. Better than failing the whole
                    // comparison.
                    Err(_) => base_obj
                        .peel_to_tree()
                        .map_err(|e| format!("base: {}", e.message()))?,
                }
            }
            _ => base_obj
                .peel_to_tree()
                .map_err(|e| format!("base: {}", e.message()))?,
        }
    } else {
        base_obj
            .peel_to_tree()
            .map_err(|e| format!("base: {}", e.message()))?
    };

    let right_tree = head_obj
        .peel_to_tree()
        .map_err(|e| format!("head: {}", e.message()))?;

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    super::diff::apply_whitespace(&mut opts, ignore_whitespace);
    // Without this, libgit2 reports a symlink that became a regular file (or a
    // file that became a directory) as a Deleted *and* an Added delta sharing
    // one path. Two tree rows with the same key highlighted together, and
    // `selectedFile()` — a `.find()` — could only ever reach the first of them,
    // so the added half's content was unreachable through the UI entirely.
    // One `Typechange` delta is both correct and addressable.
    opts.include_typechange(true);

    let mut diff = repo
        .diff_tree_to_tree(Some(&left_tree), Some(&right_tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    detect_renames(&mut diff)?;

    let mut result = collect_diff(diff, ignore_whitespace)?;

    if let Some(untracked_tree) = stash_untracked_tree(&repo, &head_obj, &left_tree) {
        let mut opts = DiffOptions::new();
        opts.context_lines(3);
        super::diff::apply_whitespace(&mut opts, ignore_whitespace);
        let extra = repo
            .diff_tree_to_tree(None, Some(&untracked_tree), Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
        let extra = collect_diff(extra, ignore_whitespace)?;
        result.files.extend(extra.files);
        result.total_additions += extra.total_additions;
        result.total_deletions += extra.total_deletions;
    }

    Ok(result)
}

/// The tree of files that were *untracked* when a stash was created, when this
/// comparison is the one that should show them.
///
/// `git stash push -u` stores untracked files in a **third parent** of the
/// stash commit, and nothing about `stash@{0}^1..stash@{0}` reaches it. The
/// Stash dialog defaults "include untracked" to on, so the default way to make
/// a stash produced a diff that omitted part of it — and the omission was
/// invisible, because the files simply were not listed.
///
/// Deliberately narrow: it fires only when head is a three-parent commit *and*
/// the left side is exactly that commit's first parent — which is to say, only
/// when the question being asked is "what is in this stash". That is the same
/// question `git stash show -u` answers, and it answers it the same way. Any
/// other pair of refs, including a hand-typed one, still gets plain two-tree
/// semantics.
fn stash_untracked_tree<'a>(
    repo: &'a git2::Repository,
    head_obj: &Object<'a>,
    left_tree: &Tree<'a>,
) -> Option<Tree<'a>> {
    let commit = head_obj.peel_to_commit().ok()?;
    if commit.parent_count() != 3 {
        return None;
    }
    if commit.parent(0).ok()?.tree().ok()?.id() != left_tree.id() {
        return None;
    }
    let tree = commit.parent(2).ok()?.tree().ok()?;
    // `repo` outlives the borrow the commit held; re-find so the tree is not
    // tied to the temporary.
    repo.find_tree(tree.id()).ok()
}

fn resolve_ref<'a>(repo: &'a git2::Repository, name: &str) -> Result<Object<'a>, String> {
    repo.revparse_single(name)
        .map_err(|e| format!("could not resolve '{name}': {}", e.message()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;

    fn write(p: &Path, contents: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, contents).unwrap();
    }

    fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    /// `git stash push -u` files live in a third parent that
    /// `stash@{0}^1..stash@{0}` cannot reach, and "include untracked" is the
    /// dialog's default — so the default way to stash produced a diff missing
    /// part of what it stashed, silently.
    #[test]
    fn a_stash_diff_includes_the_untracked_files_it_stashed() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::init(dir.path()).unwrap();
        write(&dir.path().join("tracked.txt"), "one\n");
        commit_all(&repo, "init");

        write(&dir.path().join("tracked.txt"), "two\n");
        write(&dir.path().join("brand-new.txt"), "never committed\n");

        let sig = Signature::now("Test", "test@example.com").unwrap();
        repo.stash_save2(&sig, None, Some(git2::StashFlags::INCLUDE_UNTRACKED))
            .unwrap();

        let out = git_diff_refs_impl(
            dir.path().to_string_lossy().to_string(),
            "stash@{0}^1".to_string(),
            "stash@{0}".to_string(),
            false,
            false,
        )
        .unwrap();

        let paths: Vec<_> = out.files.iter().filter_map(|f| f.new_path.as_deref()).collect();
        assert!(paths.contains(&"tracked.txt"), "got {paths:?}");
        assert!(
            paths.contains(&"brand-new.txt"),
            "the untracked half of the stash is invisible — got {paths:?}"
        );
    }

    /// The stash pane now addresses a stash by its **commit oid** rather than
    /// by `stash@{N}`, because a positional ref silently retargets when the
    /// stack shifts under an open diff. The widening above keys on the shape of
    /// the commit, not on the spelling of the ref, so it has to survive the
    /// change — otherwise fixing the retarget would have quietly re-broken the
    /// untracked half.
    #[test]
    fn a_stash_addressed_by_oid_still_includes_its_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repository::init(dir.path()).unwrap();
        write(&dir.path().join("tracked.txt"), "one\n");
        commit_all(&repo, "init");

        write(&dir.path().join("tracked.txt"), "two\n");
        write(&dir.path().join("brand-new.txt"), "never committed\n");

        let sig = Signature::now("Test", "test@example.com").unwrap();
        let oid = repo
            .stash_save2(&sig, None, Some(git2::StashFlags::INCLUDE_UNTRACKED))
            .unwrap()
            .to_string();

        let out = git_diff_refs_impl(
            dir.path().to_string_lossy().to_string(),
            format!("{oid}^1"),
            oid,
            false,
            false,
        )
        .unwrap();

        let paths: Vec<_> = out.files.iter().filter_map(|f| f.new_path.as_deref()).collect();
        assert!(paths.contains(&"tracked.txt"), "got {paths:?}");
        assert!(paths.contains(&"brand-new.txt"), "got {paths:?}");
    }

    /// The widening above must not leak into ordinary comparisons: two refs
    /// that merely happen to be commits still get plain two-tree semantics.
    #[test]
    fn an_ordinary_compare_is_untouched_by_the_stash_rule() {
        let dir = build_two_branch_repo();
        let base = head_default_branch(&Repository::open(dir.path()).unwrap());
        let out = git_diff_refs_impl(
            dir.path().to_string_lossy().to_string(),
            base,
            "feature".to_string(),
            false,
            false,
        );
        // Whatever it returns, it must not error and must not double-count.
        let out = out.unwrap();
        let mut seen = std::collections::HashSet::new();
        for f in &out.files {
            assert!(
                seen.insert(f.new_path.clone()),
                "a path was listed twice: {:?}",
                f.new_path
            );
        }
    }

    fn build_two_branch_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();

        // Main: one file
        write(&dir.path().join("a.txt"), "hello\n");
        commit_all(&repo, "init");

        // Branch off into "feature" with another commit
        let head_oid = repo.head().unwrap().target().unwrap();
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("feature", &head_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write(&dir.path().join("a.txt"), "hello\nworld\n");
        write(&dir.path().join("b.txt"), "new file\n");
        commit_all(&repo, "feature work");

        // Move main forward independently to ensure merge-base logic matters
        repo.set_head("refs/heads/master")
            .or_else(|_| repo.set_head("refs/heads/main"))
            .ok();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .ok();

        dir
    }

    #[test]
    fn diffs_two_branches() {
        let dir = build_two_branch_repo();
        let path = dir.path().to_string_lossy().to_string();
        let head_branch = "feature".to_string();
        let base_branch = head_default_branch(&Repository::open(dir.path()).unwrap());

        let result =
            git_diff_refs_impl(path, base_branch, head_branch, true, false).expect("diff succeeds");
        assert!(!result.files.is_empty(), "expected file changes");
        assert!(result.total_additions >= 1);
    }

    /// The empty tree as a base is how "what did this root commit add?" is
    /// asked, and it used to fail: `peel_to_commit` rejects a tree, so clicking
    /// the first commit in any repository always errored.
    #[test]
    fn a_root_commit_diffs_against_the_empty_tree() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        write(&dir.path().join("a.txt"), "hello\n");
        let root = commit_all(&repo, "init");

        const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        let result = git_diff_refs_impl(
            dir.path().to_string_lossy().to_string(),
            EMPTY_TREE.to_string(),
            root.to_string(),
            false,
            false,
        )
        .expect("a root commit is diffable");

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].new_path.as_deref(), Some("a.txt"));
        assert_eq!(result.files[0].status, "added");
    }

    /// A rename is one row, not an add plus a delete. Without `find_similar`
    /// the file count disagreed with `git diff -M` and `StatusBadge`'s `R`
    /// glyph was unreachable.
    #[test]
    fn a_rename_is_reported_as_one_renamed_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Long enough that similarity detection is unambiguous.
        let body: String = (0..40).map(|i| format!("line {i}\n")).collect();
        write(&dir.path().join("old-name.txt"), &body);
        let before = commit_all(&repo, "init");

        fs::remove_file(dir.path().join("old-name.txt")).unwrap();
        write(&dir.path().join("new-name.txt"), &body);
        let after = commit_all(&repo, "rename");

        let result = git_diff_refs_impl(
            dir.path().to_string_lossy().to_string(),
            before.to_string(),
            after.to_string(),
            false,
            false,
        )
        .unwrap();

        assert_eq!(result.files.len(), 1, "one file moved, not two changed");
        assert_eq!(result.files[0].status, "renamed");
        assert_eq!(result.files[0].old_path.as_deref(), Some("old-name.txt"));
        assert_eq!(result.files[0].new_path.as_deref(), Some("new-name.txt"));
    }

    /// A mode-only change carries no hunks. It must still arrive as a file, so
    /// the UI can say "no line changes" rather than rendering an empty pane.
    #[cfg(unix)]
    #[test]
    fn a_mode_only_change_is_a_file_with_no_hunks() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let script = dir.path().join("run.sh");
        write(&script, "echo hi\n");
        let before = commit_all(&repo, "init");

        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();
        let after = commit_all(&repo, "chmod");

        let result = git_diff_refs_impl(
            dir.path().to_string_lossy().to_string(),
            before.to_string(),
            after.to_string(),
            false,
            false,
        )
        .unwrap();

        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].hunks.is_empty(), "no line changed");
        assert!(!result.files[0].is_binary, "and it is not binary either");
    }

    #[test]
    fn invalid_ref_returns_error() {
        let dir = build_two_branch_repo();
        let path = dir.path().to_string_lossy().to_string();
        let base = head_default_branch(&Repository::open(dir.path()).unwrap());
        let err =
            git_diff_refs_impl(path, base, "no-such-ref".into(), true, false).unwrap_err();
        assert!(
            err.starts_with("head:"),
            "error should identify which side, at the front where the UI reads it: {err}"
        );
    }

    /// CMP-F18 / CMP-F28. The frontend decides which picker to paint red from
    /// this string. A ref failure has to say which side *at the front* — a
    /// substring test matched `origin/base-fix` inside a head error and lit up
    /// both — and a failure that is neither side has to say neither, instead of
    /// being mistaken for a typo and offering a Retry that hits the same lock.
    #[test]
    fn a_repository_level_failure_blames_neither_ref() {
        let dir = tempfile::tempdir().unwrap();
        let nowhere = dir.path().join("not-a-repo");
        std::fs::create_dir(&nowhere).unwrap();
        let err = git_diff_refs_impl(
            nowhere.to_string_lossy().to_string(),
            "main".into(),
            "feature".into(),
            true,
            false,
        )
        .unwrap_err();
        assert!(err.starts_with("repo:"), "got {err}");
    }

    /// The half that made the substring test wrong: a *head* ref whose name
    /// contains the word "base".
    #[test]
    fn a_head_ref_named_after_the_other_side_still_blames_only_head() {
        let dir = build_two_branch_repo();
        let path = dir.path().to_string_lossy().to_string();
        let base = head_default_branch(&Repository::open(dir.path()).unwrap());
        let err =
            git_diff_refs_impl(path, base, "origin/base-fix".into(), true, false).unwrap_err();
        assert!(err.starts_with("head:"), "got {err}");
    }

    fn head_default_branch(repo: &Repository) -> String {
        // After init the default branch is either "master" or "main" depending
        // on git config; pick whichever exists.
        if repo.find_branch("main", git2::BranchType::Local).is_ok() {
            "main".into()
        } else {
            "master".into()
        }
    }
}
