mod title_bar;
mod sidebar;
mod left_rail;
mod center;
mod bottom_pane;
mod command_palette;
mod status_bar;
mod right_panel;
mod right_rail;
pub mod agents;
pub mod components;
pub mod git_panel;
pub mod notes;
pub mod pr;
pub mod repo_intel;
pub mod widgets;

use crate::state::{AppState, RuntimeState};

pub fn title_bar(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &RuntimeState,
) {
    title_bar::title_bar(ctx, state, runtime);
}

/// Right-hand panel dispatcher. ED-C: when `runtime.new_shell` is true, renders
/// the new `RailCardDeck`; otherwise the legacy context panel is rendered
/// unchanged.
pub fn right_panel(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
) {
    if runtime.new_shell {
        right_rail::right_rail(ctx, state, runtime);
    } else {
        right_panel::right_panel(ctx, state);
    }
}

pub fn status_bar(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &RuntimeState,
) {
    status_bar::status_bar(ctx, state, runtime);
}

pub fn left_sidebar(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
) {
    // ED-E dispatch — when the new shell is enabled and the Explorer page is
    // active, render the workspace-grouped left rail. Every other page falls
    // through to the legacy sidebar so Search / Git / Notes / Repo / Agents
    // keep working unchanged.
    if runtime.new_shell && matches!(state.sidebar_page, crate::state::SidebarPage::Explorer) {
        left_rail::left_rail(ctx, state, runtime);
    } else {
        sidebar::left_sidebar(ctx, state, runtime);
    }
}

pub fn center_panel(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
) {
    center::center_panel(ctx, state, runtime);
}

pub fn bottom_pane(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
) {
    bottom_pane::bottom_pane(ctx, state, runtime);
}

/// Render the floating toast host on top of all panels. ED-A §4.
pub fn toast_host(
    ctx: &eframe::egui::Context,
    state: &AppState,
    runtime: &mut RuntimeState,
) {
    let palette = state.theme.palette();
    widgets::toast_host(ctx, &palette, &mut runtime.toasts);
}

/// ED-G command palette entry point. Handles the Ctrl/Cmd+K toggle and paints
/// the scrim + palette when open.
pub fn command_palette(
    ctx: &eframe::egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
) {
    command_palette::show(ctx, state, runtime);
}
