use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::{AppState, BottomTab, RuntimeState};

pub fn bottom_pane(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState) {
    if !state.layout.bottom_pane_open {
        return;
    }

    let p = state.theme.palette();

    // Poll terminal events each frame
    runtime.terminals.poll_events();

    egui::TopBottomPanel::bottom("bottom_pane")
        .default_height(state.layout.bottom_pane_height)
        .height_range(120.0..=500.0)
        .resizable(true)
        .frame(
            egui::Frame::NONE
                .fill(p.surface)
                .inner_margin(egui::Margin::ZERO),
        )
        .show(ctx, |ui| {
            state.layout.bottom_pane_height = ui.available_height();

            // ── Tab bar ─────────────────────────────────────────────────
            ui.horizontal(|ui| {
                ui.add_space(8.0);
                for &tab in BottomTab::ALL {
                    let selected = state.bottom_tab == tab;
                    let text = egui::RichText::new(tab.label())
                        .size(12.0)
                        .color(if selected { p.text } else { p.text_muted });

                    let btn = ui.add(
                        egui::Button::new(text)
                            .fill(if selected {
                                p.tab_active_bg
                            } else {
                                egui::Color32::TRANSPARENT
                            })
                            .corner_radius(CornerRadius {
                                nw: 4,
                                ne: 4,
                                sw: 0,
                                se: 0,
                            }),
                    );
                    if btn.clicked() {
                        state.bottom_tab = tab;
                    }
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add_space(8.0);
                    if ui
                        .button(
                            egui::RichText::new("\u{2715}")
                                .size(11.0)
                                .color(p.text_muted),
                        )
                        .on_hover_text("Close panel")
                        .clicked()
                    {
                        state.layout.bottom_pane_open = false;
                    }
                });
            });

            ui.add(egui::Separator::default().spacing(0.0));

            // ── Tab content ─────────────────────────────────────────────
            match state.bottom_tab {
                BottomTab::Terminal => terminal_content(ui, ctx, state, runtime),
                BottomTab::Git => {
                    super::git_panel::git_panel_content(ui, ctx, state, runtime);
                }
                BottomTab::Logs => {
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        ui.add_space(8.0);
                        ui.label(
                            egui::RichText::new("Application logs")
                                .color(p.text_muted)
                                .size(12.0),
                        );
                    });
                }
            }
        });
}

fn terminal_content(
    ui: &mut egui::Ui,
    ctx: &egui::Context,
    state: &AppState,
    runtime: &mut RuntimeState,
) {
    let p = state.theme.palette();

    // Terminal session tab bar
    let mut close_id: Option<u64> = None;
    let mut activate_id: Option<u64> = None;

    ui.horizontal(|ui| {
        ui.add_space(8.0);

        for session in &runtime.terminals.sessions {
            let is_active = runtime.terminals.active_id == Some(session.id);
            let text = egui::RichText::new(&session.label)
                .size(11.0)
                .color(if is_active { p.text } else { p.text_muted });

            let btn = ui.add(
                egui::Button::new(text).fill(if is_active {
                    p.tab_active_bg
                } else {
                    egui::Color32::TRANSPARENT
                }),
            );

            if btn.clicked() {
                activate_id = Some(session.id);
            }

            // Close button
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("\u{2715}")
                            .size(9.0)
                            .color(p.text_muted),
                    )
                    .frame(false),
                )
                .clicked()
            {
                close_id = Some(session.id);
            }

            ui.add_space(2.0);
        }

        // New terminal button
        if ui
            .button(egui::RichText::new("+").size(12.0).color(p.text_secondary))
            .on_hover_text("New terminal")
            .clicked()
        {
            let cwd = state
                .active_workspace()
                .and_then(|w| w.repo_root.as_deref());
            if let Err(e) = runtime.terminals.spawn(ctx, cwd) {
                log::error!("Failed to spawn terminal: {}", e);
            }
        }
    });

    if let Some(id) = activate_id {
        runtime.terminals.active_id = Some(id);
    }
    if let Some(id) = close_id {
        runtime.terminals.close(id);
    }

    ui.add(egui::Separator::default().spacing(0.0));

    // Render the active terminal
    if let Some(session) = runtime.terminals.active_session_mut() {
        let theme = terminal_theme_from_palette(p);
        let font = egui_term::TerminalFont::new(egui_term::FontSettings {
            font_type: egui::FontId::monospace(13.0),
        });

        let terminal_view = egui_term::TerminalView::new(ui, &mut session.backend)
            .set_theme(theme)
            .set_font(font)
            .set_focus(true);

        ui.add(terminal_view);
    } else {
        // No terminals — show empty state
        ui.centered_and_justified(|ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(24.0);
                ui.label(
                    egui::RichText::new("No terminal sessions")
                        .color(p.text_muted)
                        .size(12.0),
                );
                ui.add_space(8.0);
                if ui
                    .button("Create terminal")
                    .on_hover_text("Open a new terminal session")
                    .clicked()
                {
                    let cwd = state
                        .active_workspace()
                        .and_then(|w| w.repo_root.as_deref());
                    if let Err(e) = runtime.terminals.spawn(ctx, cwd) {
                        log::error!("Failed to spawn terminal: {}", e);
                    }
                }
            });
        });
    }
}

fn terminal_theme_from_palette(p: crate::theme::ThemePalette) -> egui_term::TerminalTheme {
    fn c32_to_hex(c: egui::Color32) -> String {
        format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
    }

    let palette = egui_term::ColorPalette {
        foreground: c32_to_hex(p.text),
        background: c32_to_hex(p.editor_bg),
        black: String::from("#282828"),
        red: String::from("#cc241d"),
        green: String::from("#98971a"),
        yellow: String::from("#d79921"),
        blue: String::from("#458588"),
        magenta: String::from("#b16286"),
        cyan: String::from("#689d6a"),
        white: String::from("#a89984"),
        bright_black: String::from("#928374"),
        bright_red: String::from("#fb4934"),
        bright_green: String::from("#b8bb26"),
        bright_yellow: String::from("#fabd2f"),
        bright_blue: String::from("#83a598"),
        bright_magenta: String::from("#d3869b"),
        bright_cyan: String::from("#8ec07c"),
        bright_white: String::from("#ebdbb2"),
        bright_foreground: None,
        dim_foreground: String::from("#928374"),
        dim_black: String::from("#1d2021"),
        dim_red: String::from("#9d0006"),
        dim_green: String::from("#79740e"),
        dim_yellow: String::from("#b57614"),
        dim_blue: String::from("#076678"),
        dim_magenta: String::from("#8f3f71"),
        dim_cyan: String::from("#427b58"),
        dim_white: String::from("#928374"),
    };

    egui_term::TerminalTheme::new(Box::new(palette))
}
