use std::process::Command;

use serde::{Deserialize, Serialize};

/// Result of a porcelain operation that may stop on conflicts (merge, rebase,
/// cherry-pick, revert). `ok` is the exit status; `conflicted` is true when it
/// halted on conflicts the user must resolve; `message` is git's own output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    pub conflicted: bool,
    pub message: String,
}

/// Run `git <args>`, classifying a conflict halt vs a hard failure. A non-zero
/// exit whose output mentions "CONFLICT" is reported as `conflicted` rather
/// than thrown, so the UI can route the paths into the conflict resolver.
pub(crate) fn run_git_op(repo_path: &str, args: &[&str]) -> Result<OpResult, String> {
    let (ok, stdout, stderr) = run_git_allow_fail(repo_path, args)?;
    let message = format!("{stdout}\n{stderr}").trim().to_string();
    let conflicted = !ok && message.contains("CONFLICT");
    Ok(OpResult { ok, conflicted, message })
}

/// Run `git <args>` inside `repo_path`, returning stdout on success and the
/// trimmed stderr as the error on a non-zero exit. We shell out to the system
/// `git` (always present on a developer machine, and at /usr/bin/git inside the
/// minimal env a Finder/Dock launch inherits) for porcelain operations whose
/// conflict mid-states — merge, rebase, cherry-pick, revert, pull — libgit2
/// either doesn't model or models differently from what users expect. Pure
/// index/ref reads and simple mutations stay on git2.
pub(crate) fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git: {e}. Is git installed and on PATH?"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Like [`run_git`] but never treats a non-zero exit as an error — returns
/// `(success, stdout, stderr)`. Use this for operations where a non-zero exit
/// is an expected outcome to inspect rather than a failure to throw: `git pull`
/// / `merge` / `rebase` leaving conflicts, or `--continue` reporting remaining
/// conflicts. The caller decides what the exit code means.
pub(crate) fn run_git_allow_fail(repo_path: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git: {e}. Is git installed and on PATH?"))?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}
