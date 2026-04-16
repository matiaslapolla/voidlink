//! Model selector pill. Parity: Conductor `✦ Sonnet 4.5`, Codex `Opus 4.6 ●`.
//!
//! Renders a clickable pill; caller opens the popup. `thinking = true` paints
//! a small animated dot next to the label.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::motion;
use crate::theme::ThemePalette;

pub fn model_selector(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    model_name: &str,
    thinking: bool,
) -> egui::Response {
    let label = format!("\u{2726} {}", model_name);
    let text = RichText::new(label).size(11.5).color(palette.text);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );

    let padding = egui::vec2(10.0, 4.0);
    let dot_width = if thinking { 14.0 } else { 0.0 };
    let width = galley.size().x + dot_width + padding.x * 2.0;
    let height = galley.size().y + padding.y * 2.0;
    let (rect, response) = ui.allocate_exact_size(egui::vec2(width, height), Sense::click());

    if ui.is_rect_visible(rect) {
        let bg = if response.hovered() {
            palette.hover
        } else {
            palette.surface_elevated
        };
        ui.painter().rect_filled(rect, CornerRadius::same(12), bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(12),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );

        let text_pos = rect.min + padding;
        ui.painter().galley(text_pos, galley.clone(), palette.text);

        if thinking {
            let pulse = motion::pulse_sine(ui.ctx(), motion::dur::STATUS_DOT_PULSE);
            let cx = rect.max.x - padding.x - 4.0;
            let cy = rect.center().y;
            let r = 3.0 + 1.5 * pulse;
            ui.painter()
                .circle_filled(egui::pos2(cx, cy), r, palette.primary);
            ui.ctx()
                .request_repaint_after(std::time::Duration::from_millis(50));
        }
    }

    response
}
