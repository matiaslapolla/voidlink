//! PR Review card — ED-F: renders `PrHeaderBand` + `PrChangesPanel` against
//! the active workspace's session. Falls back to an empty-state prompt with a
//! "Refresh" button when no PR is attached.

use eframe::egui::{self, RichText};

use crate::state::sessions_worker::PrRequest;
use crate::state::{AppState, RuntimeState};
use crate::theme::ThemePalette;
use crate::ui::pr::{pr_changes_panel, pr_header_band, PrChangesTab};

pub fn ui(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    state: &AppState,
    runtime: &RuntimeState,
) {
    let Some(ws) = state.active_workspace() else {
        empty_state(ui, palette, "No active workspace.");
        return;
    };
    let active_session_id = state.active_session_by_workspace.get(&ws.id).cloned();
    let Some(session_id) = active_session_id else {
        empty_state(ui, palette, "Select a session to see its PR.");
        return;
    };
    let Some(session) = state.sessions.get(&session_id) else {
        empty_state(ui, palette, "Active session not found.");
        return;
    };
    let Some(repo) = state.repositories.get(&session.repository_id) else {
        empty_state(ui, palette, "Session's repository is missing.");
        return;
    };
    let repo_path = repo.path.to_string_lossy().to_string();

    match session.pr.as_ref() {
        Some(pr) => {
            let derived = session.derive_status();
            let evts = pr_header_band(ui, palette, &session_id, pr, derived);

            if evts.refresh_clicked {
                runtime.pr_worker.dispatch(PrRequest::GetOne {
                    session_id: session_id.clone(),
                    repo_path: repo_path.clone(),
                    pr_number: pr.number as u32,
                });
            }
            if evts.open_external {
                // No crate dep for `open` — log the url; a future ED-G task wires the
                // `open::that` path (or xdg-open) via a platform helper.
                log::info!("open PR url: {}", pr.url);
            }
            if evts.merge_clicked {
                // TODO(ED-F-merge-wiring): the PrWorker needs a MigrationState
                // to dispatch merge_pr_impl. Plumb through here once the
                // agent MigrationState is shared with the worker.
                log::warn!("merge clicked for PR #{} — wiring pending", pr.number);
            }

            ui.add_space(8.0);

            // File list. ED-F MVP uses empty files (diff poller lands later);
            // the panel still renders sub-tabs + filter for the empty-state.
            let filter_id = egui::Id::new(("pr_filter_buf", &session_id));
            let mut filter_buf = ui
                .ctx()
                .data(|d| d.get_temp::<String>(filter_id))
                .unwrap_or_default();
            let tab_id = egui::Id::new(("pr_tab", &session_id));
            let active_tab = ui
                .ctx()
                .data(|d| d.get_temp::<PrChangesTab>(tab_id))
                .unwrap_or(PrChangesTab::Changes);

            let files: Vec<(String, u32, u32)> = Vec::new();
            let r = pr_changes_panel(ui, palette, pr, &files, active_tab, &mut filter_buf);
            if let Some(tab) = r.tab_changed {
                ui.ctx().data_mut(|d| d.insert_temp(tab_id, tab));
            }
            if r.search_query.is_some() {
                ui.ctx()
                    .data_mut(|d| d.insert_temp(filter_id, filter_buf));
            }
        }
        None => {
            empty_state_with_refresh(ui, palette, runtime, &session_id, &repo_path, &session.branch);
        }
    }
}

fn empty_state(ui: &mut egui::Ui, palette: &ThemePalette, message: &str) {
    ui.vertical_centered(|ui| {
        ui.add_space(16.0);
        ui.label(
            RichText::new(message)
                .size(12.0)
                .color(palette.text_muted),
        );
    });
}

fn empty_state_with_refresh(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    runtime: &RuntimeState,
    session_id: &str,
    repo_path: &str,
    head_branch: &str,
) {
    ui.vertical_centered(|ui| {
        ui.add_space(8.0);
        ui.label(
            RichText::new("No PR attached to this session.")
                .size(12.0)
                .color(palette.text_muted),
        );
        ui.add_space(4.0);
        if ui
            .small_button(
                RichText::new("\u{21BB}  Look for an open PR")
                    .size(11.5)
                    .color(palette.text),
            )
            .clicked()
        {
            runtime.pr_worker.dispatch(PrRequest::List {
                session_id: session_id.to_string(),
                repo_path: repo_path.to_string(),
                head_branch: head_branch.to_string(),
            });
        }
    });
}
