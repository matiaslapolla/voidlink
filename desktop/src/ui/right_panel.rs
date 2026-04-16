use eframe::egui;

use crate::state::AppState;

pub fn right_panel(ctx: &egui::Context, state: &mut AppState) {
    if !state.layout.right_sidebar_open {
        return;
    }

    let p = state.theme.palette();

    egui::SidePanel::right("right_panel")
        .default_width(state.layout.right_sidebar_width)
        .width_range(200.0..=400.0)
        .resizable(true)
        .frame(
            egui::Frame::NONE
                .fill(p.sidebar_bg)
                .inner_margin(egui::Margin::symmetric(12, 8)),
        )
        .show(ctx, |ui| {
            state.layout.right_sidebar_width = ui.available_width();

            ui.horizontal(|ui| {
                ui.heading(
                    egui::RichText::new("Context")
                        .size(13.0)
                        .color(p.text),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .button(egui::RichText::new("\u{2715}").size(11.0).color(p.text_muted))
                        .on_hover_text("Close panel")
                        .clicked()
                    {
                        state.layout.right_sidebar_open = false;
                    }
                });
            });
            ui.separator();

            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.label(
                    egui::RichText::new("Context builder and information panel")
                        .color(p.text_muted)
                        .size(12.0),
                );
            });
        });
}
