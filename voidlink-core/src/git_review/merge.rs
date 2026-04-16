use rusqlite::params;
use serde_json::json;

use crate::migration::MigrationState;

use super::audit::get_pr_impl;
use super::db::{now_ms, open_db, write_audit};
use super::github::{get_owner_repo_from_path, github_api_delete, github_api_put};
use super::{ChecklistItem, MergeInput};

pub fn merge_pr_impl(
    input: MergeInput,
    migration_state: &MigrationState,
) -> Result<(), String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

    if let Ok(checklist_json) = conn.query_row::<String, _, _>(
        "SELECT checklist_json FROM pr_reviews WHERE repo_path = ?1 AND pr_number = ?2",
        params![input.repo_path, input.pr_number],
        |row| row.get(0),
    ) {
        if let Ok(items) = serde_json::from_str::<Vec<ChecklistItem>>(&checklist_json) {
            let flagged: Vec<&str> = items
                .iter()
                .filter(|i| i.status == "flagged")
                .map(|i| i.description.as_str())
                .collect();
            if !flagged.is_empty() {
                return Err(format!(
                    "Cannot merge: {} checklist item(s) are flagged: {}",
                    flagged.len(),
                    flagged.join("; ")
                ));
            }
        }
    }

    let (owner, repo) = get_owner_repo_from_path(&input.repo_path)?;
    let pr = get_pr_impl(input.repo_path.clone(), input.pr_number)?;

    if pr.ci_status.as_deref() == Some("failure") {
        return Err("Cannot merge: CI checks are failing".to_string());
    }

    let checklist_snapshot = conn
        .query_row::<String, _, _>(
            "SELECT checklist_json FROM pr_reviews WHERE repo_path = ?1 AND pr_number = ?2",
            params![input.repo_path, input.pr_number],
            |row| row.get(0),
        )
        .ok();

    let merge_method = match input.method.as_str() {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };

    let merge_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/merge",
        owner, repo, input.pr_number
    );
    github_api_put(&merge_url, &json!({ "merge_method": merge_method }))?;

    write_audit(
        &conn,
        &input.repo_path,
        input.pr_number,
        "merged",
        "human",
        &format!("Merged via {} method", merge_method),
        checklist_snapshot.as_deref(),
    )?;

    if input.delete_branch {
        let delete_url = format!(
            "https://api.github.com/repos/{}/{}/git/refs/heads/{}",
            owner, repo, pr.head_branch
        );
        let _ = github_api_delete(&delete_url);

        if let Ok(repo_obj) = git2::Repository::discover(&input.repo_path) {
            if let Ok(mut branch) =
                repo_obj.find_branch(&pr.head_branch, git2::BranchType::Local)
            {
                let _ = branch.delete();
            }
        }
    }

    if input.delete_worktree {
        let _ = crate::git::git_remove_worktree_impl(
            input.repo_path.clone(),
            pr.head_branch.clone(),
            true,
        );
    }

    conn.execute(
        "UPDATE pr_reviews SET status = 'merged', updated_at = ?1 WHERE repo_path = ?2 AND pr_number = ?3",
        params![now_ms(), input.repo_path, input.pr_number],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
