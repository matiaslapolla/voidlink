use std::fs;
use std::path::Path;
use uuid::Uuid;

use super::search::perform_search;
use super::{MigrationState, RunWorkflowInput, SearchOptions, SearchQuery, WorkflowDsl};

pub fn resolve_workflow_for_run(
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

pub fn execute_run(
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
                        std::thread::sleep(std::time::Duration::from_millis(
                            step.retry_policy.backoff_ms,
                        ));
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
    step: &super::WorkflowStep,
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
            let summary = state.get_provider().structured_generate(&format!(
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
                state.get_provider().generate(&format!(
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
