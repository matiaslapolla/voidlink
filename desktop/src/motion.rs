//! Motion helpers for the egui desktop (polish plan §6).
//!
//! All widget animations route through the `dur` constants below rather than
//! passing raw float durations to `ctx.animate_value_with_time`. That keeps
//! timings consistent across the app and makes a global slowdown / speedup
//! a one-line change for motion-reduction preferences later.

use eframe::egui::{self, Color32};

/// Named durations (in seconds). Matches plan §6 table.
pub mod dur {
    pub const HOVER: f32 = 0.06;
    pub const PRESS: f32 = 0.08;
    pub const ROW_HOVER_FILL: f32 = 0.08;
    pub const FOCUS_RING: f32 = 0.12;
    pub const TAB_SWITCH: f32 = 0.12;
    pub const PR_BAND: f32 = 0.22;
    pub const DIALOG_IN: f32 = 0.10;
    pub const SCROLL_PILL: f32 = 0.16;
    pub const CARD_SETTLE: f32 = 0.18;
    pub const TOAST_IN: f32 = 0.18;
    pub const TOAST_OUT: f32 = 0.14;
    pub const PALETTE_IN: f32 = 0.14;
    pub const SESSION_STRIPE: f32 = 0.12;
    pub const STATUS_DOT_PULSE: f32 = 1.4;
    pub const HERO_DRIFT: f32 = 9.0;
}

/// `ease_out_expo(t)` — sharp entry, long tail. Matches CSS
/// `cubic-bezier(0.16, 1, 0.3, 1)` closely enough for UI work.
///
/// `t ∈ [0, 1]` → output in `[0, 1]`.
#[inline]
pub fn ease_out_expo(t: f32) -> f32 {
    if t >= 1.0 {
        1.0
    } else if t <= 0.0 {
        0.0
    } else {
        1.0 - (-10.0 * t).exp2()
    }
}

/// Rubber-band overshoot: `cubic-bezier(0.34, 1.56, 0.64, 1.0)` vibe.
/// Used for drag-settle on rail cards.
#[inline]
pub fn ease_out_rubber(t: f32) -> f32 {
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    let u = t - 1.0;
    1.0 + c3 * u * u * u + c1 * u * u
}

/// Linear-space colour lerp. `t` is clamped to `[0, 1]`.
#[inline]
pub fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let mix = |x: u8, y: u8| -> u8 {
        (x as f32 + (y as f32 - x as f32) * t).round().clamp(0.0, 255.0) as u8
    };
    Color32::from_rgba_premultiplied(
        mix(a.r(), b.r()),
        mix(a.g(), b.g()),
        mix(a.b(), b.b()),
        mix(a.a(), b.a()),
    )
}

/// Animate a colour per-channel via `ctx.animate_value_with_time`.
///
/// `id` must be unique per anim target (widget instance). Returns the colour
/// currently on screen (in-transition, or fully settled at `target`).
pub fn animate_color(
    ctx: &egui::Context,
    id: egui::Id,
    target: Color32,
    duration: f32,
) -> Color32 {
    let r = ctx.animate_value_with_time(id.with("r"), target.r() as f32, duration);
    let g = ctx.animate_value_with_time(id.with("g"), target.g() as f32, duration);
    let b = ctx.animate_value_with_time(id.with("b"), target.b() as f32, duration);
    let a = ctx.animate_value_with_time(id.with("a"), target.a() as f32, duration);
    Color32::from_rgba_premultiplied(
        r.round().clamp(0.0, 255.0) as u8,
        g.round().clamp(0.0, 255.0) as u8,
        b.round().clamp(0.0, 255.0) as u8,
        a.round().clamp(0.0, 255.0) as u8,
    )
}

/// Triangle/sine pulse in `[0, 1]` driven by `ctx.input(|i| i.time)`.
///
/// Useful for status-dot pulse and PR-band glow — does not allocate animation
/// state, just reads the current frame time.
pub fn pulse_sine(ctx: &egui::Context, period_seconds: f32) -> f32 {
    let t = ctx.input(|i| i.time) as f32;
    let tau = std::f32::consts::TAU;
    ((t * tau / period_seconds).sin() * 0.5 + 0.5).clamp(0.0, 1.0)
}
