use std::path::PathBuf;
use eframe::egui;

use crate::state::{AppState, FileNode, RuntimeState, SidebarPage};

pub fn left_sidebar(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState) {
    if !state.layout.left_sidebar_open {
        // Collapsed: show icon strip only
        egui::SidePanel::left("sidebar_icons")
            .exact_width(40.0)
            .resizable(false)
            .frame(
                egui::Frame::NONE
                    .fill(state.theme.palette().sidebar_bg)
                    .inner_margin(egui::Margin::symmetric(4, 8)),
            )
            .show(ctx, |ui| {
                let p = state.theme.palette();
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
        return;
    }

    let p = state.theme.palette();

    egui::SidePanel::left("sidebar")
        .default_width(state.layout.left_sidebar_width)
        .width_range(180.0..=400.0)
        .resizable(true)
        .frame(
            egui::Frame::NONE
                .fill(p.sidebar_bg)
                .inner_margin(egui::Margin::ZERO),
        )
        .show(ctx, |ui| {
            state.layout.left_sidebar_width = ui.available_width();

            ui.horizontal(|ui| {
                // Icon column
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

                ui.separator();

                // Content area
                ui.vertical(|ui| {
                    ui.add_space(8.0);
                    ui.heading(
                        egui::RichText::new(state.sidebar_page.label())
                            .size(13.0)
                            .color(p.text),
                    );
                    ui.separator();

                    match state.sidebar_page {
                        SidebarPage::Explorer => {
                            explorer_content(ui, state, runtime);
                        }
                        SidebarPage::Git => {
                            super::git_panel::git_sidebar_content(ui, state, runtime);
                        }
                        SidebarPage::Notes => {
                            super::notes::notes_sidebar_content(ui, state, runtime);
                        }
                        SidebarPage::Repo => {
                            super::repo_intel::repo_intel_sidebar(ui, state, runtime);
                        }
                        SidebarPage::Agents => {
                            agents_sidebar_placeholder(ui, state, runtime);
                        }
                        _ => {
                            egui::ScrollArea::vertical().show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(format!(
                                        "{} panel — coming in later phases",
                                        state.sidebar_page.label()
                                    ))
                                    .color(p.text_muted)
                                    .size(12.0),
                                );
                            });
                        }
                    }
                });
            });
        });
}

fn explorer_content(ui: &mut egui::Ui, state: &AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    if runtime.file_tree.is_none() {
        ui.add_space(16.0);
        ui.label(
            egui::RichText::new("No repository open")
                .color(p.text_muted)
                .size(12.0),
        );
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new("Pass a path as argument:\nvoidlink-desktop /path/to/repo")
                .color(p.text_muted)
                .size(11.0)
                .family(egui::FontFamily::Monospace),
        );
        return;
    }

    // Load git status if we have a repo root
    let git_statuses = state
        .active_workspace()
        .and_then(|ws| ws.repo_root.as_ref())
        .and_then(|root| {
            voidlink_core::git::git_file_status_impl(root.clone()).ok()
        })
        .unwrap_or_default();

    egui::ScrollArea::vertical().show(ui, |ui| {
        let mut tree = runtime.file_tree.take().unwrap();
        let mut file_to_open: Option<PathBuf> = None;
        let mut context_path: Option<PathBuf> = None;

        render_tree_node(ui, &mut tree, &mut runtime.expanded_dirs, &mut file_to_open, &mut context_path, p, &git_statuses);

        runtime.file_tree = Some(tree);

        if let Some(path) = file_to_open {
            runtime.open_file(&path);
        }

        if let Some(path) = context_path {
            runtime.context_menu_path = Some(path);
        }

        // Context menu popup
        if let Some(ref menu_path) = runtime.context_menu_path.clone() {
            let popup_id = egui::Id::new("file_context_menu");
            let mut open = true;
            egui::Area::new(popup_id)
                .order(egui::Order::Foreground)
                .current_pos(ui.ctx().input(|i| i.pointer.latest_pos().unwrap_or_default()))
                .show(ui.ctx(), |ui| {
                    egui::Frame::popup(ui.style()).show(ui, |ui| {
                        if ui.button("Copy path").clicked() {
                            ui.ctx().copy_text(menu_path.to_string_lossy().to_string());
                            open = false;
                        }
                        if ui.button("Duplicate").clicked() {
                            let _ = voidlink_core::fs::duplicate_path(
                                &menu_path.to_string_lossy(),
                            );
                            // Reload tree
                            if let Some(ref root) = state.active_workspace().and_then(|w| w.repo_root.clone()) {
                                runtime.load_tree(root);
                            }
                            open = false;
                        }
                        ui.separator();
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("Delete").color(p.error),
                                )
                            )
                            .clicked()
                        {
                            let _ = voidlink_core::fs::delete_path(
                                &menu_path.to_string_lossy(),
                            );
                            if let Some(ref root) = state.active_workspace().and_then(|w| w.repo_root.clone()) {
                                runtime.load_tree(root);
                            }
                            open = false;
                        }
                    });
                });

            // Close the context menu on click outside
            if !open || ui.ctx().input(|i| i.pointer.any_pressed()) {
                runtime.context_menu_path = None;
            }
        }
    });
}

fn render_tree_node(
    ui: &mut egui::Ui,
    node: &mut FileNode,
    expanded: &mut std::collections::HashSet<PathBuf>,
    file_to_open: &mut Option<PathBuf>,
    context_path: &mut Option<PathBuf>,
    p: crate::theme::ThemePalette,
    git_statuses: &[voidlink_core::git::GitFileStatus],
) {
    if node.is_dir {
        let is_expanded = expanded.contains(&node.path);

        // Lazy load children when first expanded
        if is_expanded && !node.loaded {
            node.load_children();
        }

        let icon = if is_expanded { "\u{25BE} \u{1F4C2}" } else { "\u{25B8} \u{1F4C1}" };
        let header_text = format!("{} {}", icon, node.name);

        let response = ui.add(
            egui::Button::new(
                egui::RichText::new(&header_text)
                    .size(12.0)
                    .color(p.text),
            )
            .frame(false),
        );

        if response.clicked() {
            if is_expanded {
                expanded.remove(&node.path);
            } else {
                expanded.insert(node.path.clone());
                if !node.loaded {
                    node.load_children();
                }
            }
        }

        // Right-click context menu
        if response.secondary_clicked() {
            *context_path = Some(node.path.clone());
        }

        // Render children if expanded
        if is_expanded {
            ui.indent(egui::Id::new(&node.path), |ui| {
                for child in &mut node.children {
                    render_tree_node(ui, child, expanded, file_to_open, context_path, p, git_statuses);
                }
            });
        }
    } else {
        // File node with full-width hover background
        let icon = file_icon(&node.name);
        let git_status = git_statuses.iter().find(|s| {
            node.path.to_string_lossy().ends_with(&s.path)
        });

        let text_color = match git_status.map(|s| s.status.as_str()) {
            Some("modified") => p.warning,
            Some("new") => p.success,
            Some("deleted") => p.error,
            _ => p.text_secondary,
        };

        let row_resp = ui.horizontal(|ui| {
            // Full-width interactive area
            let desired_width = ui.available_width();
            let (rect, response) = ui.allocate_exact_size(
                egui::vec2(desired_width, 20.0),
                egui::Sense::click(),
            );

            // Hover highlight
            if response.hovered() {
                ui.painter().rect_filled(rect, 0, p.hover);
            }

            let label = format!("{} {}", icon, node.name);

            // Draw text on top
            let text_pos = rect.left_center() + egui::vec2(2.0, 0.0);
            ui.painter().text(
                text_pos,
                egui::Align2::LEFT_CENTER,
                &label,
                egui::FontId::proportional(12.0),
                text_color,
            );

            // Git badge on the right
            if let Some(gs) = git_status {
                let badge_char = match gs.status.as_str() {
                    "modified" => "M",
                    "new" => "A",
                    "deleted" => "D",
                    "renamed" => "R",
                    _ => "?",
                };
                let badge_pos = egui::pos2(rect.right() - 16.0, rect.center().y);
                ui.painter().text(
                    badge_pos,
                    egui::Align2::CENTER_CENTER,
                    badge_char,
                    egui::FontId::proportional(10.0),
                    text_color,
                );
            }

            if response.clicked() {
                *file_to_open = Some(node.path.clone());
            }
            if response.secondary_clicked() {
                *context_path = Some(node.path.clone());
            }
        });

        let _ = row_resp;
    }
}

/// Minimal Agents sidebar (Phase 7B). Orchestrator + CLI sessions arrive in 7D.
fn agents_sidebar_placeholder(
    ui: &mut egui::Ui,
    state: &AppState,
    runtime: &mut crate::state::RuntimeState,
) {
    use crate::state::agents::{AgentAction, ChatTabState, TaskFormState};
    let p = state.theme.palette();
    let repo_path = state
        .active_workspace()
        .and_then(|w| w.repo_root.clone())
        .unwrap_or_default();

    egui::ScrollArea::vertical().show(ui, |ui| {
        ui.add_space(8.0);

        // "+ New task" primary action.
        let new_task = ui.add_sized(
            [ui.available_width().min(220.0), 28.0],
            egui::Button::new(
                egui::RichText::new("+  New task")
                    .size(12.0)
                    .color(p.primary_text)
                    .strong(),
            )
            .fill(p.primary)
            .corner_radius(eframe::epaint::CornerRadius::same(6)),
        );
        if new_task.clicked() {
            let task_id = uuid::Uuid::new_v4().to_string();
            let mut chat = ChatTabState::new(task_id.clone());
            chat.label = "New task".to_string();
            chat.form = Some(TaskFormState::default());
            runtime.agents.insert_chat(chat);

            // Open (or focus) the AgentChat tab for this task_id.
            let tab_id = format!("agent:chat:{}", task_id);
            if runtime.tabs.iter().any(|t| t.id == tab_id) {
                runtime.active_tab_id = tab_id;
            } else {
                let tab = crate::state::Tab::agent_chat(&task_id, "New task");
                runtime.active_tab_id = tab.id.clone();
                runtime.tabs.push(tab);
            }
        }

        ui.add_space(12.0);

        // ── Orphan worktrees (from previous runs) ─────────────────────────
        if !runtime.agents.orphan_worktrees.is_empty() {
            egui::CollapsingHeader::new(
                egui::RichText::new(format!(
                    "\u{26A0} Orphan worktrees ({})",
                    runtime.agents.orphan_worktrees.len()
                ))
                .size(11.0)
                .color(p.warning)
                .strong(),
            )
            .id_salt("orphan_worktrees")
            .default_open(false)
            .show(ui, |ui| {
                let orphans: Vec<_> = runtime.agents.orphan_worktrees.clone();
                let mut cleaned: Vec<String> = Vec::new();
                for entry in orphans {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new(&entry.branch_name)
                                    .size(11.0)
                                    .family(egui::FontFamily::Monospace)
                                    .color(p.text_secondary),
                            );
                            ui.label(
                                egui::RichText::new(&entry.worktree_path)
                                    .size(10.0)
                                    .color(p.text_muted),
                            );
                        });
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                let btn = ui.add(
                                    egui::Button::new(
                                        egui::RichText::new("Clean up")
                                            .size(10.5)
                                            .color(p.text),
                                    )
                                    .fill(p.surface_elevated)
                                    .corner_radius(eframe::epaint::CornerRadius::same(4)),
                                );
                                if btn.clicked() && !repo_path.is_empty() {
                                    let _ = runtime.agents.action_tx.send(
                                        AgentAction::CleanupOrphan {
                                            task_id: entry.task_id.clone(),
                                            repo_path: repo_path.clone(),
                                            branch_name: entry.branch_name.clone(),
                                            worktree_path: entry.worktree_path.clone(),
                                        },
                                    );
                                    cleaned.push(entry.task_id.clone());
                                }
                            },
                        );
                    });
                }
                for id in cleaned {
                    runtime.agents.remove_orphan(&id);
                }
            });
            ui.add_space(6.0);
        }

        // ── Chats list ────────────────────────────────────────────────────
        ui.label(
            egui::RichText::new(format!("Chats ({})", runtime.agents.chats.len()))
                .size(11.5)
                .color(p.text_secondary)
                .strong(),
        );
        ui.add_space(2.0);
        ui.separator();

        if runtime.agents.chats.is_empty() {
            ui.add_space(6.0);
            ui.label(
                egui::RichText::new("No chats yet. Click \"+ New task\" to start one.")
                    .size(11.0)
                    .color(p.text_muted),
            );
        } else {
            let order: Vec<String> = runtime.agents.chat_order.clone();
            for task_id in order {
                let Some(chat) = runtime.agents.chats.get(&task_id) else { continue };
                let label = if chat.label.is_empty() {
                    "Untitled task".to_string()
                } else {
                    chat.label.clone()
                };
                let status_color = match chat.status.as_str() {
                    "success" => p.success,
                    "failed" => p.error,
                    "cancelled" => p.text_muted,
                    s if s.is_empty() => p.text_muted,
                    _ if chat.is_running() => p.primary,
                    _ => p.text_muted,
                };
                let attention = chat.attention;
                ui.horizontal(|ui| {
                    ui.painter().circle_filled(
                        ui.cursor().min + egui::vec2(6.0, 10.0),
                        4.0,
                        status_color,
                    );
                    ui.add_space(16.0);
                    let resp = ui.add(
                        egui::Button::new(
                            egui::RichText::new(&label).size(12.0).color(p.text),
                        )
                        .frame(false),
                    );
                    if attention {
                        // Right-side warning dot to flag the chat as idle per
                        // the watchdog's ATTENTION_IDLE_THRESHOLD_MS rule.
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                let (rect, _) = ui.allocate_exact_size(
                                    egui::vec2(10.0, 10.0),
                                    egui::Sense::hover(),
                                );
                                ui.painter().circle_filled(
                                    rect.center(),
                                    4.0,
                                    p.warning,
                                );
                            },
                        );
                    }
                    if resp.clicked() {
                        let tab_id = format!("agent:chat:{}", task_id);
                        if runtime.tabs.iter().any(|t| t.id == tab_id) {
                            runtime.active_tab_id = tab_id;
                        } else {
                            let tab = crate::state::Tab::agent_chat(&task_id, &label);
                            runtime.active_tab_id = tab.id.clone();
                            runtime.tabs.push(tab);
                        }
                    }
                });
            }
        }

        ui.add_space(12.0);
        ui.separator();
        ui.add_space(6.0);
        ui.label(
            egui::RichText::new("CLI orchestrator — coming in 7D")
                .size(10.5)
                .color(p.text_muted),
        );
    });
}

fn file_icon(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("");
    match ext {
        "rs" => "\u{1F980}",       // crab for Rust
        "toml" => "\u{2699}",      // gear
        "json" => "\u{1F4CB}",     // clipboard
        "md" => "\u{1F4DD}",       // memo
        "ts" | "tsx" => "\u{1F7E6}", // blue square
        "js" | "jsx" => "\u{1F7E8}", // yellow square
        "py" => "\u{1F40D}",       // snake
        "css" | "scss" => "\u{1F3A8}", // palette
        "html" => "\u{1F310}",     // globe
        "sh" | "bash" | "zsh" => "\u{1F4DC}", // scroll
        "yaml" | "yml" => "\u{2699}",
        "lock" => "\u{1F512}",     // lock
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" => "\u{1F5BC}", // framed picture
        _ => "\u{1F4C4}",          // page
    }
}
