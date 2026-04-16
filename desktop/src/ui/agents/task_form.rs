//! `TaskCreateForm` — renders while `ChatTabState.form` is `Some`.
//!
//! Collects objective, constraints (one per line), optional branch override,
//! optional base ref, optional GitHub base branch, and auto-PR toggle, then
//! dispatches `AgentAction::StartTask`.

use eframe::egui;
use eframe::epaint::CornerRadius;

use super::AgentCtx;
use crate::state::agents::{AgentAction, ChatTabState};

/// Outcome indicates whether the form fired a `StartTask`.
pub enum FormOutcome {
    Idle,
    Started,
}

pub fn show(ui: &mut egui::Ui, chat: &mut ChatTabState, ctx: &mut AgentCtx) -> FormOutcome {
    let p = ctx.palette;

    if chat.form.is_none() {
        return FormOutcome::Idle;
    }

    // Render the form against `&mut chat.form` and capture a "start was
    // clicked" flag. Dispatching the actual StartTask happens *after* we drop
    // the borrow so we can mutate other `chat` fields freely.
    let mut start_requested = false;

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.set_max_width(640.0);
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("New autonomous task")
                    .size(15.0)
                    .color(p.text)
                    .strong(),
            );
            ui.label(
                egui::RichText::new(
                    "Describe what the agent should do. It will create a worktree, \
                     generate changes, commit, push, and optionally open a PR.",
                )
                .size(11.5)
                .color(p.text_muted),
            );
            ui.add_space(10.0);

            let form = chat.form.as_mut().expect("form presence checked above");

            field_label(ui, "Objective", true, p);
            ui.add(
                egui::TextEdit::multiline(&mut form.objective)
                    .hint_text("e.g. Add a /health endpoint that returns {status: \"ok\"}")
                    .desired_rows(3)
                    .desired_width(f32::INFINITY),
            );

            ui.add_space(8.0);
            field_label(ui, "Constraints (one per line, optional)", false, p);
            ui.add(
                egui::TextEdit::multiline(&mut form.constraints_text)
                    .hint_text("Do not touch package.json\nKeep existing routes")
                    .desired_rows(3)
                    .desired_width(f32::INFINITY),
            );

            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    field_label(ui, "Branch name (auto-generated if empty)", false, p);
                    ui.add(
                        egui::TextEdit::singleline(&mut form.branch_name)
                            .hint_text("ai/my-feature")
                            .desired_width(260.0),
                    );
                });
                ui.add_space(12.0);
                ui.vertical(|ui| {
                    field_label(ui, "Base ref", false, p);
                    ui.add(
                        egui::TextEdit::singleline(&mut form.base_ref)
                            .hint_text("HEAD")
                            .desired_width(140.0),
                    );
                });
            });

            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.checkbox(&mut form.auto_pr, "Auto-create draft PR");
                ui.add_space(12.0);
                ui.label(egui::RichText::new("GitHub base branch:").size(12.0).color(p.text_muted));
                ui.add(
                    egui::TextEdit::singleline(&mut form.github_base_branch)
                        .desired_width(100.0),
                );
            });

            if let Some(err) = form.error.as_deref() {
                ui.add_space(8.0);
                egui::Frame::NONE
                    .fill(with_alpha(p.error, 30))
                    .stroke(egui::Stroke::new(1.0, with_alpha(p.error, 140)))
                    .corner_radius(CornerRadius::same(6))
                    .inner_margin(egui::Margin::symmetric(10, 6))
                    .show(ui, |ui| {
                        ui.label(egui::RichText::new(err).size(11.5).color(p.error));
                    });
            }

            ui.add_space(12.0);
            ui.horizontal(|ui| {
                let can_start = !form.objective.trim().is_empty();
                let btn = ui.add_enabled(
                    can_start,
                    egui::Button::new(
                        egui::RichText::new("\u{25B6} Start task")
                            .size(12.5)
                            .color(p.primary_text)
                            .strong(),
                    )
                    .fill(p.primary)
                    .corner_radius(CornerRadius::same(6))
                    .min_size(egui::vec2(120.0, 30.0)),
                );
                if btn.clicked() && can_start {
                    start_requested = true;
                }

                ui.add_space(12.0);
                ui.label(
                    egui::RichText::new("Uses your configured LLM provider (settings › BYOK).")
                        .size(11.0)
                        .color(p.text_muted),
                );
            });

            ui.add_space(20.0);
        });

    if start_requested {
        if let Some(err) = try_start(chat, ctx) {
            if let Some(f) = chat.form.as_mut() {
                f.error = Some(err);
            }
        } else {
            return FormOutcome::Started;
        }
    }
    FormOutcome::Idle
}

/// Attempt to dispatch `StartTask`. Returns `Some(err)` on validation / env
/// errors; caller stores the error on the form.
fn try_start(chat: &mut ChatTabState, ctx: &mut AgentCtx) -> Option<String> {
    let repo_path = ctx.repo_path.unwrap_or("");
    let input = match chat.form.as_ref()?.build(repo_path) {
        Ok(v) => v,
        Err(e) => return Some(e),
    };
    let migration = match ctx.migration.clone() {
        Some(m) => m,
        None => {
            return Some(
                "No LLM provider configured. Open Settings › BYOK and add an API key."
                    .to_string(),
            );
        }
    };

    let task_id = chat.task_id.clone();
    let initial = voidlink_core::git_agent::AgentTaskState {
        task_id: task_id.clone(),
        status: "pending".to_string(),
        branch_name: input.branch_name.clone(),
        worktree_path: None,
        pr_url: None,
        steps_completed: Vec::new(),
        current_step: None,
        events: Vec::new(),
        error: None,
    };
    if let Ok(mut guard) = ctx.tasks_store.lock() {
        guard.insert(task_id.clone(), initial);
    }

    let emitter: std::sync::Arc<dyn voidlink_core::events::EventEmitter> = (ctx.make_emitter)();
    let action = AgentAction::StartTask {
        task_id: task_id.clone(),
        input: input.clone(),
        tasks_store: ctx.tasks_store.clone(),
        migration,
        emitter,
    };
    if ctx.action_tx.send(action).is_err() {
        return Some("Agent dispatcher is not running.".to_string());
    }

    chat.push_message(crate::state::agents::ChatMessage {
        id: format!("user-start-{}", task_id),
        role: crate::state::agents::MessageRole::User,
        content: input.objective.clone(),
        timestamp_ms: now_ms(),
        status: crate::state::agents::MessageStatus::None,
    });
    chat.status = "pending".to_string();
    chat.branch_name = input.branch_name.clone();
    // Cache the inputs we need to re-propose a PR later if auto_pr=false.
    chat.pr_context = Some(crate::state::agents::PrContext {
        repo_path: input.repo_path.clone(),
        objective: input.objective.clone(),
        constraints: input.constraints.clone(),
        base_branch: input
            .github_base_branch
            .clone()
            .unwrap_or_else(|| "main".to_string()),
        auto_pr: input.auto_pr,
    });
    let snippet: String = input.objective.chars().take(40).collect();
    let trimmed = snippet.trim().to_string();
    chat.label = if trimmed.is_empty() {
        "New task".to_string()
    } else {
        trimmed
    };
    chat.form = None;
    None
}

fn field_label(ui: &mut egui::Ui, text: &str, required: bool, p: crate::theme::ThemePalette) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(text).size(11.5).color(p.text_secondary));
        if required {
            ui.label(egui::RichText::new("*").size(11.5).color(p.error));
        }
    });
}

fn with_alpha(c: egui::Color32, a: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
