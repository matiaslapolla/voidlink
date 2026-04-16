//! Animated 3-stop shell gradient (polish plan §7.2 `fx::gradient_background`).
//!
//! Paints ~24 horizontal strips with colours interpolated across the three
//! `hero_gradient_*` tokens, slowly drifting via a sine driver over 9 s.
//! Entirely CPU-side — ~0.3 ms at 1440p.

use eframe::egui::{self, Color32};

use crate::motion;
use crate::theme::ThemePalette;

/// Paint the gradient into `rect` using `painter`. Caller decides whether to
/// paint behind a panel or a full viewport.
pub fn paint(ctx: &egui::Context, painter: &egui::Painter, rect: egui::Rect, palette: &ThemePalette) {
    let strips = 24usize;
    let strip_h = rect.height() / strips as f32;
    let t_anim = motion::pulse_sine(ctx, motion::dur::HERO_DRIFT);

    let a = palette.hero_gradient_a;
    let b = palette.hero_gradient_b;
    let c = palette.hero_gradient_c;

    for i in 0..strips {
        let pos = i as f32 / (strips - 1) as f32;
        // Drift the gradient phase over time.
        let shifted = ((pos + t_anim * 0.25) % 1.0).clamp(0.0, 1.0);
        let color = three_stop(a, b, c, shifted);
        let y0 = rect.min.y + i as f32 * strip_h;
        let y1 = y0 + strip_h + 0.5;
        let strip_rect = egui::Rect::from_min_max(
            egui::pos2(rect.min.x, y0),
            egui::pos2(rect.max.x, y1),
        );
        painter.rect_filled(strip_rect, 0.0, color);
    }
    ctx.request_repaint_after(std::time::Duration::from_millis(33));
}

fn three_stop(a: Color32, b: Color32, c: Color32, t: f32) -> Color32 {
    if t < 0.5 {
        motion::lerp_color(a, b, t * 2.0)
    } else {
        motion::lerp_color(b, c, (t - 0.5) * 2.0)
    }
}
