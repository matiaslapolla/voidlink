//! Window controls (min / max / close) for the custom title bar.
//!
//! The close button has a vivid red hover; min/max fall back to the theme's
//! generic hover. Split out of the old monolithic `title_bar.rs` so the main
//! title-bar composition stays readable.

use eframe::egui::{self, Color32, CornerRadius, Sense};

use crate::theme::ThemePalette;

pub fn window_buttons(ui: &mut egui::Ui, palette: &ThemePalette) {
    let btn_size = egui::vec2(36.0, 26.0);

    // Close — red hover, white icon.
    let close_hover = Color32::from_rgb(232, 60, 60);
    render_button(ui, "\u{2715}", btn_size, palette.text, close_hover, "Close", |ctx| {
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    });

    // Maximize.
    render_button(
        ui,
        "\u{25A1}",
        btn_size,
        palette.text,
        palette.hover,
        "Maximize",
        |ctx| ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(true)),
    );

    // Minimize.
    render_button(
        ui,
        "\u{2500}",
        btn_size,
        palette.text,
        palette.hover,
        "Minimize",
        |ctx| ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true)),
    );
}

fn render_button(
    ui: &mut egui::Ui,
    icon: &str,
    size: egui::Vec2,
    text_color: Color32,
    hover_bg: Color32,
    tooltip: &str,
    action: impl FnOnce(&egui::Context),
) {
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    let hovered = response.hovered();

    let text_c = if hovered && hover_bg.r() > 200 {
        Color32::WHITE
    } else {
        text_color
    };

    if hovered {
        ui.painter().rect_filled(rect, CornerRadius::same(4), hover_bg);
    }
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        icon,
        egui::FontId::proportional(12.0),
        text_c,
    );

    if response.on_hover_text(tooltip).clicked() {
        action(ui.ctx());
    }
}
