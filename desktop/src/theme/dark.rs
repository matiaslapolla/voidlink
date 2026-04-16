use eframe::egui::Color32;
use super::ThemePalette;

/// Default Dark theme — indigo-accented deep backgrounds.
/// Translated from the SolidJS frontend's OKLCH palette.
pub fn palette() -> ThemePalette {
    ThemePalette {
        is_dark: true,

        background:       Color32::from_rgb(18, 18, 33),   // oklch(0.145 0.012 270)
        surface:          Color32::from_rgb(28, 28, 48),    // oklch(0.185 0.012 270)
        surface_elevated: Color32::from_rgb(38, 38, 58),    // oklch(0.215 0.012 270)
        sidebar_bg:       Color32::from_rgb(22, 22, 40),    // oklch(0.160 0.014 270)
        editor_bg:        Color32::from_rgb(15, 15, 28),    // oklch(0.130 0.010 270)

        text:           Color32::from_rgb(235, 235, 245),   // oklch(0.950 0.008 270)
        text_secondary: Color32::from_rgb(175, 175, 195),   // oklch(0.750 0.010 270)
        text_muted:     Color32::from_rgb(105, 105, 130),   // oklch(0.500 0.012 270)

        primary:      Color32::from_rgb(99, 102, 241),      // oklch(0.655 0.200 270) ≈ indigo-500
        primary_text: Color32::from_rgb(245, 245, 255),     // oklch(0.980 0.010 270)

        error:   Color32::from_rgb(239, 68, 68),            // red-500
        success: Color32::from_rgb(34, 197, 94),            // green-500
        warning: Color32::from_rgb(234, 179, 8),            // yellow-500
        info:    Color32::from_rgb(59, 130, 246),           // blue-500

        border:        Color32::from_rgba_premultiplied(255, 255, 255, 30), // ~12% white
        hover:         Color32::from_rgb(45, 45, 70),
        tab_active_bg: Color32::from_rgb(35, 35, 58),
        title_bar_bg:  Color32::from_rgb(15, 15, 28),
        status_bar_bg: Color32::from_rgb(22, 22, 40),

        // ─── ED-A extensions ───────────────────────────────────────────────
        pr_ready_bg:      Color32::from_rgb(0x1f, 0x6f, 0x43),
        pr_ready_fg:      Color32::from_rgb(0xe7, 0xfc, 0xef),
        pr_ready_glow:    Color32::from_rgba_premultiplied(74, 222, 128, 56),  // ~22% alpha premultiplied
        pr_conflict_bg:   Color32::from_rgb(0x7a, 0x5a, 0x14),
        pr_conflict_fg:   Color32::from_rgb(0xfe, 0xf9, 0xc3),
        pr_draft_bg:      Color32::from_rgb(0x2e, 0x2e, 0x42),
        pr_draft_fg:      Color32::from_rgb(0xaf, 0xaf, 0xc3),
        pr_failing_bg:    Color32::from_rgb(0x6a, 0x1e, 0x22),
        pr_failing_fg:    Color32::from_rgb(0xfe, 0xca, 0xca),

        delta_add_fg: Color32::from_rgb(0x4a, 0xde, 0x80),
        delta_del_fg: Color32::from_rgb(0xf8, 0x71, 0x71),

        rail_card_bg:     Color32::from_rgb(0x1a, 0x1a, 0x2b),
        rail_card_border: Color32::from_rgba_premultiplied(255, 255, 255, 20), // ~8% alpha

        file_badge_bg: Color32::from_rgb(0x23, 0x23, 0x38),
        file_badge_fg: Color32::from_rgb(0xd5, 0xd5, 0xe5),

        keyboard_hint_bg: Color32::from_rgb(0x2d, 0x2d, 0x46),
        keyboard_hint_fg: Color32::from_rgb(0xaf, 0xaf, 0xc3),

        tool_call_row_bg:     Color32::from_rgb(0x1e, 0x1e, 0x32),
        tool_call_row_stripe: Color32::from_rgb(0x63, 0x66, 0xf1),

        status_dot_running: Color32::from_rgb(0x60, 0xa5, 0xfa),
        status_dot_idle:    Color32::from_rgb(0x6a, 0x6a, 0x87),
        status_dot_success: Color32::from_rgb(0x22, 0xc5, 0x5e),
        status_dot_error:   Color32::from_rgb(0xef, 0x44, 0x44),
        status_dot_warning: Color32::from_rgb(0xf5, 0x9e, 0x0b),

        log_prefix_tsc:     Color32::from_rgb(0x38, 0xbd, 0xf8),
        log_prefix_vite:    Color32::from_rgb(0xa7, 0x8b, 0xfa),
        log_prefix_cargo:   Color32::from_rgb(0xf5, 0x9e, 0x0b),
        log_prefix_generic: Color32::from_rgb(0x9c, 0xa0, 0xaa),

        toast_info_stripe:    Color32::from_rgb(0x60, 0xa5, 0xfa),
        toast_success_stripe: Color32::from_rgb(0x22, 0xc5, 0x5e),
        toast_warning_stripe: Color32::from_rgb(0xf5, 0x9e, 0x0b),
        toast_error_stripe:   Color32::from_rgb(0xef, 0x44, 0x44),

        session_active_glow:    Color32::from_rgba_premultiplied(99, 102, 241, 89),   // ~35% alpha
        command_palette_scrim:  Color32::from_rgba_premultiplied(0, 0, 0, 140),        // ~55% alpha

        hero_gradient_a: Color32::from_rgb(0x1a, 0x13, 0x45),
        hero_gradient_b: Color32::from_rgb(0x0a, 0x0a, 0x18),
        hero_gradient_c: Color32::from_rgb(0x0f, 0x20, 0x30),
    }
}
