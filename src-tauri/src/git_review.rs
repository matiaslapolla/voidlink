use reqwest::blocking::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

use crate::git::git_diff_branches_impl;
use crate::git_agent::parse_github_owner_repo;
use crate::migration::MigrationState;

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub draft: bool,
    pub base_branch: String,
    pub head_branch: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub mergeable: Option<bool>,
    pub ci_status: Option<String>,
    pub review_status: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChecklist {
    pub pr_number: u32,
    pub items: Vec<ChecklistItem>,
    pub overall_risk: String,
    pub ai_summary: String,
    pub generated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub category: String,
    pub description: String,
    pub status: String,
    pub ai_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    pub repo_path: String,
    pub pr_number: u32,
    pub method: String,
    pub delete_branch: bool,
    pub delete_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub pr_number: u32,
    pub action: String,
    pub actor: String,
    pub timestamp: i64,
    pub details: String,
    pub checklist_snapshot: Option<String>,
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

fn open_db(db_path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS pr_reviews (
           id TEXT PRIMARY KEY,
           repo_path TEXT NOT NULL,
           pr_number INTEGER NOT NULL,
           checklist_json TEXT NOT NULL,
           status TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(repo_path, pr_number)
         );
         CREATE TABLE IF NOT EXISTS audit_log (
           id TEXT PRIMARY KEY,
           repo_path TEXT NOT NULL,
           pr_number INTEGER NOT NULL,
           action TEXT NOT NULL,
           actor TEXT NOT NULL,
           timestamp INTEGER NOT NULL,
           details TEXT NOT NULL,
           checklist_snapshot TEXT
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn write_audit(
    conn: &Connection,
    repo_path: &str,
    pr_number: u32,
    action: &str,
    actor: &str,
    details: &str,
    checklist_snapshot: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO audit_log (id, repo_path, pr_number, action, actor, timestamp, details, checklist_snapshot)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            Uuid::new_v4().to_string(),
            repo_path,
            pr_number,
            action,
            actor,
            now_ms(),
            details,
            checklist_snapshot,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

fn github_api_get(url: &str) -> Result<Value, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .send()
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub API {}: {}", status, body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn github_api_put(url: &str, payload: &Value) -> Result<Value, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .put(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .json(payload)
        .send()
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub API {}: {}", status, body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn github_api_delete(url: &str) -> Result<(), String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .delete(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .send()
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("delete failed: {}", body));
    }
    Ok(())
}

fn get_owner_repo_from_path(repo_path: &str) -> Result<(String, String), String> {
    let repo = git2::Repository::discover(repo_path)
        .map_err(|e| e.message().to_string())?;
    let remote = repo
        .find_remote("origin")
        .map_err(|e| e.message().to_string())?;
    let url = remote
        .url()
        .ok_or_else(|| "remote origin has no URL".to_string())?;
    parse_github_owner_repo(url)
        .ok_or_else(|| format!("could not parse GitHub owner/repo from: {}", url))
}

fn value_to_pr_info(v: &Value) -> PullRequestInfo {
    let ci_status = v["head"]["sha"]
        .as_str()
        .and_then(|_| v["mergeable_state"].as_str())
        .map(|s| s.to_string());

    PullRequestInfo {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: v["title"].as_str().unwrap_or("").to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("open").to_string(),
        draft: v["draft"].as_bool().unwrap_or(false),
        base_branch: v["base"]["ref"].as_str().unwrap_or("").to_string(),
        head_branch: v["head"]["ref"].as_str().unwrap_or("").to_string(),
        author: v["user"]["login"].as_str().unwrap_or("").to_string(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
        additions: v["additions"].as_u64().unwrap_or(0) as u32,
        deletions: v["deletions"].as_u64().unwrap_or(0) as u32,
        changed_files: v["changed_files"].as_u64().unwrap_or(0) as u32,
        mergeable: v["mergeable"].as_bool(),
        ci_status,
        review_status: "pending".to_string(),
        url: v["html_url"].as_str().unwrap_or("").to_string(),
    }
}

// ─── Internal implementations ─────────────────────────────────────────────────

fn list_prs_impl(
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

fn get_pr_impl(repo_path: String, pr_number: u32) -> Result<PullRequestInfo, String> {
    let (owner, repo) = get_owner_repo_from_path(&repo_path)?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr = github_api_get(&url)?;
    Ok(value_to_pr_info(&pr))
}

fn generate_review_checklist_impl(
    repo_path: String,
    pr_number: u32,
    migration_state: &MigrationState,
) -> Result<ReviewChecklist, String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

    let pr = get_pr_impl(repo_path.clone(), pr_number)?;

    // Get diff for LLM analysis
    let diff_text = match git_diff_branches_impl(
        repo_path.clone(),
        pr.base_branch.clone(),
        pr.head_branch.clone(),
    ) {
        Ok(diff) => {
            let mut text = String::new();
            for file in diff.files.iter().take(10) {
                let path = file
                    .new_path
                    .as_deref()
                    .or(file.old_path.as_deref())
                    .unwrap_or("?");
                text.push_str(&format!(
                    "File: {} ({} +{} -{})\n",
                    path, file.status, file.additions, file.deletions
                ));
                for hunk in file.hunks.iter().take(3) {
                    for line in hunk.lines.iter().take(20) {
                        text.push_str(&format!("{}{}\n", line.origin, line.content));
                    }
                }
                text.push('\n');
            }
            text
        }
        Err(_) => format!(
            "PR #{}: {} → {}\n{} changes",
            pr_number, pr.head_branch, pr.base_branch, pr.changed_files
        ),
    };

    let prompt = format!(
        r#"Review this pull request and generate a checklist.

PR Title: {}
PR Description: {}

Code changes:
{}

Return a JSON object with:
- "items": array of checklist items, each with:
  - "id": unique string
  - "category": "security"|"performance"|"correctness"|"style"|"testing"
  - "description": what to check (1 sentence)
  - "status": "unchecked"
  - "ai_note": explanation of why this needs checking (or null if it looks fine)
- "overall_risk": "low"|"medium"|"high"
- "ai_summary": 2-3 sentence summary of the changes and main concerns

Generate 5-10 focused, actionable checklist items."#,
        pr.title, pr.body, diff_text
    );

    let raw = migration_state
        .llm_chat(&prompt, true)
        .unwrap_or_else(|_| {
            json!({
                "items": [
                    {
                        "id": Uuid::new_v4().to_string(),
                        "category": "correctness",
                        "description": "Review changes for correctness",
                        "status": "unchecked",
                        "ai_note": null
                    }
                ],
                "overall_risk": "low",
                "ai_summary": "Manual review required."
            })
            .to_string()
        });

    let v: Value = serde_json::from_str(&raw).unwrap_or_else(|_| {
        json!({
            "items": [],
            "overall_risk": "low",
            "ai_summary": "Could not parse AI response."
        })
    });

    let items: Vec<ChecklistItem> = v["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|item| ChecklistItem {
                    id: item["id"]
                        .as_str()
                        .unwrap_or(&Uuid::new_v4().to_string())
                        .to_string(),
                    category: item["category"]
                        .as_str()
                        .unwrap_or("correctness")
                        .to_string(),
                    description: item["description"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    status: "unchecked".to_string(),
                    ai_note: item["ai_note"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();

    let overall_risk = v["overall_risk"]
        .as_str()
        .unwrap_or("low")
        .to_string();
    let ai_summary = v["ai_summary"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let checklist = ReviewChecklist {
        pr_number,
        items,
        overall_risk,
        ai_summary,
        generated_at: now_ms(),
    };

    // Persist to DB
    let checklist_json = serde_json::to_string(&checklist.items).unwrap_or_default();
    let now = now_ms();
    let review_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR REPLACE INTO pr_reviews (id, repo_path, pr_number, checklist_json, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            review_id,
            repo_path,
            pr_number,
            checklist_json,
            "pending",
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    write_audit(
        &conn,
        &repo_path,
        pr_number,
        "checklist_generated",
        "ai-agent",
        &format!("{} items generated, risk: {}", checklist.items.len(), checklist.overall_risk),
        None,
    )?;

    Ok(checklist)
}

fn update_checklist_item_impl(
    repo_path: String,
    pr_number: u32,
    item_id: String,
    status: String,
    migration_state: &MigrationState,
) -> Result<(), String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

    // Load existing checklist
    let checklist_json: String = conn
        .query_row(
            "SELECT checklist_json FROM pr_reviews WHERE repo_path = ?1 AND pr_number = ?2",
            params![repo_path, pr_number],
            |row| row.get(0),
        )
        .map_err(|e| format!("checklist not found: {}", e))?;

    let mut items: Vec<ChecklistItem> =
        serde_json::from_str(&checklist_json).map_err(|e| e.to_string())?;

    let item = items
        .iter_mut()
        .find(|i| i.id == item_id)
        .ok_or_else(|| format!("item {} not found", item_id))?;
    item.status = status.clone();

    let updated_json = serde_json::to_string(&items).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pr_reviews SET checklist_json = ?1, updated_at = ?2 WHERE repo_path = ?3 AND pr_number = ?4",
        params![updated_json, now_ms(), repo_path, pr_number],
    )
    .map_err(|e| e.to_string())?;

    write_audit(
        &conn,
        &repo_path,
        pr_number,
        &format!("checklist_item_{}", status),
        "human",
        &format!("Item {} marked as {}", item_id, status),
        None,
    )?;

    Ok(())
}

fn merge_pr_impl(
    input: MergeInput,
    migration_state: &MigrationState,
) -> Result<(), String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

    // Check for flagged checklist items
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

    // Get the PR to find the head branch
    let pr = get_pr_impl(input.repo_path.clone(), input.pr_number)?;

    // Check CI status (warn but don't block if unknown)
    if pr.ci_status.as_deref() == Some("failure") {
        return Err("Cannot merge: CI checks are failing".to_string());
    }

    // Capture checklist snapshot for audit
    let checklist_snapshot = conn
        .query_row::<String, _, _>(
            "SELECT checklist_json FROM pr_reviews WHERE repo_path = ?1 AND pr_number = ?2",
            params![input.repo_path, input.pr_number],
            |row| row.get(0),
        )
        .ok();

    // Merge via GitHub API
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

    // Delete remote branch
    if input.delete_branch {
        let delete_url = format!(
            "https://api.github.com/repos/{}/{}/git/refs/heads/{}",
            owner, repo, pr.head_branch
        );
        let _ = github_api_delete(&delete_url);

        // Delete local branch via git2
        if let Ok(repo_obj) = git2::Repository::discover(&input.repo_path) {
            if let Ok(mut branch) =
                repo_obj.find_branch(&pr.head_branch, git2::BranchType::Local)
            {
                let _ = branch.delete();
            }
        }
    }

    // Remove worktree
    if input.delete_worktree {
        let _ = crate::git::git_remove_worktree_impl(
            input.repo_path.clone(),
            pr.head_branch.clone(),
            true,
        );
    }

    // Update review status in DB
    conn.execute(
        "UPDATE pr_reviews SET status = 'merged', updated_at = ?1 WHERE repo_path = ?2 AND pr_number = ?3",
        params![now_ms(), input.repo_path, input.pr_number],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn get_audit_log_impl(
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

// ─── Tauri command wrappers ───────────────────────────────────────────────────

#[tauri::command]
pub fn git_list_prs(
    repo_path: String,
    state_filter: Option<String>,
) -> Result<Vec<PullRequestInfo>, String> {
    list_prs_impl(repo_path, state_filter)
}

#[tauri::command]
pub fn git_get_pr(repo_path: String, pr_number: u32) -> Result<PullRequestInfo, String> {
    get_pr_impl(repo_path, pr_number)
}

#[tauri::command]
pub fn git_generate_review_checklist(
    repo_path: String,
    pr_number: u32,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<ReviewChecklist, String> {
    generate_review_checklist_impl(repo_path, pr_number, &migration_state)
}

#[tauri::command]
pub fn git_update_checklist_item(
    repo_path: String,
    pr_number: u32,
    item_id: String,
    status: String,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<(), String> {
    update_checklist_item_impl(repo_path, pr_number, item_id, status, &migration_state)
}

#[tauri::command]
pub fn git_merge_pr(
    input: MergeInput,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<(), String> {
    merge_pr_impl(input, &migration_state)
}

#[tauri::command]
pub fn git_get_audit_log(
    repo_path: String,
    pr_number: Option<u32>,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<Vec<AuditEntry>, String> {
    get_audit_log_impl(repo_path, pr_number, &migration_state)
}
