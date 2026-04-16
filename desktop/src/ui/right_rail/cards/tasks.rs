//! Tasks card — ED-C placeholder. Groups Running / Completed with runtime.

use eframe::egui::{self, RichText};

use crate::theme::ThemePalette;
use crate::ui::widgets::{self, StatusDotState};

pub fn ui(ui: &mut egui::Ui, palette: &ThemePalette) {
    ui.label(
        RichText::new("Running")
            .size(11.0)
            .color(palette.text_muted),
    );
    ui.add_space(2.0);
    task_row(ui, palette, StatusDotState::Running, "lint voidlink-desktop", "0m 18s");

    ui.add_space(6.0);

    ui.label(
        RichText::new("Completed")
            .size(11.0)
            .color(palette.text_muted),
    );
    ui.add_space(2.0);
    task_row(ui, palette, StatusDotState::Success, "typecheck voidlink-core", "1m 12s");
    task_row(ui, palette, StatusDotState::Error, "test voidlink-core", "0m 42s");

    ui.add_space(4.0);
    ui.label(
        RichText::new("(ED-C placeholder — real task telemetry in ED-D)")
            .size(10.0)
            .color(palette.text_muted),
    );
}

fn task_row(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    dot: StatusDotState,
    title: &str,
    runtime: &str,
) {
    ui.horizontal(|ui| {
        let _ = widgets::status_dot(ui, palette, dot, dot == StatusDotState::Running);
        ui.add(egui::Label::new(
            RichText::new(title)
                .size(11.5)
                .color(palette.text),
        ));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add(egui::Label::new(
                RichText::new(runtime)
                    .monospace()
                    .size(11.0)
                    .color(palette.text_muted),
            ));
        });
    });
}
