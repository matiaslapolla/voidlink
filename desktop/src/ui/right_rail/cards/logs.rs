//! Logs card — ED-C placeholder. ED-G wires real log buffer + prefix coloring.

use eframe::egui::{self, CornerRadius, RichText, Stroke};

use crate::state::RailCardMeta;
use crate::theme::ThemePalette;

pub fn ui(ui: &mut egui::Ui, palette: &ThemePalette, meta: &RailCardMeta) {
    let _ = meta; // source filter will drive which lines we render in ED-G.

    // Filter strip.
    ui.horizontal(|ui| {
        for label in ["all", "stdout", "stderr"] {
            ui.add(egui::Label::new(
                RichText::new(label)
                    .size(11.0)
                    .color(palette.text_muted),
            ));
            ui.add_space(8.0);
        }
    });

    ui.add_space(4.0);

    let avail = ui.available_rect_before_wrap();
    let body_h = 110.0_f32;
    let (rect, _) = ui.allocate_exact_size(
        egui::vec2(avail.width(), body_h),
        egui::Sense::hover(),
    );
    ui.painter()
        .rect_filled(rect, CornerRadius::same(6), palette.editor_bg);
    ui.painter().rect_stroke(
        rect,
        CornerRadius::same(6),
        Stroke::new(1.0, palette.border),
        egui::StrokeKind::Inside,
    );

    let rows = [
        ("tsc", "ok Found 0 errors.", palette.log_prefix_tsc),
        (
            "vite",
            "hmr update /src/ui/widgets/status_dot.rs",
            palette.log_prefix_vite,
        ),
        ("cargo", "Finished `dev` profile", palette.log_prefix_cargo),
    ];

    let mut y = rect.min.y + 8.0;
    for (prefix, text, color) in rows {
        ui.painter().text(
            egui::pos2(rect.min.x + 10.0, y),
            egui::Align2::LEFT_TOP,
            format!("[{}]", prefix),
            egui::FontId::monospace(11.0),
            color,
        );
        ui.painter().text(
            egui::pos2(rect.min.x + 60.0, y),
            egui::Align2::LEFT_TOP,
            text,
            egui::FontId::monospace(11.0),
            palette.text_secondary,
        );
        y += 16.0;
    }

    ui.add_space(4.0);
    ui.label(
        RichText::new("(ED-C placeholder — real log stream in ED-G)")
            .size(10.0)
            .color(palette.text_muted),
    );
}
