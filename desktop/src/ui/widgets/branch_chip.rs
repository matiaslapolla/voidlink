//! `/branch-name Open ▾` chip for the title bar. Parity: Conductor
//! `/kampala-v3 Open ▾`.
//!
//! This widget renders a pill with the branch name. The optional dropdown
//! affordance (▾) is painted when `dropdown_label` is `Some`; callers can
//! detect a click via the returned `Response` and open their own popup.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

/// Render the branch chip.
///
/// Returns the clickable `Response`. When `dropdown_label` is `Some`, the
/// trailing label + ▾ is drawn; callers open a popup on `response.clicked()`.
pub fn branch_chip(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    branch: &str,
    dropdown_label: Option<&str>,
) -> egui::Response {
    let branch_text = RichText::new(format!("/{}", branch))
        .monospace()
        .size(12.0)
        .color(palette.text);
    let branch_galley = egui::WidgetText::from(branch_text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Monospace,
    );

    let drop_galley = dropdown_label.map(|label| {
        let text = RichText::new(format!("{} \u{25BE}", label))
            .size(11.0)
            .color(palette.text_muted);
        egui::WidgetText::from(text).into_galley(
            ui,
            Some(egui::TextWrapMode::Extend),
            f32::INFINITY,
            egui::TextStyle::Body,
        )
    });

    let padding = egui::vec2(10.0, 3.0);
    let inner_gap = if drop_galley.is_some() { 10.0 } else { 0.0 };
    let drop_width = drop_galley.as_ref().map(|g| g.size().x).unwrap_or(0.0);

    let width = branch_galley.size().x + drop_width + inner_gap + padding.x * 2.0;
    let height = branch_galley.size().y.max(16.0) + padding.y * 2.0;

    let (rect, response) = ui.allocate_exact_size(egui::vec2(width, height), Sense::click());

    if ui.is_rect_visible(rect) {
        let bg = if response.hovered() {
            palette.hover
        } else {
            palette.surface
        };
        ui.painter().rect_filled(rect, CornerRadius::same(14), bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(14),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );

        let text_y = rect.center().y - branch_galley.size().y * 0.5;
        let branch_pos = egui::pos2(rect.min.x + padding.x, text_y);
        ui.painter().galley(branch_pos, branch_galley.clone(), palette.text);

        if let Some(drop_galley) = drop_galley {
            let drop_pos = egui::pos2(
                branch_pos.x + branch_galley.size().x + inner_gap,
                rect.center().y - drop_galley.size().y * 0.5,
            );
            ui.painter().galley(drop_pos, drop_galley, palette.text_muted);
        }
    }

    response
}
