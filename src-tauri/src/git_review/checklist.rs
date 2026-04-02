use rusqlite::params;
use serde_json::json;
use uuid::Uuid;

use crate::git::git_diff_branches_impl;
use crate::migration::MigrationState;

use super::audit::get_pr_impl;
use super::db::{now_ms, open_db, write_audit};
use super::{ChecklistItem, ReviewChecklist};

pub(super) fn generate_review_checklist_impl(
    repo_path: String,
    pr_number: u32,
    migration_state: &MigrationState,
) -> Result<ReviewChecklist, String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

    let pr = get_pr_impl(repo_path.clone(), pr_number)?;

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

    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|_| {
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

    let overall_risk = v["overall_risk"].as_str().unwrap_or("low").to_string();
    let ai_summary = v["ai_summary"].as_str().unwrap_or("").to_string();

    let checklist = ReviewChecklist {
        pr_number,
        items,
        overall_risk,
        ai_summary,
        generated_at: now_ms(),
    };

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

pub(super) fn update_checklist_item_impl(
    repo_path: String,
    pr_number: u32,
    item_id: String,
    status: String,
    migration_state: &MigrationState,
) -> Result<(), String> {
    let db_path = migration_state.db_path();
    let conn = open_db(&db_path)?;

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
