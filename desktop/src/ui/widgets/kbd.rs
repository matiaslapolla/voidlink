//! Single keyboard key chip — e.g. `⌘`, `K`, `Esc`. Used inline in help
//! banners, command palette rows, keyboard hint pills.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

/// Render one `<kbd>`-style chip. Not interactive; returns the allocated
/// response so callers can position it inside a row.
pub fn kbd(ui: &mut egui::Ui, palette: &ThemePalette, key: &str) -> egui::Response {
    let text = RichText::new(key)
        .monospace()
        .size(11.0)
        .color(palette.keyboard_hint_fg);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Monospace,
    );

    let padding = egui::vec2(5.0, 1.5);
    // Keep all chips the same minimum height so ⌘ + K line up visually.
    let min_height = 18.0_f32;
    let width = galley.size().x + padding.x * 2.0;
    let height = min_height.max(galley.size().y + padding.y * 2.0);
    let (rect, response) = ui.allocate_exact_size(egui::vec2(width, height), Sense::hover());

    if ui.is_rect_visible(rect) {
        ui.painter()
            .rect_filled(rect, CornerRadius::same(3), palette.keyboard_hint_bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(3),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );
        let text_pos = egui::pos2(
            rect.min.x + padding.x,
            rect.center().y - galley.size().y * 0.5,
        );
        ui.painter()
            .galley(text_pos, galley, palette.keyboard_hint_fg);
    }

    response
}
