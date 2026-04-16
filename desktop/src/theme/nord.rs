use eframe::egui::Color32;
use super::ThemePalette;

/// Nord theme — Arctic, north-bluish color palette.
/// https://www.nordtheme.com/
pub fn palette() -> ThemePalette {
    ThemePalette {
        is_dark: true,

        // Polar Night
        background:       Color32::from_rgb(0x2E, 0x34, 0x40), // nord0
        surface:          Color32::from_rgb(0x3B, 0x42, 0x52), // nord1
        surface_elevated: Color32::from_rgb(0x43, 0x4C, 0x5E), // nord2
        sidebar_bg:       Color32::from_rgb(0x2E, 0x34, 0x40), // nord0
        editor_bg:        Color32::from_rgb(0x2E, 0x34, 0x40), // nord0

        // Snow Storm
        text:           Color32::from_rgb(0xEC, 0xEF, 0xF4), // nord6
        text_secondary: Color32::from_rgb(0xD8, 0xDE, 0xE9), // nord4
        text_muted:     Color32::from_rgb(0x4C, 0x56, 0x6A), // nord3

        // Frost
        primary:      Color32::from_rgb(0x88, 0xC0, 0xD0), // nord8 (frost)
        primary_text: Color32::from_rgb(0x2E, 0x34, 0x40), // nord0

        // Aurora
        error:   Color32::from_rgb(0xBF, 0x61, 0x6A), // nord11
        success: Color32::from_rgb(0xA3, 0xBE, 0x8C), // nord14
        warning: Color32::from_rgb(0xEB, 0xCB, 0x8B), // nord13
        info:    Color32::from_rgb(0x81, 0xA1, 0xC1), // nord9

        border:        Color32::from_rgb(0x43, 0x4C, 0x5E), // nord2
        hover:         Color32::from_rgb(0x4C, 0x56, 0x6A), // nord3 — distinct from border
        tab_active_bg: Color32::from_rgb(0x3B, 0x42, 0x52), // nord1
        title_bar_bg:  Color32::from_rgb(0x2E, 0x34, 0x40), // nord0
        status_bar_bg: Color32::from_rgb(0x2E, 0x34, 0x40), // nord0

        // ─── ED-A extensions ───────────────────────────────────────────────
        pr_ready_bg:      Color32::from_rgb(0x4c, 0x7f, 0x5b),
        pr_ready_fg:      Color32::from_rgb(0xec, 0xef, 0xf4),
        pr_ready_glow:    Color32::from_rgba_premultiplied(163, 190, 140, 56),
        pr_conflict_bg:   Color32::from_rgb(0x8a, 0x6d, 0x2c),
        pr_conflict_fg:   Color32::from_rgb(0xec, 0xef, 0xf4),
        pr_draft_bg:      Color32::from_rgb(0x43, 0x4c, 0x5e),
        pr_draft_fg:      Color32::from_rgb(0xd8, 0xde, 0xe9),
        pr_failing_bg:    Color32::from_rgb(0x7d, 0x42, 0x49),
        pr_failing_fg:    Color32::from_rgb(0xec, 0xef, 0xf4),

        delta_add_fg: Color32::from_rgb(0xa3, 0xbe, 0x8c), // nord14
        delta_del_fg: Color32::from_rgb(0xbf, 0x61, 0x6a), // nord11

        rail_card_bg:     Color32::from_rgb(0x3b, 0x42, 0x52), // nord1
        rail_card_border: Color32::from_rgb(0x43, 0x4c, 0x5e), // nord2

        file_badge_bg: Color32::from_rgb(0x43, 0x4c, 0x5e),
        file_badge_fg: Color32::from_rgb(0xe5, 0xe9, 0xf0),

        keyboard_hint_bg: Color32::from_rgb(0x4c, 0x56, 0x6a),
        keyboard_hint_fg: Color32::from_rgb(0xd8, 0xde, 0xe9),

        tool_call_row_bg:     Color32::from_rgb(0x3b, 0x42, 0x52),
        tool_call_row_stripe: Color32::from_rgb(0x88, 0xc0, 0xd0), // nord8

        status_dot_running: Color32::from_rgb(0x81, 0xa1, 0xc1), // nord9
        status_dot_idle:    Color32::from_rgb(0x4c, 0x56, 0x6a),
        status_dot_success: Color32::from_rgb(0xa3, 0xbe, 0x8c),
        status_dot_error:   Color32::from_rgb(0xbf, 0x61, 0x6a),
        status_dot_warning: Color32::from_rgb(0xd0, 0x87, 0x70), // nord12

        log_prefix_tsc:     Color32::from_rgb(0x88, 0xc0, 0xd0),
        log_prefix_vite:    Color32::from_rgb(0xb4, 0x8e, 0xad), // nord15
        log_prefix_cargo:   Color32::from_rgb(0xd0, 0x87, 0x70),
        log_prefix_generic: Color32::from_rgb(0x81, 0xa1, 0xc1),

        toast_info_stripe:    Color32::from_rgb(0x81, 0xa1, 0xc1),
        toast_success_stripe: Color32::from_rgb(0xa3, 0xbe, 0x8c),
        toast_warning_stripe: Color32::from_rgb(0xeb, 0xcb, 0x8b), // nord13
        toast_error_stripe:   Color32::from_rgb(0xbf, 0x61, 0x6a),

        session_active_glow:    Color32::from_rgba_premultiplied(136, 192, 208, 89),
        command_palette_scrim:  Color32::from_rgba_premultiplied(46, 52, 64, 140),

        hero_gradient_a: Color32::from_rgb(0x2e, 0x3d, 0x56),
        hero_gradient_b: Color32::from_rgb(0x2e, 0x34, 0x40),
        hero_gradient_c: Color32::from_rgb(0x35, 0x41, 0x4e),
    }
}
