//! Chat bubble renderer (Phase 7B).
//!
//! Each `ChatMessage` is shown as an `egui::Frame` aligned left (assistant /
//! system / tool) or right (user). Role drives background; `MessageStatus`
//! drives a subtle left-border tint (info/warn/error/success). Matches the
//! SolidJS layout in `frontend/src/components/agent/AgentChatView.tsx`.
//!
//! Phase 7E replaced the chat's flat message list with the `EventTimeline`
//! component. The chat-bubble renderer is kept here because it's still used
//! by the `TaskCreateForm` welcome screen and may be re-adopted for per-turn
//! chat messages in Phase 8. Mark the module as allow-dead-code to avoid
//! noise.
#![allow(dead_code)]

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::agents::{ChatMessage, MessageRole, MessageStatus};
use crate::theme::ThemePalette;

/// Render one chat bubble row. Must be called inside a vertical layout.
pub fn show(ui: &mut egui::Ui, msg: &ChatMessage, p: ThemePalette) {
    let is_user = matches!(msg.role, MessageRole::User);
    let bubble_max = (ui.available_width() * 0.85).min(640.0);

    let layout = if is_user {
        egui::Layout::right_to_left(egui::Align::Min)
    } else {
        egui::Layout::left_to_right(egui::Align::Min)
    };

    ui.with_layout(layout, |ui| {
        ui.add_space(4.0);

        // Avatar circle (assistant / system only — user avatar is trailing).
        if !is_user {
            avatar_dot(ui, msg.role, p);
            ui.add_space(6.0);
        }

        // Bubble frame.
        let (fill, text_color) = bubble_colors(msg, p);
        let border = match msg.status {
            MessageStatus::Error => Some(p.error),
            MessageStatus::Warn => Some(p.warning),
            MessageStatus::Success => Some(p.success),
            MessageStatus::Info => Some(p.info),
            MessageStatus::None => None,
        };
        let stroke = match border {
            Some(c) => egui::Stroke::new(1.0, with_alpha(c, 140)),
            None => egui::Stroke::new(1.0, p.border),
        };

        let corner_main = 12;
        let corner_tail = 4;
        let corner = if is_user {
            CornerRadius {
                nw: corner_main,
                ne: corner_main,
                sw: corner_main,
                se: corner_tail,
            }
        } else {
            CornerRadius {
                nw: corner_main,
                ne: corner_main,
                sw: corner_tail,
                se: corner_main,
            }
        };

        egui::Frame::NONE
            .fill(fill)
            .stroke(stroke)
            .corner_radius(corner)
            .inner_margin(egui::Margin::symmetric(12, 8))
            .show(ui, |ui| {
                ui.set_max_width(bubble_max);
                // Left status gutter for level tint (skipped for user/plain).
                if let Some(c) = border {
                    let rect = ui.available_rect_before_wrap();
                    let gutter = egui::Rect::from_min_size(
                        rect.min,
                        egui::vec2(3.0, rect.height()),
                    );
                    ui.painter().rect_filled(gutter, 0.0, with_alpha(c, 180));
                    ui.add_space(6.0);
                }
                ui.vertical(|ui| {
                    ui.label(
                        egui::RichText::new(&msg.content)
                            .size(12.5)
                            .color(text_color),
                    );
                    ui.add_space(2.0);
                    ui.label(
                        egui::RichText::new(format_time(msg.timestamp_ms))
                            .size(10.0)
                            .color(p.text_muted),
                    );
                });
            });

        if is_user {
            ui.add_space(6.0);
            avatar_dot(ui, msg.role, p);
        }
    });
    ui.add_space(6.0);
}

fn bubble_colors(msg: &ChatMessage, p: ThemePalette) -> (egui::Color32, egui::Color32) {
    match msg.role {
        MessageRole::User => (p.primary, p.primary_text),
        MessageRole::System => (p.surface_elevated, p.text_secondary),
        MessageRole::Assistant => {
            // Level-tinted fills for assistant bubbles.
            match msg.status {
                MessageStatus::Error => (with_alpha(p.error, 40), p.text),
                MessageStatus::Warn => (with_alpha(p.warning, 40), p.text),
                MessageStatus::Success => (with_alpha(p.success, 40), p.text),
                _ => (p.surface, p.text),
            }
        }
    }
}

fn avatar_dot(ui: &mut egui::Ui, role: MessageRole, p: ThemePalette) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(22.0, 22.0), egui::Sense::hover());
    let color = match role {
        MessageRole::User => p.surface_elevated,
        MessageRole::Assistant => with_alpha(p.primary, 60),
        MessageRole::System => p.surface,
    };
    ui.painter().circle_filled(rect.center(), 11.0, color);
    let glyph = match role {
        MessageRole::User => "\u{1F464}",      // bust
        MessageRole::Assistant => "\u{1F916}", // robot
        MessageRole::System => "\u{2699}",     // gear
    };
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        glyph,
        egui::FontId::proportional(12.0),
        match role {
            MessageRole::User => p.text_secondary,
            MessageRole::Assistant => p.primary,
            MessageRole::System => p.text_muted,
        },
    );
}

fn with_alpha(c: egui::Color32, a: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

fn format_time(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let secs = ms / 1000;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}
