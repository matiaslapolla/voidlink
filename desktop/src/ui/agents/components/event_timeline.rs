//! `EventTimeline` + `StepProgress` — the core 7E chat replacements for the
//! flat message list.
//!
//! `show_step_progress` renders six pips (branch → worktree → implement →
//! commit → push → pr). Each pip is filled/outlined/accented based on whether
//! it appears in the task's `steps_completed` array or matches the chat's
//! `current_step`.
//!
//! `show_timeline` groups the chat's `messages` by canonical step (see
//! `ChatTabState::group_messages_by_step`) and renders each group as a
//! `CollapsingHeader` containing one row per event with a coloured left
//! gutter derived from the event level.

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::agents::{
    classify_completed, ChatMessage, ChatTabState, MessageStatus, PIPELINE_STEPS,
};
use crate::state::agents_parse::parse_event;
use crate::theme::ThemePalette;
use crate::ui::agents::components::{agent_message::agent_message, chat_timeline_row::chat_timeline_row};

// ─── StepProgress ────────────────────────────────────────────────────────────

/// Horizontal row of pipeline-step pips. Renders a small caption under the
/// currently-active pip (if any).
pub fn show_step_progress(ui: &mut egui::Ui, chat: &ChatTabState, palette: &ThemePalette) {
    let task = {
        // Prefer the chat's mirrored view but also consult the shared task
        // store so `steps_completed` is fresh (the chat doesn't mirror that
        // array today). If either is unavailable we fall back to whatever the
        // chat has.
        None::<voidlink_core::git_agent::AgentTaskState>
    };
    let _ = task; // placeholder: we only use chat.current_step for the active

    // Canonical step ids present in the task's `steps_completed` array. Since
    // `ChatTabState` doesn't mirror that vector directly today, we reconstruct
    // it heuristically from chat message content: if a "Step: <x>" message
    // exists and the next "Step:" message is *different*, then `<x>` is
    // completed. Plus a few explicit markers.
    let completed = completed_steps_from_messages(chat);
    let current_canon = chat
        .current_step
        .as_deref()
        .and_then(crate::state::agents::classify_step);

    let pip_radius: f32 = 7.0;
    let pip_gap: f32 = 12.0;
    let row_height: f32 = 26.0;
    let count = PIPELINE_STEPS.len() as f32;

    egui::Frame::NONE
        .fill(palette.background)
        .inner_margin(egui::Margin::symmetric(12, 6))
        .show(ui, |ui| {
            let avail = ui.available_width().max(260.0);
            let total_w = avail.min(540.0);
            let (rect, _) = ui.allocate_exact_size(
                egui::vec2(total_w, row_height),
                egui::Sense::hover(),
            );
            let painter = ui.painter_at(rect);

            let left = rect.left() + pip_radius;
            let right = rect.right() - pip_radius;
            let span = (right - left).max(1.0);
            let stride = if count > 1.0 { span / (count - 1.0) } else { 0.0 };
            let center_y = rect.center().y;

            // Connecting line between consecutive pips (single flat segment,
            // coloured by `palette.border`).
            if stride > pip_gap {
                painter.line_segment(
                    [
                        egui::pos2(left + pip_radius, center_y),
                        egui::pos2(right - pip_radius, center_y),
                    ],
                    egui::Stroke::new(1.0, palette.border),
                );
            }

            for (i, (id, _label)) in PIPELINE_STEPS.iter().enumerate() {
                let cx = left + stride * i as f32;
                let center = egui::pos2(cx, center_y);
                let is_completed = completed.contains(id);
                let is_current = current_canon == Some(*id);

                // Fill / outline rule.
                if is_completed {
                    painter.circle_filled(center, pip_radius, palette.success);
                } else if is_current {
                    painter.circle_filled(center, pip_radius, palette.primary);
                    painter.circle_stroke(
                        center,
                        pip_radius + 2.0,
                        egui::Stroke::new(1.0, palette.primary),
                    );
                } else {
                    painter.circle_filled(center, pip_radius, palette.surface);
                    painter.circle_stroke(
                        center,
                        pip_radius,
                        egui::Stroke::new(1.0, palette.border),
                    );
                }
            }

            // Caption under the active pip (below the row).
            if let Some(current_id) = current_canon {
                if let Some(active_idx) = PIPELINE_STEPS.iter().position(|(id, _)| *id == current_id) {
                    let label = PIPELINE_STEPS[active_idx].1;
                    let cx = left + stride * active_idx as f32;
                    painter.text(
                        egui::pos2(cx, rect.bottom() + 4.0),
                        egui::Align2::CENTER_TOP,
                        label,
                        egui::FontId::proportional(10.5),
                        palette.text_secondary,
                    );
                }
            }
        });
    ui.add_space(14.0);
}

fn completed_steps_from_messages(chat: &ChatTabState) -> Vec<&'static str> {
    // Start from explicit signals (branch/worktree/commit/push/pr) and fold in
    // step transitions — any step that is followed by a *different* step
    // marker in `chat.messages` has finished.
    let mut set: Vec<&'static str> = Vec::new();
    let mut last_step: Option<&'static str> = None;

    for m in chat.messages.iter() {
        if let Some(rest) = m.content.strip_prefix("Step: ") {
            if let Some(canon) = crate::state::agents::classify_step(rest.trim()) {
                if let Some(prev) = last_step {
                    if prev != canon && !set.contains(&prev) {
                        set.push(prev);
                    }
                }
                last_step = Some(canon);
            }
        }
        // Explicit completion markers.
        if m.content.starts_with("Worktree created at: ") && !set.contains(&"worktree") {
            set.push("worktree");
        }
        if m.content.starts_with("Committed:") && !set.contains(&"commit") {
            set.push("commit");
        }
        if m.content == "Branch pushed to origin" && !set.contains(&"push") {
            set.push("push");
        }
        if m.content.starts_with("Draft PR created:") && !set.contains(&"pr") {
            set.push("pr");
        }
        if m.content.starts_with("Branch name: ") && !set.contains(&"branch") {
            set.push("branch");
        }
    }

    // Terminal-success: everything is considered done.
    if chat.status == "success" {
        for (id, _) in PIPELINE_STEPS.iter() {
            if !set.contains(id) {
                set.push(*id);
            }
        }
    }

    // Also fold in any classifiable entries from the shared task store — the
    // pipeline pushes "worktree_created", "implementation_applied", etc.
    // Chat doesn't mirror that, so we skip. (The message heuristic above is
    // the single source of truth here.)
    let _ = classify_completed;
    set
}

// ─── EventTimeline ───────────────────────────────────────────────────────────

pub fn show_timeline(ui: &mut egui::Ui, chat: &ChatTabState, palette: &ThemePalette) {
    if chat.messages.is_empty() {
        ui.vertical_centered(|ui| {
            ui.add_space(32.0);
            ui.label(
                egui::RichText::new("\u{1F916}")
                    .size(28.0)
                    .color(palette.text_muted),
            );
            ui.add_space(6.0);
            ui.label(
                egui::RichText::new("Agent is warming up…")
                    .size(12.0)
                    .color(palette.text_muted),
            );
        });
        return;
    }

    let groups = chat.group_messages_by_step();
    let last_idx = groups.len().saturating_sub(1);

    for (i, (step_id, bucket)) in groups.iter().enumerate() {
        let header_label = match step_id {
            Some(id) => {
                let pretty = PIPELINE_STEPS
                    .iter()
                    .find(|(k, _)| k == id)
                    .map(|(_, v)| *v)
                    .unwrap_or(id);
                format!("{}  ({} event{})", pretty, bucket.len(), if bucket.len() == 1 { "" } else { "s" })
            }
            None => format!(
                "Pipeline setup  ({} event{})",
                bucket.len(),
                if bucket.len() == 1 { "" } else { "s" }
            ),
        };
        let default_open = i == last_idx;
        let id_src = egui::Id::new((
            "agent_timeline_group",
            &chat.task_id,
            i,
            step_id.unwrap_or("_pre"),
        ));

        egui::CollapsingHeader::new(
            egui::RichText::new(header_label)
                .size(12.0)
                .color(palette.text_secondary)
                .strong(),
        )
        .id_salt(id_src)
        .default_open(default_open)
        .show(ui, |ui| {
            for m in bucket {
                event_row(ui, m, palette);
            }
        });
        ui.add_space(2.0);
    }
}

fn event_row(ui: &mut egui::Ui, msg: &ChatMessage, p: &ThemePalette) {
    // ED-D: if the message content parses as a structured tool call, render
    // the compact `chat_timeline_row`. Otherwise, render the redesigned
    // `agent_message` (bubble-less prose with inline file badges).
    if let Some(call) = parse_event(&msg.content) {
        let _ = chat_timeline_row(ui, p, &call, None);
        ui.add_space(2.0);
        return;
    }

    // Fall back to the redesigned prose renderer for non-tool-call events.
    agent_message(ui, p, msg, |_path| {
        // TODO(ED-G): wire `RuntimeState::open_file` through `AgentCtx` so
        // clicking an @file badge opens it in a new center tab.
    });
    ui.add_space(2.0);
    // Reserve referenced symbols to silence unused-import warnings when this
    // branch is exercised exclusively.
    let _ = MessageStatus::None;
    let _ = format_ts;
    let _ = CornerRadius::same(0);
}

fn format_ts(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let secs = ms / 1000;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}
