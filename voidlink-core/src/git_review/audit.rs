use rusqlite::params;

use super::db::{now_ms, open_db};
use super::github::{get_owner_repo_from_path, github_api_get, value_to_pr_info};
use super::{AuditEntry, PullRequestInfo};
use crate::migration::MigrationState;

pub fn list_prs_impl(
    repo_path: String,
    state_filter: Option<String>,
) -> Result<Vec<PullRequestInfo>, String> {
    let (owner, repo) = get_owner_repo_from_path(&repo_path)?;
    let state = state_filter.as_deref().unwrap_or("open");
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls?state={}&per_page=50",
        owner, repo, state
    );

    let prs = github_api_get(&url)?;
    let arr = prs
        .as_array()
        .ok_or_else(|| "expected array from GitHub".to_string())?;

    Ok(arr.iter().map(value_to_pr_info).collect())
}

pub fn get_pr_impl(repo_path: String, pr_number: u32) -> Result<PullRequestInfo, String> {
    let (owner, repo) = get_owner_repo_from_path(&repo_path)?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr = github_api_get(&url)?;
    Ok(value_to_pr_info(&pr))
}

pub fn get_audit_log_impl(
    repo_path: String,
    pr_number: Option<u32>,
    migration_state: &MigrationState,
) -> Result<Vec<AuditEntry>, String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

    type Row = (String, u32, String, String, i64, String, Option<String>);

    let rows: Vec<Row> = if let Some(pr) = pr_number {
        let mut stmt = conn
            .prepare(
                "SELECT id, pr_number, action, actor, timestamp, details, checklist_snapshot
                 FROM audit_log WHERE repo_path = ?1 AND pr_number = ?2
                 ORDER BY timestamp DESC LIMIT 200",
            )
            .map_err(|e| e.to_string())?;
        let collected: Vec<Row> = stmt.query_map(params![repo_path, pr], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        collected
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, pr_number, action, actor, timestamp, details, checklist_snapshot
                 FROM audit_log WHERE repo_path = ?1
                 ORDER BY timestamp DESC LIMIT 200",
            )
            .map_err(|e| e.to_string())?;
        let collected: Vec<Row> = stmt.query_map(params![repo_path], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        collected
    };

    let _ = now_ms; // suppress unused warning if any
    Ok(rows
        .into_iter()
        .map(|(id, pr_num, action, actor, timestamp, details, snapshot)| AuditEntry {
            id,
            pr_number: pr_num,
            action,
            actor,
            timestamp,
            details,
            checklist_snapshot: snapshot,
        })
        .collect())
}
