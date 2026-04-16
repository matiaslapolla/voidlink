//! PR file list with sub-tabs. Parity: Conductor `Changes 10 | All files | Review`.
//!
//! Rows are (path, +adds, -dels). The path is truncated left-to-right with an
//! ellipsis. Clicking a row emits an "open file" event via the returned
//! `selected_path`.

use eframe::egui::{self, RichText, Sense};

use crate::state::PullRequestInfo;
use crate::theme::ThemePalette;
use crate::ui::widgets;

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum PrChangesTab {
    Changes,
    AllFiles,
    Review,
}

impl PrChangesTab {
    pub const ALL: &[PrChangesTab] = &[
        PrChangesTab::Changes,
        PrChangesTab::AllFiles,
        PrChangesTab::Review,
    ];

    fn label(&self) -> &'static str {
        match self {
            PrChangesTab::Changes => "Changes",
            PrChangesTab::AllFiles => "All files",
            PrChangesTab::Review => "Review",
        }
    }
}

pub struct PrChangesPanelResult {
    pub tab_changed: Option<PrChangesTab>,
    pub selected_path: Option<String>,
    pub search_query: Option<String>,
}

/// The `files` argument is intentionally a thin triple (path, add, del). ED-F
/// pulls this from a worker that calls `voidlink_core::git::diff_branches` for
/// the PR head/base pair; the rail card for now passes whatever data the
/// session already has.
pub fn pr_changes_panel(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    pr: &PullRequestInfo,
    files: &[(String, u32, u32)],
    active_tab: PrChangesTab,
    search_buf: &mut String,
) -> PrChangesPanelResult {
    let mut tab_changed: Option<PrChangesTab> = None;
    let mut selected_path: Option<String> = None;
    let mut search_query: Option<String> = None;

    // Sub-tabs row.
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 14.0;
        for tab in PrChangesTab::ALL {
            let is_active = *tab == active_tab;
            let color = if is_active {
                palette.text
            } else {
                palette.text_muted
            };
            let label = if matches!(tab, PrChangesTab::Changes) {
                format!("{} {}", tab.label(), files.len())
            } else {
                tab.label().to_string()
            };
            let r = ui.add(egui::Label::new(RichText::new(label).size(11.5).color(color)).sense(Sense::click()));
            if r.clicked() && !is_active {
                tab_changed = Some(*tab);
            }
            if is_active {
                // Thin underline under the active tab.
                let rect = r.rect;
                ui.painter().line_segment(
                    [
                        egui::pos2(rect.min.x, rect.max.y + 1.0),
                        egui::pos2(rect.max.x, rect.max.y + 1.0),
                    ],
                    egui::Stroke::new(2.0, palette.primary),
                );
            }
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let r = ui.add(
                egui::TextEdit::singleline(search_buf)
                    .hint_text(RichText::new("Filter").color(palette.text_muted))
                    .desired_width(110.0)
                    .font(egui::TextStyle::Body),
            );
            if r.changed() {
                search_query = Some(search_buf.clone());
            }
        });
    });

    ui.add_space(6.0);

    // File rows.
    let filter = search_buf.trim().to_lowercase();
    let mut shown = 0usize;
    for (path, add, del) in files {
        if !filter.is_empty() && !path.to_lowercase().contains(&filter) {
            continue;
        }
        shown += 1;
        let row_h = 22.0_f32;
        let (rect, response) = ui.allocate_exact_size(
            egui::vec2(ui.available_width(), row_h),
            Sense::click(),
        );
        if response.hovered() && ui.is_rect_visible(rect) {
            ui.painter()
                .rect_filled(rect, egui::CornerRadius::same(4), palette.hover);
        }
        // Path (truncated left).
        let shown_path = truncate_path(path, 36);
        ui.painter().text(
            egui::pos2(rect.min.x + 6.0, rect.center().y),
            egui::Align2::LEFT_CENTER,
            shown_path,
            egui::FontId::monospace(11.0),
            palette.text,
        );
        // Delta right-aligned.
        let delta_text = match (*add, *del) {
            (0, 0) => String::new(),
            (a, 0) => format!("+{}", a),
            (0, d) => format!("-{}", d),
            (a, d) => format!("+{} -{}", a, d),
        };
        if !delta_text.is_empty() {
            ui.painter().text(
                egui::pos2(rect.max.x - 6.0, rect.center().y),
                egui::Align2::RIGHT_CENTER,
                delta_text,
                egui::FontId::monospace(11.0),
                palette.delta_add_fg,
            );
        }

        if response.clicked() {
            selected_path = Some(path.clone());
        }
    }

    if shown == 0 {
        ui.label(
            RichText::new("No files match.")
                .size(11.0)
                .color(palette.text_muted),
        );
    }

    let _ = pr; // reserved for future "Review" tab content.
    let _ = widgets::delta_count; // referenced elsewhere in this phase.

    PrChangesPanelResult {
        tab_changed,
        selected_path,
        search_query,
    }
}

fn truncate_path(path: &str, max_chars: usize) -> String {
    if path.chars().count() <= max_chars {
        return path.to_string();
    }
    let keep = max_chars.saturating_sub(1);
    let chars: Vec<char> = path.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(keep)..].iter().collect();
    format!("\u{2026}{}", tail)
}
