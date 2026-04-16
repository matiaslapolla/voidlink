//! Collapsible repository group. Parity: Conductor left-rail sections like
//! `conductor`, `melty_home`, each with a header row and session rows beneath.

use eframe::egui::{self, RichText, Sense};

use crate::state::{Repository, Session};
use crate::theme::ThemePalette;

use super::session_row::session_row;

pub struct WorkspaceGroupEvents {
    pub toggle: bool,
    pub add_session: bool,
    pub selected_session: Option<String>,
}

pub fn workspace_group(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    repo: &Repository,
    sessions: &[&Session],
    expanded: bool,
    active_session_id: Option<&str>,
) -> WorkspaceGroupEvents {
    let mut events = WorkspaceGroupEvents {
        toggle: false,
        add_session: false,
        selected_session: None,
    };

    // Header row: ▶/▼ icon + repo name + session count + `+` add button.
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let chevron = if expanded { "\u{25BC}" } else { "\u{25B6}" };

        let header_text = RichText::new(format!("{}  {}", chevron, repo.display_name))
            .strong()
            .size(12.5)
            .color(palette.text);
        let header_galley = egui::WidgetText::from(header_text).into_galley(
            ui,
            Some(egui::TextWrapMode::Extend),
            f32::INFINITY,
            egui::TextStyle::Body,
        );
        let padding = egui::vec2(4.0, 4.0);
        let size = egui::vec2(
            ui.available_width() - 32.0,
            header_galley.size().y + padding.y * 2.0,
        );
        let (rect, response) = ui.allocate_exact_size(size, Sense::click());
        if response.clicked() {
            events.toggle = true;
        }
        if ui.is_rect_visible(rect) {
            let text_pos = rect.min + padding;
            ui.painter()
                .galley(text_pos, header_galley, palette.text);

            // Session count suffix.
            let count_text = format!("({})", sessions.len());
            ui.painter().text(
                egui::pos2(rect.max.x - 6.0, rect.center().y),
                egui::Align2::RIGHT_CENTER,
                count_text,
                egui::FontId::proportional(10.5),
                palette.text_muted,
            );
        }

        if ui
            .small_button(
                RichText::new("+")
                    .size(13.0)
                    .color(palette.text_muted),
            )
            .on_hover_text("New session")
            .clicked()
        {
            events.add_session = true;
        }
    });

    if expanded {
        for s in sessions {
            let is_active = active_session_id == Some(s.id.as_str());
            let r = session_row(ui, palette, s, is_active);
            if r.clicked() {
                events.selected_session = Some(s.id.clone());
            }
        }
    }

    events
}
