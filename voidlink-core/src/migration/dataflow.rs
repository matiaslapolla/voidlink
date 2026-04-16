use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::db::SqliteStore;
use super::path_utils::canonicalize_repo_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFlowStep {
    pub file_path: String,
    pub description: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPipeline {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps: Vec<DataFlowStep>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFlowAnalysisResult {
    pub pipelines: Vec<DataPipeline>,
    pub summary: String,
}

pub fn analyze_data_flows(
    db: &SqliteStore,
    repo_path: &str,
    llm_chat: &dyn Fn(&str, bool) -> Result<String, String>,
) -> Result<DataFlowAnalysisResult, String> {
    let canonical = canonicalize_repo_path(repo_path)?;
    let conn = db.open()?;

    let repo_id: String = conn
        .query_row(
            "SELECT id FROM repos WHERE root_path = ?1",
            params![canonical],
            |row| row.get(0),
        )
        .map_err(|_| format!("Repository not found: {canonical}"))?;

    // Load files with import edges to understand connectivity
    let mut file_paths: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT path FROM files WHERE repo_id = ?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            file_paths.push(row.get::<_, String>(0).map_err(|e| e.to_string())?);
        }
    }

    // Load import edges
    let mut imports: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.source_id, e.target_id, e.metadata_json
                 FROM edges e
                 INNER JOIN files sf ON sf.id = e.source_id
                 WHERE e.repo_id = ?1 AND e.edge_type = 'import'",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let source_id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
            let target_id = row.get::<_, String>(1).map_err(|e| e.to_string())?;
            imports.push((source_id, target_id));
        }
    }

    // Build file id→path map
    let mut id_to_path: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, path FROM files WHERE repo_id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
            let path = row.get::<_, String>(1).map_err(|e| e.to_string())?;
            id_to_path.insert(id, path);
        }
    }

    // Build import relationships as file paths
    let mut import_lines = Vec::new();
    for (src_id, tgt_id) in &imports {
        let src_path = id_to_path.get(src_id);
        let tgt_path = id_to_path.get(tgt_id);
        if let (Some(s), Some(t)) = (src_path, tgt_path) {
            import_lines.push(format!("{s} -> {t}"));
        }
    }

    if file_paths.is_empty() {
        return Ok(DataFlowAnalysisResult {
            pipelines: vec![],
            summary: "No files found in repository.".to_string(),
        });
    }

    // Truncate for context window limits
    let file_list = file_paths.iter().take(200).cloned().collect::<Vec<_>>().join("\n");
    let import_list = import_lines.iter().take(300).cloned().collect::<Vec<_>>().join("\n");

    let prompt = format!(
        r#"Analyze the following repository structure and import relationships to identify data flows and pipelines.

A data pipeline is a sequence of files/modules that data passes through, e.g.:
- API route -> service -> database model
- Event listener -> handler -> notification service
- CLI command -> parser -> processor -> output

For each pipeline, identify the role of each file: "source" (where data enters), "transform" (where data is processed), "sink" (where data is stored/output), or "middleware" (cross-cutting concerns).

Return ONLY valid JSON with this structure:
{{
  "pipelines": [
    {{
      "id": "pipeline_1",
      "name": "User Registration Flow",
      "description": "Handles user signup from API to database",
      "steps": [
        {{ "filePath": "src/routes/auth.ts", "description": "Receives signup request", "role": "source" }},
        {{ "filePath": "src/services/auth.ts", "description": "Validates and hashes password", "role": "transform" }},
        {{ "filePath": "src/models/user.ts", "description": "Persists user to database", "role": "sink" }}
      ],
      "confidence": 0.85
    }}
  ],
  "summary": "Found 3 main data flows..."
}}

File paths:
{file_list}

Import relationships (source -> target):
{import_list}"#
    );

    let response = llm_chat(&prompt, true)?;

    let result: DataFlowAnalysisResult = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse LLM response: {e}"))?;

    Ok(result)
}
