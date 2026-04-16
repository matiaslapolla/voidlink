pub mod db;

use db::PromptStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

use crate::migration::MigrationState;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVariable {
    pub id: String,
    pub name: String,
    pub var_type: String,
    pub default_value: String,
    pub description: String,
    pub required: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_favorite: bool,
    pub updated_at: i64,
    pub version_count: i32,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFull {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub system_prompt: String,
    pub model_override: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub is_favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub variables: Vec<PromptVariable>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVariableInput {
    pub name: String,
    pub var_type: Option<String>,
    pub default_value: Option<String>,
    pub description: Option<String>,
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePromptInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub content: Option<String>,
    pub system_prompt: Option<String>,
    pub model_override: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub variables: Option<Vec<SaveVariableInput>>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersion {
    pub id: String,
    pub version: i32,
    pub content: String,
    pub system_prompt: String,
    pub variables_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptExecution {
    pub id: String,
    pub prompt_id: String,
    pub rendered_prompt: String,
    pub system_prompt: String,
    pub variables_json: String,
    pub model: String,
    pub provider: String,
    pub output: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub duration_ms: i64,
    pub rating: Option<i32>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutePromptInput {
    pub prompt_id: String,
    pub variables: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeResult {
    pub original: String,
    pub optimized: String,
    pub improvements: Vec<String>,
    pub clarity_score_before: i32,
    pub clarity_score_after: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAnalysis {
    pub token_count: i32,
    pub clarity_score: i32,
    pub structure_score: i32,
    pub suggestions: Vec<String>,
    pub detected_variables: Vec<String>,
    pub risk_flags: Vec<String>,
}

// ─── State ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct PromptStudioState {
    pub db: PromptStore,
}

impl PromptStudioState {
    pub fn new() -> Result<Self, String> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let db_path = std::path::PathBuf::from(home)
            .join(".voidlink")
            .join("prompt_studio.db");
        let db = PromptStore::new(db_path)?;
        Ok(Self { db })
    }
}

// ─── Template rendering ─────────────────────────────────────────────────────

pub fn render_template(content: &str, variables: &HashMap<String, String>) -> String {
    let mut result = content.to_string();
    for (name, value) in variables {
        let pattern = format!("{{{{{}}}}}", name);
        result = result.replace(&pattern, value);
        let prefix = format!("{{{{{name}:");
        while let Some(start) = result.find(&prefix) {
            if let Some(end) = result[start..].find("}}") {
                let full = &result[start..start + end + 2];
                result = result.replace(full, value);
            } else {
                break;
            }
        }
    }
    let mut output = String::with_capacity(result.len());
    let mut rest = result.as_str();
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("}}") {
            let inner = &rest[..end];
            if let Some(colon) = inner.find(':') {
                let default = &inner[colon + 1..];
                output.push_str(default);
            } else {
                output.push_str("{{");
                output.push_str(inner);
                output.push_str("}}");
            }
            rest = &rest[end + 2..];
        } else {
            output.push_str("{{");
        }
    }
    output.push_str(rest);
    output
}

pub fn extract_variables(content: &str) -> Vec<String> {
    let mut vars = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("{{") {
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("}}") {
            let inner = &rest[..end];
            let name = if let Some(colon) = inner.find(':') {
                &inner[..colon]
            } else {
                inner
            };
            let name = name.trim();
            if !name.is_empty() && !vars.contains(&name.to_string()) {
                vars.push(name.to_string());
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    vars
}

pub fn estimate_tokens(text: &str) -> i32 {
    (text.len() as f64 / 4.0).ceil() as i32
}

// ─── Public API ─────────────────────────────────────────────────────────────

pub fn prompt_list(state: &PromptStudioState) -> Result<Vec<PromptSummary>, String> {
    state.db.list_prompts()
}

pub fn prompt_get(state: &PromptStudioState, id: &str) -> Result<PromptFull, String> {
    state.db.get_prompt(id)
}

pub fn prompt_save(state: &PromptStudioState, input: &SavePromptInput) -> Result<PromptFull, String> {
    state.db.save_prompt(input)
}

pub fn prompt_delete(state: &PromptStudioState, id: &str) -> Result<(), String> {
    state.db.delete_prompt(id)
}

pub fn prompt_toggle_favorite(state: &PromptStudioState, id: &str) -> Result<bool, String> {
    state.db.toggle_favorite(id)
}

pub fn prompt_list_tags(state: &PromptStudioState) -> Result<Vec<PromptTag>, String> {
    state.db.list_tags()
}

pub fn prompt_get_versions(state: &PromptStudioState, prompt_id: &str) -> Result<Vec<PromptVersion>, String> {
    state.db.get_versions(prompt_id)
}

pub fn prompt_get_executions(
    state: &PromptStudioState,
    prompt_id: &str,
    limit: Option<usize>,
) -> Result<Vec<PromptExecution>, String> {
    state.db.get_executions(prompt_id, limit)
}

pub fn prompt_rate_execution(
    state: &PromptStudioState,
    execution_id: &str,
    rating: i32,
) -> Result<(), String> {
    state.db.rate_execution(execution_id, rating)
}

pub fn prompt_execute(
    state: &PromptStudioState,
    migration_state: &MigrationState,
    input: &ExecutePromptInput,
) -> Result<PromptExecution, String> {
    let prompt = state.db.get_prompt(&input.prompt_id)?;
    let rendered = render_template(&prompt.content, &input.variables);
    let system = if prompt.system_prompt.is_empty() {
        "You are a helpful assistant.".to_string()
    } else {
        render_template(&prompt.system_prompt, &input.variables)
    };

    let provider = migration_state.get_provider();
    let start = std::time::Instant::now();

    let full_prompt = if system.is_empty() {
        rendered.clone()
    } else {
        format!("System: {system}\n\nUser: {rendered}")
    };
    let output = provider.generate(&full_prompt);
    let duration_ms = start.elapsed().as_millis() as i64;

    let exec = PromptExecution {
        id: Uuid::new_v4().to_string(),
        prompt_id: input.prompt_id.clone(),
        rendered_prompt: rendered,
        system_prompt: system,
        variables_json: serde_json::to_string(&input.variables)
            .unwrap_or_else(|_| "{}".to_string()),
        model: "configured".to_string(),
        provider: "configured".to_string(),
        output,
        input_tokens: Some(estimate_tokens(&full_prompt) as i64),
        output_tokens: None,
        duration_ms,
        rating: None,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
    };

    state.db.save_execution(&exec)?;
    Ok(exec)
}

pub fn prompt_analyze(
    migration_state: &MigrationState,
    content: &str,
    system_prompt: Option<&str>,
) -> Result<PromptAnalysis, String> {
    let detected_variables = extract_variables(content);
    let full_text = format!(
        "{}{}",
        system_prompt.unwrap_or(""),
        content
    );
    let token_count = estimate_tokens(&full_text);

    let analysis_prompt = format!(
        r#"Analyze this prompt template for quality. Return ONLY valid JSON:
{{
  "clarityScore": <0-100>,
  "structureScore": <0-100>,
  "suggestions": ["suggestion1", "suggestion2"],
  "riskFlags": ["flag1"]
}}

System prompt: {}
User prompt: {}"#,
        system_prompt.unwrap_or("(none)"),
        content
    );

    let provider = migration_state.get_provider();
    match provider.chat_completion(&analysis_prompt, true) {
        Ok(response) => {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&response) {
                Ok(PromptAnalysis {
                    token_count,
                    clarity_score: parsed
                        .get("clarityScore")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(50) as i32,
                    structure_score: parsed
                        .get("structureScore")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(50) as i32,
                    suggestions: parsed
                        .get("suggestions")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                    detected_variables,
                    risk_flags: parsed
                        .get("riskFlags")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            } else {
                Ok(PromptAnalysis {
                    token_count,
                    clarity_score: 50,
                    structure_score: 50,
                    suggestions: vec![],
                    detected_variables,
                    risk_flags: vec![],
                })
            }
        }
        Err(_) => Ok(PromptAnalysis {
            token_count,
            clarity_score: 50,
            structure_score: 50,
            suggestions: vec!["LLM unavailable for analysis".to_string()],
            detected_variables,
            risk_flags: vec![],
        }),
    }
}

pub fn prompt_optimize(
    migration_state: &MigrationState,
    content: &str,
    system_prompt: Option<&str>,
) -> Result<OptimizeResult, String> {
    let optimize_prompt = format!(
        r#"You are a prompt engineering expert. Optimize the following prompt for clarity, specificity, and effectiveness.

Return ONLY valid JSON:
{{
  "optimized": "<the improved prompt>",
  "improvements": ["improvement1", "improvement2"],
  "clarityScoreBefore": <0-100>,
  "clarityScoreAfter": <0-100>
}}

System prompt: {}
User prompt to optimize:
{}"#,
        system_prompt.unwrap_or("(none)"),
        content
    );

    let provider = migration_state.get_provider();
    let response = provider.chat_completion(&optimize_prompt, true)?;
    let parsed: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| e.to_string())?;

    Ok(OptimizeResult {
        original: content.to_string(),
        optimized: parsed
            .get("optimized")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        improvements: parsed
            .get("improvements")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        clarity_score_before: parsed
            .get("clarityScoreBefore")
            .and_then(|v| v.as_i64())
            .unwrap_or(50) as i32,
        clarity_score_after: parsed
            .get("clarityScoreAfter")
            .and_then(|v| v.as_i64())
            .unwrap_or(70) as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_simple_variables() {
        let mut vars = HashMap::new();
        vars.insert("name".to_string(), "Alice".to_string());
        vars.insert("lang".to_string(), "Rust".to_string());
        let result = render_template("Hello {{name}}, write {{lang}} code", &vars);
        assert_eq!(result, "Hello Alice, write Rust code");
    }

    #[test]
    fn renders_default_values() {
        let vars = HashMap::new();
        let result = render_template("Use {{lang:Python}} for this", &vars);
        assert_eq!(result, "Use Python for this");
    }

    #[test]
    fn extracts_variable_names() {
        let vars = extract_variables("Hello {{name}}, use {{lang:Python}} and {{framework}}");
        assert_eq!(vars, vec!["name", "lang", "framework"]);
    }
}
