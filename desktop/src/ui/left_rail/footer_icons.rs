//! Left-rail footer row: `+ Add repository` | archive | chat | settings.
//! Parity: Conductor footer of the left rail.

use eframe::egui::{self, RichText, Sense};

use crate::theme::ThemePalette;

pub struct FooterEvents {
    pub add_repo: bool,
    pub open_archive: bool,
    pub open_chat: bool,
    pub open_settings: bool,
}

pub fn footer_icons(ui: &mut egui::Ui, palette: &ThemePalette) -> FooterEvents {
    let mut evts = FooterEvents {
        add_repo: false,
        open_archive: false,
        open_chat: false,
        open_settings: false,
    };

    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;

        let add_r = ui.add(
            egui::Label::new(
                RichText::new("+  Add repository")
                    .size(11.5)
                    .color(palette.text_muted),
            )
            .sense(Sense::click()),
        );
        if add_r.clicked() {
            evts.add_repo = true;
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            for (glyph, tip, action) in [
                ("\u{2699}", "Settings", &mut evts.open_settings),
                ("\u{1F5EB}", "Chat", &mut evts.open_chat),
                ("\u{1F5C4}", "Archive", &mut evts.open_archive),
            ] {
                if ui
                    .small_button(
                        RichText::new(glyph)
                            .size(13.0)
                            .color(palette.text_muted),
                    )
                    .on_hover_text(tip)
                    .clicked()
                {
                    *action = true;
                }
            }
        });
    });

    evts
}
