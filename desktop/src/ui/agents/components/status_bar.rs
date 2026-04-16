//! Task status bar (top strip of an agent chat tab).
//!
//! Mirrors the SolidJS version in `AgentChatView.tsx:234-284`:
//!   [spinner/check/X]  status  — current step        [branch chip]  [PR link]  [Cancel]

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::agents::ChatTabState;
use crate::theme::ThemePalette;

/// Returns `true` if the user clicked "Cancel". Caller should issue the
/// `AgentAction::CancelTask`.
pub fn show(ui: &mut egui::Ui, chat: &ChatTabState, p: ThemePalette) -> bool {
    let mut cancel_clicked = false;

    egui::Frame::NONE
        .fill(with_alpha(p.background, 200))
        .stroke(egui::Stroke::new(1.0, p.border))
        .inner_margin(egui::Margin::symmetric(12, 6))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                // Leading icon.
                if chat.is_running() {
                    ui.add(egui::Spinner::new().size(14.0));
                } else if chat.status == "success" {
                    ui.label(egui::RichText::new("\u{2713}").size(14.0).color(p.success));
                } else if chat.status == "failed" {
                    ui.label(egui::RichText::new("\u{2715}").size(14.0).color(p.error));
                } else if chat.status == "cancelled" {
                    ui.label(
                        egui::RichText::new("\u{2205}")
                            .size(14.0)
                            .color(p.text_muted),
                    );
                } else {
                    ui.label(egui::RichText::new("\u{25CB}").size(14.0).color(p.text_muted));
                }

                ui.add_space(6.0);

                // Status + step.
                ui.label(
                    egui::RichText::new(&chat.status)
                        .size(12.0)
                        .strong()
                        .color(p.text),
                );
                if let Some(step) = chat.current_step.as_deref() {
                    ui.label(
                        egui::RichText::new(format!("— {}", step))
                            .size(12.0)
                            .color(p.text_muted),
                    );
                }

                // Right-aligned: branch chip, PR link, cancel.
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if chat.is_running() {
                        let resp = ui.add(
                            egui::Button::new(
                                egui::RichText::new("\u{2715} Cancel").size(11.0).color(p.text),
                            )
                            .fill(p.surface_elevated)
                            .corner_radius(CornerRadius::same(4)),
                        );
                        if resp.clicked() {
                            cancel_clicked = true;
                        }
                    }

                    if let Some(url) = chat.pr_url.as_deref() {
                        ui.hyperlink_to(
                            egui::RichText::new("PR \u{2197}").size(11.0).color(p.primary),
                            url,
                        );
                        ui.add_space(6.0);
                    }

                    if let Some(branch) = chat.branch_name.as_deref() {
                        egui::Frame::NONE
                            .fill(p.surface_elevated)
                            .corner_radius(CornerRadius::same(4))
                            .inner_margin(egui::Margin::symmetric(6, 2))
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(format!("\u{2442} {}", branch))
                                        .size(11.0)
                                        .family(egui::FontFamily::Monospace)
                                        .color(p.text_secondary),
                                );
                            });
                        ui.add_space(6.0);
                    }
                });
            });
        });

    cancel_clicked
}

fn with_alpha(c: egui::Color32, a: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}
