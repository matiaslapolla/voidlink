//! Two-line session row. Parity: Conductor
//! `⌥ archive-in-repo-details   +312 -332 / kampala-v3 · Ready to merge   ⌘1`.

use eframe::egui::{self, CornerRadius, RichText, Sense};

use crate::motion;
use crate::state::{Session, SessionStatus};
use crate::theme::ThemePalette;
use crate::ui::widgets;

use super::session_status_chip::session_status_chip;

pub fn session_row(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    session: &Session,
    active: bool,
) -> egui::Response {
    let full_width = ui.available_width();
    let row_height = 44.0;
    let (rect, response) =
        ui.allocate_exact_size(egui::vec2(full_width, row_height), Sense::click());

    // Animated hover fill alpha.
    let anim_id = ui.id().with(("session_row_hover", &session.id));
    let target = if response.hovered() || active { 1.0_f32 } else { 0.0 };
    let t_raw =
        ui.ctx().animate_value_with_time(anim_id, target, motion::dur::ROW_HOVER_FILL);
    let t = motion::ease_out_expo(t_raw);

    if ui.is_rect_visible(rect) {
        if t > 0.02 {
            let alpha = (t * 255.0 * 0.35).clamp(0.0, 255.0) as u8;
            let bg = egui::Color32::from_rgba_unmultiplied(
                palette.hover.r(),
                palette.hover.g(),
                palette.hover.b(),
                alpha,
            );
            ui.painter().rect_filled(rect, CornerRadius::same(6), bg);
        }

        if active {
            // 2 px left stripe in the primary accent. Slides in via width anim.
            let stripe_anim = ui.id().with(("session_row_stripe", &session.id));
            let w_target = if active { 3.0_f32 } else { 0.0 };
            let w = ui
                .ctx()
                .animate_value_with_time(stripe_anim, w_target, motion::dur::SESSION_STRIPE);
            let stripe = egui::Rect::from_min_size(
                rect.min,
                egui::vec2(w, rect.height()),
            );
            ui.painter().rect_filled(stripe, CornerRadius::same(2), palette.primary);
        }

        // Line 1: ⌥ <name>    <+add -del>
        let name_pos = egui::pos2(rect.min.x + 12.0, rect.min.y + 8.0);
        ui.painter().text(
            name_pos,
            egui::Align2::LEFT_TOP,
            format!("\u{2325} {}", session.name),
            egui::FontId::proportional(12.5),
            palette.text,
        );

        // Delta count top-right.
        let delta_text = match (session.last_delta.add, session.last_delta.del) {
            (0, 0) => String::new(),
            (a, 0) => format!("+{}", a),
            (0, d) => format!("-{}", d),
            (a, d) => format!("+{} -{}", a, d),
        };
        if !delta_text.is_empty() {
            ui.painter().text(
                egui::pos2(rect.max.x - 10.0, rect.min.y + 8.0),
                egui::Align2::RIGHT_TOP,
                delta_text,
                egui::FontId::monospace(11.0),
                palette.delta_add_fg,
            );
        }
    }

    // Line 2: parent-branch · status chip   [⌘N]
    // Paint inside the row rect using absolute coordinates via a new ui scope.
    let line2_rect = egui::Rect::from_min_size(
        egui::pos2(rect.min.x + 12.0, rect.min.y + 24.0),
        egui::vec2(rect.width() - 18.0, 18.0),
    );
    let line2_ui = &mut ui.new_child(
        egui::UiBuilder::new().max_rect(line2_rect)
            .layout(egui::Layout::left_to_right(egui::Align::Center)),
    );
    line2_ui.spacing_mut().item_spacing.x = 6.0;
    line2_ui.add(egui::Label::new(
        RichText::new(&session.parent_branch)
            .monospace()
            .size(10.5)
            .color(palette.text_muted),
    ));
    line2_ui.add(egui::Label::new(
        RichText::new("\u{00B7}")
            .size(10.5)
            .color(palette.text_muted),
    ));
    let _ = session_status_chip(line2_ui, palette, session.status);
    if let Some(idx) = session.shortcut_index {
        line2_ui.with_layout(
            egui::Layout::right_to_left(egui::Align::Center),
            |ui| {
                let _ = widgets::keyboard_hint_chip(
                    ui,
                    palette,
                    &["\u{2318}", &idx.to_string()],
                    None,
                );
            },
        );
    }

    // Reserve SessionStatus enum use so the imports don't warn when the match
    // arms above are sparse.
    let _ = SessionStatus::Idle;

    response
}
