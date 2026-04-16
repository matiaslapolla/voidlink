//! Changes card — ED-C placeholder. ED-F wires real PR / worktree deltas.

use eframe::egui::{self, RichText};

use crate::theme::ThemePalette;
use crate::ui::widgets;

pub fn ui(ui: &mut egui::Ui, palette: &ThemePalette) {
    // Sub-tabs placeholder (Changes | All files | Review).
    ui.horizontal(|ui| {
        for label in ["Changes", "All files", "Review"] {
            ui.add(egui::Label::new(
                RichText::new(label)
                    .size(11.0)
                    .color(palette.text_muted),
            ));
            ui.add_space(8.0);
        }
    });

    ui.add_space(6.0);

    // Fake rows — wire to voidlink-core::git::diff in ED-F.
    for (path, add, del) in [
        ("src/ui/title_bar/mod.rs", 142, 38),
        ("src/motion.rs", 87, 0),
        ("src/ui/widgets/toast_host.rs", 163, 0),
    ] {
        ui.horizontal(|ui| {
            ui.add(egui::Label::new(
                RichText::new(path)
                    .monospace()
                    .size(11.0)
                    .color(palette.text),
            ));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let _ = widgets::delta_count(ui, palette, add, del, true);
            });
        });
    }

    ui.add_space(4.0);
    ui.label(
        RichText::new("(ED-C placeholder — live deltas land in ED-F)")
            .size(10.0)
            .color(palette.text_muted),
    );
}
