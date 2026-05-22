use super::cmd::{run_git, run_git_op, OpResult};

/// Merge `branch` into the current branch. `no_ff` forces a merge commit even
/// when a fast-forward is possible. Shells out so MERGE_HEAD and the standard
/// merge message land exactly as the porcelain writes them — our operation
/// detection and the conflict resolver depend on that.
pub(crate) fn git_merge_impl(
    repo_path: String,
    branch: String,
    no_ff: bool,
) -> Result<OpResult, String> {
    let mut args: Vec<&str> = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.push(&branch);
    run_git_op(&repo_path, &args)
}

pub(crate) fn git_merge_abort_impl(repo_path: String) -> Result<(), String> {
    run_git(&repo_path, &["merge", "--abort"]).map(|_| ())
}
