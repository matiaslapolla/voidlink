//! Compact tool-call timeline row. Parity: Codex
//! `Write src/components/PanelGrid.tsx +62 >`.
//!
//! Replaces the verbose `event_row` when the message content parses as a
//! structured tool call.

use eframe::egui::{self, CornerRadius, RichText, Sense};

use crate::state::agents_parse::{ToolCall, ToolCallKind, ToolCallStatus};
use crate::theme::ThemePalette;
use crate::ui::widgets::{self, StatusDotState};

/// Render one tool-call row. Returns the `Response` so callers can wire
/// "expand details on click".
pub fn chat_timeline_row(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    call: &ToolCall,
    duration_ms: Option<u64>,
) -> egui::Response {
    let full_width = ui.available_width();
    let row_height = 26.0;
    let (rect, response) =
        ui.allocate_exact_size(egui::vec2(full_width, row_height), Sense::click());

    if ui.is_rect_visible(rect) {
        let bg = if response.hovered() {
            palette.tool_call_row_bg
        } else {
            palette.surface
        };
        ui.painter().rect_filled(rect, CornerRadius::same(4), bg);

        // Left stripe for running calls.
        if matches!(call.status, ToolCallStatus::Running) {
            let stripe = egui::Rect::from_min_size(rect.min, egui::vec2(2.0, rect.height()));
            ui.painter().rect_filled(
                stripe,
                CornerRadius::same(1),
                palette.tool_call_row_stripe,
            );
        }

        // Layout inside the row.
        let mut cursor_x = rect.min.x + 10.0;

        // Status dot.
        let dot_state = match call.status {
            ToolCallStatus::Running => StatusDotState::Running,
            ToolCallStatus::Success => StatusDotState::Success,
            ToolCallStatus::Error => StatusDotState::Error,
            ToolCallStatus::Skipped => StatusDotState::Idle,
        };
        let dot_color = match dot_state {
            StatusDotState::Running => palette.status_dot_running,
            StatusDotState::Success => palette.status_dot_success,
            StatusDotState::Error => palette.status_dot_error,
            StatusDotState::Idle => palette.status_dot_idle,
            StatusDotState::Warning => palette.status_dot_warning,
        };
        ui.painter().circle_filled(
            egui::pos2(cursor_x + 4.0, rect.center().y),
            3.5,
            dot_color,
        );
        cursor_x += 16.0;

        // Kind label.
        ui.painter().text(
            egui::pos2(cursor_x, rect.center().y),
            egui::Align2::LEFT_CENTER,
            call.kind.label(),
            egui::FontId::monospace(11.5),
            palette.text,
        );
        cursor_x += kind_label_width(call.kind) + 10.0;

        // Path (truncated from the left if too long).
        if let Some(path) = call.path.as_ref() {
            let path_str = path.to_string_lossy();
            let available = rect.max.x - cursor_x - 130.0;
            let truncated = truncate_left(&path_str, available, 11.0);
            ui.painter().text(
                egui::pos2(cursor_x, rect.center().y),
                egui::Align2::LEFT_CENTER,
                truncated,
                egui::FontId::monospace(11.0),
                palette.text_muted,
            );
        } else if let Some(extra) = call.extra.as_ref() {
            ui.painter().text(
                egui::pos2(cursor_x, rect.center().y),
                egui::Align2::LEFT_CENTER,
                extra,
                egui::FontId::proportional(11.0),
                palette.text_muted,
            );
        }

        // Right side: delta + duration.
        let mut right_x = rect.max.x - 10.0;

        // Chevron `>`.
        ui.painter().text(
            egui::pos2(right_x, rect.center().y),
            egui::Align2::RIGHT_CENTER,
            "\u{203A}",
            egui::FontId::proportional(12.0),
            palette.text_muted,
        );
        right_x -= 14.0;

        // Duration (if known).
        if let Some(ms) = duration_ms {
            let text = format_duration(ms);
            let galley = egui::WidgetText::from(
                RichText::new(text).monospace().size(11.0).color(palette.text_muted),
            )
            .into_galley(
                ui,
                Some(egui::TextWrapMode::Extend),
                f32::INFINITY,
                egui::TextStyle::Monospace,
            );
            let w = galley.size().x;
            ui.painter().galley(
                egui::pos2(right_x - w, rect.center().y - galley.size().y * 0.5),
                galley,
                palette.text_muted,
            );
            right_x -= w + 10.0;
        }

        // Delta `+N` `-M`.
        if let (Some(add), del) = (call.add, call.del) {
            let text = match del {
                Some(d) if d > 0 => format!("+{} -{}", add, d),
                _ => format!("+{}", add),
            };
            let galley = egui::WidgetText::from(
                RichText::new(text).monospace().size(11.0).color(palette.delta_add_fg),
            )
            .into_galley(
                ui,
                Some(egui::TextWrapMode::Extend),
                f32::INFINITY,
                egui::TextStyle::Monospace,
            );
            let w = galley.size().x;
            ui.painter().galley(
                egui::pos2(right_x - w, rect.center().y - galley.size().y * 0.5),
                galley,
                palette.delta_add_fg,
            );
        }
    }

    // Silence widget primitives not directly painted above — they're referenced
    // via module-level `use` for clarity.
    let _ = widgets::status_dot;

    response
}

fn kind_label_width(kind: ToolCallKind) -> f32 {
    // Approximation from monospace 11.5 — keeps layout stable without paying
    // for a galley round-trip per row.
    kind.label().len() as f32 * 7.0
}

fn truncate_left(s: &str, max_width_px: f32, char_px: f32) -> String {
    let max_chars = (max_width_px / char_px).floor() as usize;
    if s.len() <= max_chars {
        s.to_string()
    } else {
        let keep = max_chars.saturating_sub(1);
        let start = s.len().saturating_sub(keep);
        format!("\u{2026}{}", &s[start..])
    }
}

fn format_duration(ms: u64) -> String {
    if ms >= 60_000 {
        format!("{}m {}s", ms / 60_000, (ms % 60_000) / 1000)
    } else if ms >= 1000 {
        format!("{:.1}s", ms as f32 / 1000.0)
    } else {
        format!("{}ms", ms)
    }
}
