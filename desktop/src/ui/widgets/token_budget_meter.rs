//! Token-budget pill. Shows `↓ 37.1k / 200k` tinted by fraction used. Parity:
//! Conductor composer footer `25s · ↓ 37.1k tokens`.

use eframe::egui::{self, Color32, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

/// `used` / `total` in input+output token counts.
pub fn token_budget_meter(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    used: u64,
    total: u64,
) -> egui::Response {
    let fraction = if total == 0 {
        0.0
    } else {
        (used as f32 / total as f32).clamp(0.0, 1.0)
    };
    let (stroke_color, text_color) = if fraction >= 0.95 {
        (palette.toast_error_stripe, palette.toast_error_stripe)
    } else if fraction >= 0.8 {
        (palette.toast_warning_stripe, palette.toast_warning_stripe)
    } else {
        (palette.border, palette.text_muted)
    };

    let label = format!(
        "\u{2193} {} / {}",
        humanize(used),
        humanize(total)
    );

    let text = RichText::new(label).size(11.5).color(text_color);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );

    let padding = egui::vec2(10.0, 4.0);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::hover());

    if ui.is_rect_visible(rect) {
        ui.painter().rect_filled(rect, CornerRadius::same(12), palette.surface_elevated);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(12),
            Stroke::new(1.0, stroke_color),
            egui::StrokeKind::Inside,
        );

        // Progress fill along the inner bottom edge.
        if fraction > 0.0 {
            let inner = rect.shrink2(egui::vec2(4.0, 4.0));
            let w = inner.width() * fraction;
            let bar = egui::Rect::from_min_size(
                egui::pos2(inner.min.x, inner.max.y - 2.0),
                egui::vec2(w, 2.0),
            );
            ui.painter().rect_filled(
                bar,
                CornerRadius::same(1),
                Color32::from_rgba_unmultiplied(stroke_color.r(), stroke_color.g(), stroke_color.b(), 180),
            );
        }

        let text_pos = rect.min + padding;
        ui.painter().galley(text_pos, galley, text_color);
    }

    response.on_hover_text(format!("{} / {} tokens used", used, total))
}

fn humanize(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f32 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f32 / 1_000.0)
    } else {
        format!("{}", n)
    }
}
