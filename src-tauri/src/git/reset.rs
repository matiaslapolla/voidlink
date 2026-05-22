use git2::ResetType;

use super::repo::open_repo;

/// Amend the most recent commit: re-commit the current index tree onto HEAD's
/// parents, optionally replacing the message. Author and committer are
/// preserved when `message` is None (and the original message kept too).
pub(crate) fn git_amend_impl(repo_path: String, message: Option<String>) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;

    let msg = message.as_deref().filter(|m| !m.trim().is_empty());
    let new_oid = head_commit
        .amend(Some("HEAD"), None, None, None, msg, Some(&tree))
        .map_err(|e| e.message().to_string())?;
    Ok(new_oid.to_string())
}

/// Undo the last commit, keeping its changes staged (soft reset to HEAD~1).
pub(crate) fn git_undo_last_commit_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let head = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let parent = head
        .parent(0)
        .map_err(|_| "no parent commit to undo to".to_string())?;
    repo.reset(parent.as_object(), ResetType::Soft, None)
        .map_err(|e| e.message().to_string())
}

/// Reset HEAD (and optionally index/working tree) to `target`. `mode` is
/// "soft" | "mixed" | "hard". Hard is destructive — the UI guards it.
pub(crate) fn git_reset_impl(
    repo_path: String,
    target: String,
    mode: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let obj = repo
        .revparse_single(&target)
        .map_err(|e| format!("could not resolve '{target}': {}", e.message()))?;
    let kind = match mode.as_str() {
        "soft" => ResetType::Soft,
        "hard" => ResetType::Hard,
        _ => ResetType::Mixed,
    };
    repo.reset(&obj, kind, None)
        .map_err(|e| e.message().to_string())
}
