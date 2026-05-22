use super::cmd::{run_git, run_git_op, OpResult};

/// Rebase the current branch onto `onto`. Shells out: git2's rebase API is
/// fiddly around conflict mid-states, while the porcelain writes the
/// rebase-merge/ state our operation banner reads.
pub(crate) fn git_rebase_impl(repo_path: String, onto: String) -> Result<OpResult, String> {
    run_git_op(&repo_path, &["rebase", &onto])
}

/// Continue an in-progress rebase after conflicts were resolved and staged.
/// `-c core.editor=true` keeps `--continue` from blocking on an editor for the
/// commit message (it reuses the existing one).
pub(crate) fn git_rebase_continue_impl(repo_path: String) -> Result<OpResult, String> {
    run_git_op(&repo_path, &["-c", "core.editor=true", "rebase", "--continue"])
}

pub(crate) fn git_rebase_abort_impl(repo_path: String) -> Result<(), String> {
    run_git(&repo_path, &["rebase", "--abort"]).map(|_| ())
}
