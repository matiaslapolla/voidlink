//! Shared unified-diff row renderer (extracted from `ui::git_panel` in 7C).
//!
//! The renderer is split into three reuse levels:
//! 1. `render_diff_hunks` — lowest level: given a slice of `DiffHunk`, paint
//!    `+`/`-`/context lines with per-origin background tints and line-number
//!    gutters. Pure function — no state.
//! 2. `render_file_diff_body` — given a `FileDiff`, render its header line
//!    (path + `+N -M` counter) + the hunks beneath it (or "Binary file").
//! 3. `DiffRowsView::show` — list-of-files primitive with per-file click-to-
//!    expand. Used by `LiveDiffPanel` (7C). `git_panel` continues to use the
//!    single-file and all-files-expanded renderers directly.
//!
//! Visual output is intentionally identical to the pre-extraction `git_panel`
//! implementation — callers that care about pixel parity can diff this file
//! against the original block in git_panel.rs history.

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::theme::ThemePalette;
use voidlink_core::git::{DiffHunk, FileDiff};

/// Render the hunks of a single file diff. Preserves the original line-number
/// gutter formatting from `git_panel::render_diff_hunks`.
pub fn render_diff_hunks(ui: &mut egui::Ui, hunks: &[DiffHunk], p: ThemePalette) {
    ui.style_mut().override_font_id = Some(egui::FontId::monospace(12.0));

    for hunk in hunks {
        // Hunk header
        ui.label(
            egui::RichText::new(&hunk.header)
                .size(11.0)
                .color(p.info)
                .family(egui::FontFamily::Monospace),
        );

        for line in &hunk.lines {
            let (bg, text_color) = match line.origin.as_str() {
                "+" => (p.success.linear_multiply(0.12), p.success),
                "-" => (p.error.linear_multiply(0.12), p.error),
                _ => (egui::Color32::TRANSPARENT, p.text_secondary),
            };

            let line_num = match line.origin.as_str() {
                "+" => line
                    .new_lineno
                    .map(|n| format!("    {:>4} ", n))
                    .unwrap_or_else(|| "         ".to_string()),
                "-" => line
                    .old_lineno
                    .map(|n| format!("{:>4}     ", n))
                    .unwrap_or_else(|| "         ".to_string()),
                _ => {
                    let old = line
                        .old_lineno
                        .map(|n| format!("{:>4}", n))
                        .unwrap_or_else(|| "    ".to_string());
                    let new = line
                        .new_lineno
                        .map(|n| format!("{:>4}", n))
                        .unwrap_or_else(|| "    ".to_string());
                    format!("{} {} ", old, new)
                }
            };

            let display = format!(
                "{}{} {}",
                line_num,
                line.origin,
                line.content.trim_end_matches('\n')
            );

            let frame = egui::Frame::NONE
                .fill(bg)
                .inner_margin(egui::Margin::symmetric(4, 0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(
                    egui::RichText::new(&display)
                        .size(12.0)
                        .color(text_color)
                        .family(egui::FontFamily::Monospace),
                );
            });
        }
    }
}

/// Badge + colour mapping for `FileDiff::status`. Extracted verbatim from
/// `git_panel::diff_status_badge_color` so both call sites stay in sync.
pub fn diff_status_badge_color(status: &str, p: ThemePalette) -> (&'static str, egui::Color32) {
    match status {
        "modified" => ("M", p.warning),
        "added" => ("A", p.success),
        "deleted" => ("D", p.error),
        "renamed" => ("R", p.info),
        _ => ("?", p.text_muted),
    }
}

// ─── Click-to-expand list view (7C) ──────────────────────────────────────────

/// "Collapsible list of changed files + inline unified diff" — the primitive
/// used by `LiveDiffPanel` in the agent chat right-side panel.
///
/// Visually each row is a status-badge + path + `+N -M` counter. Clicking a
/// row toggles its expansion; the expanded body reuses the exact same
/// `render_diff_hunks` output as `git_panel`, ensuring the two surfaces stay
/// in sync.
pub struct DiffRowsView<'a> {
    pub files: &'a [FileDiff],
    /// Path of the currently-expanded file (matches `FileDiff::new_path` or,
    /// for deletions, `FileDiff::old_path`). Written to on row click.
    pub selected: &'a mut Option<String>,
    pub palette: ThemePalette,
}

impl<'a> DiffRowsView<'a> {
    pub fn show(self, ui: &mut egui::Ui) {
        let Self {
            files,
            selected,
            palette: p,
        } = self;

        if files.is_empty() {
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("No changes yet.")
                    .size(11.0)
                    .color(p.text_muted),
            );
            return;
        }

        for file in files {
            let path = file
                .new_path
                .clone()
                .or_else(|| file.old_path.clone())
                .unwrap_or_else(|| "unknown".to_string());
            let is_selected = selected.as_deref() == Some(path.as_str());

            let (badge, color) = diff_status_badge_color(&file.status, p);
            let bg = if is_selected {
                p.hover
            } else {
                egui::Color32::TRANSPARENT
            };

            let resp = egui::Frame::NONE
                .fill(bg)
                .corner_radius(CornerRadius::same(3))
                .inner_margin(egui::Margin::symmetric(6, 2))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(badge)
                                .size(10.0)
                                .color(color)
                                .strong(),
                        );
                        ui.label(
                            egui::RichText::new(&path)
                                .size(11.0)
                                .color(p.text),
                        );
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                ui.label(
                                    egui::RichText::new(format!(
                                        "+{} -{}",
                                        file.additions, file.deletions
                                    ))
                                    .size(10.0)
                                    .color(p.text_muted),
                                );
                            },
                        );
                    });
                });

            if resp.response.interact(egui::Sense::click()).clicked() {
                if is_selected {
                    *selected = None;
                } else {
                    *selected = Some(path.clone());
                }
            }

            // Expanded body — same rendering as git_panel single-file viewer.
            if is_selected {
                egui::Frame::NONE
                    .inner_margin(egui::Margin::symmetric(4, 4))
                    .show(ui, |ui| {
                        if file.is_binary {
                            ui.label(
                                egui::RichText::new("Binary file")
                                    .color(p.text_muted)
                                    .size(12.0),
                            );
                        } else {
                            render_diff_hunks(ui, &file.hunks, p);
                        }
                    });
            }
        }
    }
}
