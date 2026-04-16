use rusqlite::{params, Connection};
use std::path::PathBuf;
use uuid::Uuid;

pub(super) fn open_db(db_path: &PathBuf) -> Result<Connection, String> {
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

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn write_audit(
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
