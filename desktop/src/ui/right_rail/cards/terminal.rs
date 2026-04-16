//! Terminal card — ED-C placeholder. ED-G mounts an egui_term TerminalView
//! here once we can keep a rail-mounted terminal alongside a bottom-pane one.

use eframe::egui::{self, CornerRadius, RichText, Stroke};

use crate::theme::ThemePalette;

pub fn ui(ui: &mut egui::Ui, palette: &ThemePalette) {
    let avail = ui.available_rect_before_wrap();
    let body_h = 140.0_f32;
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

    // Fake prompt lines.
    let mut y = rect.min.y + 10.0;
    for line in ["$ cargo check -p voidlink-desktop", "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.64s", "$ █"] {
        ui.painter().text(
            egui::pos2(rect.min.x + 10.0, y),
            egui::Align2::LEFT_TOP,
            line,
            egui::FontId::monospace(11.0),
            palette.text_secondary,
        );
        y += 16.0;
    }

    ui.add_space(4.0);
    ui.label(
        RichText::new("(ED-C placeholder — rail-mounted terminal in ED-G)")
            .size(10.0)
            .color(palette.text_muted),
    );
}
