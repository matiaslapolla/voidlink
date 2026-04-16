use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use super::path_utils::{canonicalize_repo_path, now_ms};
use super::{RunEvent, RunState, RunStepState, WorkflowDsl};

#[derive(Clone)]
pub struct SqliteStore {
    pub path: PathBuf,
}

impl SqliteStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let store = Self { path };
        let conn = store.open()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS repos (
              id TEXT PRIMARY KEY,
              root_path TEXT NOT NULL UNIQUE,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS files (
              id TEXT PRIMARY KEY,
              repo_id TEXT NOT NULL,
              path TEXT NOT NULL,
              language TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              mtime_ms INTEGER NOT NULL,
              content_hash TEXT NOT NULL,
              indexed_at INTEGER NOT NULL,
              FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE,
              UNIQUE(repo_id, path)
            );

            CREATE TABLE IF NOT EXISTS chunks (
              id TEXT PRIMARY KEY,
              file_id TEXT NOT NULL,
              chunk_index INTEGER NOT NULL,
              start_line INTEGER NOT NULL,
              end_line INTEGER NOT NULL,
              content TEXT NOT NULL,
              token_estimate INTEGER NOT NULL,
              FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS edges (
              id TEXT PRIMARY KEY,
              repo_id TEXT NOT NULL,
              edge_type TEXT NOT NULL,
              source_id TEXT NOT NULL,
              target_id TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS embeddings (
              id TEXT PRIMARY KEY,
              owner_type TEXT NOT NULL,
              owner_id TEXT NOT NULL,
              model TEXT NOT NULL,
              vector_json TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflows (
              id TEXT PRIMARY KEY,
              repo_id TEXT,
              dsl_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_runs (
              id TEXT PRIMARY KEY,
              workflow_id TEXT NOT NULL,
              status TEXT NOT NULL,
              started_at INTEGER NOT NULL,
              finished_at INTEGER,
              FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS run_steps (
              run_id TEXT NOT NULL,
              step_id TEXT NOT NULL,
              status TEXT NOT NULL,
              attempts INTEGER NOT NULL,
              last_message TEXT,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(run_id, step_id),
              FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS run_events (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              step_id TEXT,
              level TEXT NOT NULL,
              message TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
            );

            -- Indexes for search/embedding performance
            CREATE INDEX IF NOT EXISTS idx_embeddings_lookup
              ON embeddings(owner_type, model, owner_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_file
              ON chunks(file_id);
            CREATE INDEX IF NOT EXISTS idx_files_repo
              ON files(repo_id);
            "#,
        )
        .map_err(|e| e.to_string())?;
        Ok(store)
    }

    pub fn open(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    pub fn upsert_repo(&self, root_path: &str) -> Result<String, String> {
        let now = now_ms();
        let conn = self.open()?;

        // Check + mutate in one connection (avoids TOCTOU race and extra opens)
        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM repos WHERE root_path = ?1",
                params![root_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match existing_id {
            Some(id) => {
                conn.execute(
                    "UPDATE repos SET updated_at = ?1 WHERE id = ?2",
                    params![now, id],
                )
                .map_err(|e| e.to_string())?;
                Ok(id)
            }
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO repos (id, root_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    params![id, root_path, now, now],
                )
                .map_err(|e| e.to_string())?;
                Ok(id)
            }
        }
    }

    pub fn repo_id_for_path(&self, root_path: &str) -> Result<Option<String>, String> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT id FROM repos WHERE root_path = ?1",
            params![root_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn save_workflow(
        &self,
        workflow: &WorkflowDsl,
        repo_path: Option<&str>,
    ) -> Result<String, String> {
        let repo_id = match repo_path {
            Some(path) => {
                let canonical = canonicalize_repo_path(path)?;
                Some(self.upsert_repo(&canonical)?)
            }
            None => None,
        };
        let conn = self.open()?;
        let workflow_id = workflow.workflow.id.clone();
        conn.execute(
            "INSERT INTO workflows (id, repo_id, dsl_json, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, dsl_json = excluded.dsl_json",
            params![
                workflow_id,
                repo_id,
                serde_json::to_string(workflow).map_err(|e| e.to_string())?,
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(workflow.workflow.id.clone())
    }

    pub fn load_workflow(&self, workflow_id: &str) -> Result<WorkflowDsl, String> {
        let conn = self.open()?;
        let raw = conn
            .query_row(
                "SELECT dsl_json FROM workflows WHERE id = ?1",
                params![workflow_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workflow not found".to_string())?;
        serde_json::from_str::<WorkflowDsl>(&raw).map_err(|e| e.to_string())
    }

    pub fn create_run(&self, run_id: &str, workflow: &WorkflowDsl) -> Result<(), String> {
        let conn = self.open()?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO workflow_runs (id, workflow_id, status, started_at) VALUES (?1, ?2, ?3, ?4)",
            params![run_id, workflow.workflow.id, "pending", now_ms()],
        )
        .map_err(|e| e.to_string())?;

        for step in &workflow.steps {
            tx.execute(
                "INSERT INTO run_steps (run_id, step_id, status, attempts, last_message, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![run_id, step.id, "pending", 0u32, Option::<String>::None, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute(
            "INSERT INTO run_events (id, run_id, step_id, level, message, created_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
            params![
                Uuid::new_v4().to_string(),
                run_id,
                "info",
                "Run created and pending execution",
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn set_run_status(
        &self,
        run_id: &str,
        status: &str,
        finished: bool,
    ) -> Result<(), String> {
        let conn = self.open()?;
        if finished {
            conn.execute(
                "UPDATE workflow_runs SET status = ?1, finished_at = ?2 WHERE id = ?3",
                params![status, now_ms(), run_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE workflow_runs SET status = ?1 WHERE id = ?2",
                params![status, run_id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn set_step_status(
        &self,
        run_id: &str,
        step_id: &str,
        status: &str,
        attempts: u32,
        last_message: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE run_steps SET status = ?1, attempts = ?2, last_message = ?3, updated_at = ?4 WHERE run_id = ?5 AND step_id = ?6",
            params![status, attempts, last_message, now_ms(), run_id, step_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_run_event(
        &self,
        run_id: &str,
        step_id: Option<&str>,
        level: &str,
        message: &str,
    ) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO run_events (id, run_id, step_id, level, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                Uuid::new_v4().to_string(),
                run_id,
                step_id,
                level,
                message,
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_run_state(&self, run_id: &str) -> Result<RunState, String> {
        let conn = self.open()?;
        let run_row = conn
            .query_row(
                "SELECT workflow_id, status, started_at, finished_at FROM workflow_runs WHERE id = ?1",
                params![run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Run not found".to_string())?;

        let mut steps = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT step_id, status, attempts, last_message FROM run_steps WHERE run_id = ?1 ORDER BY rowid",
                )
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query(params![run_id]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                steps.push(RunStepState {
                    step_id: row.get(0).map_err(|e| e.to_string())?,
                    status: row.get(1).map_err(|e| e.to_string())?,
                    attempts: row.get::<_, u32>(2).map_err(|e| e.to_string())?,
                    last_message: row.get(3).map_err(|e| e.to_string())?,
                });
            }
        }

        let mut events = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, run_id, step_id, level, message, created_at
                     FROM run_events
                     WHERE run_id = ?1
                     ORDER BY created_at ASC",
                )
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query(params![run_id]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                events.push(RunEvent {
                    id: row.get(0).map_err(|e| e.to_string())?,
                    run_id: row.get(1).map_err(|e| e.to_string())?,
                    step_id: row.get(2).map_err(|e| e.to_string())?,
                    level: row.get(3).map_err(|e| e.to_string())?,
                    message: row.get(4).map_err(|e| e.to_string())?,
                    created_at: row.get(5).map_err(|e| e.to_string())?,
                });
            }
        }

        Ok(RunState {
            run_id: run_id.to_string(),
            workflow_id: run_row.0,
            status: run_row.1,
            started_at: run_row.2,
            finished_at: run_row.3,
            steps,
            events,
        })
    }
}
