//! Inline `@Filename.tsx` chip. Parity: Conductor inline file references.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

/// Paints a clickable chip showing `@<path basename>`. The response is
/// clickable; callers typically open the file on click.
pub fn file_badge(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    path: &str,
) -> egui::Response {
    let basename = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let label = format!("@{}", basename);

    let text = RichText::new(label)
        .monospace()
        .size(12.0)
        .color(palette.file_badge_fg);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Monospace,
    );

    let padding = egui::vec2(6.0, 2.0);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());

    if ui.is_rect_visible(rect) {
        let bg = if response.hovered() {
            palette.hover
        } else {
            palette.file_badge_bg
        };
        ui.painter().rect_filled(rect, CornerRadius::same(4), bg);
        ui.painter()
            .rect_stroke(rect, CornerRadius::same(4), Stroke::new(1.0, palette.border), egui::StrokeKind::Inside);
        let text_pos = rect.min + padding;
        ui.painter()
            .galley(text_pos, galley, palette.file_badge_fg);
    }

    response.on_hover_text(path)
}
