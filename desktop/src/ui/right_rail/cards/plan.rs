//! Plan card — ED-C placeholder checklist.

use eframe::egui::{self, RichText};

use crate::theme::ThemePalette;

pub fn ui(ui: &mut egui::Ui, palette: &ThemePalette) {
    for (done, text) in [
        (true, "Scaffold widget primitives"),
        (true, "Refactor title bar"),
        (false, "Wire rail-card deck"),
        (false, "Redesign agent chat"),
    ] {
        ui.horizontal(|ui| {
            let box_char = if done { "\u{2611}" } else { "\u{2610}" };
            ui.add(egui::Label::new(
                RichText::new(box_char)
                    .size(13.0)
                    .color(if done {
                        palette.success
                    } else {
                        palette.text_muted
                    }),
            ));
            let color = if done {
                palette.text_muted
            } else {
                palette.text
            };
            ui.add(egui::Label::new(
                RichText::new(text)
                    .size(11.5)
                    .color(color),
            ));
        });
    }

    ui.add_space(4.0);
    ui.label(
        RichText::new("(ED-C placeholder — agent plan stream in ED-D)")
            .size(10.0)
            .color(palette.text_muted),
    );
}
