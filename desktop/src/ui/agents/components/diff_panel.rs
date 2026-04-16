//! Right-side live-diff panel for an agent chat tab (Phase 7C).
//!
//! Renders a header ("Changed files" + count chip + Refresh) followed by one
//! of four states:
//! 1. No worktree yet → "Diff will appear once the agent starts editing files."
//! 2. Worktree but no diff result and loading → "Loading diff…"
//! 3. Worktree, diff result cached → the shared `DiffRowsView`.
//! 4. Worktree, no diff result, not loading → an implicit refresh is already
//!    scheduled (`diff_needs_refresh = true` is sticky until the worker
//!    returns) so we show a soft placeholder.
//!
//! The actual diff fetch is driven by `AgentsRuntime::drain_pipeline_messages`
//! on the UI thread — this widget only displays state and flips
//! `diff_needs_refresh` on manual Refresh clicks.

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::agents::ChatTabState;
use crate::ui::agents::AgentCtx;
use crate::ui::components::diff_rows::DiffRowsView;

pub fn show(ui: &mut egui::Ui, chat: &mut ChatTabState, ctx: &mut AgentCtx) {
    let p = ctx.palette;

    egui::Frame::NONE
        .fill(p.background)
        .inner_margin(egui::Margin::symmetric(8, 6))
        .show(ui, |ui| {
            ui.set_min_height(ui.available_height());
            ui.vertical(|ui| {
                header(ui, chat, p);
                ui.add_space(4.0);
                ui.separator();
                ui.add_space(4.0);
                body(ui, chat, p);
            });
        });
}

fn header(ui: &mut egui::Ui, chat: &mut ChatTabState, p: crate::theme::ThemePalette) {
    ui.horizontal(|ui| {
        ui.label(
            egui::RichText::new("Changed files")
                .size(11.0)
                .strong()
                .color(p.text),
        );

        let count = chat
            .diff_result
            .as_ref()
            .map(|d| d.files.len())
            .unwrap_or(0);
        if count > 0 {
            egui::Frame::NONE
                .fill(p.surface_elevated)
                .corner_radius(CornerRadius::same(4))
                .inner_margin(egui::Margin::symmetric(5, 1))
                .show(ui, |ui| {
                    ui.label(
                        egui::RichText::new(count.to_string())
                            .size(10.0)
                            .color(p.text_secondary),
                    );
                });
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let enabled = chat.worktree_path.is_some() && !chat.diff_loading;
            let resp = ui.add_enabled(
                enabled,
                egui::Button::new(
                    egui::RichText::new("\u{21BB} Refresh")
                        .size(10.0)
                        .color(if enabled { p.text_secondary } else { p.text_muted }),
                )
                .fill(egui::Color32::TRANSPARENT)
                .corner_radius(CornerRadius::same(4)),
            );
            if resp.clicked() {
                chat.diff_needs_refresh = true;
            }

            if chat.diff_loading {
                ui.add_space(4.0);
                ui.add(egui::Spinner::new().size(11.0));
            }
        });
    });
}

fn body(ui: &mut egui::Ui, chat: &mut ChatTabState, p: crate::theme::ThemePalette) {
    // State 1 — task not started / no worktree.
    if chat.worktree_path.is_none() {
        ui.add_space(12.0);
        ui.vertical_centered(|ui| {
            ui.label(
                egui::RichText::new("\u{1F4C4}")
                    .size(22.0)
                    .color(p.text_muted),
            );
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("Diff will appear once the agent\nstarts editing files.")
                    .size(11.0)
                    .color(p.text_muted),
            );
        });
        return;
    }

    // State 2 — loading first diff result.
    if chat.diff_result.is_none() && chat.diff_loading {
        ui.add_space(12.0);
        ui.vertical_centered(|ui| {
            ui.add(egui::Spinner::new().size(16.0));
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("Loading diff\u{2026}")
                    .size(11.0)
                    .color(p.text_muted),
            );
        });
        return;
    }

    // State 4 — worktree known, nothing yet (refresh pending). Mild placeholder.
    let Some(diff) = chat.diff_result.as_ref() else {
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new("No changes yet.")
                .size(11.0)
                .color(p.text_muted),
        );
        return;
    };

    // Split `chat` borrow so we can pass `&files` + `&mut selected_file`.
    let files = diff.files.clone();

    egui::ScrollArea::vertical()
        .id_salt("agent_diff_rows")
        .auto_shrink([false, false])
        .show(ui, |ui| {
            DiffRowsView {
                files: &files,
                selected: &mut chat.selected_file,
                palette: p,
            }
            .show(ui);
        });
}
