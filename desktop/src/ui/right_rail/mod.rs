//! Right rail — stackable `RailCard` deck (polish plan §3.1, ED-C).
//!
//! The deck renders top-to-bottom: a toolbar row with a `+` menu for
//! re-adding dismissed cards, then each `RailCardState` in `RuntimeState.rail_deck`.
//! Per-card events (dismiss / move up / move down / collapse toggle) are
//! collected during rendering and applied after to avoid mutating the deck
//! mid-iteration.

mod cards;
mod deck_toolbar;
mod rail_card;

use eframe::egui;

use crate::state::{AppState, RailCardKind, RailCardMeta, RuntimeState};

use rail_card::rail_card;

pub fn right_rail(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState) {
    if !state.layout.right_sidebar_open {
        return;
    }
    let p = state.theme.palette();

    egui::SidePanel::right("right_rail")
        .default_width(state.layout.right_sidebar_width.max(320.0))
        .width_range(260.0..=460.0)
        .resizable(true)
        .frame(
            egui::Frame::NONE
                .fill(p.sidebar_bg)
                .inner_margin(egui::Margin::symmetric(10, 8)),
        )
        .show(ctx, |ui| {
            state.layout.right_sidebar_width = ui.available_width();

            ui.horizontal(|ui| {
                if let Some(kind) = deck_toolbar::deck_toolbar(ui, &p, &runtime.rail_deck) {
                    runtime.rail_deck.add(kind);
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .small_button(egui::RichText::new("\u{2715}").size(11.0).color(p.text_muted))
                        .on_hover_text("Close panel")
                        .clicked()
                    {
                        state.layout.right_sidebar_open = false;
                    }
                });
            });

            ui.separator();

            // Deferred mutations — collected during iteration, applied after.
            let mut to_dismiss: Option<RailCardKind> = None;
            let mut to_move_up: Option<RailCardKind> = None;
            let mut to_move_down: Option<RailCardKind> = None;
            let mut to_toggle: Option<RailCardKind> = None;

            egui::ScrollArea::vertical()
                .auto_shrink([false; 2])
                .show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 10.0;

                    let total = runtime.rail_deck.cards.len();
                    // Clone the list to avoid borrow conflicts while rendering.
                    let cards_snapshot = runtime.rail_deck.cards.clone();
                    for (idx, card) in cards_snapshot.iter().enumerate() {
                        let evts = rail_card(
                            ui,
                            &p,
                            card,
                            idx > 0,
                            idx + 1 < total,
                            |ui| render_card_body(ui, &p, card.kind, &card.meta, state, runtime),
                        );

                        if evts.dismiss {
                            to_dismiss = Some(card.kind);
                        }
                        if evts.move_up {
                            to_move_up = Some(card.kind);
                        }
                        if evts.move_down {
                            to_move_down = Some(card.kind);
                        }
                        if evts.toggle_collapsed {
                            to_toggle = Some(card.kind);
                        }
                    }

                    if runtime.rail_deck.cards.is_empty() {
                        ui.add_space(24.0);
                        ui.vertical_centered(|ui| {
                            ui.label(
                                egui::RichText::new("Stack is empty")
                                    .size(13.0)
                                    .color(p.text_muted),
                            );
                            ui.add_space(4.0);
                            ui.label(
                                egui::RichText::new("Use + above to add a card.")
                                    .size(11.0)
                                    .color(p.text_muted),
                            );
                        });
                    }
                });

            if let Some(k) = to_dismiss {
                runtime.rail_deck.dismiss(k);
            }
            if let Some(k) = to_move_up {
                runtime.rail_deck.move_up(k);
            }
            if let Some(k) = to_move_down {
                runtime.rail_deck.move_down(k);
            }
            if let Some(k) = to_toggle {
                if let Some(card) = runtime.rail_deck.cards.iter_mut().find(|c| c.kind == k) {
                    card.collapsed = !card.collapsed;
                }
            }
        });
}

fn render_card_body(
    ui: &mut egui::Ui,
    palette: &crate::theme::ThemePalette,
    kind: RailCardKind,
    meta: &RailCardMeta,
    state: &AppState,
    runtime: &RuntimeState,
) {
    match kind {
        RailCardKind::Preview => cards::preview::ui(ui, palette, meta),
        RailCardKind::Changes => cards::changes::ui(ui, palette),
        RailCardKind::Terminal => cards::terminal::ui(ui, palette),
        RailCardKind::Tasks => cards::tasks::ui(ui, palette),
        RailCardKind::Plan => cards::plan::ui(ui, palette),
        RailCardKind::PrReview => cards::pr_review::ui(ui, palette, state, runtime),
        RailCardKind::Logs => cards::logs::ui(ui, palette, meta),
    }
}
