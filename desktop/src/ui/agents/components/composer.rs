//! Message composer — multi-line text input + Send button.
//!
//! Per plan §6.3: in 7B, follow-ups in an in-flight task are ignored with a
//! greyed-out composer. The Send button just surfaces a static hint in that
//! case. Before first send, the `TaskCreateForm` takes over (composer never
//! dispatches `StartTask` itself in 7B).

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::theme::ThemePalette;

/// What the composer decided at the end of the frame. The `Submitted` payload
/// carries the trimmed text — reserved for follow-up messaging that 7E may
/// wire up. In 7B the composer is always disabled so this arm is never
/// constructed; `#[allow(dead_code)]` documents the intent without warnings.
#[allow(dead_code)]
pub enum ComposerOutcome {
    /// Nothing happened.
    Idle,
    /// The user pressed Enter (no Shift) or clicked Send with non-empty input.
    Submitted(String),
}

/// Show the composer. `disabled` greys the whole row out; `placeholder` is the
/// hint shown when the buffer is empty.
pub fn show(
    ui: &mut egui::Ui,
    buffer: &mut String,
    disabled: bool,
    placeholder: &str,
    p: ThemePalette,
) -> ComposerOutcome {
    let mut outcome = ComposerOutcome::Idle;

    egui::Frame::NONE
        .fill(p.background)
        .stroke(egui::Stroke::new(1.0, p.border))
        .inner_margin(egui::Margin::symmetric(10, 6))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                let text_color = if disabled { p.text_muted } else { p.text };

                ui.add_enabled_ui(!disabled, |ui| {
                    let hint = if buffer.is_empty() {
                        placeholder.to_string()
                    } else {
                        String::new()
                    };
                    let response = ui.add(
                        egui::TextEdit::multiline(buffer)
                            .hint_text(egui::RichText::new(hint).color(p.text_muted).size(12.0))
                            .desired_rows(1)
                            .desired_width(ui.available_width() - 56.0)
                            .text_color(text_color)
                            .frame(false)
                            .font(egui::TextStyle::Body),
                    );

                    // Enter submits, Shift+Enter inserts a newline.
                    if !disabled && response.has_focus() {
                        let submit = ui.input(|i| {
                            i.key_pressed(egui::Key::Enter) && !i.modifiers.shift
                        });
                        if submit {
                            let trimmed = buffer.trim().to_string();
                            if !trimmed.is_empty() {
                                outcome = ComposerOutcome::Submitted(trimmed);
                            }
                            // Strip the trailing newline egui's TextEdit inserts.
                            if buffer.ends_with('\n') {
                                buffer.pop();
                            }
                        }
                    }
                });

                // Send button.
                let can_send = !disabled && !buffer.trim().is_empty();
                let send = ui.add_enabled(
                    can_send,
                    egui::Button::new(
                        egui::RichText::new("\u{27A4}")
                            .size(14.0)
                            .color(if can_send { p.primary_text } else { p.text_muted }),
                    )
                    .fill(if can_send { p.primary } else { p.surface_elevated })
                    .corner_radius(CornerRadius::same(6))
                    .min_size(egui::vec2(32.0, 28.0)),
                );
                if send.clicked() && can_send {
                    let trimmed = buffer.trim().to_string();
                    if !trimmed.is_empty() {
                        outcome = ComposerOutcome::Submitted(trimmed);
                    }
                }
            });
        });

    outcome
}
