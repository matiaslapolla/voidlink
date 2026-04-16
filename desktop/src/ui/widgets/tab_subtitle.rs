//! Sub-tab strip with underline-under-active styling. Parity: Conductor header
//! `All changes | Debugging ReferenceError | Review branch changes | +`.
//!
//! Distinct from the main tab bar — TabSubtitle is session-scoped sub-views
//! inside one session's workspace area.

use eframe::egui::{self, RichText, Sense};

use crate::motion;
use crate::theme::ThemePalette;

pub struct SubtabEntry<'a> {
    pub id: &'a str,
    pub label: &'a str,
}

/// Returns `Some(new_active_id)` if the user clicked a different tab.
/// Returns `"+"` marker string `"__add__"` when the add button was clicked
/// and `on_add` is `true`.
pub fn tab_subtitle(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    tabs: &[SubtabEntry],
    active_id: &str,
    show_add: bool,
) -> Option<String> {
    let mut clicked: Option<String> = None;

    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 16.0;

        for tab in tabs {
            let is_active = tab.id == active_id;
            let color = if is_active { palette.text } else { palette.text_muted };
            let text = RichText::new(tab.label).size(13.0).color(color);
            let galley = egui::WidgetText::from(text).into_galley(
                ui,
                Some(egui::TextWrapMode::Extend),
                f32::INFINITY,
                egui::TextStyle::Body,
            );

            let padding = egui::vec2(0.0, 6.0);
            let size = egui::vec2(galley.size().x, galley.size().y + padding.y * 2.0);
            let (rect, response) = ui.allocate_exact_size(size, Sense::click());

            if response.clicked() {
                clicked = Some(tab.id.to_string());
            }

            if ui.is_rect_visible(rect) {
                let text_pos = egui::pos2(rect.min.x, rect.min.y + padding.y);
                ui.painter().galley(text_pos, galley, color);

                // Underline-under-active. Animate width via `ease_out_expo`.
                let anim_id = ui.id().with(("tab_subtitle", tab.id));
                let target = if is_active { 1.0_f32 } else { 0.0 };
                let t = ui.ctx().animate_value_with_time(
                    anim_id,
                    target,
                    motion::dur::TAB_SWITCH,
                );
                let t_eased = motion::ease_out_expo(t);
                if t_eased > 0.01 {
                    let y = rect.max.y - 2.0;
                    let half = (rect.width() * 0.5) * t_eased;
                    let cx = rect.center().x;
                    ui.painter().line_segment(
                        [egui::pos2(cx - half, y), egui::pos2(cx + half, y)],
                        egui::Stroke::new(2.0, palette.primary),
                    );
                }
            }
        }

        if show_add {
            let add_text = RichText::new("+").size(14.0).color(palette.text_muted);
            let add_galley = egui::WidgetText::from(add_text).into_galley(
                ui,
                Some(egui::TextWrapMode::Extend),
                f32::INFINITY,
                egui::TextStyle::Body,
            );
            let size = egui::vec2(add_galley.size().x + 6.0, add_galley.size().y + 12.0);
            let (rect, response) = ui.allocate_exact_size(size, Sense::click());
            if response.clicked() {
                clicked = Some("__add__".to_string());
            }
            if ui.is_rect_visible(rect) {
                let pos = egui::pos2(rect.min.x + 3.0, rect.min.y + 6.0);
                ui.painter().galley(pos, add_galley, palette.text_muted);
            }
        }
    });

    clicked
}
