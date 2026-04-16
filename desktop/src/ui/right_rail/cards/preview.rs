//! Preview card — embedded browser preview. ED-C renders a faux browser
//! chrome row + "no preview configured" body.

use eframe::egui::{self, CornerRadius, RichText, Stroke};

use crate::state::RailCardMeta;
use crate::theme::ThemePalette;

pub fn ui(ui: &mut egui::Ui, palette: &ThemePalette, meta: &RailCardMeta) {
    let url = match meta {
        RailCardMeta::Preview { url } => url.as_str(),
        _ => "",
    };

    // Faux browser chrome: ← → ↻ <url>
    ui.horizontal(|ui| {
        for glyph in ["\u{2039}", "\u{203A}", "\u{21BB}"] {
            let _ = ui.small_button(
                RichText::new(glyph)
                    .size(11.0)
                    .color(palette.text_muted),
            );
        }
        ui.add_space(4.0);
        let rect = ui.available_rect_before_wrap();
        let bar_height = 22.0_f32;
        let (bar_rect, _) = ui.allocate_exact_size(
            egui::vec2(rect.width().min(200.0), bar_height),
            egui::Sense::hover(),
        );
        ui.painter().rect_filled(bar_rect, CornerRadius::same(4), palette.surface);
        ui.painter().rect_stroke(
            bar_rect,
            CornerRadius::same(4),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );
        let label = if url.is_empty() { "localhost:5173" } else { url };
        ui.painter().text(
            egui::pos2(bar_rect.min.x + 8.0, bar_rect.center().y),
            egui::Align2::LEFT_CENTER,
            label,
            egui::FontId::monospace(11.0),
            palette.text_muted,
        );
    });

    ui.add_space(6.0);

    // Body placeholder.
    let avail = ui.available_rect_before_wrap();
    let preview_h = 120.0_f32;
    let (body_rect, _) =
        ui.allocate_exact_size(egui::vec2(avail.width(), preview_h), egui::Sense::hover());
    ui.painter()
        .rect_filled(body_rect, CornerRadius::same(6), palette.surface);
    ui.painter().rect_stroke(
        body_rect,
        CornerRadius::same(6),
        Stroke::new(1.0, palette.border),
        egui::StrokeKind::Inside,
    );
    ui.painter().text(
        body_rect.center(),
        egui::Align2::CENTER_CENTER,
        "Preview card\n(ED-C placeholder)",
        egui::FontId::proportional(12.0),
        palette.text_muted,
    );
}
