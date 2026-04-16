//! Custom title bar — ED-B refactor (polish plan §3.1, §3.8).
//!
//! Composes:
//!   - App logo + workspace selector
//!   - Left breadcrumb (workspace › active tab)
//!   - Right-aligned branch chip (when repo_info loaded)
//!   - Theme picker + window controls
//!
//! Drag region is the horizontal band of the title bar, excluding interactive
//! widgets. We listen for `primary_pressed` inside the title bar rect rather
//! than `any_down` so KDE/Wayland doesn't start-drag on every button click.

mod breadcrumb;
mod window_buttons;

use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::{AppState, RuntimeState};
use crate::theme::Theme;
use crate::ui::widgets;

pub fn title_bar(ctx: &egui::Context, state: &mut AppState, runtime: &RuntimeState) {
    let p = state.theme.palette();

    // macOS reserves the first 80 px for traffic lights when
    // `tauri.conf.json` / platform style puts them inside our chrome.
    // egui's `with_decorations(false)` + macOS isn't currently used, but the
    // padding is a no-op on Linux/Windows so it's safe to include.
    let macos_reserve: f32 = if cfg!(target_os = "macos") { 80.0 } else { 0.0 };

    let title_bar_response = egui::TopBottomPanel::top("title_bar")
        .exact_height(38.0)
        .frame(
            egui::Frame::NONE
                .fill(p.title_bar_bg)
                .stroke(egui::Stroke::new(1.0, p.border))
                .inner_margin(egui::Margin::symmetric(0, 0)),
        )
        .show(ctx, |ui| {
            ui.horizontal_centered(|ui| {
                ui.add_space(14.0 + macos_reserve);

                // App name.
                ui.label(
                    egui::RichText::new("VoidLink")
                        .strong()
                        .size(13.0)
                        .color(p.primary),
                );

                ui.add_space(6.0);

                // Thin divider.
                let rect = ui.available_rect_before_wrap();
                let x = rect.left();
                ui.painter().line_segment(
                    [
                        egui::pos2(x, rect.top() + 6.0),
                        egui::pos2(x, rect.bottom() - 6.0),
                    ],
                    egui::Stroke::new(1.0, p.border),
                );
                ui.add_space(8.0);

                // Workspace selector.
                let ws_name = state
                    .active_workspace()
                    .map(|w| w.name.clone())
                    .unwrap_or_else(|| "No workspace".to_string());

                egui::ComboBox::from_id_salt("workspace_selector")
                    .selected_text(&ws_name)
                    .width(160.0)
                    .show_ui(ui, |ui| {
                        let ids_names: Vec<(String, String)> = state
                            .workspaces
                            .iter()
                            .map(|w| (w.id.clone(), w.name.clone()))
                            .collect();
                        for (id, name) in &ids_names {
                            if ui
                                .selectable_label(state.active_workspace_id == *id, name)
                                .clicked()
                            {
                                state.active_workspace_id = id.clone();
                            }
                        }
                        ui.separator();
                        if ui.button("+ New Workspace").clicked() {
                            state.add_workspace("New Workspace");
                        }
                    });

                ui.add_space(8.0);

                // Breadcrumb (workspace › tab label).
                breadcrumb::breadcrumb(ui, &p, state, runtime);

                // ── Right side: branch chip + theme + window controls ──
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add_space(4.0);

                    window_buttons::window_buttons(ui, &p);

                    ui.add_space(6.0);

                    // Theme picker.
                    let theme_label = state.theme.name();
                    egui::ComboBox::from_id_salt("theme_selector")
                        .selected_text(theme_label)
                        .width(110.0)
                        .show_ui(ui, |ui| {
                            for &theme in Theme::ALL {
                                if ui
                                    .selectable_label(state.theme == theme, theme.name())
                                    .clicked()
                                {
                                    state.theme = theme;
                                }
                            }
                        });

                    ui.add_space(8.0);

                    // Branch chip (shows current branch when git info loaded).
                    if let Some(info) = runtime.git_panel.repo_info.as_ref() {
                        let branch = info.current_branch.as_deref().unwrap_or("HEAD");
                        let _ = widgets::branch_chip(ui, &p, branch, Some("Open"));
                    }
                });
            });
        });

    // Drag region — guard with `primary_pressed` so child widget clicks don't
    // start a drag on KDE Wayland.
    let title_bar_rect = title_bar_response.response.rect;
    let should_drag = ctx.input(|i| {
        i.pointer.primary_pressed()
            && i.pointer
                .interact_pos()
                .map(|p| title_bar_rect.contains(p))
                .unwrap_or(false)
    });
    if should_drag {
        ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
    }

    // Silence "unused import" for CornerRadius: reserved for future decorated
    // window-control rendering split-out.
    let _ = CornerRadius::same(0);
}
