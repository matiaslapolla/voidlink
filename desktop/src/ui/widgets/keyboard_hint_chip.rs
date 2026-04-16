//! Full keyboard-hint pill combining one or more `kbd` chips + an optional
//! trailing label, e.g. `⌘ L to focus`. Parity: Conductor composer pill.

use eframe::egui::{self, RichText};

use super::kbd;
use crate::theme::ThemePalette;

/// Render `<kbd>⌘</kbd> <kbd>L</kbd> to focus`.
pub fn keyboard_hint_chip(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    keys: &[&str],
    trailing_label: Option<&str>,
) -> egui::Response {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 3.0;
        for key in keys {
            kbd(ui, palette, key);
        }
        if let Some(label) = trailing_label {
            ui.add(egui::Label::new(
                RichText::new(label)
                    .size(11.0)
                    .color(palette.text_muted),
            ));
        }
    })
    .response
}
