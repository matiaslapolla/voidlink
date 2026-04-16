use rusqlite::{params, Connection};
use std::path::PathBuf;
use uuid::Uuid;

use super::*;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone)]
pub struct PromptStore {
    pub path: PathBuf,
}

impl PromptStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let store = Self { path };
        let conn = store.open()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS prompts (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              content TEXT NOT NULL DEFAULT '',
              system_prompt TEXT NOT NULL DEFAULT '',
              model_override TEXT,
              temperature REAL,
              max_tokens INTEGER,
              is_favorite INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS prompt_variables (
              id TEXT PRIMARY KEY,
              prompt_id TEXT NOT NULL,
              name TEXT NOT NULL,
              var_type TEXT NOT NULL DEFAULT 'text',
              default_value TEXT NOT NULL DEFAULT '',
              description TEXT NOT NULL DEFAULT '',
              required INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0,
              FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE,
              UNIQUE(prompt_id, name)
            );

            CREATE TABLE IF NOT EXISTS prompt_tags (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              color TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS prompt_tag_map (
              prompt_id TEXT NOT NULL,
              tag_id TEXT NOT NULL,
              PRIMARY KEY(prompt_id, tag_id),
              FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES prompt_tags(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS prompt_versions (
              id TEXT PRIMARY KEY,
              prompt_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              content TEXT NOT NULL,
              system_prompt TEXT NOT NULL DEFAULT '',
              variables_json TEXT NOT NULL DEFAULT '[]',
              created_at INTEGER NOT NULL,
              FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS prompt_executions (
              id TEXT PRIMARY KEY,
              prompt_id TEXT NOT NULL,
              rendered_prompt TEXT NOT NULL,
              system_prompt TEXT NOT NULL DEFAULT '',
              variables_json TEXT NOT NULL DEFAULT '{}',
              model TEXT NOT NULL,
              provider TEXT NOT NULL,
              output TEXT NOT NULL,
              input_tokens INTEGER,
              output_tokens INTEGER,
              duration_ms INTEGER NOT NULL,
              rating INTEGER,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_variables_prompt
              ON prompt_variables(prompt_id);
            CREATE INDEX IF NOT EXISTS idx_prompt_tag_map_prompt
              ON prompt_tag_map(prompt_id);
            CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt
              ON prompt_versions(prompt_id, version DESC);
            CREATE INDEX IF NOT EXISTS idx_prompt_executions_prompt
              ON prompt_executions(prompt_id, created_at DESC);
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

    // ─── Prompt CRUD ─────────────────────────────────────────────────────────

    pub fn list_prompts(&self) -> Result<Vec<PromptSummary>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, p.description, p.is_favorite, p.updated_at,
                        (SELECT COUNT(*) FROM prompt_versions WHERE prompt_id = p.id) as version_count
                 FROM prompts p ORDER BY p.updated_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let mut prompts = Vec::new();
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id: String = row.get(0).map_err(|e| e.to_string())?;
            let tags = self.get_tags_for_prompt_conn(&conn, &id)?;
            prompts.push(PromptSummary {
                id,
                name: row.get(1).map_err(|e| e.to_string())?,
                description: row.get(2).map_err(|e| e.to_string())?,
                is_favorite: row.get::<_, i32>(3).map_err(|e| e.to_string())? != 0,
                updated_at: row.get(4).map_err(|e| e.to_string())?,
                version_count: row.get(5).map_err(|e| e.to_string())?,
                tags,
            });
        }
        Ok(prompts)
    }

    pub fn get_prompt(&self, id: &str) -> Result<PromptFull, String> {
        let conn = self.open()?;
        let row = conn
            .query_row(
                "SELECT id, name, description, content, system_prompt, model_override,
                        temperature, max_tokens, is_favorite, created_at, updated_at
                 FROM prompts WHERE id = ?1",
                params![id],
                |row| {
                    Ok(PromptFull {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        content: row.get(3)?,
                        system_prompt: row.get(4)?,
                        model_override: row.get(5)?,
                        temperature: row.get(6)?,
                        max_tokens: row.get(7)?,
                        is_favorite: row.get::<_, i32>(8)? != 0,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                        variables: Vec::new(),
                        tags: Vec::new(),
                    })
                },
            )
            .map_err(|e| e.to_string())?;

        let mut prompt = row;
        prompt.variables = self.get_variables_conn(&conn, id)?;
        prompt.tags = self.get_tags_for_prompt_conn(&conn, id)?;
        Ok(prompt)
    }

    pub fn save_prompt(&self, input: &SavePromptInput) -> Result<PromptFull, String> {
        let conn = self.open()?;
        let now = now_ms();
        let is_new = input.id.is_none();
        let id = input.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

        if is_new {
            conn.execute(
                "INSERT INTO prompts (id, name, description, content, system_prompt, model_override, temperature, max_tokens, is_favorite, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)",
                params![
                    id,
                    input.name,
                    input.description.as_deref().unwrap_or(""),
                    input.content.as_deref().unwrap_or(""),
                    input.system_prompt.as_deref().unwrap_or(""),
                    input.model_override,
                    input.temperature,
                    input.max_tokens,
                    now,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE prompts SET name = ?1, description = ?2, content = ?3, system_prompt = ?4,
                        model_override = ?5, temperature = ?6, max_tokens = ?7, updated_at = ?8
                 WHERE id = ?9",
                params![
                    input.name,
                    input.description.as_deref().unwrap_or(""),
                    input.content.as_deref().unwrap_or(""),
                    input.system_prompt.as_deref().unwrap_or(""),
                    input.model_override,
                    input.temperature,
                    input.max_tokens,
                    now,
                    id,
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        // Save variables
        if let Some(vars) = &input.variables {
            conn.execute("DELETE FROM prompt_variables WHERE prompt_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            for (i, var) in vars.iter().enumerate() {
                let var_id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO prompt_variables (id, prompt_id, name, var_type, default_value, description, required, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        var_id,
                        id,
                        var.name,
                        var.var_type.as_deref().unwrap_or("text"),
                        var.default_value.as_deref().unwrap_or(""),
                        var.description.as_deref().unwrap_or(""),
                        if var.required.unwrap_or(true) { 1 } else { 0 },
                        i as i32,
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // Save tags
        if let Some(tags) = &input.tags {
            conn.execute("DELETE FROM prompt_tag_map WHERE prompt_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            for tag_name in tags {
                let tag_id = self.ensure_tag_conn(&conn, tag_name)?;
                conn.execute(
                    "INSERT OR IGNORE INTO prompt_tag_map (prompt_id, tag_id) VALUES (?1, ?2)",
                    params![id, tag_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // Create version snapshot
        let version = self.next_version_conn(&conn, &id)?;
        let vars_json = serde_json::to_string(
            &input.variables.as_deref().unwrap_or(&[]),
        )
        .unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO prompt_versions (id, prompt_id, version, content, system_prompt, variables_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                id,
                version,
                input.content.as_deref().unwrap_or(""),
                input.system_prompt.as_deref().unwrap_or(""),
                vars_json,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;

        self.get_prompt(&id)
    }

    pub fn delete_prompt(&self, id: &str) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute("DELETE FROM prompts WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn toggle_favorite(&self, id: &str) -> Result<bool, String> {
        let conn = self.open()?;
        let current: i32 = conn
            .query_row(
                "SELECT is_favorite FROM prompts WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let new_val = if current == 0 { 1 } else { 0 };
        conn.execute(
            "UPDATE prompts SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_val, now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(new_val == 1)
    }

    // ─── Tags ────────────────────────────────────────────────────────────────

    pub fn list_tags(&self) -> Result<Vec<PromptTag>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.name, t.color, COUNT(m.prompt_id) as usage_count
                 FROM prompt_tags t
                 LEFT JOIN prompt_tag_map m ON t.id = m.tag_id
                 GROUP BY t.id ORDER BY usage_count DESC",
            )
            .map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            tags.push(PromptTag {
                id: row.get(0).map_err(|e| e.to_string())?,
                name: row.get(1).map_err(|e| e.to_string())?,
                color: row.get(2).map_err(|e| e.to_string())?,
            });
        }
        Ok(tags)
    }

    fn ensure_tag_conn(&self, conn: &Connection, name: &str) -> Result<String, String> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM prompt_tags WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match existing {
            Some(id) => Ok(id),
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO prompt_tags (id, name, color) VALUES (?1, ?2, ?3)",
                    params![id, name, ""],
                )
                .map_err(|e| e.to_string())?;
                Ok(id)
            }
        }
    }

    fn get_tags_for_prompt_conn(
        &self,
        conn: &Connection,
        prompt_id: &str,
    ) -> Result<Vec<String>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT t.name FROM prompt_tags t
                 JOIN prompt_tag_map m ON t.id = m.tag_id
                 WHERE m.prompt_id = ?1 ORDER BY t.name",
            )
            .map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        let mut rows = stmt.query(params![prompt_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            tags.push(row.get::<_, String>(0).map_err(|e| e.to_string())?);
        }
        Ok(tags)
    }

    // ─── Variables ───────────────────────────────────────────────────────────

    fn get_variables_conn(
        &self,
        conn: &Connection,
        prompt_id: &str,
    ) -> Result<Vec<PromptVariable>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, var_type, default_value, description, required, sort_order
                 FROM prompt_variables WHERE prompt_id = ?1 ORDER BY sort_order",
            )
            .map_err(|e| e.to_string())?;
        let mut vars = Vec::new();
        let mut rows = stmt.query(params![prompt_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            vars.push(PromptVariable {
                id: row.get(0).map_err(|e| e.to_string())?,
                name: row.get(1).map_err(|e| e.to_string())?,
                var_type: row.get(2).map_err(|e| e.to_string())?,
                default_value: row.get(3).map_err(|e| e.to_string())?,
                description: row.get(4).map_err(|e| e.to_string())?,
                required: row.get::<_, i32>(5).map_err(|e| e.to_string())? != 0,
                sort_order: row.get(6).map_err(|e| e.to_string())?,
            });
        }
        Ok(vars)
    }

    // ─── Versions ────────────────────────────────────────────────────────────

    pub fn get_versions(&self, prompt_id: &str) -> Result<Vec<PromptVersion>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, version, content, system_prompt, variables_json, created_at
                 FROM prompt_versions WHERE prompt_id = ?1 ORDER BY version DESC",
            )
            .map_err(|e| e.to_string())?;
        let mut versions = Vec::new();
        let mut rows = stmt.query(params![prompt_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            versions.push(PromptVersion {
                id: row.get(0).map_err(|e| e.to_string())?,
                version: row.get(1).map_err(|e| e.to_string())?,
                content: row.get(2).map_err(|e| e.to_string())?,
                system_prompt: row.get(3).map_err(|e| e.to_string())?,
                variables_json: row.get(4).map_err(|e| e.to_string())?,
                created_at: row.get(5).map_err(|e| e.to_string())?,
            });
        }
        Ok(versions)
    }

    fn next_version_conn(&self, conn: &Connection, prompt_id: &str) -> Result<i32, String> {
        let current: Option<i32> = conn
            .query_row(
                "SELECT MAX(version) FROM prompt_versions WHERE prompt_id = ?1",
                params![prompt_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        Ok(current.unwrap_or(0) + 1)
    }

    // ─── Executions ──────────────────────────────────────────────────────────

    pub fn save_execution(&self, exec: &PromptExecution) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO prompt_executions (id, prompt_id, rendered_prompt, system_prompt, variables_json, model, provider, output, input_tokens, output_tokens, duration_ms, rating, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                exec.id,
                exec.prompt_id,
                exec.rendered_prompt,
                exec.system_prompt,
                exec.variables_json,
                exec.model,
                exec.provider,
                exec.output,
                exec.input_tokens,
                exec.output_tokens,
                exec.duration_ms,
                exec.rating,
                exec.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_executions(
        &self,
        prompt_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<PromptExecution>, String> {
        let conn = self.open()?;
        let limit = limit.unwrap_or(20);
        let mut stmt = conn
            .prepare(
                "SELECT id, prompt_id, rendered_prompt, system_prompt, variables_json, model, provider, output, input_tokens, output_tokens, duration_ms, rating, created_at
                 FROM prompt_executions WHERE prompt_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let mut executions = Vec::new();
        let mut rows = stmt
            .query(params![prompt_id, limit as i64])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            executions.push(PromptExecution {
                id: row.get(0).map_err(|e| e.to_string())?,
                prompt_id: row.get(1).map_err(|e| e.to_string())?,
                rendered_prompt: row.get(2).map_err(|e| e.to_string())?,
                system_prompt: row.get(3).map_err(|e| e.to_string())?,
                variables_json: row.get(4).map_err(|e| e.to_string())?,
                model: row.get(5).map_err(|e| e.to_string())?,
                provider: row.get(6).map_err(|e| e.to_string())?,
                output: row.get(7).map_err(|e| e.to_string())?,
                input_tokens: row.get(8).map_err(|e| e.to_string())?,
                output_tokens: row.get(9).map_err(|e| e.to_string())?,
                duration_ms: row.get(10).map_err(|e| e.to_string())?,
                rating: row.get(11).map_err(|e| e.to_string())?,
                created_at: row.get(12).map_err(|e| e.to_string())?,
            });
        }
        Ok(executions)
    }

    pub fn rate_execution(&self, execution_id: &str, rating: i32) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE prompt_executions SET rating = ?1 WHERE id = ?2",
            params![rating, execution_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

use rusqlite::OptionalExtension;
