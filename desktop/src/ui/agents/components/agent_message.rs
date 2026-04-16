//! Redesigned chat message renderer (ED-D).
//!
//! Two render modes:
//!   - User messages  → right-aligned filled bubble (`surface_elevated`)
//!   - Assistant/system messages → bubble-less prose with status-tint side stripe
//!
//! The message body is split into `MessageSegment::Text` + `FileBadge` and
//! rendered inline; callers pass `on_open_file` to hook clicks on badges.

use eframe::egui::{self, CornerRadius, RichText, Stroke};

use crate::state::agents::{ChatMessage, MessageRole, MessageStatus};
use crate::state::agents_parse::{split_file_badges, MessageSegment};
use crate::theme::ThemePalette;
use crate::ui::widgets;

pub fn agent_message<F: FnMut(&str)>(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    msg: &ChatMessage,
    mut on_open_file: F,
) {
    let is_user = matches!(msg.role, MessageRole::User);

    if is_user {
        render_user_bubble(ui, palette, msg, &mut on_open_file);
    } else {
        render_assistant_prose(ui, palette, msg, &mut on_open_file);
    }
    ui.add_space(8.0);
}

fn render_user_bubble<F: FnMut(&str)>(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    msg: &ChatMessage,
    on_open_file: &mut F,
) {
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
        let bubble_max = (ui.available_width() * 0.82).min(560.0);
        egui::Frame::NONE
            .fill(palette.surface_elevated)
            .stroke(Stroke::new(1.0, palette.border))
            .corner_radius(CornerRadius {
                nw: 12,
                ne: 12,
                sw: 12,
                se: 4,
            })
            .inner_margin(egui::Margin::symmetric(12, 8))
            .show(ui, |ui| {
                ui.set_max_width(bubble_max);
                render_body(ui, palette, &msg.content, on_open_file);
            });
    });
}

fn render_assistant_prose<F: FnMut(&str)>(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    msg: &ChatMessage,
    on_open_file: &mut F,
) {
    let stripe_color = match msg.status {
        MessageStatus::Error => Some(palette.error),
        MessageStatus::Warn => Some(palette.warning),
        MessageStatus::Success => Some(palette.success),
        MessageStatus::Info => Some(palette.info),
        MessageStatus::None => None,
    };

    ui.horizontal(|ui| {
        // Left stripe (4 px) for status-tinted messages; spacer otherwise.
        let stripe_width = if stripe_color.is_some() { 4.0 } else { 12.0 };
        let (stripe_rect, _) = ui.allocate_exact_size(
            egui::vec2(stripe_width, 2.0),
            egui::Sense::hover(),
        );
        if let Some(color) = stripe_color {
            // Paint a tall thin stripe — use `hline`-like rect spanning the
            // expected bubble height. A small fudge (40 px) covers short
            // messages; longer messages still get a visible accent because
            // the stripe is repainted on scroll.
            let span = egui::Rect::from_min_size(
                stripe_rect.min,
                egui::vec2(stripe_width, 40.0),
            );
            ui.painter().rect_filled(
                span,
                CornerRadius::same(2),
                egui::Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), 180),
            );
        }

        ui.add_space(6.0);

        ui.vertical(|ui| {
            render_body(ui, palette, &msg.content, on_open_file);
        });
    });
}

fn render_body<F: FnMut(&str)>(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    content: &str,
    on_open_file: &mut F,
) {
    let segments = split_file_badges(content);

    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = egui::vec2(4.0, 2.0);
        for seg in &segments {
            match seg {
                MessageSegment::Text(text) => {
                    // Split on newline so `horizontal_wrapped` still flows
                    // paragraphs naturally.
                    let mut first = true;
                    for line in text.split_inclusive('\n') {
                        if !first {
                            ui.end_row();
                        }
                        first = false;
                        ui.add(egui::Label::new(
                            RichText::new(line).size(12.5).color(palette.text),
                        ));
                    }
                }
                MessageSegment::FileBadge(path) => {
                    let r = widgets::file_badge(ui, palette, path);
                    if r.clicked() {
                        on_open_file(path);
                    }
                }
            }
        }
    });
}
