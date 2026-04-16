//! Generic rail-card frame. Renders: icon + title + (drag handle stub,
//! collapse chevron, dismiss ×) header row, separator, body slot.

use eframe::egui::{self, CornerRadius, Frame, Margin, RichText, Stroke};

use crate::state::{RailCardKind, RailCardState};
use crate::theme::ThemePalette;

pub struct RailCardEvents {
    pub dismiss: bool,
    pub move_up: bool,
    pub move_down: bool,
    pub toggle_collapsed: bool,
}

impl RailCardEvents {
    fn empty() -> Self {
        Self {
            dismiss: false,
            move_up: false,
            move_down: false,
            toggle_collapsed: false,
        }
    }
}

pub fn rail_card<F: FnOnce(&mut egui::Ui)>(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    card: &RailCardState,
    show_move_up: bool,
    show_move_down: bool,
    body: F,
) -> RailCardEvents {
    let mut events = RailCardEvents::empty();
    let kind = card.kind;

    let frame = Frame {
        fill: palette.rail_card_bg,
        stroke: Stroke::new(1.0, palette.rail_card_border),
        corner_radius: CornerRadius::same(8),
        inner_margin: Margin::symmetric(10, 8),
        outer_margin: Margin::symmetric(0, 0),
        shadow: egui::epaint::Shadow::NONE,
    };

    frame.show(ui, |ui| {
        // Header row.
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;

            // Collapse chevron.
            let chevron = if card.collapsed { "\u{25B6}" } else { "\u{25BC}" };
            if ui
                .add(egui::Label::new(
                    RichText::new(chevron)
                        .size(11.0)
                        .color(palette.text_muted),
                ).sense(egui::Sense::click()))
                .clicked()
            {
                events.toggle_collapsed = true;
            }

            // Icon.
            ui.add(egui::Label::new(
                RichText::new(kind.icon())
                    .size(13.0)
                    .color(palette.text_muted),
            ));

            // Title.
            ui.add(egui::Label::new(
                RichText::new(kind.title())
                    .strong()
                    .size(12.5)
                    .color(palette.text),
            ));

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // Dismiss ×
                if ui
                    .small_button(
                        RichText::new("\u{2715}")
                            .size(11.0)
                            .color(palette.text_muted),
                    )
                    .on_hover_text("Dismiss card")
                    .clicked()
                {
                    events.dismiss = true;
                }

                // Move down ▼
                if show_move_down {
                    if ui
                        .small_button(
                            RichText::new("\u{25BE}")
                                .size(11.0)
                                .color(palette.text_muted),
                        )
                        .on_hover_text("Move down")
                        .clicked()
                    {
                        events.move_down = true;
                    }
                }

                // Move up ▲
                if show_move_up {
                    if ui
                        .small_button(
                            RichText::new("\u{25B4}")
                                .size(11.0)
                                .color(palette.text_muted),
                        )
                        .on_hover_text("Move up")
                        .clicked()
                    {
                        events.move_up = true;
                    }
                }
            });
        });

        if !card.collapsed {
            ui.add_space(6.0);
            ui.painter().hline(
                ui.available_rect_before_wrap().x_range(),
                ui.cursor().top(),
                Stroke::new(1.0, palette.border),
            );
            ui.add_space(4.0);
            body(ui);
        }
    });

    // Silence unused-kind-binding if no branches reference it directly.
    let _ = kind;
    let _ = RailCardKind::Changes;
    events
}
