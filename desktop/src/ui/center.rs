use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::{AppState, RuntimeState, TabKind};

pub fn center_panel(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    // Honor any queued file-open request from repo_intel click handlers.
    let repo_root = state.active_workspace().and_then(|w| w.repo_root.clone());
    super::repo_intel::process_pending_open(runtime, repo_root.as_deref());

    egui::CentralPanel::default()
        .frame(
            egui::Frame::NONE
                .fill(p.editor_bg)
                .inner_margin(egui::Margin::ZERO),
        )
        .show(ctx, |ui| {
            // ── Tab bar ─────────────────────────────────────────────────────
            tab_bar(ui, runtime, p);

            ui.add(egui::Separator::default().spacing(0.0));

            // ── Tab content ─────────────────────────────────────────────────
            let active_kind = runtime
                .active_tab()
                .map(|t| t.kind.clone());

            match active_kind {
                Some(TabKind::Welcome) => welcome_screen(ui, p),
                Some(TabKind::File { ref path }) => {
                    let is_image = matches!(
                        path.extension().and_then(|e| e.to_str()),
                        Some("png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp")
                    );
                    if is_image {
                        image_viewer(ui, path, p);
                    } else {
                        code_editor(ui, runtime, p);
                    }
                }
                Some(TabKind::Note { ref id }) => {
                    let note_id = id.clone();
                    super::notes::note_editor(ui, runtime, p, &note_id);
                }
                Some(TabKind::Search) => {
                    super::repo_intel::search_tab(ui, state, runtime);
                }
                Some(TabKind::DepGraph) => {
                    super::repo_intel::dep_graph_tab(ui, state, runtime);
                }
                Some(TabKind::DataFlow) => {
                    super::repo_intel::data_flow_tab(ui, state, runtime);
                }
                Some(TabKind::AgentChat { ref session_id }) => {
                    let task_id = session_id.clone();
                    agent_chat_tab(ui, ctx, state, runtime, &task_id);
                }
                Some(TabKind::AgentOrchestrator)
                | Some(TabKind::AgentCliTerminal { .. }) => {
                    agent_tab_placeholder(ui, p);
                }
                None => welcome_screen(ui, p),
            }
        });
}

fn tab_bar(
    ui: &mut egui::Ui,
    runtime: &mut RuntimeState,
    p: crate::theme::ThemePalette,
) {
    let mut tab_to_close: Option<String> = None;
    let mut tab_to_activate: Option<String> = None;

    ui.horizontal(|ui| {
        ui.add_space(4.0);
        for tab in &runtime.tabs {
            let is_active = tab.id == runtime.active_tab_id;
            let dirty_marker = if tab.dirty { " \u{25CF}" } else { "" };
            let label_text = format!("{}{}", tab.label, dirty_marker);

            let text = egui::RichText::new(&label_text)
                .size(12.0)
                .color(if is_active { p.text } else { p.text_muted });

            let fill = if is_active {
                p.tab_active_bg
            } else {
                egui::Color32::TRANSPARENT
            };

            let btn = ui.add(
                egui::Button::new(text)
                    .fill(fill)
                    .corner_radius(CornerRadius {
                        nw: 4,
                        ne: 4,
                        sw: 0,
                        se: 0,
                    }),
            );

            if btn.clicked() {
                tab_to_activate = Some(tab.id.clone());
            }

            // Middle-click or close button to close
            if btn.middle_clicked() {
                tab_to_close = Some(tab.id.clone());
            }

            // Small close button next to the tab
            if tab.kind != TabKind::Welcome {
                let close = ui.add(
                    egui::Button::new(
                        egui::RichText::new("\u{2715}")
                            .size(10.0)
                            .color(p.text_muted),
                    )
                    .frame(false),
                );
                if close.clicked() {
                    tab_to_close = Some(tab.id.clone());
                }
            }

            ui.add_space(2.0);
        }
    });

    if let Some(id) = tab_to_activate {
        runtime.active_tab_id = id;
    }
    if let Some(id) = tab_to_close {
        runtime.close_tab(&id);
    }
}

fn welcome_screen(ui: &mut egui::Ui, p: crate::theme::ThemePalette) {
    let available_h = ui.available_height();

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space((available_h * 0.22).max(40.0));

                ui.label(
                    egui::RichText::new("VoidLink")
                        .size(28.0)
                        .color(p.primary)
                        .strong(),
                );
                ui.add_space(6.0);
                ui.label(
                    egui::RichText::new("Pure Rust desktop \u{2014} powered by egui")
                        .size(13.0)
                        .color(p.text_secondary),
                );
                ui.add_space(28.0);

                ui.label(
                    egui::RichText::new("Open a file from the explorer to start editing")
                        .size(12.0)
                        .color(p.text_muted),
                );

                ui.add_space(20.0);

                // Keyboard shortcut table with pill badges
                ui.vertical(|ui| {
                    ui.set_max_width(280.0);
                    ui.spacing_mut().item_spacing.y = 6.0;

                    for (key, desc) in [
                        ("Ctrl+B", "Toggle sidebar"),
                        ("Ctrl+J", "Toggle terminal"),
                        ("Ctrl+\\", "Toggle right panel"),
                        ("Ctrl+S", "Save file"),
                        ("Ctrl+W", "Close tab"),
                    ] {
                        ui.horizontal(|ui| {
                            // Key badge pill
                            egui::Frame::NONE
                                .fill(p.surface_elevated)
                                .corner_radius(CornerRadius::same(4))
                                .inner_margin(egui::Margin::symmetric(6, 2))
                                .show(ui, |ui| {
                                    ui.label(
                                        egui::RichText::new(key)
                                            .size(11.0)
                                            .color(p.text_secondary)
                                            .family(egui::FontFamily::Monospace),
                                    );
                                });
                            ui.add_space(6.0);
                            ui.label(
                                egui::RichText::new(desc)
                                    .size(11.0)
                                    .color(p.text_muted),
                            );
                        });
                    }
                });
            });
        });
}

fn code_editor(
    ui: &mut egui::Ui,
    runtime: &mut RuntimeState,
    p: crate::theme::ThemePalette,
) {
    let id = runtime.active_tab_id.clone();
    if let Some(tab) = runtime.tabs.iter_mut().find(|t| t.id == id) {
        let line_count = tab.content.lines().count().max(1);
        let gutter_chars = format!("{}", line_count).len();
        let gutter_width = gutter_chars as f32 * 8.0 + 24.0;

        egui::ScrollArea::both()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.horizontal_top(|ui| {
                    // Gutter with background
                    egui::Frame::NONE
                        .fill(p.surface)
                        .inner_margin(egui::Margin {
                            left: 8,
                            right: 8,
                            top: 4,
                            bottom: 4,
                        })
                        .show(ui, |ui| {
                            ui.set_width(gutter_width);
                            for i in 1..=line_count {
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Min),
                                    |ui| {
                                        ui.label(
                                            egui::RichText::new(format!("{}", i))
                                                .size(13.0)
                                                .color(p.text_muted)
                                                .family(egui::FontFamily::Monospace),
                                        );
                                    },
                                );
                            }
                        });

                    // Vertical rule between gutter and editor
                    let gutter_rect = ui.cursor();
                    ui.painter().line_segment(
                        [
                            egui::pos2(gutter_rect.left(), gutter_rect.top()),
                            egui::pos2(
                                gutter_rect.left(),
                                gutter_rect.top() + ui.available_height(),
                            ),
                        ],
                        egui::Stroke::new(1.0, p.border),
                    );
                    ui.add_space(2.0);

                    // Editor area
                    let response = ui.add(
                        egui::TextEdit::multiline(&mut tab.content)
                            .font(egui::TextStyle::Monospace)
                            .desired_width(f32::INFINITY)
                            .frame(false)
                            .code_editor()
                            .lock_focus(true),
                    );

                    if response.changed() {
                        tab.dirty = true;
                    }
                });
            });
    }
}

fn agent_chat_tab(
    ui: &mut egui::Ui,
    ctx: &egui::Context,
    state: &mut AppState,
    runtime: &mut RuntimeState,
    task_id: &str,
) {
    let p = state.theme.palette();

    // Ensure chat exists — the sidebar is the normal creator, but if the
    // tab survived a restart without an in-memory chat, fall back to an
    // empty placeholder row.
    if !runtime.agents.chats.contains_key(task_id) {
        ui.vertical_centered(|ui| {
            ui.add_space(40.0);
            ui.label(
                egui::RichText::new("Chat not found")
                    .size(14.0)
                    .color(p.text),
            );
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new(
                    "This chat's in-memory state was lost. Start a new task from the Agents sidebar.",
                )
                .size(11.0)
                .color(p.text_muted),
            );
        });
        return;
    }

    let repo_path_owned: Option<String> =
        state.active_workspace().and_then(|w| w.repo_root.clone());

    // Ensure migration state exists once — reuse `RepoIntelState`'s lazy init.
    let migration = runtime
        .repo_intel
        .ensure_migration(repo_path_owned.as_deref())
        .map(|m| (*m).clone());

    // Build AgentCtx bits that don't borrow the chat.
    let tasks_store = runtime.agents.git_agent_state.tasks.clone();
    let action_tx = runtime.agents.action_tx.clone();
    let pipeline_tx = runtime.agents.pipeline_tx.clone();
    let ctx_clone = ctx.clone();

    let make_emitter: Box<dyn Fn() -> std::sync::Arc<crate::state::agents::EguiEmitter>> =
        Box::new(move || {
            std::sync::Arc::new(crate::state::agents::EguiEmitter::new(
                ctx_clone.clone(),
                pipeline_tx.clone(),
            ))
        });

    // Temporarily detach the chat to avoid double-borrow of runtime.agents.
    let mut chat = match runtime.agents.chats.remove(task_id) {
        Some(c) => c,
        None => return,
    };

    {
        let mut agent_ctx = super::agents::AgentCtx {
            palette: p,
            repo_path: repo_path_owned.as_deref(),
            action_tx: &action_tx,
            make_emitter,
            tasks_store,
            migration,
            egui_ctx: ctx,
        };
        super::agents::chat::show(ui, &mut chat, &mut agent_ctx);
    }

    // Reinstall. Don't touch chat_order — insertion order is preserved elsewhere.
    runtime.agents.chats.insert(task_id.to_string(), chat);
}

fn agent_tab_placeholder(ui: &mut egui::Ui, p: crate::theme::ThemePalette) {
    ui.vertical_centered(|ui| {
        ui.add_space(40.0);
        ui.label(
            egui::RichText::new("Agent tab")
                .size(16.0)
                .color(p.text)
                .strong(),
        );
        ui.add_space(6.0);
        ui.label(
            egui::RichText::new("Chat, orchestrator, and CLI terminal views arrive in 7B–7D.")
                .size(12.0)
                .color(p.text_muted),
        );
    });
}

fn image_viewer(
    ui: &mut egui::Ui,
    path: &std::path::Path,
    p: crate::theme::ThemePalette,
) {
    ui.centered_and_justified(|ui| {
        ui.vertical_centered(|ui| {
            ui.add_space(16.0);
            ui.label(
                egui::RichText::new(
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                )
                .size(14.0)
                .color(p.text),
            );
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("Image preview not yet implemented")
                    .size(12.0)
                    .color(p.text_muted),
            );
        });
    });
}
