//! `TypingIndicator` — 3 bouncing dots shown while the agent is running and
//! no assistant message has landed yet. Parity with the SolidJS version in
//! `AgentChatView.tsx:344-357`.
//!
//! Each dot has its own staggered alpha animated via
//! `egui::Context::animate_value_with_time`. The function requests a repaint
//! while it is visible so the animation keeps ticking.

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::theme::ThemePalette;

/// Dot cycle length in seconds (one full up-down bounce).
const CYCLE_S: f32 = 1.2;
/// Dot stagger offset in seconds between consecutive dots.
const STAGGER_S: f32 = 0.18;
/// Visual dot radius.
const DOT_RADIUS: f32 = 3.0;
/// Horizontal gap between dots.
const DOT_GAP: f32 = 4.0;

/// Render a row with a bubble-like frame containing three bouncing dots.
/// Must be invoked inside a vertical layout. Nothing is returned.
pub fn show(ui: &mut egui::Ui, palette: &ThemePalette) {
    let dots = 3_usize;
    // Allocate the row first so the painter lines up with the bubble.
    let size = egui::vec2(
        DOT_RADIUS * 2.0 * dots as f32 + DOT_GAP * (dots as f32 - 1.0) + 24.0,
        20.0,
    );

    ui.horizontal(|ui| {
        ui.add_space(32.0);
        egui::Frame::NONE
            .fill(palette.surface)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(CornerRadius {
                nw: 12,
                ne: 12,
                sw: 4,
                se: 12,
            })
            .inner_margin(egui::Margin::symmetric(10, 6))
            .show(ui, |ui| {
                let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
                let ctx = ui.ctx().clone();
                let now = ui.input(|i| i.time) as f32;
                let painter = ui.painter_at(rect);

                let base_x = rect.left() + DOT_RADIUS + 6.0;
                let center_y = rect.center().y;

                for i in 0..dots {
                    // Per-dot animated alpha in [60, 220].
                    let phase_key = egui::Id::new(("agent_typing_dot", i));
                    let offset_t = now + i as f32 * STAGGER_S;
                    let wave = ((offset_t * std::f32::consts::TAU / CYCLE_S).sin() + 1.0) * 0.5;
                    let target = 60.0 + wave * 160.0;
                    let alpha = ctx.animate_value_with_time(phase_key, target, 0.08);
                    let alpha_u8 = alpha.clamp(0.0, 255.0) as u8;

                    let cx = base_x + i as f32 * (DOT_RADIUS * 2.0 + DOT_GAP);
                    let color = egui::Color32::from_rgba_unmultiplied(
                        palette.primary.r(),
                        palette.primary.g(),
                        palette.primary.b(),
                        alpha_u8,
                    );
                    painter.circle_filled(egui::pos2(cx, center_y), DOT_RADIUS, color);
                }
            });
    });

    ui.ctx().request_repaint();
}
