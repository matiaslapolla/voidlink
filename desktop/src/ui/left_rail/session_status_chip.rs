//! Color-tinted session status chip. Parity: Conductor row subtitle
//! `Ready to merge` (green) / `Merge conflicts` (amber) / `Archived` (muted).

use eframe::egui::{self, Color32, CornerRadius, RichText, Sense};

use crate::state::SessionStatus;
use crate::theme::ThemePalette;

pub fn session_status_chip(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    status: SessionStatus,
) -> egui::Response {
    let (bg, fg) = colors_for(palette, status);

    let text = RichText::new(status.label()).size(10.5).color(fg);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );
    let padding = egui::vec2(7.0, 2.0);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::hover());

    if ui.is_rect_visible(rect) {
        ui.painter().rect_filled(rect, CornerRadius::same(9), bg);
        ui.painter()
            .galley(rect.min + padding, galley, fg);
    }

    response
}

fn colors_for(p: &ThemePalette, status: SessionStatus) -> (Color32, Color32) {
    match status {
        SessionStatus::ReadyToMerge | SessionStatus::PrMerged => (p.pr_ready_bg, p.pr_ready_fg),
        SessionStatus::MergeConflicts => (p.pr_conflict_bg, p.pr_conflict_fg),
        SessionStatus::Failed | SessionStatus::ChecksFailing => (p.pr_failing_bg, p.pr_failing_fg),
        SessionStatus::DraftPr | SessionStatus::Archived => (p.pr_draft_bg, p.pr_draft_fg),
        SessionStatus::PrOpen | SessionStatus::ChecksRunning | SessionStatus::Running => {
            (p.surface_elevated, p.info)
        }
        SessionStatus::PrClosed => (p.surface_elevated, p.text_muted),
        SessionStatus::Idle => (p.surface_elevated, p.text_muted),
    }
}
