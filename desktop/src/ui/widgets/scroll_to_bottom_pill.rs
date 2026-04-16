//! Floating "Scroll to bottom" pill. Parity: Conductor chat.
//!
//! This widget is rendered **as a floating Area** — callers place it inside a
//! `CentralPanel` that already contains the scroll view; the pill anchors to
//! the bottom-center of the panel.

use eframe::egui::{self, CornerRadius, RichText, Sense, Stroke};

use crate::motion;
use crate::theme::ThemePalette;

/// Returns true when the user clicked the pill. Pass `visible = false` to
/// animate it out; the pill paints nothing once fully faded.
pub fn scroll_to_bottom_pill(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    visible: bool,
    unread_count: u32,
) -> bool {
    let anim_id = ui.id().with("scroll_to_bottom_pill");
    let target = if visible { 1.0_f32 } else { 0.0 };
    let t_raw = ui.ctx().animate_value_with_time(
        anim_id,
        target,
        motion::dur::SCROLL_PILL,
    );
    let t = motion::ease_out_expo(t_raw);
    if t < 0.02 {
        return false;
    }

    let label = if unread_count == 0 {
        "\u{2193} Scroll to bottom".to_string()
    } else {
        format!("\u{2193} {} new", unread_count)
    };

    let text = RichText::new(label).size(11.5).color(palette.primary_text);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );

    let padding = egui::vec2(12.0, 5.0);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());

    if ui.is_rect_visible(rect) {
        let alpha = (t * 255.0) as u8;
        let bg = egui::Color32::from_rgba_unmultiplied(
            palette.primary.r(),
            palette.primary.g(),
            palette.primary.b(),
            alpha,
        );
        ui.painter().rect_filled(rect, CornerRadius::same(14), bg);
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(14),
            Stroke::new(1.0, palette.border),
            egui::StrokeKind::Inside,
        );
        let text_pos = rect.min + padding;
        ui.painter().galley(text_pos, galley, palette.primary_text);
    }

    response.clicked() && visible
}
