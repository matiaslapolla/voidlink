pub(crate) mod chunks;
pub(crate) mod db;
pub(crate) mod graph;
pub(crate) mod path_utils;
pub(crate) mod provider;
pub(crate) mod scan;
pub(crate) mod search;
pub(crate) mod workflow;

use db::SqliteStore;
use path_utils::{canonicalize_repo_path, default_db_path, now_ms};
use provider::ProviderAdapter;
use scan::execute_scan_job;
use search::perform_search;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;
use workflow::{execute_run, resolve_workflow_for_run};

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
    pub(crate) db: SqliteStore,
    pub(crate) scan_jobs: Arc<Mutex<HashMap<String, ScanProgress>>>,
    pub(crate) run_cache: Arc<Mutex<HashMap<String, RunState>>>,
    pub(crate) provider: Arc<Mutex<Arc<ProviderAdapter>>>,
    pub startup_repo_path: Option<String>,
}

impl MigrationState {
    pub fn new(startup_repo_path: Option<String>) -> Result<Self, String> {
        let db_path = default_db_path()?;
        let db = SqliteStore::new(db_path)?;
        Ok(Self {
            db,
            scan_jobs: Arc::new(Mutex::new(HashMap::new())),
            run_cache: Arc::new(Mutex::new(HashMap::new())),
            provider: Arc::new(Mutex::new(Arc::new(ProviderAdapter::new()))),
            startup_repo_path,
        })
    }

    /// Returns a snapshot of the current provider adapter.
    pub(crate) fn get_provider(&self) -> Arc<ProviderAdapter> {
        self.provider
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| Arc::new(ProviderAdapter::new()))
    }

    pub fn llm_chat(&self, prompt: &str, json_mode: bool) -> Result<String, String> {
        self.get_provider().chat_completion(prompt, json_mode)
    }

    pub fn db_path(&self) -> std::path::PathBuf {
        self.db.path.clone()
    }
}

pub fn reload_provider(state: tauri::State<'_, MigrationState>) -> Result<(), String> {
    let new_provider = Arc::new(ProviderAdapter::new());
    *state.provider.lock().map_err(|e| e.to_string())? = new_provider;
    Ok(())
}

pub(crate) fn update_scan<F>(state: &MigrationState, job_id: &str, updater: F) -> Result<(), String>
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
    std::thread::spawn(move || {
        if let Err(err) = execute_scan_job(&shared, &spawned_job, &canonical, &options) {
            let _ = update_scan(&shared, &spawned_job, |job| {
                job.status = "failed".to_string();
                job.finished_at = Some(now_ms());
                job.error = Some(err.clone());
            });
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

    let repo_path = input
        .repo_path
        .as_deref()
        .map(canonicalize_repo_path)
        .transpose()?;
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
            expected_output: "Artifact saved for review with explicit acceptance checks"
                .to_string(),
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
    std::thread::spawn(move || {
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

#[cfg(test)]
mod migration_tests {
    use super::path_utils::*;
    use super::graph::extract_import_specs;
    use super::search::compute_graph_proximity;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn normalizes_relative_paths() {
        assert_eq!(normalize_relative_path("./src//app/../lib.rs"), "src/lib.rs");
        assert_eq!(
            normalize_relative_path("src\\nested\\mod.rs"),
            "src/nested/mod.rs"
        );
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
