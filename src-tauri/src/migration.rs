use ignore::WalkBuilder;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const APP_IGNORE_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    ".idea",
    ".voidlink",
];

const DETERMINISTIC_EMBED_MODEL: &str = "deterministic-v1";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    #[serde(default)]
    pub force_full_rescan: bool,
    pub max_file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_job_id: String,
    pub repo_path: String,
    pub status: String,
    pub scanned_files: u64,
    pub indexed_files: u64,
    pub indexed_chunks: u64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub repo_path: String,
    pub text: String,
    pub path: Option<String>,
    pub language: Option<String>,
    #[serde(rename = "type")]
    pub query_type: Option<String>,
    pub max_tokens: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWhy {
    pub matched_terms: Vec<String>,
    pub semantic_score: f32,
    pub graph_proximity: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub file_path: String,
    pub anchor: String,
    pub snippet: String,
    pub language: String,
    pub score: f32,
    pub lexical_score: f32,
    pub semantic_score: f32,
    pub why: SearchWhy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundle {
    pub free_text: Option<String>,
    pub selected_results: Vec<SearchResult>,
    pub max_tokens: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub backoff_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMeta {
    pub id: String,
    pub objective: String,
    pub constraints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub id: String,
    pub intent: String,
    pub inputs: Value,
    pub tools: Vec<String>,
    pub expected_output: String,
    pub acceptance_checks: Vec<String>,
    pub retry_policy: RetryPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowArtifact {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDsl {
    pub workflow: WorkflowMeta,
    pub steps: Vec<WorkflowStep>,
    pub artifacts: Vec<WorkflowArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateWorkflowInput {
    pub repo_path: Option<String>,
    pub objective: String,
    pub constraints: Option<Vec<String>>,
    pub context_bundle: Option<ContextBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunWorkflowInput {
    pub workflow_id: Option<String>,
    pub dsl: Option<WorkflowDsl>,
    pub repo_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub id: String,
    pub run_id: String,
    pub step_id: Option<String>,
    pub level: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStepState {
    pub step_id: String,
    pub status: String,
    pub attempts: u32,
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub run_id: String,
    pub workflow_id: String,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub steps: Vec<RunStepState>,
    pub events: Vec<RunEvent>,
}

#[derive(Clone)]
pub struct MigrationState {
    db: SqliteStore,
    scan_jobs: Arc<Mutex<HashMap<String, ScanProgress>>>,
    run_cache: Arc<Mutex<HashMap<String, RunState>>>,
    provider: Arc<ProviderAdapter>,
    startup_repo_path: Option<String>,
}

impl MigrationState {
    pub fn new(startup_repo_path: Option<String>) -> Result<Self, String> {
        let db_path = default_db_path()?;
        let db = SqliteStore::new(db_path)?;
        Ok(Self {
            db,
            scan_jobs: Arc::new(Mutex::new(HashMap::new())),
            run_cache: Arc::new(Mutex::new(HashMap::new())),
            provider: Arc::new(ProviderAdapter::new()),
            startup_repo_path,
        })
    }
}

#[derive(Clone)]
struct SqliteStore {
    path: PathBuf,
}

impl SqliteStore {
    fn new(path: PathBuf) -> Result<Self, String> {
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
            "#,
        )
        .map_err(|e| e.to_string())?;
        Ok(store)
    }

    fn open(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    fn upsert_repo(&self, root_path: &str) -> Result<String, String> {
        let now = now_ms();
        let repo_id = {
            let conn = self.open()?;
            conn.query_row(
                "SELECT id FROM repos WHERE root_path = ?1",
                params![root_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        };

        match repo_id {
            Some(id) => {
                let conn = self.open()?;
                conn.execute(
                    "UPDATE repos SET updated_at = ?1 WHERE id = ?2",
                    params![now, id],
                )
                .map_err(|e| e.to_string())?;
                Ok(id)
            }
            None => {
                let id = Uuid::new_v4().to_string();
                let conn = self.open()?;
                conn.execute(
                    "INSERT INTO repos (id, root_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    params![id, root_path, now, now],
                )
                .map_err(|e| e.to_string())?;
                Ok(id)
            }
        }
    }

    fn repo_id_for_path(&self, root_path: &str) -> Result<Option<String>, String> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT id FROM repos WHERE root_path = ?1",
            params![root_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    fn save_workflow(&self, workflow: &WorkflowDsl, repo_path: Option<&str>) -> Result<String, String> {
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

    fn load_workflow(&self, workflow_id: &str) -> Result<WorkflowDsl, String> {
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

    fn create_run(&self, run_id: &str, workflow: &WorkflowDsl) -> Result<(), String> {
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

    fn set_run_status(&self, run_id: &str, status: &str, finished: bool) -> Result<(), String> {
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

    fn set_step_status(
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

    fn add_run_event(
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

    fn load_run_state(&self, run_id: &str) -> Result<RunState, String> {
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

#[derive(Clone, Debug)]
struct ExistingFileMeta {
    id: String,
    mtime_ms: i64,
    content_hash: String,
}

#[derive(Clone, Debug)]
struct FileRecord {
    id: String,
    path: String,
    language: String,
}

#[derive(Clone, Debug)]
struct SearchCandidate {
    file_id: String,
    result: SearchResult,
    raw_content: String,
}

#[derive(Clone, Debug)]
struct EmbeddingOutput {
    model_id: String,
    vectors: Vec<Vec<f32>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderKind {
    OpenAi,
    Groq,
    OpenRouter,
    Ollama,
}

impl ProviderKind {
    fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Groq => "groq",
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Ollama => "ollama",
        }
    }

    fn from_env_or_auto() -> Self {
        if let Ok(raw) = std::env::var("VOIDLINK_LLM_PROVIDER") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "openai" => return ProviderKind::OpenAi,
                "groq" => return ProviderKind::Groq,
                "openrouter" => return ProviderKind::OpenRouter,
                "ollama" => return ProviderKind::Ollama,
                _ => {}
            }
        }

        if std::env::var("VOIDLINK_OLLAMA_BASE_URL").is_ok()
            || std::env::var("OLLAMA_HOST").is_ok()
        {
            ProviderKind::Ollama
        } else if std::env::var("OPENROUTER_API_KEY").is_ok() {
            ProviderKind::OpenRouter
        } else if std::env::var("GROQ_API_KEY").is_ok() {
            ProviderKind::Groq
        } else {
            ProviderKind::OpenAi
        }
    }
}

#[derive(Clone)]
struct ProviderAdapter {
    kind: ProviderKind,
    model: String,
    embedding_model: Option<String>,
    api_key: Option<String>,
    base_url: String,
    client: Client,
    extra_headers: HeaderMap,
    supports_response_format: bool,
}

impl ProviderAdapter {
    fn new() -> Self {
        let kind = ProviderKind::from_env_or_auto();
        let timeout_secs = first_env(&["VOIDLINK_LLM_TIMEOUT_SECS", "VOIDLINK_OPENAI_TIMEOUT_SECS"])
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(30);
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .unwrap_or_else(|_| Client::new());

        match kind {
            ProviderKind::OpenAi => Self {
                kind,
                model: first_env_or_default(&["VOIDLINK_OPENAI_MODEL"], "gpt-5-mini"),
                embedding_model: Some(first_env_or_default(
                    &["VOIDLINK_OPENAI_EMBED_MODEL"],
                    "text-embedding-3-small",
                )),
                api_key: first_env(&["OPENAI_API_KEY"]),
                base_url: first_env_or_default(
                    &["VOIDLINK_OPENAI_BASE_URL"],
                    "https://api.openai.com/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: true,
            },
            ProviderKind::Groq => Self {
                kind,
                model: first_env_or_default(
                    &["VOIDLINK_GROQ_MODEL", "VOIDLINK_OPENAI_MODEL"],
                    "llama-3.3-70b-versatile",
                ),
                embedding_model: first_env(&["VOIDLINK_GROQ_EMBED_MODEL"]),
                api_key: first_env(&["GROQ_API_KEY", "OPENAI_API_KEY"]),
                base_url: first_env_or_default(
                    &["VOIDLINK_GROQ_BASE_URL"],
                    "https://api.groq.com/openai/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
            },
            ProviderKind::OpenRouter => {
                let mut extra_headers = HeaderMap::new();
                let site_url = first_env_or_default(
                    &["VOIDLINK_OPENROUTER_SITE_URL"],
                    "https://voidlink.local",
                );
                let app_name = first_env_or_default(
                    &["VOIDLINK_OPENROUTER_APP_NAME"],
                    "VoidLink",
                );
                if let Ok(value) = HeaderValue::from_str(&site_url) {
                    extra_headers.insert(HeaderName::from_static("http-referer"), value);
                }
                if let Ok(value) = HeaderValue::from_str(&app_name) {
                    extra_headers.insert(HeaderName::from_static("x-title"), value);
                }

                Self {
                    kind,
                    model: first_env_or_default(
                        &["VOIDLINK_OPENROUTER_MODEL", "VOIDLINK_OPENAI_MODEL"],
                        "openai/gpt-4.1-mini",
                    ),
                    embedding_model: Some(first_env_or_default(
                        &["VOIDLINK_OPENROUTER_EMBED_MODEL", "VOIDLINK_OPENAI_EMBED_MODEL"],
                        "openai/text-embedding-3-small",
                    )),
                    api_key: first_env(&["OPENROUTER_API_KEY", "OPENAI_API_KEY"]),
                    base_url: first_env_or_default(
                        &["VOIDLINK_OPENROUTER_BASE_URL"],
                        "https://openrouter.ai/api/v1",
                    )
                    .trim_end_matches('/')
                    .to_string(),
                    client,
                    extra_headers,
                    supports_response_format: true,
                }
            }
            ProviderKind::Ollama => Self {
                kind,
                model: first_env_or_default(
                    &["VOIDLINK_OLLAMA_MODEL", "VOIDLINK_OPENAI_MODEL"],
                    "llama3.2",
                ),
                embedding_model: Some(first_env_or_default(
                    &["VOIDLINK_OLLAMA_EMBED_MODEL", "VOIDLINK_OPENAI_EMBED_MODEL"],
                    "nomic-embed-text",
                )),
                api_key: first_env(&["OLLAMA_API_KEY", "OPENAI_API_KEY"]),
                base_url: first_env_or_default(
                    &["VOIDLINK_OLLAMA_BASE_URL", "OLLAMA_HOST"],
                    "http://localhost:11434/v1",
                )
                .trim_end_matches('/')
                .to_string(),
                client,
                extra_headers: HeaderMap::new(),
                supports_response_format: false,
            },
        }
    }

    fn generate(&self, prompt: &str) -> String {
        match self.chat_completion(prompt, false) {
            Ok(text) => text,
            Err(_) => format!(
                "{}-offline:{} {}",
                self.kind.as_str(),
                self.model,
                truncate_plain(prompt, 180)
            ),
        }
    }

    fn structured_generate(&self, prompt: &str) -> Value {
        match self.chat_completion(prompt, true) {
            Ok(raw_json) => serde_json::from_str::<Value>(&raw_json).unwrap_or_else(|_| {
                json!({
                    "provider": self.kind.as_str(),
                    "model": self.model.as_str(),
                    "summary": truncate_plain(&raw_json, 200)
                })
            }),
            Err(_) => json!({
                "provider": format!("{}-offline", self.kind.as_str()),
                "model": self.model.as_str(),
                "summary": truncate_plain(prompt, 180)
            }),
        }
    }

    fn embed(&self, text: &str) -> (String, Vec<f32>) {
        let batch = self.embed_many(&[text.to_string()]);
        let vector = batch
            .vectors
            .into_iter()
            .next()
            .unwrap_or_else(|| deterministic_embedding(text, 16));
        (batch.model_id, vector)
    }

    fn embed_many(&self, texts: &[String]) -> EmbeddingOutput {
        if texts.is_empty() {
            return EmbeddingOutput {
                model_id: DETERMINISTIC_EMBED_MODEL.to_string(),
                vectors: Vec::new(),
            };
        }

        if let Ok(vectors) = self.embed_many_remote(texts) {
            let model = self
                .embedding_model
                .as_deref()
                .unwrap_or(DETERMINISTIC_EMBED_MODEL);
            return EmbeddingOutput {
                model_id: format!("{}:{model}", self.kind.as_str()),
                vectors,
            };
        }

        EmbeddingOutput {
            model_id: DETERMINISTIC_EMBED_MODEL.to_string(),
            vectors: texts
                .iter()
                .map(|text| deterministic_embedding(text, 16))
                .collect(),
        }
    }

    fn chat_completion(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
        let mut body = json!({
            "model": self.model.as_str(),
            "messages": [
                {
                    "role": "system",
                    "content": if json_mode {
                        "You are a strict JSON generator. Return only a valid JSON object."
                    } else {
                        "You are a concise software engineering assistant."
                    }
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.1
        });

        if json_mode && self.supports_response_format {
            body["response_format"] = json!({ "type": "json_object" });
        }

        let payload = match self.chat_completion_request(&body) {
            Ok(payload) => payload,
            Err(primary_err) => {
                if json_mode && self.supports_response_format {
                    let mut fallback = body.clone();
                    if let Some(object) = fallback.as_object_mut() {
                        object.remove("response_format");
                    }
                    self.chat_completion_request(&fallback)
                        .map_err(|_| primary_err)?
                } else {
                    return Err(primary_err);
                }
            }
        };

        extract_chat_message_content(&payload).ok_or_else(|| {
            format!(
                "{} chat response had no message content",
                self.kind.as_str()
            )
        })
    }

    fn chat_completion_request(&self, body: &Value) -> Result<Value, String> {
        let api_key = if self.kind == ProviderKind::Ollama {
            self.api_key.as_deref()
        } else {
            Some(
                self.api_key
                    .as_deref()
                    .ok_or_else(|| format!("{} API key not configured", self.kind.as_str()))?,
            )
        };
        let response = self
            .request_builder(format!("{}/chat/completions", self.base_url), api_key)
            .json(body)
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(format!("{} chat error {status}: {body}", self.kind.as_str()));
        }
        response.json::<Value>().map_err(|e| e.to_string())
    }

    fn embed_many_remote(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let embedding_model = self
            .embedding_model
            .as_ref()
            .ok_or_else(|| format!("{} embedding model not configured", self.kind.as_str()))?;
        let api_key = if self.kind == ProviderKind::Ollama {
            self.api_key.as_deref()
        } else {
            Some(
                self.api_key
                    .as_deref()
                    .ok_or_else(|| format!("{} API key not configured", self.kind.as_str()))?,
            )
        };

        let body = json!({
            "model": embedding_model.as_str(),
            "input": texts,
            "encoding_format": "float"
        });

        let response = self
            .request_builder(format!("{}/embeddings", self.base_url), api_key)
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(format!(
                "{} embeddings error {status}: {body}",
                self.kind.as_str()
            ));
        }
        let payload: Value = response.json().map_err(|e| e.to_string())?;
        let data = payload
            .get("data")
            .and_then(|value| value.as_array())
            .ok_or_else(|| format!("{} embeddings response missing data", self.kind.as_str()))?;

        let mut indexed = data
            .iter()
            .filter_map(|item| {
                let index = item.get("index").and_then(|value| value.as_u64())?;
                let embedding = item.get("embedding")?.as_array()?;
                let vector = embedding
                    .iter()
                    .filter_map(|number| number.as_f64().map(|value| value as f32))
                    .collect::<Vec<_>>();
                Some((index as usize, vector))
            })
            .collect::<Vec<_>>();
        indexed.sort_by_key(|(index, _)| *index);

        if indexed.len() != texts.len() {
            return Err(format!(
                "{} embeddings response length mismatch",
                self.kind.as_str()
            ));
        }
        Ok(indexed.into_iter().map(|(_, vector)| vector).collect())
    }

    fn request_builder(
        &self,
        url: String,
        api_key: Option<&str>,
    ) -> reqwest::blocking::RequestBuilder {
        let mut builder = self.client.post(url);
        if let Some(key) = api_key {
            builder = builder.bearer_auth(key);
        }
        for (header_name, header_value) in &self.extra_headers {
            builder = builder.header(header_name, header_value);
        }
        builder
    }
}

pub fn scan_repository(
    state: tauri::State<'_, MigrationState>,
    repo_path: String,
    options: Option<ScanOptions>,
) -> Result<String, String> {
    let canonical = canonicalize_repo_path(&repo_path)?;
    let job_id = Uuid::new_v4().to_string();
    let options = options.unwrap_or_default();

    let progress = ScanProgress {
        scan_job_id: job_id.clone(),
        repo_path: canonical.clone(),
        status: "pending".to_string(),
        scanned_files: 0,
        indexed_files: 0,
        indexed_chunks: 0,
        started_at: now_ms(),
        finished_at: None,
        error: None,
    };
    {
        let mut jobs = state.scan_jobs.lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), progress);
    }

    let shared = state.inner().clone();
    let spawned_job = job_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = execute_scan_job(&shared, &spawned_job, &canonical, &options) {
            let _ = update_scan(
                &shared,
                &spawned_job,
                |job| {
                    job.status = "failed".to_string();
                    job.finished_at = Some(now_ms());
                    job.error = Some(err.clone());
                },
            );
        }
    });

    Ok(job_id)
}

pub fn get_scan_status(
    state: tauri::State<'_, MigrationState>,
    scan_job_id: String,
) -> Result<ScanProgress, String> {
    let jobs = state.scan_jobs.lock().map_err(|e| e.to_string())?;
    jobs.get(&scan_job_id)
        .cloned()
        .ok_or_else(|| "Scan job not found".to_string())
}

pub fn search_repository(
    state: tauri::State<'_, MigrationState>,
    query: SearchQuery,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchResult>, String> {
    perform_search(&state.inner().clone(), &query, options.as_ref())
}

pub fn generate_workflow(
    state: tauri::State<'_, MigrationState>,
    input: GenerateWorkflowInput,
) -> Result<WorkflowDsl, String> {
    if input.objective.trim().is_empty() {
        return Err("objective is required".to_string());
    }

    let repo_path = input.repo_path.as_deref().map(canonicalize_repo_path).transpose()?;
    let constraints = input.constraints.clone().unwrap_or_default();
    let objective = input.objective.trim();
    let workflow_id = Uuid::new_v4().to_string();

    let augmented_results = match repo_path.clone() {
        Some(path) => perform_search(
            &state.inner().clone(),
            &SearchQuery {
                repo_path: path,
                text: objective.to_string(),
                path: None,
                language: None,
                query_type: Some("hybrid".to_string()),
                max_tokens: Some(120),
            },
            Some(&SearchOptions { limit: Some(3) }),
        )
        .unwrap_or_default(),
        None => Vec::new(),
    };

    let user_context_count = input
        .context_bundle
        .as_ref()
        .map(|ctx| ctx.selected_results.len())
        .unwrap_or(0);
    let augmentation_count = augmented_results.len();

    let steps = vec![
        WorkflowStep {
            id: "step_01_search_files".to_string(),
            intent: "Find code areas most relevant to the objective".to_string(),
            inputs: json!({
                "query": objective,
                "repoPath": repo_path,
                "seedAnchors": augmented_results.iter().map(|result| result.anchor.clone()).collect::<Vec<_>>()
            }),
            tools: vec!["search_files".to_string()],
            expected_output: "Top candidate files with concise rationale".to_string(),
            acceptance_checks: vec![
                "At least 3 anchors are returned or an explicit gap is documented".to_string(),
                "Each anchor includes path and line range".to_string(),
            ],
            retry_policy: RetryPolicy {
                max_retries: 1,
                backoff_ms: 300,
            },
        },
        WorkflowStep {
            id: "step_02_open_snippets".to_string(),
            intent: "Inspect snippets and extract implementation constraints".to_string(),
            inputs: json!({
                "objective": objective,
                "selectedContextCount": user_context_count,
                "augmentedResultsCount": augmentation_count
            }),
            tools: vec!["open_file_snippet".to_string()],
            expected_output: "Working notes with assumptions and constraints".to_string(),
            acceptance_checks: vec![
                "Notes reference concrete files or unresolved blockers".to_string(),
                "Each constraint ties back to objective or repository evidence".to_string(),
            ],
            retry_policy: RetryPolicy {
                max_retries: 1,
                backoff_ms: 300,
            },
        },
        WorkflowStep {
            id: "step_03_write_artifact".to_string(),
            intent: "Produce the migration artifact and next actions".to_string(),
            inputs: json!({
                "objective": objective,
                "constraints": constraints,
                "outputFormat": "markdown"
            }),
            tools: vec!["write_note/artifact".to_string()],
            expected_output: "Artifact saved for review with explicit acceptance checks".to_string(),
            acceptance_checks: vec![
                "Artifact exists on disk and includes objective + constraints".to_string(),
                "Artifact proposes concrete next actions".to_string(),
            ],
            retry_policy: RetryPolicy {
                max_retries: 0,
                backoff_ms: 0,
            },
        },
    ];

    let dsl = WorkflowDsl {
        workflow: WorkflowMeta {
            id: workflow_id.clone(),
            objective: objective.to_string(),
            constraints,
        },
        steps,
        artifacts: vec![WorkflowArtifact {
            id: "artifact_primary".to_string(),
            name: "Workflow Notes".to_string(),
            kind: "note".to_string(),
            reference: format!(".voidlink/artifacts/{workflow_id}/artifact_primary.md"),
        }],
    };

    state
        .db
        .save_workflow(&dsl, repo_path.as_deref())
        .map_err(|e| format!("failed to save workflow: {e}"))?;
    Ok(dsl)
}

pub fn run_workflow(
    state: tauri::State<'_, MigrationState>,
    input: RunWorkflowInput,
) -> Result<String, String> {
    let shared = state.inner().clone();
    let (workflow, repo_path_hint) = resolve_workflow_for_run(&shared, input)?;
    let run_id = Uuid::new_v4().to_string();

    shared.db.create_run(&run_id, &workflow)?;
    if let Ok(run_state) = shared.db.load_run_state(&run_id) {
        let mut cache = shared.run_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(run_id.clone(), run_state);
    }

    let run_id_for_task = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = execute_run(&shared, &run_id_for_task, &workflow, repo_path_hint.as_deref());
        if let Ok(run_state) = shared.db.load_run_state(&run_id_for_task) {
            if let Ok(mut cache) = shared.run_cache.lock() {
                cache.insert(run_id_for_task.clone(), run_state);
            }
        }
    });

    Ok(run_id)
}

pub fn get_run_status(
    state: tauri::State<'_, MigrationState>,
    run_id: String,
) -> Result<RunState, String> {
    {
        let cache = state.run_cache.lock().map_err(|e| e.to_string())?;
        if let Some(run) = cache.get(&run_id) {
            return Ok(run.clone());
        }
    }

    let run = state.db.load_run_state(&run_id)?;
    {
        let mut cache = state.run_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(run_id, run.clone());
    }
    Ok(run)
}

pub fn get_startup_repo_path(state: tauri::State<'_, MigrationState>) -> Option<String> {
    state.startup_repo_path.clone()
}

fn execute_scan_job(
    state: &MigrationState,
    job_id: &str,
    repo_path: &str,
    options: &ScanOptions,
) -> Result<(), String> {
    update_scan(state, job_id, |job| {
        job.status = "running".to_string();
    })?;

    let repo_id = state.db.upsert_repo(repo_path)?;
    let max_file_size = options.max_file_size_bytes.unwrap_or(768 * 1024);
    let conn = state.db.open()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let mut existing = HashMap::<String, ExistingFileMeta>::new();
    {
        let mut stmt = tx
            .prepare("SELECT id, path, mtime_ms, content_hash FROM files WHERE repo_id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            existing.insert(
                row.get::<_, String>(1).map_err(|e| e.to_string())?,
                ExistingFileMeta {
                    id: row.get(0).map_err(|e| e.to_string())?,
                    mtime_ms: row.get(2).map_err(|e| e.to_string())?,
                    content_hash: row.get(3).map_err(|e| e.to_string())?,
                },
            );
        }
    }

    let mut seen_paths = HashSet::<String>::new();
    let mut scanned_files: u64 = 0;
    let mut indexed_files: u64 = 0;
    let mut indexed_chunks: u64 = 0;
    let mut pending_chunk_embeddings = Vec::<(String, String)>::new();

    let mut walker = WalkBuilder::new(repo_path);
    walker.hidden(false);
    walker.git_ignore(true);
    walker.git_global(true);
    walker.git_exclude(true);
    walker.parents(true);

    for entry in walker.build() {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(ft) => ft,
            None => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let path = entry.path();
        if should_ignore_app_path(path, Path::new(repo_path)) {
            continue;
        }

        let metadata = match fs::metadata(path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.len() > max_file_size {
            continue;
        }

        let relative = match path.strip_prefix(repo_path) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        seen_paths.insert(relative.clone());
        scanned_files += 1;

        let bytes = match fs::read(path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if bytes.contains(&0) {
            continue;
        }

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| {
                time.duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|duration| duration.as_millis() as i64)
            })
            .unwrap_or(0);
        let content_hash = blake3::hash(&bytes).to_hex().to_string();

        if !options.force_full_rescan {
            if let Some(meta) = existing.get(&relative) {
                if meta.mtime_ms == mtime_ms && meta.content_hash == content_hash {
                    continue;
                }
            }
        }

        let file_id = existing
            .get(&relative)
            .map(|meta| meta.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let language = detect_language(path);
        let content = String::from_utf8_lossy(&bytes).to_string();
        let chunks = chunk_content(&content, 120, 20);
        let indexed_at = now_ms();

        tx.execute(
            "INSERT INTO files (id, repo_id, path, language, size_bytes, mtime_ms, content_hash, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(repo_id, path) DO UPDATE SET
               language = excluded.language,
               size_bytes = excluded.size_bytes,
               mtime_ms = excluded.mtime_ms,
               content_hash = excluded.content_hash,
               indexed_at = excluded.indexed_at",
            params![
                file_id,
                repo_id,
                relative,
                language,
                metadata.len() as i64,
                mtime_ms,
                content_hash,
                indexed_at
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM embeddings
             WHERE owner_type = 'chunk'
               AND owner_id IN (SELECT id FROM chunks WHERE file_id = ?1)",
            params![file_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chunks WHERE file_id = ?1", params![file_id])
            .map_err(|e| e.to_string())?;

        for (idx, chunk) in chunks.iter().enumerate() {
            let chunk_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO chunks (id, file_id, chunk_index, start_line, end_line, content, token_estimate)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    chunk_id,
                    file_id,
                    idx as i64,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.text,
                    chunk.token_estimate as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            pending_chunk_embeddings.push((chunk_id, chunk.text.clone()));
        }

        indexed_files += 1;
        indexed_chunks += chunks.len() as u64;

        if scanned_files % 25 == 0 {
            let _ = update_scan(state, job_id, |job| {
                job.scanned_files = scanned_files;
                job.indexed_files = indexed_files;
                job.indexed_chunks = indexed_chunks;
            });
        }
    }

    for path in existing.keys() {
        if !seen_paths.contains(path) {
            tx.execute(
                "DELETE FROM files WHERE repo_id = ?1 AND path = ?2",
                params![repo_id, path],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    rebuild_repo_edges(&tx, &repo_id, Path::new(repo_path))?;

    tx.commit().map_err(|e| e.to_string())?;
    persist_chunk_embeddings(&state.db, &state.provider, &pending_chunk_embeddings)?;
    cleanup_orphan_chunk_embeddings(&state.db)?;

    update_scan(state, job_id, |job| {
        job.status = "success".to_string();
        job.scanned_files = scanned_files;
        job.indexed_files = indexed_files;
        job.indexed_chunks = indexed_chunks;
        job.finished_at = Some(now_ms());
    })?;

    Ok(())
}

fn perform_search(
    state: &MigrationState,
    query: &SearchQuery,
    options: Option<&SearchOptions>,
) -> Result<Vec<SearchResult>, String> {
    let repo_path = canonicalize_repo_path(&query.repo_path)?;
    let repo_id = state
        .db
        .repo_id_for_path(&repo_path)?
        .ok_or_else(|| "Repository has not been scanned yet".to_string())?;

    let conn = state.db.open()?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, f.id, f.path, f.language, c.start_line, c.end_line, c.content
             FROM chunks c
             INNER JOIN files f ON f.id = c.file_id
             WHERE f.repo_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;

    let query_tokens = tokenize(&query.text);
    let (embedding_model_id, query_embedding) = state.provider.embed(&query.text);
    let max_tokens = query.max_tokens.unwrap_or(140);
    let limit = options.and_then(|opts| opts.limit).unwrap_or(25);
    let path_filter = query.path.as_ref().map(|value| value.to_lowercase());
    let language_filter = query.language.as_ref().map(|value| value.to_lowercase());

    let mut candidates = Vec::<SearchCandidate>::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        let file_id = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        let path = row.get::<_, String>(2).map_err(|e| e.to_string())?;
        let language = row.get::<_, String>(3).map_err(|e| e.to_string())?;
        let start_line = row.get::<_, i64>(4).map_err(|e| e.to_string())?;
        let end_line = row.get::<_, i64>(5).map_err(|e| e.to_string())?;
        let content = row.get::<_, String>(6).map_err(|e| e.to_string())?;

        if let Some(filter) = &path_filter {
            if !path.to_lowercase().contains(filter) {
                continue;
            }
        }
        if let Some(filter) = &language_filter {
            if language.to_lowercase() != *filter {
                continue;
            }
        }

        let path_lc = path.to_lowercase();
        let content_lc = content.to_lowercase();

        let mut matched_terms = Vec::new();
        let mut lexical_hits = 0f32;
        for token in &query_tokens {
            let in_path = path_lc.contains(token);
            let count_in_content = content_lc.matches(token).count() as f32;
            if in_path || count_in_content > 0.0 {
                matched_terms.push(token.clone());
                lexical_hits += count_in_content + if in_path { 2.0 } else { 0.0 };
            }
        }

        let lexical_score = if query_tokens.is_empty() {
            0.0
        } else {
            (lexical_hits / ((query_tokens.len() as f32) * 4.0)).min(1.0)
        };

        let score = lexical_score * 0.65;
        candidates.push(SearchCandidate {
            file_id,
            result: SearchResult {
                id,
                file_path: path.clone(),
                anchor: format!("{path}:{}-{}", start_line, end_line),
                snippet: truncate_to_tokens(&content, max_tokens),
                language,
                score,
                lexical_score,
                semantic_score: 0.0,
                why: SearchWhy {
                    matched_terms,
                    semantic_score: 0.0,
                    graph_proximity: None,
                },
            },
            raw_content: content,
        });
    }

    let chunk_ids = candidates
        .iter()
        .map(|candidate| candidate.result.id.clone())
        .collect::<Vec<_>>();
    let embeddings_by_chunk =
        load_chunk_embeddings(&conn, &chunk_ids, &embedding_model_id).unwrap_or_default();

    for candidate in &mut candidates {
        let embedding_semantic = embeddings_by_chunk
            .get(&candidate.result.id)
            .map(|vector| cosine_similarity(&query_embedding, vector))
            .unwrap_or(0.0);
        let lexical_semantic = jaccard_similarity(&query_tokens, &tokenize(&candidate.raw_content));
        let semantic_score = embedding_semantic.max(lexical_semantic);

        candidate.result.semantic_score = semantic_score;
        candidate.result.why.semantic_score = semantic_score;
        candidate.result.score = ((candidate.result.lexical_score * 0.65) + (semantic_score * 0.35))
            .clamp(0.0, 1.0);
    }

    candidates.retain(|candidate| {
        if query_tokens.is_empty() {
            true
        } else {
            candidate.result.lexical_score > 0.0 || candidate.result.semantic_score >= 0.08
        }
    });

    let seed_file_ids = collect_seed_file_ids(&candidates, 6);
    let graph_neighbors = load_graph_neighbors(&conn, &repo_id).unwrap_or_default();
    for candidate in &mut candidates {
        let graph_proximity =
            compute_graph_proximity(&candidate.file_id, &seed_file_ids, &graph_neighbors);
        let proximity_boost = graph_proximity.unwrap_or(0.0) * 0.15;
        candidate.result.why.graph_proximity = graph_proximity;
        candidate.result.score = (candidate.result.score + proximity_boost).clamp(0.0, 1.0);
    }

    candidates.sort_by(|a, b| {
        b.result
            .score
            .partial_cmp(&a.result.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if candidates.len() > limit {
        candidates.truncate(limit);
    }
    Ok(candidates.into_iter().map(|candidate| candidate.result).collect())
}

fn resolve_workflow_for_run(
    state: &MigrationState,
    input: RunWorkflowInput,
) -> Result<(WorkflowDsl, Option<String>), String> {
    if let Some(workflow_id) = input.workflow_id {
        let workflow = state.db.load_workflow(&workflow_id)?;
        return Ok((workflow, input.repo_path));
    }

    if let Some(mut dsl) = input.dsl {
        if dsl.workflow.id.trim().is_empty() {
            dsl.workflow.id = Uuid::new_v4().to_string();
        }
        state
            .db
            .save_workflow(&dsl, input.repo_path.as_deref())
            .map_err(|e| format!("failed to persist workflow: {e}"))?;
        return Ok((dsl, input.repo_path));
    }

    Err("Either workflowId or dsl is required".to_string())
}

fn execute_run(
    state: &MigrationState,
    run_id: &str,
    workflow: &WorkflowDsl,
    repo_path_hint: Option<&str>,
) -> Result<(), String> {
    state.db.set_run_status(run_id, "running", false)?;
    state
        .db
        .add_run_event(run_id, None, "info", "Run started")?;

    for step in &workflow.steps {
        let max_attempts = step.retry_policy.max_retries + 1;
        let mut last_err: Option<String> = None;

        for attempt in 1..=max_attempts {
            state.db.set_step_status(
                run_id,
                &step.id,
                "running",
                attempt,
                Some("Step execution in progress"),
            )?;
            state.db.add_run_event(
                run_id,
                Some(&step.id),
                "info",
                &format!("Starting step {} (attempt {attempt}/{max_attempts})", step.id),
            )?;

            match execute_step(state, run_id, workflow, step, repo_path_hint) {
                Ok(output) => {
                    state
                        .db
                        .set_step_status(run_id, &step.id, "success", attempt, Some(&output))?;
                    state
                        .db
                        .add_run_event(run_id, Some(&step.id), "info", &output)?;
                    last_err = None;
                    break;
                }
                Err(err) => {
                    last_err = Some(err.clone());
                    state.db.add_run_event(
                        run_id,
                        Some(&step.id),
                        "error",
                        &format!("Step {} failed: {err}", step.id),
                    )?;
                    if attempt < max_attempts && step.retry_policy.backoff_ms > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(step.retry_policy.backoff_ms));
                    }
                }
            }
        }

        if let Some(err) = last_err {
            state
                .db
                .set_step_status(run_id, &step.id, "failed", max_attempts, Some(&err))?;
            state.db.set_run_status(run_id, "failed", true)?;
            state
                .db
                .add_run_event(run_id, Some(&step.id), "error", "Run halted after step failure")?;
            return Err(err);
        }
    }

    state.db.set_run_status(run_id, "success", true)?;
    state
        .db
        .add_run_event(run_id, None, "info", "Run completed successfully")?;
    Ok(())
}

fn execute_step(
    state: &MigrationState,
    run_id: &str,
    workflow: &WorkflowDsl,
    step: &WorkflowStep,
    repo_path_hint: Option<&str>,
) -> Result<String, String> {
    let tool = step
        .tools
        .first()
        .cloned()
        .unwrap_or_else(|| "write_note/artifact".to_string());

    match tool.as_str() {
        "search_files" => {
            let repo_path = step
                .inputs
                .get("repoPath")
                .and_then(|value| value.as_str())
                .or(repo_path_hint)
                .ok_or_else(|| "search_files requires repoPath".to_string())?;
            let text = step
                .inputs
                .get("query")
                .and_then(|value| value.as_str())
                .unwrap_or(&workflow.workflow.objective);
            let results = perform_search(
                state,
                &SearchQuery {
                    repo_path: repo_path.to_string(),
                    text: text.to_string(),
                    path: None,
                    language: None,
                    query_type: Some("hybrid".to_string()),
                    max_tokens: Some(80),
                },
                Some(&SearchOptions { limit: Some(5) }),
            )?;
            Ok(format!(
                "{} search results captured (top: {}).",
                results.len(),
                results
                    .first()
                    .map(|r| r.anchor.clone())
                    .unwrap_or_else(|| "none".to_string())
            ))
        }
        "open_file_snippet" => {
            let summary = state.provider.structured_generate(&format!(
                "Objective: {}. Step intent: {}",
                workflow.workflow.objective, step.intent
            ));
            Ok(format!(
                "Snippet analysis generated via provider adapter: {}",
                summary
            ))
        }
        "write_note/artifact" => {
            let run_dir = Path::new(".voidlink").join("artifacts").join(run_id);
            fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
            let note_path = run_dir.join(format!("{}.md", step.id));
            let body = format!(
                "# {}\n\n## Objective\n{}\n\n## Intent\n{}\n\n## Constraints\n{}\n\n## Provider Note\n{}\n",
                step.id,
                workflow.workflow.objective,
                step.intent,
                if workflow.workflow.constraints.is_empty() {
                    "- none".to_string()
                } else {
                    workflow
                        .workflow
                        .constraints
                        .iter()
                        .map(|item| format!("- {item}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                },
                state.provider.generate(&format!(
                    "Create concise execution notes for step {}",
                    step.id
                ))
            );
            fs::write(&note_path, body).map_err(|e| e.to_string())?;
            state.db.add_run_event(
                run_id,
                Some(&step.id),
                "info",
                &format!("Artifact written to {}", note_path.to_string_lossy()),
            )?;
            Ok(format!("Artifact created: {}", note_path.to_string_lossy()))
        }
        other => Err(format!("Unsupported tool for MVP: {other}")),
    }
}

fn persist_chunk_embeddings(
    store: &SqliteStore,
    provider: &ProviderAdapter,
    chunk_entries: &[(String, String)],
) -> Result<(), String> {
    if chunk_entries.is_empty() {
        return Ok(());
    }

    let conn = store.open()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    const BATCH_SIZE: usize = 24;

    for chunk_batch in chunk_entries.chunks(BATCH_SIZE) {
        let texts = chunk_batch
            .iter()
            .map(|(_, text)| truncate_plain(text, 12_000))
            .collect::<Vec<_>>();
        let embeddings = provider.embed_many(&texts);

        for (index, (chunk_id, text)) in chunk_batch.iter().enumerate() {
            let vector = embeddings
                .vectors
                .get(index)
                .cloned()
                .unwrap_or_else(|| deterministic_embedding(text, 16));
            tx.execute(
                "DELETE FROM embeddings WHERE owner_type = 'chunk' AND owner_id = ?1",
                params![chunk_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO embeddings (id, owner_type, owner_id, model, vector_json, created_at)
                 VALUES (?1, 'chunk', ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    chunk_id,
                    embeddings.model_id.as_str(),
                    serde_json::to_string(&vector).map_err(|e| e.to_string())?,
                    now_ms()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())
}

fn cleanup_orphan_chunk_embeddings(store: &SqliteStore) -> Result<(), String> {
    let conn = store.open()?;
    conn.execute(
        "DELETE FROM embeddings
         WHERE owner_type = 'chunk'
           AND owner_id NOT IN (SELECT id FROM chunks)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_chunk_embeddings(
    conn: &Connection,
    chunk_ids: &[String],
    model_id: &str,
) -> Result<HashMap<String, Vec<f32>>, String> {
    if chunk_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let wanted = chunk_ids.iter().cloned().collect::<HashSet<_>>();
    let mut out = HashMap::<String, Vec<f32>>::new();

    let mut stmt = conn
        .prepare(
            "SELECT owner_id, vector_json
             FROM embeddings
             WHERE owner_type = 'chunk' AND model = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![model_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let owner_id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        if !wanted.contains(&owner_id) {
            continue;
        }
        let vector_json = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        if let Ok(vector) = serde_json::from_str::<Vec<f32>>(&vector_json) {
            out.insert(owner_id, vector);
        }
    }
    Ok(out)
}

fn extract_chat_message_content(payload: &Value) -> Option<String> {
    let content = payload
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.trim().to_string());
    }

    if let Some(parts) = content.as_array() {
        let mut out = String::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text.trim());
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }

    None
}

fn rebuild_repo_edges(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
    repo_root: &Path,
) -> Result<(), String> {
    tx.execute("DELETE FROM edges WHERE repo_id = ?1", params![repo_id])
        .map_err(|e| e.to_string())?;

    let files = load_repo_files_for_edges(tx, repo_id)?;
    let file_by_path = files
        .iter()
        .map(|file| (normalize_relative_path(&file.path), file.id.clone()))
        .collect::<HashMap<_, _>>();

    let mut seen_directories = HashSet::<String>::new();
    for file in &files {
        let parent = parent_rel_path(&file.path);
        let parent_node = format!("dir:{parent}");
        insert_edge(
            tx,
            repo_id,
            "path_parent",
            &file.id,
            &parent_node,
            json!({
                "kind": "file_parent",
                "filePath": file.path,
                "parentPath": parent
            }),
        )?;
        insert_directory_parent_edges(tx, repo_id, &parent, &mut seen_directories)?;
    }

    {
        let mut stmt = tx
            .prepare(
                "SELECT c.id, c.file_id, c.chunk_index, c.start_line, c.end_line
                 FROM chunks c
                 INNER JOIN files f ON f.id = c.file_id
                 WHERE f.repo_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let chunk_id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
            let file_id = row.get::<_, String>(1).map_err(|e| e.to_string())?;
            let chunk_index = row.get::<_, i64>(2).map_err(|e| e.to_string())?;
            let start_line = row.get::<_, i64>(3).map_err(|e| e.to_string())?;
            let end_line = row.get::<_, i64>(4).map_err(|e| e.to_string())?;

            insert_edge(
                tx,
                repo_id,
                "contains",
                &file_id,
                &chunk_id,
                json!({
                    "chunkIndex": chunk_index,
                    "startLine": start_line,
                    "endLine": end_line
                }),
            )?;
        }
    }

    for file in &files {
        let full_path = repo_root.join(&file.path);
        let content = match fs::read_to_string(&full_path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let imports = extract_import_specs(&file.language, &content);
        let mut dedup = HashSet::<String>::new();
        for import_spec in imports {
            if !dedup.insert(import_spec.clone()) {
                continue;
            }
            let resolved = resolve_import_target(
                &file.path,
                &file.language,
                &import_spec,
                &file_by_path,
            );
            let (target_id, resolved_path, resolved_flag) = match resolved {
                Some((target_file_id, path)) => (target_file_id, Some(path), true),
                None => (format!("external:{import_spec}"), None, false),
            };

            insert_edge(
                tx,
                repo_id,
                "import",
                &file.id,
                &target_id,
                json!({
                    "import": import_spec,
                    "resolved": resolved_flag,
                    "resolvedPath": resolved_path
                }),
            )?;
        }
    }

    Ok(())
}

fn load_repo_files_for_edges(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
) -> Result<Vec<FileRecord>, String> {
    let mut files = Vec::new();
    let mut stmt = tx
        .prepare("SELECT id, path, language FROM files WHERE repo_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        files.push(FileRecord {
            id: row.get(0).map_err(|e| e.to_string())?,
            path: row.get(1).map_err(|e| e.to_string())?,
            language: row.get(2).map_err(|e| e.to_string())?,
        });
    }
    Ok(files)
}

fn insert_directory_parent_edges(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
    directory_path: &str,
    seen_directories: &mut HashSet<String>,
) -> Result<(), String> {
    let mut current = normalize_relative_path(directory_path);
    if current == "." {
        return Ok(());
    }

    loop {
        if !seen_directories.insert(current.clone()) {
            break;
        }
        let parent = parent_rel_path(&current);
        insert_edge(
            tx,
            repo_id,
            "path_parent",
            &format!("dir:{current}"),
            &format!("dir:{parent}"),
            json!({
                "kind": "dir_parent",
                "path": current,
                "parentPath": parent
            }),
        )?;
        if parent == "." {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn insert_edge(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
    edge_type: &str,
    source_id: &str,
    target_id: &str,
    metadata: Value,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO edges (id, repo_id, edge_type, source_id, target_id, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            repo_id,
            edge_type,
            source_id,
            target_id,
            serde_json::to_string(&metadata).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_import_specs(language: &str, content: &str) -> Vec<String> {
    let mut imports = Vec::new();

    for line in content.lines().take(400) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match language {
            "typescript" | "javascript" => {
                if (trimmed.starts_with("import ") || trimmed.starts_with("export "))
                    && trimmed.contains(" from ")
                {
                    if let Some(spec) = extract_quoted_after_keyword(trimmed, " from ") {
                        imports.push(spec);
                    }
                }

                if let Some(spec) = extract_quoted_call_arg(trimmed, "require(") {
                    imports.push(spec);
                }
                if let Some(spec) = extract_quoted_call_arg(trimmed, "import(") {
                    imports.push(spec);
                }
            }
            "python" => {
                if let Some(rest) = trimmed.strip_prefix("from ") {
                    if let Some((module, _)) = rest.split_once(" import ") {
                        let module = module.trim();
                        if !module.is_empty() {
                            imports.push(module.to_string());
                        }
                    }
                } else if let Some(rest) = trimmed.strip_prefix("import ") {
                    for item in rest.split(',') {
                        let module = item.trim().split_whitespace().next().unwrap_or_default();
                        if !module.is_empty() {
                            imports.push(module.to_string());
                        }
                    }
                }
            }
            "rust" => {
                if let Some(rest) = trimmed.strip_prefix("use ") {
                    let use_path = rest.trim_end_matches(';').trim();
                    if !use_path.is_empty() {
                        imports.push(use_path.to_string());
                    }
                } else if let Some(rest) = trimmed.strip_prefix("mod ") {
                    let module = rest
                        .trim_end_matches(';')
                        .split_whitespace()
                        .next()
                        .unwrap_or_default();
                    if !module.is_empty() {
                        imports.push(module.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    imports
}

fn extract_quoted_after_keyword(input: &str, keyword: &str) -> Option<String> {
    let (_, suffix) = input.split_once(keyword)?;
    extract_first_quoted(suffix)
}

fn extract_quoted_call_arg(input: &str, call_prefix: &str) -> Option<String> {
    let idx = input.find(call_prefix)?;
    extract_first_quoted(&input[(idx + call_prefix.len())..])
}

fn extract_first_quoted(input: &str) -> Option<String> {
    let mut start_index = None::<(usize, char)>;
    for (idx, ch) in input.char_indices() {
        if start_index.is_none() && (ch == '"' || ch == '\'' || ch == '`') {
            start_index = Some((idx, ch));
            continue;
        }

        if let Some((start, quote)) = start_index {
            if ch == quote {
                let value = input[(start + 1)..idx].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
                return None;
            }
        }
    }
    None
}

fn resolve_import_target(
    source_path: &str,
    language: &str,
    import_spec: &str,
    file_by_path: &HashMap<String, String>,
) -> Option<(String, String)> {
    let candidates = import_path_candidates(source_path, language, import_spec);
    for candidate in candidates {
        if let Some(target_id) = file_by_path.get(&candidate) {
            return Some((target_id.clone(), candidate));
        }
    }
    None
}

fn import_path_candidates(source_path: &str, language: &str, import_spec: &str) -> Vec<String> {
    let spec = import_spec.trim();
    if spec.is_empty() {
        return Vec::new();
    }

    let mut candidates = Vec::new();
    let source_dir = parent_rel_path(source_path);

    match language {
        "typescript" | "javascript" => {
            let base = if spec.starts_with('.') {
                join_relative(&source_dir, spec)
            } else if spec.starts_with('/') {
                normalize_relative_path(spec)
            } else {
                String::new()
            };

            if !base.is_empty() {
                append_module_candidates(
                    &base,
                    &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
                    &mut candidates,
                );
            }
        }
        "python" => {
            let base = if spec.starts_with('.') {
                let leading_dots = spec.chars().take_while(|ch| *ch == '.').count();
                let remainder = spec.trim_start_matches('.');
                let mut package_parts = split_relative_path(&source_dir);
                let pops = leading_dots.saturating_sub(1);
                for _ in 0..pops {
                    if package_parts.pop().is_none() {
                        break;
                    }
                }
                let prefix = if package_parts.is_empty() {
                    ".".to_string()
                } else {
                    package_parts.join("/")
                };
                if remainder.is_empty() {
                    prefix
                } else {
                    join_relative(&prefix, &remainder.replace('.', "/"))
                }
            } else {
                normalize_relative_path(&spec.replace('.', "/"))
            };

            if base != "." {
                candidates.push(format!("{base}.py"));
                candidates.push(format!("{base}/__init__.py"));
            }
        }
        "rust" => {
            if let Some(path) = spec.strip_prefix("crate::") {
                let base = normalize_relative_path(&format!("src/{}", path.replace("::", "/")));
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            } else if let Some(path) = spec.strip_prefix("self::") {
                let base = join_relative(&source_dir, &path.replace("::", "/"));
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            } else if let Some(path) = spec.strip_prefix("super::") {
                let parent = parent_rel_path(&source_dir);
                let base = join_relative(&parent, &path.replace("::", "/"));
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            } else if !spec.contains("::") {
                let base = join_relative(&source_dir, spec);
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            }
        }
        _ => {
            if spec.starts_with('.') {
                candidates.push(join_relative(&source_dir, spec));
            }
        }
    }

    dedupe_paths(candidates)
}

fn append_module_candidates(base: &str, extensions: &[&str], out: &mut Vec<String>) {
    let normalized = normalize_relative_path(base);
    if normalized == "." {
        return;
    }
    out.push(normalized.clone());

    let has_extension = Path::new(&normalized).extension().is_some();
    if has_extension {
        return;
    }
    for ext in extensions {
        out.push(format!("{normalized}.{ext}"));
    }
    for ext in extensions {
        out.push(format!("{normalized}/index.{ext}"));
    }
}

fn dedupe_paths(paths: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    let mut seen = HashSet::<String>::new();
    for path in paths {
        let normalized = normalize_relative_path(&path);
        if normalized == "." {
            continue;
        }
        if seen.insert(normalized.clone()) {
            unique.push(normalized);
        }
    }
    unique
}

fn load_graph_neighbors(
    conn: &Connection,
    repo_id: &str,
) -> Result<HashMap<String, HashSet<String>>, String> {
    let mut neighbors = HashMap::<String, HashSet<String>>::new();
    let mut stmt = conn
        .prepare(
            "SELECT source_id, target_id
             FROM edges
             WHERE repo_id = ?1
               AND edge_type IN ('import', 'path_parent')",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let source = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        let target = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        neighbors
            .entry(source.clone())
            .or_default()
            .insert(target.clone());
        neighbors.entry(target).or_default().insert(source);
    }
    Ok(neighbors)
}

fn collect_seed_file_ids(candidates: &[SearchCandidate], max_seeds: usize) -> HashSet<String> {
    let mut sorted = candidates.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        right
            .result
            .lexical_score
            .partial_cmp(&left.result.lexical_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .result
                    .score
                    .partial_cmp(&left.result.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut seeds = HashSet::<String>::new();
    for candidate in sorted {
        if seeds.len() >= max_seeds {
            break;
        }
        if candidate.result.lexical_score > 0.0 || seeds.is_empty() {
            seeds.insert(candidate.file_id.clone());
        }
    }
    seeds
}

fn compute_graph_proximity(
    file_id: &str,
    seed_file_ids: &HashSet<String>,
    neighbors: &HashMap<String, HashSet<String>>,
) -> Option<f32> {
    if seed_file_ids.is_empty() {
        return None;
    }

    if seed_file_ids.contains(file_id) {
        return Some(1.0);
    }

    if let Some(first_hop) = neighbors.get(file_id) {
        if first_hop.iter().any(|node| seed_file_ids.contains(node)) {
            return Some(0.66);
        }

        for node in first_hop {
            if let Some(second_hop) = neighbors.get(node) {
                if second_hop.iter().any(|next| seed_file_ids.contains(next)) {
                    return Some(0.33);
                }
            }
        }
    }

    Some(0.0)
}

fn update_scan<F>(state: &MigrationState, job_id: &str, updater: F) -> Result<(), String>
where
    F: FnOnce(&mut ScanProgress),
{
    let mut jobs = state.scan_jobs.lock().map_err(|e| e.to_string())?;
    let job = jobs
        .get_mut(job_id)
        .ok_or_else(|| "Scan job not found".to_string())?;
    updater(job);
    Ok(())
}

fn first_env(names: &[&str]) -> Option<String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn first_env_or_default(names: &[&str], default: &str) -> String {
    first_env(names).unwrap_or_else(|| default.to_string())
}

fn default_db_path() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("VOIDLINK_DB_PATH") {
        return Ok(PathBuf::from(raw));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".voidlink")
        .join("voidlink.sqlite3"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn canonicalize_repo_path(input: &str) -> Result<String, String> {
    let candidate = PathBuf::from(input);
    if !candidate.exists() {
        return Err(format!("Path does not exist: {input}"));
    }
    let canonical = fs::canonicalize(candidate).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Repository path must be a directory".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

fn should_ignore_app_path(path: &Path, root: &Path) -> bool {
    let relative = match path.strip_prefix(root) {
        Ok(value) => value,
        Err(_) => return true,
    };
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if APP_IGNORE_DIRS.iter().any(|item| item == &name) {
            return true;
        }
    }
    false
}

fn normalize_relative_path(input: &str) -> String {
    let normalized_input = input.replace('\\', "/");
    let mut parts = Vec::<String>::new();
    for part in normalized_input.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                if !parts.is_empty() {
                    parts.pop();
                }
            }
            _ => parts.push(part.to_string()),
        }
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn split_relative_path(input: &str) -> Vec<String> {
    let normalized = normalize_relative_path(input);
    if normalized == "." {
        Vec::new()
    } else {
        normalized.split('/').map(|part| part.to_string()).collect()
    }
}

fn parent_rel_path(path: &str) -> String {
    let normalized = normalize_relative_path(path);
    if normalized == "." {
        return ".".to_string();
    }
    let parent = Path::new(&normalized).parent().and_then(|value| value.to_str());
    match parent {
        Some(value) if !value.is_empty() => normalize_relative_path(value),
        _ => ".".to_string(),
    }
}

fn join_relative(base: &str, suffix: &str) -> String {
    if base == "." || base.is_empty() {
        normalize_relative_path(suffix)
    } else {
        normalize_relative_path(&format!("{base}/{suffix}"))
    }
}

fn detect_language(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "css" | "scss" => "css",
        "html" | "htm" => "html",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shell",
        _ => "text",
    }
    .to_string()
}

#[derive(Clone)]
struct ChunkRecord {
    start_line: usize,
    end_line: usize,
    text: String,
    token_estimate: usize,
}

fn chunk_content(content: &str, max_lines: usize, overlap: usize) -> Vec<ChunkRecord> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return vec![ChunkRecord {
            start_line: 1,
            end_line: 1,
            text: String::new(),
            token_estimate: 0,
        }];
    }

    let mut records = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + max_lines).min(lines.len());
        let text = lines[start..end].join("\n");
        records.push(ChunkRecord {
            start_line: start + 1,
            end_line: end,
            token_estimate: text.split_whitespace().count(),
            text,
        });
        if end == lines.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    records
}

fn tokenize(input: &str) -> Vec<String> {
    input
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter_map(|part| {
            let token = part.trim().to_ascii_lowercase();
            if token.len() > 1 {
                Some(token)
            } else {
                None
            }
        })
        .collect()
}

fn truncate_to_tokens(content: &str, max_tokens: usize) -> String {
    if max_tokens == 0 {
        return String::new();
    }
    let mut tokens = content.split_whitespace();
    let mut output = Vec::new();
    for _ in 0..max_tokens {
        if let Some(token) = tokens.next() {
            output.push(token);
        } else {
            break;
        }
    }
    output.join(" ")
}

fn truncate_plain(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars {
        return content.to_string();
    }
    let mut truncated = content.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn deterministic_embedding(content: &str, size: usize) -> Vec<f32> {
    let mut out = vec![0f32; size];
    for token in tokenize(content) {
        let mut hash = 0u64;
        for b in token.as_bytes() {
            hash = hash.wrapping_mul(31).wrapping_add(*b as u64);
        }
        let idx = (hash % size as u64) as usize;
        out[idx] += 1.0;
    }
    normalize(&mut out);
    out
}

fn normalize(values: &mut [f32]) {
    let magnitude = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if magnitude > 0.0 {
        for value in values.iter_mut() {
            *value /= magnitude;
        }
    }
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.is_empty() || right.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>().clamp(0.0, 1.0)
}

fn jaccard_similarity(left: &[String], right: &[String]) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let left_set: HashSet<&String> = left.iter().collect();
    let right_set: HashSet<&String> = right.iter().collect();
    let intersect = left_set.intersection(&right_set).count() as f32;
    let union = left_set.union(&right_set).count() as f32;
    if union <= 0.0 {
        0.0
    } else {
        (intersect / union).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn normalizes_relative_paths() {
        assert_eq!(normalize_relative_path("./src//app/../lib.rs"), "src/lib.rs");
        assert_eq!(normalize_relative_path("src\\nested\\mod.rs"), "src/nested/mod.rs");
        assert_eq!(normalize_relative_path("../.."), ".");
    }

    #[test]
    fn extracts_typescript_import_specs() {
        let content = r#"
            import { x } from "./utils";
            const mod = require("../shared/config");
            export * from "./feature/index";
        "#;
        let imports = extract_import_specs("typescript", content);
        assert!(imports.contains(&"./utils".to_string()));
        assert!(imports.contains(&"../shared/config".to_string()));
        assert!(imports.contains(&"./feature/index".to_string()));
    }

    #[test]
    fn computes_graph_proximity_scores() {
        let seeds = HashSet::from(["file:a".to_string()]);
        let mut graph = HashMap::<String, HashSet<String>>::new();
        graph.insert("file:b".to_string(), HashSet::from(["file:a".to_string()]));
        graph.insert("file:c".to_string(), HashSet::from(["dir:x".to_string()]));
        graph.insert("dir:x".to_string(), HashSet::from(["file:a".to_string()]));

        assert_eq!(
            compute_graph_proximity("file:a", &seeds, &graph),
            Some(1.0)
        );
        assert_eq!(
            compute_graph_proximity("file:b", &seeds, &graph),
            Some(0.66)
        );
        assert_eq!(
            compute_graph_proximity("file:c", &seeds, &graph),
            Some(0.33)
        );
    }
}
