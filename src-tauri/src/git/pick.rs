use super::cmd::{run_git, run_git_op, OpResult};

/// Cherry-pick a commit onto the current branch. On conflict, CHERRY_PICK_HEAD
/// is left for the operation banner; resolve + continue finishes it.
pub(crate) fn git_cherry_pick_impl(repo_path: String, oid: String) -> Result<OpResult, String> {
    run_git_op(&repo_path, &["cherry-pick", &oid])
}

pub(crate) fn git_cherry_pick_continue_impl(repo_path: String) -> Result<OpResult, String> {
    run_git_op(&repo_path, &["-c", "core.editor=true", "cherry-pick", "--continue"])
}

pub(crate) fn git_cherry_pick_abort_impl(repo_path: String) -> Result<(), String> {
    run_git(&repo_path, &["cherry-pick", "--abort"]).map(|_| ())
}

/// Revert a commit, creating a new commit that undoes it. `--no-edit` keeps the
/// auto-generated message so the call doesn't block on an editor.
pub(crate) fn git_revert_impl(repo_path: String, oid: String) -> Result<OpResult, String> {
    run_git_op(&repo_path, &["revert", "--no-edit", &oid])
}

pub(crate) fn git_revert_continue_impl(repo_path: String) -> Result<OpResult, String> {
    run_git_op(&repo_path, &["-c", "core.editor=true", "revert", "--continue"])
}

pub(crate) fn git_revert_abort_impl(repo_path: String) -> Result<(), String> {
    run_git(&repo_path, &["revert", "--abort"]).map(|_| ())
}
