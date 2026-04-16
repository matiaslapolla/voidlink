//! Generic pill/chip badge with semantic tone. Thin wrapper over `rect_filled`
//! + centered text. Not a replacement for the specialised chips
//! (`file_badge`, `keyboard_hint_chip`, `kbd`) — reach for those first.

use eframe::egui::{self, Color32, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

#[derive(Debug, Clone, Copy)]
pub enum BadgeTone {
    Neutral,
    Primary,
    Success,
    Warning,
    Error,
    Info,
}

impl BadgeTone {
    fn colors(&self, palette: &ThemePalette) -> (Color32, Color32) {
        // (bg, fg)
        match self {
            BadgeTone::Neutral => (palette.surface_elevated, palette.text_muted),
            BadgeTone::Primary => (palette.primary, palette.primary_text),
            BadgeTone::Success => (palette.pr_ready_bg, palette.pr_ready_fg),
            BadgeTone::Warning => (palette.pr_conflict_bg, palette.pr_conflict_fg),
            BadgeTone::Error => (palette.pr_failing_bg, palette.pr_failing_fg),
            BadgeTone::Info => (palette.surface_elevated, palette.info),
        }
    }
}

pub fn badge(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    label: &str,
    tone: BadgeTone,
) -> egui::Response {
    let (bg, fg) = tone.colors(palette);
    let text = RichText::new(label).size(11.0).color(fg);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );
    let padding = egui::vec2(8.0, 2.5);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::hover());

    if ui.is_rect_visible(rect) {
        ui.painter().rect_filled(rect, CornerRadius::same(10), bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(10),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );
        let text_pos = rect.min + padding;
        ui.painter().galley(text_pos, galley, fg);
    }

    response
}
