//! Left-aligned breadcrumb in the title bar. Parity: Conductor
//! `⌥ archive-in-repo-details` between app name and right-side chip.
//!
//! Until ED-E introduces the Session data model, the breadcrumb shows:
//!   - workspace name
//!   - active tab label (when informative, i.e. not "Welcome")
//! separated by chevrons.

use eframe::egui::{self, RichText};

use crate::state::{AppState, RuntimeState, TabKind};
use crate::theme::ThemePalette;

pub fn breadcrumb(ui: &mut egui::Ui, palette: &ThemePalette, state: &AppState, runtime: &RuntimeState) {
    let workspace_name = state
        .active_workspace()
        .map(|w| w.name.clone())
        .unwrap_or_else(|| "No workspace".to_string());

    // The active tab becomes the "session" segment. Hide for Welcome since it
    // carries no useful context.
    let tab_segment: Option<String> = runtime.active_tab().and_then(|t| match t.kind {
        TabKind::Welcome => None,
        _ => Some(t.label.clone()),
    });

    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;

        ui.add(egui::Label::new(
            RichText::new(&workspace_name)
                .size(12.0)
                .color(palette.text_muted),
        ));

        if let Some(label) = tab_segment {
            ui.add(egui::Label::new(
                RichText::new("\u{203A}") // ›
                    .size(12.0)
                    .color(palette.text_muted),
            ));
            ui.add(egui::Label::new(
                RichText::new(format!("\u{2325} {}", label))
                    .size(12.0)
                    .strong()
                    .color(palette.text),
            ));
        }
    });
}
