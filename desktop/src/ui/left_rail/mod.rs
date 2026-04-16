//! ED-E left rail — Workspace → Repository → Session grouping.
//!
//! Sibling to the legacy `ui/sidebar.rs`. Dispatched from `ui/mod.rs` when
//! `runtime.new_shell` is true.

mod footer_icons;
mod session_row;
mod session_status_chip;
mod workspace_group;

use std::collections::HashSet;

use eframe::egui;

use crate::state::{AppState, Repository, RuntimeState, Session, SidebarPage};

pub fn left_rail(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState) {
    if !state.layout.left_sidebar_open {
        collapsed_rail(ctx, state);
        return;
    }

    let p = state.theme.palette();

    egui::SidePanel::left("left_rail")
        .default_width(state.layout.left_sidebar_width.max(260.0))
        .width_range(220.0..=420.0)
        .resizable(true)
        .frame(
            egui::Frame::NONE
                .fill(p.sidebar_bg)
                .inner_margin(egui::Margin::ZERO),
        )
        .show(ctx, |ui| {
            state.layout.left_sidebar_width = ui.available_width();

            ui.horizontal(|ui| {
                // Icon strip on the left.
                icon_strip(ui, state, &p);
                ui.separator();

                ui.vertical(|ui| {
                    ui.set_width(ui.available_width());
                    match state.sidebar_page {
                        SidebarPage::Explorer => workspaces_page(ui, state, runtime, &p),
                        _ => {
                            // Fall back to the legacy sidebar content for the
                            // non-Explorer pages until ED-E fully owns all of
                            // them (Search/Git/Notes/Repo/Agents stay on the
                            // legacy path for now — the dispatcher in
                            // `ui/mod.rs` still calls the legacy `sidebar`
                            // when the page isn't Explorer, but since this
                            // whole module takes over, we render a placeholder
                            // here instead).
                            ui.add_space(12.0);
                            ui.label(
                                egui::RichText::new(format!(
                                    "{}  (legacy content)",
                                    state.sidebar_page.label()
                                ))
                                .size(12.0)
                                .color(p.text_muted),
                            );
                        }
                    }
                });
            });
        });
}

fn collapsed_rail(ctx: &egui::Context, state: &mut AppState) {
    let p = state.theme.palette();
    egui::SidePanel::left("left_rail_icons")
        .exact_width(40.0)
        .resizable(false)
        .frame(
            egui::Frame::NONE
                .fill(p.sidebar_bg)
                .inner_margin(egui::Margin::symmetric(4, 8)),
        )
        .show(ctx, |ui| {
            for &page in SidebarPage::ALL {
                let selected = state.sidebar_page == page;
                let btn = ui.add_sized(
                    [32.0, 32.0],
                    egui::Button::new(
                        egui::RichText::new(page.icon())
                            .size(16.0)
                            .color(if selected { p.primary } else { p.text_secondary }),
                    )
                    .frame(false),
                );
                if btn.on_hover_text(page.label()).clicked() {
                    state.sidebar_page = page;
                    state.layout.left_sidebar_open = true;
                }
            }
        });
}

fn icon_strip(ui: &mut egui::Ui, state: &mut AppState, p: &crate::theme::ThemePalette) {
    ui.vertical(|ui| {
        ui.set_width(36.0);
        ui.add_space(8.0);
        for &page in SidebarPage::ALL {
            let selected = state.sidebar_page == page;
            let btn = ui.add_sized(
                [32.0, 32.0],
                egui::Button::new(
                    egui::RichText::new(page.icon())
                        .size(16.0)
                        .color(if selected { p.primary } else { p.text_secondary }),
                )
                .frame(false),
            );
            if btn.on_hover_text(page.label()).clicked() {
                if state.sidebar_page == page {
                    state.layout.left_sidebar_open = false;
                } else {
                    state.sidebar_page = page;
                }
            }
        }
    });
}

fn workspaces_page(
    ui: &mut egui::Ui,
    state: &mut AppState,
    runtime: &mut RuntimeState,
    p: &crate::theme::ThemePalette,
) {
    let ws_name = state
        .active_workspace()
        .map(|w| w.name.clone())
        .unwrap_or_else(|| "No workspace".to_string());

    ui.add_space(10.0);
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.add(egui::Label::new(
            egui::RichText::new(&ws_name)
                .strong()
                .size(13.0)
                .color(p.text),
        ));
    });
    ui.add_space(6.0);

    // Workspace groups — one per repository in the active workspace.
    let active_ws_id = state.active_workspace_id.clone();
    let active_session_id = state
        .active_session_by_workspace
        .get(&active_ws_id)
        .cloned();

    // Track expanded repo ids in egui memory so it survives tab switches.
    let mem_id = egui::Id::new(("left_rail_expanded", active_ws_id.clone()));
    let mut expanded: HashSet<String> = ui
        .ctx()
        .data(|d| d.get_temp::<HashSet<String>>(mem_id))
        .unwrap_or_default();

    // Deferred mutations.
    let mut to_toggle: Option<String> = None;
    let mut to_select: Option<String> = None;
    let mut to_add_session_for: Option<String> = None;

    let repos: Vec<Repository> = state.active_repositories().into_iter().cloned().collect();

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 4.0;

            if repos.is_empty() {
                ui.add_space(24.0);
                ui.vertical_centered(|ui| {
                    ui.label(
                        egui::RichText::new("No repositories yet")
                            .size(12.5)
                            .color(p.text_muted),
                    );
                    ui.add_space(6.0);
                    ui.label(
                        egui::RichText::new("Use the + below to add one.")
                            .size(11.0)
                            .color(p.text_muted),
                    );
                });
            }

            for repo in &repos {
                let is_expanded = expanded.contains(&repo.id);
                let sessions: Vec<&Session> =
                    state.sessions.sessions_for_repo(&repo.id);

                let evts = workspace_group::workspace_group(
                    ui,
                    p,
                    repo,
                    &sessions,
                    is_expanded,
                    active_session_id.as_deref(),
                );
                if evts.toggle {
                    to_toggle = Some(repo.id.clone());
                }
                if let Some(sid) = evts.selected_session {
                    to_select = Some(sid);
                }
                if evts.add_session {
                    to_add_session_for = Some(repo.id.clone());
                }
                ui.add_space(6.0);
            }
        });

    ui.separator();
    ui.add_space(4.0);
    let footer = footer_icons::footer_icons(ui, p);
    ui.add_space(4.0);

    // Apply deferred mutations.
    if let Some(id) = to_toggle {
        if expanded.contains(&id) {
            expanded.remove(&id);
        } else {
            expanded.insert(id);
        }
        ui.ctx().data_mut(|d| d.insert_temp(mem_id, expanded));
    }
    if let Some(session_id) = to_select {
        state
            .active_session_by_workspace
            .insert(active_ws_id.clone(), session_id);
    }
    if let Some(repo_id) = to_add_session_for {
        let session = create_default_session(&state, &repo_id);
        let sid = state.sessions.insert(session);
        state
            .active_session_by_workspace
            .insert(active_ws_id.clone(), sid);
    }
    if footer.add_repo {
        // ED-E MVP: toast a hint — real dialog lands in ED-F via a new
        // `CommandAction::OpenFolderPicker`. Keeping the UI responsive here
        // without pulling a blocking dialog dep.
        runtime
            .toasts
            .info("Use File → Open Folder or run with a repo path for now.");
    }
    if footer.open_settings {
        runtime.toasts.info("Settings panel lands in ED-G.");
    }
    if footer.open_chat {
        state.sidebar_page = SidebarPage::Agents;
    }
    if footer.open_archive {
        runtime.toasts.info("Archive view lands in ED-E.1.");
    }
}

fn create_default_session(state: &AppState, repo_id: &str) -> Session {
    let branch = state
        .repositories
        .get(repo_id)
        .map(|r| r.default_branch.clone())
        .unwrap_or_else(|| "main".to_string());
    Session::new(
        repo_id,
        &format!("session-{}", now_ms_suffix()),
        &branch,
        &branch,
    )
}

fn now_ms_suffix() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}", ms % 100_000)
}
