use eframe::egui::Color32;
use super::ThemePalette;

/// Default Light theme — clean white surfaces with indigo accent.
pub fn palette() -> ThemePalette {
    ThemePalette {
        is_dark: false,

        background:       Color32::from_rgb(250, 250, 252),
        surface:          Color32::from_rgb(255, 255, 255),
        surface_elevated: Color32::from_rgb(245, 245, 248),
        sidebar_bg:       Color32::from_rgb(247, 247, 250),
        editor_bg:        Color32::from_rgb(253, 253, 255),

        text:           Color32::from_rgb(20, 20, 35),
        text_secondary: Color32::from_rgb(80, 80, 100),
        text_muted:     Color32::from_rgb(140, 140, 160),

        primary:      Color32::from_rgb(79, 70, 229),       // indigo-600
        primary_text: Color32::from_rgb(255, 255, 255),

        error:   Color32::from_rgb(220, 38, 38),
        success: Color32::from_rgb(22, 163, 74),
        warning: Color32::from_rgb(202, 138, 4),
        info:    Color32::from_rgb(37, 99, 235),

        border:        Color32::from_rgba_premultiplied(0, 0, 0, 25),  // ~10% black
        hover:         Color32::from_rgb(238, 238, 245),
        tab_active_bg: Color32::from_rgb(255, 255, 255),
        title_bar_bg:  Color32::from_rgb(247, 247, 250),
        status_bar_bg: Color32::from_rgb(247, 247, 250),

        // ─── ED-A extensions ───────────────────────────────────────────────
        pr_ready_bg:      Color32::from_rgb(0xc7, 0xf0, 0xd8),
        pr_ready_fg:      Color32::from_rgb(0x14, 0x53, 0x2d),
        pr_ready_glow:    Color32::from_rgba_premultiplied(22, 163, 74, 36),
        pr_conflict_bg:   Color32::from_rgb(0xff, 0xf1, 0xc2),
        pr_conflict_fg:   Color32::from_rgb(0x5a, 0x3a, 0x02),
        pr_draft_bg:      Color32::from_rgb(0xee, 0xee, 0xf2),
        pr_draft_fg:      Color32::from_rgb(0x4a, 0x4a, 0x5a),
        pr_failing_bg:    Color32::from_rgb(0xff, 0xd4, 0xd4),
        pr_failing_fg:    Color32::from_rgb(0x7f, 0x1d, 0x1d),

        delta_add_fg: Color32::from_rgb(0x15, 0x80, 0x3d),
        delta_del_fg: Color32::from_rgb(0xb9, 0x1c, 0x1c),

        rail_card_bg:     Color32::from_rgb(0xf7, 0xf7, 0xfa),
        rail_card_border: Color32::from_rgba_premultiplied(0, 0, 0, 20),

        file_badge_bg: Color32::from_rgb(0xee, 0xf0, 0xf6),
        file_badge_fg: Color32::from_rgb(0x2a, 0x30, 0x40),

        keyboard_hint_bg: Color32::from_rgb(0xec, 0xec, 0xf2),
        keyboard_hint_fg: Color32::from_rgb(0x4a, 0x4a, 0x5a),

        tool_call_row_bg:     Color32::from_rgb(0xf3, 0xf3, 0xf8),
        tool_call_row_stripe: Color32::from_rgb(0x4f, 0x46, 0xe5),

        status_dot_running: Color32::from_rgb(0x25, 0x63, 0xeb),
        status_dot_idle:    Color32::from_rgb(0x9c, 0xa0, 0xaa),
        status_dot_success: Color32::from_rgb(0x15, 0x80, 0x3d),
        status_dot_error:   Color32::from_rgb(0xb9, 0x1c, 0x1c),
        status_dot_warning: Color32::from_rgb(0xb4, 0x53, 0x09),

        log_prefix_tsc:     Color32::from_rgb(0x03, 0x69, 0xa1),
        log_prefix_vite:    Color32::from_rgb(0x6d, 0x28, 0xd9),
        log_prefix_cargo:   Color32::from_rgb(0xb4, 0x53, 0x09),
        log_prefix_generic: Color32::from_rgb(0x4a, 0x51, 0x60),

        toast_info_stripe:    Color32::from_rgb(0x25, 0x63, 0xeb),
        toast_success_stripe: Color32::from_rgb(0x15, 0x80, 0x3d),
        toast_warning_stripe: Color32::from_rgb(0xb4, 0x53, 0x09),
        toast_error_stripe:   Color32::from_rgb(0xb9, 0x1c, 0x1c),

        session_active_glow:    Color32::from_rgba_premultiplied(79, 70, 229, 64),
        command_palette_scrim:  Color32::from_rgba_premultiplied(20, 20, 35, 71),

        hero_gradient_a: Color32::from_rgb(0xe8, 0xea, 0xff),
        hero_gradient_b: Color32::from_rgb(0xf7, 0xf7, 0xfa),
        hero_gradient_c: Color32::from_rgb(0xed, 0xf0, 0xff),
    }
}
