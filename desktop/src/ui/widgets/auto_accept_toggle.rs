//! Auto-accept edits toggle pill. Parity: Codex `Auto accept edits`.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

pub fn auto_accept_toggle(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    value: &mut bool,
) -> egui::Response {
    let label = if *value {
        "Auto accept edits"
    } else {
        "Manual accept"
    };
    let icon = if *value { "\u{2714}" } else { "\u{2715}" };

    let text = RichText::new(format!("{}  {}", icon, label))
        .size(11.5)
        .color(if *value {
            palette.toast_success_stripe
        } else {
            palette.text_muted
        });

    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );

    let padding = egui::vec2(10.0, 4.0);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());

    if response.clicked() {
        *value = !*value;
    }

    if ui.is_rect_visible(rect) {
        let (bg, stroke) = if *value {
            (
                egui::Color32::from_rgba_unmultiplied(
                    palette.toast_success_stripe.r(),
                    palette.toast_success_stripe.g(),
                    palette.toast_success_stripe.b(),
                    48,
                ),
                palette.toast_success_stripe,
            )
        } else {
            (palette.surface_elevated, palette.border)
        };
        ui.painter().rect_filled(rect, CornerRadius::same(12), bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(12),
            Stroke::new(1.0, stroke),
            egui::StrokeKind::Inside,
        );
        let text_pos = rect.min + padding;
        ui.painter().galley(text_pos, galley, palette.text);
    }

    response
}
