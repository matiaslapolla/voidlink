mod dark;
mod light;
mod nord;

use eframe::egui::{self, Color32, Stroke, Visuals};
use eframe::epaint::CornerRadius;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Theme {
    Dark,
    Light,
    Nord,
}

impl Theme {
    pub const ALL: &[Theme] = &[Theme::Dark, Theme::Light, Theme::Nord];

    pub fn name(&self) -> &str {
        match self {
            Theme::Dark => "Default Dark",
            Theme::Light => "Default Light",
            Theme::Nord => "Nord",
        }
    }

    pub fn palette(&self) -> ThemePalette {
        match self {
            Theme::Dark => dark::palette(),
            Theme::Light => light::palette(),
            Theme::Nord => nord::palette(),
        }
    }

    pub fn apply(&self, ctx: &egui::Context) {
        let p = self.palette();
        let mut visuals = if p.is_dark { Visuals::dark() } else { Visuals::light() };

        visuals.override_text_color = Some(p.text);

        // Window
        visuals.window_fill = p.surface;
        visuals.window_stroke = Stroke::new(1.0, p.border);
        visuals.window_corner_radius = CornerRadius::same(8);

        // Panel
        visuals.panel_fill = p.background;

        // Menu
        visuals.menu_corner_radius = CornerRadius::same(6);

        // Widgets
        visuals.widgets.noninteractive.bg_fill = p.surface;
        visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, p.text_secondary);
        visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, p.border);
        visuals.widgets.noninteractive.corner_radius = CornerRadius::same(6);

        visuals.widgets.inactive.bg_fill = p.surface_elevated;
        visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, p.text);
        visuals.widgets.inactive.bg_stroke = Stroke::NONE;
        visuals.widgets.inactive.corner_radius = CornerRadius::same(6);

        visuals.widgets.hovered.bg_fill = p.hover;
        visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, p.text);
        visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, p.primary.linear_multiply(0.5));
        visuals.widgets.hovered.corner_radius = CornerRadius::same(6);

        visuals.widgets.active.bg_fill = p.primary;
        visuals.widgets.active.fg_stroke = Stroke::new(1.0, p.primary_text);
        visuals.widgets.active.bg_stroke = Stroke::NONE;
        visuals.widgets.active.corner_radius = CornerRadius::same(6);

        visuals.widgets.open.bg_fill = p.surface_elevated;
        visuals.widgets.open.fg_stroke = Stroke::new(1.0, p.text);
        visuals.widgets.open.bg_stroke = Stroke::new(1.0, p.border);
        visuals.widgets.open.corner_radius = CornerRadius::same(6);

        visuals.selection.bg_fill = p.primary.linear_multiply(0.3);
        visuals.selection.stroke = Stroke::new(1.0, p.primary);

        visuals.extreme_bg_color = p.editor_bg;
        visuals.faint_bg_color = p.surface_elevated;

        ctx.set_visuals(visuals);
    }
}

impl Default for Theme {
    fn default() -> Self {
        Theme::Dark
    }
}

/// Concrete color palette that each theme provides.
///
/// ED-A extends this struct beyond the base 20-field palette with 34 tokens
/// from the polish plan §5 (PR chrome, delta counts, rail cards, file badges,
/// keyboard hints, tool-call rows, status dots, log prefixes, toasts, hero
/// gradients, session glows). Added in-place rather than introducing a parallel
/// `ThemeTokens` struct so widgets can keep importing `ThemePalette`.
#[derive(Debug, Clone, Copy)]
pub struct ThemePalette {
    pub is_dark: bool,

    // ─── Base surfaces ─────────────────────────────────────────────────────
    pub background: Color32,
    pub surface: Color32,
    pub surface_elevated: Color32,
    pub sidebar_bg: Color32,
    pub editor_bg: Color32,

    // ─── Text ──────────────────────────────────────────────────────────────
    pub text: Color32,
    pub text_secondary: Color32,
    pub text_muted: Color32,

    // ─── Primary accent ────────────────────────────────────────────────────
    pub primary: Color32,
    pub primary_text: Color32,

    // ─── Semantic ──────────────────────────────────────────────────────────
    pub error: Color32,
    pub success: Color32,
    pub warning: Color32,
    pub info: Color32,

    // ─── Borders & interaction ─────────────────────────────────────────────
    pub border: Color32,
    pub hover: Color32,
    pub tab_active_bg: Color32,
    pub title_bar_bg: Color32,
    pub status_bar_bg: Color32,

    // ─── ED-A extensions (polish plan §5) ──────────────────────────────────

    // PR chrome bands (Conductor green band / amber conflicts / muted draft / red failing)
    pub pr_ready_bg: Color32,
    pub pr_ready_fg: Color32,
    pub pr_ready_glow: Color32,
    pub pr_conflict_bg: Color32,
    pub pr_conflict_fg: Color32,
    pub pr_draft_bg: Color32,
    pub pr_draft_fg: Color32,
    pub pr_failing_bg: Color32,
    pub pr_failing_fg: Color32,

    // Delta counts (+X/-Y monospace)
    pub delta_add_fg: Color32,
    pub delta_del_fg: Color32,

    // Rail card surfaces
    pub rail_card_bg: Color32,
    pub rail_card_border: Color32,

    // Inline file badge chip (@File.tsx)
    pub file_badge_bg: Color32,
    pub file_badge_fg: Color32,

    // Keyboard hint pill (⌘L to focus)
    pub keyboard_hint_bg: Color32,
    pub keyboard_hint_fg: Color32,

    // Tool call timeline row
    pub tool_call_row_bg: Color32,
    pub tool_call_row_stripe: Color32,

    // Status dots
    pub status_dot_running: Color32,
    pub status_dot_idle: Color32,
    pub status_dot_success: Color32,
    pub status_dot_error: Color32,
    pub status_dot_warning: Color32,

    // Terminal log prefix colors
    pub log_prefix_tsc: Color32,
    pub log_prefix_vite: Color32,
    pub log_prefix_cargo: Color32,
    pub log_prefix_generic: Color32,

    // Toast variant stripes
    pub toast_info_stripe: Color32,
    pub toast_success_stripe: Color32,
    pub toast_warning_stripe: Color32,
    pub toast_error_stripe: Color32,

    // Misc
    pub session_active_glow: Color32,
    pub command_palette_scrim: Color32,

    // Hero shader gradient stops (used by fx::gradient_background / shader_background)
    pub hero_gradient_a: Color32,
    pub hero_gradient_b: Color32,
    pub hero_gradient_c: Color32,
}
