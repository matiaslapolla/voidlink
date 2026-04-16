//! Top strip of the right rail: "Stack" label on the left, `+` popover to
//! re-add dismissed cards on the right.

use eframe::egui::{self, RichText};

use crate::state::{RailCardKind, RailDeck};
use crate::theme::ThemePalette;

/// Returns `Some(kind)` when the user picked a kind to add.
pub fn deck_toolbar(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    deck: &RailDeck,
) -> Option<RailCardKind> {
    let mut picked: Option<RailCardKind> = None;

    ui.horizontal(|ui| {
        ui.add(egui::Label::new(
            RichText::new("Stack")
                .strong()
                .size(12.0)
                .color(palette.text),
        ));

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let available = deck.available_to_add();
            ui.menu_button(
                RichText::new("+").size(14.0).color(palette.text_muted),
                |ui| {
                    if available.is_empty() {
                        ui.label(
                            RichText::new("All cards are on the stack")
                                .size(11.0)
                                .color(palette.text_muted),
                        );
                    } else {
                        for kind in available {
                            let label = format!("{}  {}", kind.icon(), kind.title());
                            if ui.button(label).clicked() {
                                picked = Some(kind);
                                ui.close_menu();
                            }
                        }
                    }
                },
            );
        });
    });

    picked
}
