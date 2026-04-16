//! `+X -Y` monospace delta pair. Parity: Conductor `+312 -332`, Codex `+62`.

use eframe::egui::{self, Color32, RichText};

use crate::theme::ThemePalette;

/// Render a monospace `+add` / `-del` pair inline. Returns the combined
/// `egui::Response` spanning both labels for hover/click targets.
///
/// When `hide_zeros == true`, a zero-valued side is omitted.
pub fn delta_count(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    add: i64,
    del: i64,
    hide_zeros: bool,
) -> egui::Response {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        if add != 0 || !hide_zeros {
            ui.add(
                egui::Label::new(
                    RichText::new(format!("+{}", add))
                        .monospace()
                        .color(palette.delta_add_fg)
                        .size(12.0),
                )
                .wrap_mode(egui::TextWrapMode::Extend),
            );
        }
        if del != 0 || !hide_zeros {
            ui.add(
                egui::Label::new(
                    RichText::new(format!("-{}", del))
                        .monospace()
                        .color(palette.delta_del_fg)
                        .size(12.0),
                )
                .wrap_mode(egui::TextWrapMode::Extend),
            );
        }
        // Return a neutral Color32 to keep the closure result type simple —
        // we discard it and wrap by `ui.horizontal(...)` to get a Response.
        let _ = Color32::PLACEHOLDER;
    })
    .response
}
