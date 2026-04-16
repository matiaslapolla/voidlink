//! `PrDraftCard` — rendered inside a chat tab once its task is terminal and
//! the user either has a PR draft to review or an already-opened PR URL.
//!
//! Three states, per 7E plan §5:
//!   1. **No PR yet** (auto_pr=false and no draft yet): a "Propose PR" button
//!      that dispatches `AgentAction::ProposePr`.
//!   2. **Draft available** (we have a `PrDescription`, no url): title/body/
//!      labels rendered read-only plus "Submit as draft PR" button.
//!   3. **PR already open** (pr_url set): branch chip, URL hyperlink, "Open
//!      in browser" button, plus the draft title/labels if present.

use eframe::egui;
use eframe::epaint::CornerRadius;

use super::super::AgentCtx;
use crate::state::agents::{AgentAction, ChatTabState};

pub fn show(ui: &mut egui::Ui, chat: &ChatTabState, ctx: &mut AgentCtx) {
    let p = ctx.palette;

    if !chat.is_terminal() {
        return;
    }
    // Only show when there's *something* meaningful: a live URL, a draft, or
    // a task the user deliberately ran with auto_pr=false.
    let auto_pr_was_off = chat
        .pr_context
        .as_ref()
        .map(|c| !c.auto_pr)
        .unwrap_or(false);
    let has_url = chat.pr_url.is_some();
    let has_draft = chat.pr_draft.is_some();
    if !has_url && !has_draft && !auto_pr_was_off {
        return;
    }

    egui::Frame::NONE
        .fill(p.surface_elevated)
        .stroke(egui::Stroke::new(1.0, p.border))
        .corner_radius(CornerRadius::same(8))
        .inner_margin(egui::Margin::symmetric(14, 10))
        .show(ui, |ui| {
            ui.vertical(|ui| {
                header_row(ui, chat, p);
                ui.add_space(6.0);

                if let Some(url) = chat.pr_url.as_deref() {
                    ui.label(
                        egui::RichText::new("Pull request open")
                            .size(11.5)
                            .color(p.success)
                            .strong(),
                    );
                    ui.add_space(4.0);
                    ui.hyperlink_to(
                        egui::RichText::new(url)
                            .size(11.5)
                            .family(egui::FontFamily::Monospace)
                            .color(p.primary),
                        url,
                    );
                    ui.add_space(6.0);
                    if let Some(draft) = chat.pr_draft.as_ref() {
                        labels_row(ui, &draft.labels, p);
                        ui.add_space(4.0);
                        title_row(ui, &draft.title, p);
                    }
                } else if let Some(draft) = chat.pr_draft.as_ref() {
                    title_row(ui, &draft.title, p);
                    ui.add_space(4.0);
                    labels_row(ui, &draft.labels, p);
                    ui.add_space(6.0);
                    body_preview(ui, &draft.body, p);
                    ui.add_space(8.0);
                    if let Some(err) = chat.pr_error.as_deref() {
                        ui.label(
                            egui::RichText::new(err)
                                .size(11.0)
                                .color(p.error),
                        );
                        ui.add_space(4.0);
                    }
                    submit_button(ui, chat, ctx);
                } else {
                    ui.label(
                        egui::RichText::new(
                            "This task ran with auto-PR disabled. Click below to draft a PR.",
                        )
                        .size(11.5)
                        .color(p.text_secondary),
                    );
                    ui.add_space(6.0);
                    if let Some(err) = chat.pr_error.as_deref() {
                        ui.label(
                            egui::RichText::new(err)
                                .size(11.0)
                                .color(p.error),
                        );
                        ui.add_space(4.0);
                    }
                    propose_button(ui, chat, ctx);
                }
            });
        });
    ui.add_space(6.0);
}

fn header_row(ui: &mut egui::Ui, chat: &ChatTabState, p: crate::theme::ThemePalette) {
    ui.horizontal(|ui| {
        ui.label(
            egui::RichText::new("\u{1F4E6} Pull Request")
                .size(12.5)
                .strong()
                .color(p.text),
        );
        ui.add_space(8.0);
        if let Some(branch) = chat.branch_name.as_deref() {
            egui::Frame::NONE
                .fill(p.surface)
                .corner_radius(CornerRadius::same(4))
                .inner_margin(egui::Margin::symmetric(6, 2))
                .show(ui, |ui| {
                    ui.label(
                        egui::RichText::new(format!("\u{2442} {}", branch))
                            .size(10.5)
                            .family(egui::FontFamily::Monospace)
                            .color(p.text_secondary),
                    );
                });
        }
    });
}

fn title_row(ui: &mut egui::Ui, title: &str, p: crate::theme::ThemePalette) {
    ui.label(
        egui::RichText::new(title)
            .size(12.5)
            .strong()
            .color(p.text),
    );
}

fn labels_row(ui: &mut egui::Ui, labels: &[String], p: crate::theme::ThemePalette) {
    if labels.is_empty() {
        return;
    }
    ui.horizontal_wrapped(|ui| {
        for label in labels {
            egui::Frame::NONE
                .fill(p.surface)
                .stroke(egui::Stroke::new(1.0, p.border))
                .corner_radius(CornerRadius::same(6))
                .inner_margin(egui::Margin::symmetric(6, 2))
                .show(ui, |ui| {
                    ui.label(
                        egui::RichText::new(label)
                            .size(10.0)
                            .color(p.text_secondary),
                    );
                });
            ui.add_space(4.0);
        }
    });
}

fn body_preview(ui: &mut egui::Ui, body: &str, p: crate::theme::ThemePalette) {
    let preview_lines: Vec<&str> = body.lines().take(12).collect();
    let preview = preview_lines.join("\n");
    egui::Frame::NONE
        .fill(p.editor_bg)
        .corner_radius(CornerRadius::same(4))
        .inner_margin(egui::Margin::symmetric(8, 6))
        .show(ui, |ui| {
            ui.label(
                egui::RichText::new(preview)
                    .size(11.0)
                    .family(egui::FontFamily::Monospace)
                    .color(p.text_secondary),
            );
        });
}

fn propose_button(ui: &mut egui::Ui, chat: &ChatTabState, ctx: &mut AgentCtx) {
    let p = ctx.palette;
    let busy = chat.pr_action_in_flight;
    let enabled = !busy && chat.pr_context.is_some() && ctx.migration.is_some();
    let label = if busy {
        "Proposing…"
    } else {
        "Propose PR"
    };
    ui.horizontal(|ui| {
        let resp = ui.add_enabled(
            enabled,
            egui::Button::new(
                egui::RichText::new(label)
                    .size(11.5)
                    .color(p.primary_text),
            )
            .fill(p.primary)
            .corner_radius(CornerRadius::same(5)),
        );
        if resp.clicked() {
            if let (Some(pctx), Some(migration)) = (chat.pr_context.as_ref(), ctx.migration.as_ref())
            {
                let _ = ctx.action_tx.send(AgentAction::ProposePr {
                    task_id: chat.task_id.clone(),
                    repo_path: pctx.repo_path.clone(),
                    objective: pctx.objective.clone(),
                    constraints: pctx.constraints.clone(),
                    branch_name: chat.branch_name.clone(),
                    base_branch: pctx.base_branch.clone(),
                    migration: migration.clone(),
                });
            }
        }
        if ctx.migration.is_none() {
            ui.label(
                egui::RichText::new("Configure an LLM provider to propose a PR.")
                    .size(10.5)
                    .color(p.text_muted),
            );
        }
    });
}

fn submit_button(ui: &mut egui::Ui, chat: &ChatTabState, ctx: &mut AgentCtx) {
    let p = ctx.palette;
    let busy = chat.pr_action_in_flight;
    let enabled = !busy
        && chat.branch_name.is_some()
        && chat.pr_context.is_some()
        && chat.pr_draft.is_some();
    ui.horizontal(|ui| {
        let resp = ui.add_enabled(
            enabled,
            egui::Button::new(
                egui::RichText::new(if busy { "Submitting…" } else { "Submit as draft PR" })
                    .size(11.5)
                    .color(p.primary_text),
            )
            .fill(p.primary)
            .corner_radius(CornerRadius::same(5)),
        );
        if resp.clicked() {
            if let (Some(pctx), Some(draft), Some(head)) = (
                chat.pr_context.as_ref(),
                chat.pr_draft.as_ref(),
                chat.branch_name.as_deref(),
            ) {
                let _ = ctx.action_tx.send(AgentAction::CreatePr {
                    task_id: chat.task_id.clone(),
                    repo_path: pctx.repo_path.clone(),
                    head_branch: head.to_string(),
                    base_branch: pctx.base_branch.clone(),
                    description: draft.clone(),
                });
            }
        }
    });
}
