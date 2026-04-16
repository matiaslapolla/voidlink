//! Collapsible `> N tool calls, M messages` row. Parity: Conductor chat
//! `> 13 tool calls, 7 messages`.
//!
//! The collapsed/expanded state is owned by the caller (`ToolCallGroupState`)
//! so the chat can persist it across frames without pulling in
//! `CollapsingHeader`'s auto-state.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::theme::ThemePalette;

pub struct ToolCallGroupState {
    pub open: bool,
}

impl ToolCallGroupState {
    pub fn new(default_open: bool) -> Self {
        Self { open: default_open }
    }
}

/// Render the header row. Returns the header response; the caller is
/// responsible for rendering child rows inside the `if state.open { ... }`
/// branch it already owns.
pub fn tool_call_group(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    state: &mut ToolCallGroupState,
    title: &str,
    count: usize,
) -> egui::Response {
    let full_width = ui.available_width();
    let row_height = 26.0;
    let (rect, response) =
        ui.allocate_exact_size(egui::vec2(full_width, row_height), Sense::click());

    if response.clicked() {
        state.open = !state.open;
    }

    if ui.is_rect_visible(rect) {
        let bg = if response.hovered() {
            palette.tool_call_row_bg
        } else {
            palette.surface
        };
        ui.painter().rect_filled(rect, CornerRadius::same(4), bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(4),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );

        let arrow = if state.open { "\u{25BC}" } else { "\u{25B6}" }; // ▼ / ▶
        let arrow_pos = egui::pos2(rect.min.x + 10.0, rect.center().y);
        ui.painter().text(
            arrow_pos,
            egui::Align2::LEFT_CENTER,
            arrow,
            egui::FontId::monospace(11.0),
            palette.text_muted,
        );

        let label = format!("{} · {} tool calls", title, count);
        let text_pos = egui::pos2(rect.min.x + 28.0, rect.center().y);
        ui.painter().text(
            text_pos,
            egui::Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(13.0),
            palette.text,
        );

        // Right-aligned count badge.
        let count_text = RichText::new(format!("{}", count))
            .monospace()
            .size(11.0)
            .color(palette.text_muted);
        let galley = egui::WidgetText::from(count_text).into_galley(
            ui,
            Some(egui::TextWrapMode::Extend),
            f32::INFINITY,
            egui::TextStyle::Monospace,
        );
        let right_pos = egui::pos2(rect.max.x - 12.0 - galley.size().x, rect.center().y - galley.size().y * 0.5);
        ui.painter().galley(right_pos, galley, palette.text_muted);
    }

    response
}
