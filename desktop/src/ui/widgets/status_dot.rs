//! 6 px status dot with optional neon pulse (polish plan §7.2 `fx::neon_pulse`
//! inlined here for ED-A; can be hoisted into `desktop/src/fx/` later).
//!
//! The pulse is driven by `motion::pulse_sine(ctx, 1.4s)` and modulates the
//! alpha of three stacked halos.

use eframe::egui::{self, Color32, Sense, Stroke};

use crate::motion;
use crate::theme::ThemePalette;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusDotState {
    Running,
    Idle,
    Success,
    Error,
    Warning,
}

impl StatusDotState {
    fn color(&self, palette: &ThemePalette) -> Color32 {
        match self {
            StatusDotState::Running => palette.status_dot_running,
            StatusDotState::Idle => palette.status_dot_idle,
            StatusDotState::Success => palette.status_dot_success,
            StatusDotState::Error => palette.status_dot_error,
            StatusDotState::Warning => palette.status_dot_warning,
        }
    }
}

/// Render the dot. Pass `pulse = true` to animate it (sine breathe on the
/// outer halo). Typically `true` when `state == Running`.
pub fn status_dot(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    state: StatusDotState,
    pulse: bool,
) -> egui::Response {
    let color = state.color(palette);
    let size = egui::vec2(14.0, 14.0);
    let (rect, response) = ui.allocate_exact_size(size, Sense::hover());

    if ui.is_rect_visible(rect) {
        let center = rect.center();
        let pulse_t = if pulse {
            motion::pulse_sine(ui.ctx(), motion::dur::STATUS_DOT_PULSE)
        } else {
            0.0
        };

        // Outer halo — only painted when pulsing or on non-idle states.
        if pulse {
            let outer_alpha = (40.0 + 30.0 * pulse_t) as u8;
            ui.painter().circle_filled(
                center,
                5.5,
                Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), outer_alpha),
            );
            ui.ctx()
                .request_repaint_after(std::time::Duration::from_millis(33));
        }

        // Mid halo
        ui.painter().circle_filled(
            center,
            3.5,
            Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), 128),
        );

        // Core
        ui.painter().circle_filled(center, 2.5, color);

        // Faint outer stroke for contrast on light backgrounds.
        ui.painter()
            .circle_stroke(center, 2.5, Stroke::new(0.5, palette.border));
    }

    response
}
