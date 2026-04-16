use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::{AppState, GitSubTab, RuntimeState};
use crate::theme::ThemePalette;

/// Main entry point — called from bottom_pane when the Git tab is active.
pub fn git_panel_content(
    ui: &mut egui::Ui,
    _ctx: &egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
) {
    let repo_root = state
        .active_workspace()
        .and_then(|ws| ws.repo_root.clone());

    let Some(repo_root) = repo_root else {
        let p = state.theme.palette();
        ui.add_space(16.0);
        ui.label(
            egui::RichText::new("No repository open")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    };

    // Refresh cached data when needed
    if runtime.git_panel.needs_refresh {
        refresh_git_data(&repo_root, runtime);
    }

    let p = state.theme.palette();

    // Sub-tab bar
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        for &tab in GitSubTab::ALL {
            let selected = runtime.git_panel.sub_tab == tab;
            let text = egui::RichText::new(tab.label())
                .size(11.0)
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
                runtime.git_panel.sub_tab = tab;
            }
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(8.0);
            if ui
                .button(egui::RichText::new("\u{21BB}").size(12.0).color(p.text_secondary))
                .on_hover_text("Refresh")
                .clicked()
            {
                runtime.git_panel.needs_refresh = true;
            }
        });
    });

    ui.add(egui::Separator::default().spacing(0.0));

    // Status message bar with tinted background
    if let Some((ref msg, is_err)) = runtime.git_panel.status_message {
        let color = if is_err { p.error } else { p.success };
        let bg = color.linear_multiply(0.1);
        egui::Frame::NONE
            .fill(bg)
            .inner_margin(egui::Margin::symmetric(8, 3))
            .show(ui, |ui| {
                ui.label(egui::RichText::new(msg).size(11.0).color(color));
            });
    }

    // Sub-tab content
    match runtime.git_panel.sub_tab {
        GitSubTab::Changes => changes_tab(ui, &repo_root, p, runtime),
        GitSubTab::Branches => branches_tab(ui, &repo_root, p, runtime),
        GitSubTab::Worktrees => worktrees_tab(ui, &repo_root, p, runtime),
        GitSubTab::Log => log_tab(ui, &repo_root, p, runtime),
        GitSubTab::PRs => prs_tab(ui, &repo_root, p, runtime),
    }
}

/// Sidebar Git page — lightweight status overview.
pub fn git_sidebar_content(ui: &mut egui::Ui, state: &AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    let repo_root = state
        .active_workspace()
        .and_then(|ws| ws.repo_root.clone());

    let Some(repo_root) = repo_root else {
        ui.label(
            egui::RichText::new("No repository open")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    };

    if runtime.git_panel.needs_refresh {
        refresh_git_data(&repo_root, runtime);
    }

    egui::ScrollArea::vertical().show(ui, |ui| {
        // Repo info
        if let Some(ref info) = runtime.git_panel.repo_info {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("\u{2442}")
                        .size(12.0)
                        .color(p.primary),
                );
                let branch_name = info
                    .current_branch
                    .as_deref()
                    .unwrap_or("detached HEAD");
                ui.label(
                    egui::RichText::new(branch_name)
                        .size(12.0)
                        .color(p.text)
                        .strong(),
                );
            });

            if !info.is_clean {
                ui.label(
                    egui::RichText::new("Uncommitted changes")
                        .size(11.0)
                        .color(p.warning),
                );
            }
        }

        ui.add_space(8.0);
        ui.separator();
        ui.add_space(4.0);

        // File status summary
        let staged: Vec<_> = runtime
            .git_panel
            .file_statuses
            .iter()
            .filter(|s| s.staged)
            .collect();
        let unstaged: Vec<_> = runtime
            .git_panel
            .file_statuses
            .iter()
            .filter(|s| !s.staged)
            .collect();

        ui.label(
            egui::RichText::new(format!("Staged: {}", staged.len()))
                .size(11.0)
                .color(p.success),
        );
        ui.label(
            egui::RichText::new(format!("Unstaged: {}", unstaged.len()))
                .size(11.0)
                .color(p.warning),
        );

        ui.add_space(8.0);

        // Quick file list
        for s in runtime.git_panel.file_statuses.iter().take(20) {
            let (badge, color) = status_badge_color(s, p);
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(badge).size(10.0).color(color).strong());
                ui.label(
                    egui::RichText::new(&s.path)
                        .size(11.0)
                        .color(color),
                );
            });
        }
        let total = runtime.git_panel.file_statuses.len();
        if total > 20 {
            ui.label(
                egui::RichText::new(format!("... and {} more", total - 20))
                    .size(11.0)
                    .color(p.text_muted),
            );
        }
    });
}

// ─── Changes sub-tab ────────────────────────────────────────────────────────

fn changes_tab(ui: &mut egui::Ui, repo_root: &str, p: ThemePalette, runtime: &mut RuntimeState) {
    let staged: Vec<_> = runtime
        .git_panel
        .file_statuses
        .iter()
        .filter(|s| s.staged)
        .cloned()
        .collect();
    let unstaged: Vec<_> = runtime
        .git_panel
        .file_statuses
        .iter()
        .filter(|s| !s.staged)
        .cloned()
        .collect();

    // Horizontal split: file list (left) | diff viewer (right)
    let available = ui.available_size();
    let list_width = (available.x * 0.35).clamp(200.0, 350.0);

    ui.horizontal(|ui| {
        // ── Left: file list + commit ──
        ui.vertical(|ui| {
            ui.set_width(list_width);

            egui::ScrollArea::vertical()
                .id_salt("changes_file_list")
                .show(ui, |ui| {
                    // Staged section
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(format!("Staged Changes ({})", staged.len()))
                                .size(11.0)
                                .color(p.text)
                                .strong(),
                        );
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if !staged.is_empty()
                                    && ui
                                        .button(
                                            egui::RichText::new("\u{2212}")
                                                .size(11.0)
                                                .color(p.text_secondary),
                                        )
                                        .on_hover_text("Unstage all")
                                        .clicked()
                                {
                                    let paths: Vec<String> =
                                        staged.iter().map(|s| s.path.clone()).collect();
                                    match voidlink_core::git::git_unstage_files_impl(
                                        repo_root.to_string(),
                                        paths,
                                    ) {
                                        Ok(()) => runtime.git_panel.needs_refresh = true,
                                        Err(e) => {
                                            runtime.git_panel.status_message =
                                                Some((e, true));
                                        }
                                    }
                                }
                            },
                        );
                    });

                    for s in &staged {
                        file_status_row(ui, repo_root, s, true, p, runtime);
                    }

                    if staged.is_empty() {
                        ui.label(
                            egui::RichText::new("  No staged changes")
                                .size(11.0)
                                .color(p.text_muted),
                        );
                    }

                    ui.add_space(8.0);

                    // Unstaged section
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(format!(
                                "Unstaged Changes ({})",
                                unstaged.len()
                            ))
                            .size(11.0)
                            .color(p.text)
                            .strong(),
                        );
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if !unstaged.is_empty()
                                    && ui
                                        .button(
                                            egui::RichText::new("+")
                                                .size(11.0)
                                                .color(p.text_secondary),
                                        )
                                        .on_hover_text("Stage all")
                                        .clicked()
                                {
                                    match voidlink_core::git::git_stage_all_impl(
                                        repo_root.to_string(),
                                    ) {
                                        Ok(()) => runtime.git_panel.needs_refresh = true,
                                        Err(e) => {
                                            runtime.git_panel.status_message =
                                                Some((e, true));
                                        }
                                    }
                                }
                            },
                        );
                    });

                    for s in &unstaged {
                        file_status_row(ui, repo_root, s, false, p, runtime);
                    }

                    if unstaged.is_empty() {
                        ui.label(
                            egui::RichText::new("  No unstaged changes")
                                .size(11.0)
                                .color(p.text_muted),
                        );
                    }
                });

            ui.add_space(4.0);
            ui.separator();

            // Commit area
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.add_space(4.0);
                let response = ui.add(
                    egui::TextEdit::singleline(&mut runtime.git_panel.commit_message)
                        .hint_text("Commit message...")
                        .desired_width(list_width - 80.0)
                        .font(egui::FontId::proportional(12.0)),
                );

                let can_commit =
                    !staged.is_empty() && !runtime.git_panel.commit_message.trim().is_empty();

                let commit_btn = ui.add_enabled(
                    can_commit,
                    egui::Button::new(
                        egui::RichText::new("\u{2713} Commit")
                            .size(11.0)
                            .color(if can_commit { p.primary_text } else { p.text_muted }),
                    )
                    .fill(if can_commit {
                        p.primary
                    } else {
                        p.surface_elevated
                    }),
                );

                // Commit on button click or Enter in the text field
                if commit_btn.clicked()
                    || (response.lost_focus()
                        && ui.input(|i| i.key_pressed(egui::Key::Enter))
                        && can_commit)
                {
                    match voidlink_core::git::git_commit_impl(
                        repo_root.to_string(),
                        runtime.git_panel.commit_message.clone(),
                    ) {
                        Ok(oid) => {
                            runtime.git_panel.status_message = Some((
                                format!("Committed {}", &oid[..8.min(oid.len())]),
                                false,
                            ));
                            runtime.git_panel.commit_message.clear();
                            runtime.git_panel.needs_refresh = true;
                        }
                        Err(e) => {
                            runtime.git_panel.status_message = Some((e, true));
                        }
                    }
                }
            });
        });

        ui.separator();

        // ── Right: diff viewer ──
        ui.vertical(|ui| {
            diff_viewer(ui, repo_root, p, runtime);
        });
    });
}

fn file_status_row(
    ui: &mut egui::Ui,
    repo_root: &str,
    status: &voidlink_core::git::GitFileStatus,
    is_staged: bool,
    p: ThemePalette,
    runtime: &mut RuntimeState,
) {
    let (badge, color) = status_badge_color(status, p);
    let selected = runtime.git_panel.selected_diff_path.as_deref() == Some(&status.path);

    let bg = if selected { p.hover } else { egui::Color32::TRANSPARENT };

    let response = ui.horizontal(|ui| {
        let frame = egui::Frame::NONE.fill(bg).inner_margin(egui::Margin::symmetric(4, 1));
        frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(badge).size(10.0).color(color).strong());
                ui.label(
                    egui::RichText::new(&status.path)
                        .size(11.0)
                        .color(color),
                );

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let btn_label = if is_staged { "\u{2212}" } else { "+" };
                    let hover = if is_staged { "Unstage" } else { "Stage" };
                    if ui
                        .button(
                            egui::RichText::new(btn_label)
                                .size(10.0)
                                .color(p.text_secondary),
                        )
                        .on_hover_text(hover)
                        .clicked()
                    {
                        if is_staged {
                            let _ = voidlink_core::git::git_unstage_files_impl(
                                repo_root.to_string(),
                                vec![status.path.clone()],
                            );
                        } else {
                            let _ = voidlink_core::git::git_stage_files_impl(
                                repo_root.to_string(),
                                vec![status.path.clone()],
                            );
                        }
                        runtime.git_panel.needs_refresh = true;
                    }
                });
            });
        });
    });

    if response.response.interact(egui::Sense::click()).clicked() {
        let path = status.path.clone();
        let staged_only = is_staged;
        runtime.git_panel.selected_diff_path = Some(path);
        // Load diff for this file
        match voidlink_core::git::git_diff_working_impl(repo_root.to_string(), staged_only) {
            Ok(diff) => runtime.git_panel.diff_result = Some(diff),
            Err(e) => {
                runtime.git_panel.status_message = Some((e, true));
            }
        }
    }
}

fn diff_viewer(ui: &mut egui::Ui, _repo_root: &str, p: ThemePalette, runtime: &mut RuntimeState) {
    let Some(ref selected_path) = runtime.git_panel.selected_diff_path else {
        ui.centered_and_justified(|ui| {
            ui.label(
                egui::RichText::new("Select a file to view diff")
                    .color(p.text_muted)
                    .size(12.0),
            );
        });
        return;
    };

    let Some(ref diff) = runtime.git_panel.diff_result else {
        ui.label(
            egui::RichText::new("Loading diff...")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    };

    // Find the file diff matching the selected path
    let file_diff = diff.files.iter().find(|f| {
        f.new_path.as_deref() == Some(selected_path)
            || f.old_path.as_deref() == Some(selected_path)
    });

    let Some(file_diff) = file_diff else {
        ui.label(
            egui::RichText::new("No diff available for this file")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    };

    // Header
    ui.horizontal(|ui| {
        ui.add_space(4.0);
        ui.label(
            egui::RichText::new(selected_path)
                .size(11.0)
                .color(p.text)
                .strong(),
        );
        ui.label(
            egui::RichText::new(format!(
                "+{} -{}", file_diff.additions, file_diff.deletions
            ))
            .size(11.0)
            .color(p.text_muted),
        );
    });

    ui.add(egui::Separator::default().spacing(2.0));

    if file_diff.is_binary {
        ui.label(
            egui::RichText::new("Binary file")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    }

    egui::ScrollArea::vertical()
        .id_salt("diff_scroll")
        .show(ui, |ui| {
            crate::ui::components::diff_rows::render_diff_hunks(ui, &file_diff.hunks, p);
        });
}

// ─── Branches sub-tab ───────────────────────────────────────────────────────

fn branches_tab(
    ui: &mut egui::Ui,
    repo_root: &str,
    p: ThemePalette,
    runtime: &mut RuntimeState,
) {
    egui::ScrollArea::vertical()
        .id_salt("branches_scroll")
        .show(ui, |ui| {
            ui.add_space(4.0);

            let local: Vec<_> = runtime
                .git_panel
                .branches
                .iter()
                .filter(|b| !b.is_remote)
                .collect();
            let remote: Vec<_> = runtime
                .git_panel
                .branches
                .iter()
                .filter(|b| b.is_remote)
                .collect();

            // Local branches
            ui.label(
                egui::RichText::new("Local Branches")
                    .size(11.0)
                    .color(p.text)
                    .strong(),
            );
            ui.add_space(2.0);

            for branch in &local {
                ui.horizontal(|ui| {
                    ui.add_space(8.0);

                    let indicator = if branch.is_head { "\u{25CF}" } else { "  " };
                    let indicator_color = if branch.is_head { p.success } else { p.text_muted };
                    ui.label(
                        egui::RichText::new(indicator)
                            .size(10.0)
                            .color(indicator_color),
                    );

                    let name_color = if branch.is_head { p.text } else { p.text_secondary };
                    ui.label(
                        egui::RichText::new(&branch.name)
                            .size(12.0)
                            .color(name_color)
                            .strong(),
                    );

                    // Ahead/behind
                    if branch.ahead > 0 || branch.behind > 0 {
                        let ahead_behind = format!("\u{2191}{} \u{2193}{}", branch.ahead, branch.behind);
                        ui.label(
                            egui::RichText::new(ahead_behind)
                                .size(10.0)
                                .color(p.text_muted),
                        );
                    }

                    // Checkout button (only for non-current branches)
                    if !branch.is_head {
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if ui
                                    .button(
                                        egui::RichText::new("checkout")
                                            .size(10.0)
                                            .color(p.primary),
                                    )
                                    .clicked()
                                {
                                    match voidlink_core::git::git_checkout_branch_impl(
                                        repo_root.to_string(),
                                        branch.name.clone(),
                                        false,
                                    ) {
                                        Ok(()) => {
                                            runtime.git_panel.status_message = Some((
                                                format!("Switched to {}", branch.name),
                                                false,
                                            ));
                                            runtime.git_panel.needs_refresh = true;
                                        }
                                        Err(e) => {
                                            runtime.git_panel.status_message = Some((e, true));
                                        }
                                    }
                                }
                            },
                        );
                    }
                });
            }

            if local.is_empty() {
                ui.label(
                    egui::RichText::new("  No local branches")
                        .size(11.0)
                        .color(p.text_muted),
                );
            }

            ui.add_space(12.0);

            // Remote branches
            ui.label(
                egui::RichText::new("Remote Branches")
                    .size(11.0)
                    .color(p.text)
                    .strong(),
            );
            ui.add_space(2.0);

            for branch in &remote {
                ui.horizontal(|ui| {
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new("  ")
                            .size(10.0),
                    );
                    ui.label(
                        egui::RichText::new(&branch.name)
                            .size(12.0)
                            .color(p.text_muted),
                    );
                });
            }

            if remote.is_empty() {
                ui.label(
                    egui::RichText::new("  No remote branches")
                        .size(11.0)
                        .color(p.text_muted),
                );
            }
        });
}

// ─── Worktrees sub-tab ──────────────────────────────────────────────────────

fn worktrees_tab(
    ui: &mut egui::Ui,
    repo_root: &str,
    p: ThemePalette,
    runtime: &mut RuntimeState,
) {
    egui::ScrollArea::vertical()
        .id_salt("worktrees_scroll")
        .show(ui, |ui| {
            ui.add_space(4.0);

            // Create new worktree
            ui.label(
                egui::RichText::new("Create Worktree")
                    .size(11.0)
                    .color(p.text)
                    .strong(),
            );
            ui.add_space(2.0);

            ui.horizontal(|ui| {
                ui.add_space(8.0);
                ui.label(egui::RichText::new("Branch:").size(11.0).color(p.text_secondary));
                ui.add(
                    egui::TextEdit::singleline(&mut runtime.git_panel.new_wt_branch)
                        .hint_text("feature/my-branch")
                        .desired_width(150.0)
                        .font(egui::FontId::proportional(11.0)),
                );
                ui.label(egui::RichText::new("Base:").size(11.0).color(p.text_secondary));
                ui.add(
                    egui::TextEdit::singleline(&mut runtime.git_panel.new_wt_base)
                        .hint_text("HEAD")
                        .desired_width(80.0)
                        .font(egui::FontId::proportional(11.0)),
                );

                let can_create = !runtime.git_panel.new_wt_branch.trim().is_empty();
                if ui
                    .add_enabled(
                        can_create,
                        egui::Button::new(
                            egui::RichText::new("Create")
                                .size(11.0)
                                .color(if can_create { p.primary_text } else { p.text_muted }),
                        )
                        .fill(if can_create { p.primary } else { p.surface_elevated }),
                    )
                    .clicked()
                {
                    let input = voidlink_core::git::CreateWorktreeInput {
                        repo_path: repo_root.to_string(),
                        branch_name: runtime.git_panel.new_wt_branch.clone(),
                        base_ref: Some(runtime.git_panel.new_wt_base.clone()),
                    };
                    match voidlink_core::git::git_create_worktree_impl(input) {
                        Ok(wt) => {
                            runtime.git_panel.status_message = Some((
                                format!("Created worktree at {}", wt.path),
                                false,
                            ));
                            runtime.git_panel.new_wt_branch.clear();
                            runtime.git_panel.new_wt_base = "HEAD".to_string();
                            runtime.git_panel.needs_refresh = true;
                        }
                        Err(e) => {
                            runtime.git_panel.status_message = Some((e, true));
                        }
                    }
                }
            });

            ui.add_space(8.0);
            ui.separator();
            ui.add_space(4.0);

            // Existing worktrees
            ui.label(
                egui::RichText::new("Worktrees")
                    .size(11.0)
                    .color(p.text)
                    .strong(),
            );
            ui.add_space(2.0);

            let worktrees = runtime.git_panel.worktrees.clone();
            for wt in &worktrees {
                ui.horizontal(|ui| {
                    ui.add_space(8.0);

                    let lock_icon = if wt.is_locked { "\u{1F512} " } else { "" };
                    ui.label(
                        egui::RichText::new(format!("{}{}", lock_icon, wt.name))
                            .size(12.0)
                            .color(p.text)
                            .strong(),
                    );

                    if let Some(ref branch) = wt.branch {
                        ui.label(
                            egui::RichText::new(format!("({})", branch))
                                .size(11.0)
                                .color(p.text_muted),
                        );
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .button(
                                egui::RichText::new("\u{2715}")
                                    .size(10.0)
                                    .color(p.error),
                            )
                            .on_hover_text("Remove worktree")
                            .clicked()
                        {
                            match voidlink_core::git::git_remove_worktree_impl(
                                repo_root.to_string(),
                                wt.name.clone(),
                                false,
                            ) {
                                Ok(()) => {
                                    runtime.git_panel.status_message = Some((
                                        format!("Removed worktree {}", wt.name),
                                        false,
                                    ));
                                    runtime.git_panel.needs_refresh = true;
                                }
                                Err(e) => {
                                    runtime.git_panel.status_message = Some((e, true));
                                }
                            }
                        }
                    });
                });

                // Worktree path
                ui.horizontal(|ui| {
                    ui.add_space(16.0);
                    ui.label(
                        egui::RichText::new(&wt.path)
                            .size(10.0)
                            .color(p.text_muted)
                            .family(egui::FontFamily::Monospace),
                    );
                });
            }

            if worktrees.is_empty() {
                ui.label(
                    egui::RichText::new("  No worktrees")
                        .size(11.0)
                        .color(p.text_muted),
                );
            }
        });
}

// ─── Log sub-tab ────────────────────────────────────────────────────────────

fn log_tab(ui: &mut egui::Ui, repo_root: &str, p: ThemePalette, runtime: &mut RuntimeState) {
    // Horizontal split: log list (left) | commit diff (right)
    let available = ui.available_size();
    let has_commit_diff = runtime.git_panel.selected_commit_oid.is_some();
    let list_width = if has_commit_diff {
        (available.x * 0.4).clamp(250.0, 450.0)
    } else {
        available.x
    };

    ui.horizontal(|ui| {
        // Left: commit list
        ui.vertical(|ui| {
            ui.set_width(list_width);

            egui::ScrollArea::vertical()
                .id_salt("log_scroll")
                .show(ui, |ui| {
                    ui.add_space(4.0);

                    let log = runtime.git_panel.log.clone();
                    for commit in &log {
                        let selected = runtime
                            .git_panel
                            .selected_commit_oid
                            .as_deref()
                            == Some(&commit.oid);
                        let bg = if selected { p.hover } else { egui::Color32::TRANSPARENT };

                        let resp = egui::Frame::NONE
                            .fill(bg)
                            .inner_margin(egui::Margin::symmetric(8, 2))
                            .show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                ui.horizontal(|ui| {
                                    // Short OID
                                    let short_oid =
                                        &commit.oid[..7.min(commit.oid.len())];
                                    ui.label(
                                        egui::RichText::new(short_oid)
                                            .size(11.0)
                                            .color(p.primary)
                                            .family(egui::FontFamily::Monospace),
                                    );

                                    // Summary
                                    ui.label(
                                        egui::RichText::new(&commit.summary)
                                            .size(11.0)
                                            .color(p.text),
                                    );
                                });
                                ui.horizontal(|ui| {
                                    ui.add_space(4.0);
                                    ui.label(
                                        egui::RichText::new(&commit.author_name)
                                            .size(10.0)
                                            .color(p.text_muted),
                                    );
                                    // Relative time
                                    let time_str = format_relative_time(commit.time);
                                    ui.label(
                                        egui::RichText::new(time_str)
                                            .size(10.0)
                                            .color(p.text_muted),
                                    );
                                });
                            });

                        if resp.response.interact(egui::Sense::click()).clicked() {
                            runtime.git_panel.selected_commit_oid =
                                Some(commit.oid.clone());
                            // Load commit diff
                            match voidlink_core::git::git_diff_commit_impl(
                                repo_root.to_string(),
                                commit.oid.clone(),
                            ) {
                                Ok(diff) => runtime.git_panel.commit_diff = Some(diff),
                                Err(e) => {
                                    runtime.git_panel.status_message = Some((e, true));
                                }
                            }
                        }
                    }

                    if log.is_empty() {
                        ui.label(
                            egui::RichText::new("No commits")
                                .size(11.0)
                                .color(p.text_muted),
                        );
                    }
                });
        });

        if has_commit_diff {
            ui.separator();

            // Right: commit diff
            ui.vertical(|ui| {
                if let Some(ref diff) = runtime.git_panel.commit_diff {
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(format!(
                            "{} files changed, +{} -{}",
                            diff.files.len(),
                            diff.total_additions,
                            diff.total_deletions
                        ))
                        .size(11.0)
                        .color(p.text_secondary),
                    );
                    ui.add(egui::Separator::default().spacing(2.0));

                    egui::ScrollArea::vertical()
                        .id_salt("commit_diff_scroll")
                        .show(ui, |ui| {
                            for file in &diff.files {
                                let path = file
                                    .new_path
                                    .as_deref()
                                    .or(file.old_path.as_deref())
                                    .unwrap_or("unknown");
                                let (badge, color) =
                                    crate::ui::components::diff_rows::diff_status_badge_color(
                                        &file.status, p,
                                    );

                                ui.add_space(4.0);
                                ui.horizontal(|ui| {
                                    ui.label(
                                        egui::RichText::new(badge)
                                            .size(10.0)
                                            .color(color)
                                            .strong(),
                                    );
                                    ui.label(
                                        egui::RichText::new(path)
                                            .size(11.0)
                                            .color(p.text)
                                            .strong(),
                                    );
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "+{} -{}",
                                            file.additions, file.deletions
                                        ))
                                        .size(10.0)
                                        .color(p.text_muted),
                                    );
                                });

                                if !file.is_binary {
                                    crate::ui::components::diff_rows::render_diff_hunks(
                                        ui, &file.hunks, p,
                                    );
                                } else {
                                    ui.label(
                                        egui::RichText::new("  Binary file")
                                            .size(11.0)
                                            .color(p.text_muted),
                                    );
                                }
                            }
                        });
                } else {
                    ui.centered_and_justified(|ui| {
                        ui.label(
                            egui::RichText::new("Loading...")
                                .color(p.text_muted)
                                .size(12.0),
                        );
                    });
                }
            });
        }
    });
}

// ─── PRs sub-tab ────────────────────────────────────────────────────────────

fn prs_tab(ui: &mut egui::Ui, repo_root: &str, p: ThemePalette, runtime: &mut RuntimeState) {
    egui::ScrollArea::vertical()
        .id_salt("prs_scroll")
        .show(ui, |ui| {
            ui.add_space(4.0);

            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("Pull Requests")
                        .size(11.0)
                        .color(p.text)
                        .strong(),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add_space(8.0);
                    if ui
                        .button(
                            egui::RichText::new("Fetch PRs")
                                .size(10.0)
                                .color(p.primary),
                        )
                        .clicked()
                    {
                        match voidlink_core::git_review::list_prs_impl(
                            repo_root.to_string(),
                            None,
                        ) {
                            Ok(prs) => {
                                runtime.git_panel.prs = prs;
                                runtime.git_panel.status_message = None;
                            }
                            Err(e) => {
                                runtime.git_panel.status_message = Some((e, true));
                            }
                        }
                    }
                });
            });

            ui.add_space(4.0);

            if runtime.git_panel.prs.is_empty() {
                ui.label(
                    egui::RichText::new("No PRs loaded. Click \"Fetch PRs\" to load from GitHub.")
                        .size(11.0)
                        .color(p.text_muted),
                );
                ui.add_space(4.0);
                ui.label(
                    egui::RichText::new("Requires GITHUB_TOKEN environment variable.")
                        .size(10.0)
                        .color(p.text_muted),
                );
                return;
            }

            for pr in &runtime.git_panel.prs {
                let frame_bg = p.surface_elevated;
                egui::Frame::NONE
                    .fill(frame_bg)
                    .inner_margin(egui::Margin::symmetric(8, 4))
                    .corner_radius(CornerRadius::same(4))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());

                        ui.horizontal(|ui| {
                            // PR number
                            ui.label(
                                egui::RichText::new(format!("#{}", pr.number))
                                    .size(11.0)
                                    .color(p.primary)
                                    .strong(),
                            );

                            // Title
                            ui.label(
                                egui::RichText::new(&pr.title)
                                    .size(11.0)
                                    .color(p.text),
                            );

                            // Draft badge
                            if pr.draft {
                                ui.label(
                                    egui::RichText::new("DRAFT")
                                        .size(9.0)
                                        .color(p.text_muted)
                                        .strong(),
                                );
                            }
                        });

                        ui.horizontal(|ui| {
                            ui.add_space(4.0);
                            ui.label(
                                egui::RichText::new(format!(
                                    "{} \u{2192} {}",
                                    pr.head_branch, pr.base_branch
                                ))
                                .size(10.0)
                                .color(p.text_muted),
                            );
                            ui.label(
                                egui::RichText::new(format!("by {}", pr.author))
                                    .size(10.0)
                                    .color(p.text_muted),
                            );
                            ui.label(
                                egui::RichText::new(format!(
                                    "+{} -{} ({} files)",
                                    pr.additions, pr.deletions, pr.changed_files
                                ))
                                .size(10.0)
                                .color(p.text_secondary),
                            );

                            // State badge
                            let state_color = match pr.state.as_str() {
                                "open" => p.success,
                                "closed" => p.error,
                                "merged" => p.primary,
                                _ => p.text_muted,
                            };
                            ui.label(
                                egui::RichText::new(&pr.state)
                                    .size(10.0)
                                    .color(state_color)
                                    .strong(),
                            );
                        });
                    });
                ui.add_space(2.0);
            }
        });
}

// ─── Data refresh ───────────────────────────────────────────────────────────

fn refresh_git_data(repo_root: &str, runtime: &mut RuntimeState) {
    runtime.git_panel.needs_refresh = false;

    // Repo info
    runtime.git_panel.repo_info =
        voidlink_core::git::git_repo_info_impl(repo_root.to_string()).ok();

    // File statuses
    runtime.git_panel.file_statuses =
        voidlink_core::git::git_file_status_impl(repo_root.to_string()).unwrap_or_default();

    // Branches
    runtime.git_panel.branches =
        voidlink_core::git::git_list_branches_impl(repo_root.to_string(), true)
            .unwrap_or_default();

    // Worktrees
    runtime.git_panel.worktrees =
        voidlink_core::git::git_list_worktrees_impl(repo_root.to_string()).unwrap_or_default();

    // Log (last 100 commits)
    runtime.git_panel.log =
        voidlink_core::git::git_log_impl(repo_root.to_string(), None, 100).unwrap_or_default();

    // Clear status message on successful refresh
    runtime.git_panel.status_message = None;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn status_badge_color(
    status: &voidlink_core::git::GitFileStatus,
    p: ThemePalette,
) -> (&'static str, egui::Color32) {
    match status.status.as_str() {
        "modified" => ("M", p.warning),
        "added" => ("A", p.success),
        "deleted" => ("D", p.error),
        "renamed" => ("R", p.info),
        "untracked" => ("?", p.text_muted),
        "conflicted" => ("C", p.error),
        _ => ("?", p.text_muted),
    }
}

fn format_relative_time(unix_secs: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let delta = now - unix_secs;

    if delta < 60 {
        "just now".to_string()
    } else if delta < 3600 {
        format!("{}m ago", delta / 60)
    } else if delta < 86400 {
        format!("{}h ago", delta / 3600)
    } else if delta < 604800 {
        format!("{}d ago", delta / 86400)
    } else {
        format!("{}w ago", delta / 604800)
    }
}
