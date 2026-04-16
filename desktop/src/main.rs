mod fonts;
mod fx;
mod motion;
mod state;
mod theme;
mod ui;

use eframe::egui;

fn main() -> eframe::Result<()> {
    env_logger::init();

    let saved_state = state::persistence::load();
    let is_dark = saved_state.theme.palette().is_dark;

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([800.0, 500.0])
            .with_title("VoidLink")
            .with_decorations(false),
        ..Default::default()
    };

    eframe::run_native(
        "VoidLink",
        options,
        Box::new(move |cc| {
            // ED-A: install Geist fonts (falls back to egui default if assets
            // missing).
            fonts::install_fonts(&cc.egui_ctx);

            if is_dark {
                cc.egui_ctx.set_visuals(egui::Visuals::dark());
            } else {
                cc.egui_ctx.set_visuals(egui::Visuals::light());
            }
            Ok(Box::new(VoidLinkApp::new(cc, saved_state)))
        }),
    )
}

pub struct VoidLinkApp {
    pub state: state::AppState,
    pub runtime: state::RuntimeState,
    last_theme: theme::Theme,
    dirty_frames: u32,
}

impl VoidLinkApp {
    fn new(cc: &eframe::CreationContext<'_>, mut saved_state: state::AppState) -> Self {
        // If a repo path was passed on the command line, set it on the active workspace
        if let Some(repo) = std::env::args().nth(1) {
            if let Some(ws) = saved_state.active_workspace_mut() {
                ws.repo_root = Some(repo);
            }
        }

        saved_state.theme.apply(&cc.egui_ctx);

        // Initialize runtime state with file tree from active workspace
        let mut runtime = state::RuntimeState::default();
        if let Some(ws) = saved_state.active_workspace() {
            if let Some(ref root) = ws.repo_root {
                runtime.load_tree(root);
            }
        }

        // Spawn the agent dispatcher thread and hydrate persisted agent state.
        runtime.agents.spawn_dispatcher(&cc.egui_ctx);
        runtime.agents.seed_from_persisted(&saved_state.agents);
        // Phase 7E: attention watchdog + orphan worktree reconcile.
        runtime.agents.spawn_watchdog(&cc.egui_ctx);
        runtime.agents.reconcile_orphans(&saved_state.agents);

        Self {
            last_theme: saved_state.theme,
            state: saved_state,
            runtime,
            dirty_frames: 0,
        }
    }

    fn handle_keyboard(&mut self, ctx: &egui::Context) {
        ctx.input(|i| {
            // Ctrl+B: toggle left sidebar
            if i.modifiers.ctrl && i.key_pressed(egui::Key::B) && !i.modifiers.shift {
                self.state.layout.left_sidebar_open = !self.state.layout.left_sidebar_open;
                self.dirty_frames = 1;
            }
            // Ctrl+Shift+B or Ctrl+\: toggle right sidebar
            if (i.modifiers.ctrl && i.modifiers.shift && i.key_pressed(egui::Key::B))
                || (i.modifiers.ctrl && i.key_pressed(egui::Key::Backslash))
            {
                self.state.layout.right_sidebar_open = !self.state.layout.right_sidebar_open;
                self.dirty_frames = 1;
            }
            // Ctrl+J: toggle bottom pane
            if i.modifiers.ctrl && i.key_pressed(egui::Key::J) {
                self.state.layout.bottom_pane_open = !self.state.layout.bottom_pane_open;
                self.dirty_frames = 1;
            }
            // Ctrl+S: save active tab
            if i.modifiers.ctrl && i.key_pressed(egui::Key::S) {
                if let Err(e) = self.runtime.save_active_tab() {
                    log::error!("Failed to save: {}", e);
                }
                self.dirty_frames = 1;
            }
            // Ctrl+W: close active tab
            if i.modifiers.ctrl && i.key_pressed(egui::Key::W) {
                let id = self.runtime.active_tab_id.clone();
                self.runtime.close_tab(&id);
            }
        });
    }
}

impl eframe::App for VoidLinkApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Re-apply theme if it changed
        if self.state.theme != self.last_theme {
            self.state.theme.apply(ctx);
            self.last_theme = self.state.theme;
            self.dirty_frames = 1;
        }

        self.handle_keyboard(ctx);

        // ED-G: paint the gradient into the shared background layer so panel
        // frames (which paint into their own layers at a higher Order) always
        // cover it. Using `Area::new(...).order(Background)` stacked above
        // the panels instead of beneath — that bug blanked the whole UI.
        if self.state.fx_preference.wants_gradient() {
            let palette = self.state.theme.palette();
            let screen = ctx.screen_rect();
            let painter = ctx.layer_painter(egui::LayerId::background());
            fx::gradient_background::paint(ctx, &painter, screen, &palette);
        }

        // Drain any pipeline messages posted by background workers.
        self.runtime.agents.drain_pipeline_messages();

        // ED-F: drain PR worker responses into the sessions registry.
        for resp in self.runtime.pr_worker.drain() {
            match resp {
                state::sessions_worker::PrResponse::Updated { session_id, pr } => {
                    if let Some(session) = self.state.sessions.get_mut(&session_id) {
                        session.pr = pr;
                        session.status = session.derive_status();
                        session.updated_at_ms = now_ms();
                    }
                }
                state::sessions_worker::PrResponse::Merged { session_id, result } => {
                    match result {
                        Ok(()) => {
                            self.runtime.toasts.success("PR merged.");
                            if let Some(session) = self.state.sessions.get_mut(&session_id) {
                                if let Some(pr) = session.pr.as_mut() {
                                    pr.state = state::PrState::Merged;
                                }
                                session.status = state::SessionStatus::PrMerged;
                            }
                        }
                        Err(e) => {
                            self.runtime.toasts.error("Merge failed", Some(e));
                        }
                    }
                }
                state::sessions_worker::PrResponse::Error { message, .. } => {
                    self.runtime.toasts.warning(message);
                }
            }
        }

        // Render panels in order (outer to inner)
        ui::title_bar(ctx, &mut self.state, &self.runtime);
        ui::status_bar(ctx, &mut self.state, &self.runtime);
        ui::bottom_pane(ctx, &mut self.state, &mut self.runtime);
        ui::left_sidebar(ctx, &mut self.state, &mut self.runtime);
        ui::right_panel(ctx, &mut self.state, &mut self.runtime);
        ui::center_panel(ctx, &mut self.state, &mut self.runtime);

        // ED-A: floating toasts anchored on top of everything.
        ui::toast_host(ctx, &self.state, &mut self.runtime);

        // ED-G: command palette (Ctrl/Cmd+K). Rendered last so it layers
        // above the toast host's Area.
        ui::command_palette(ctx, &mut self.state, &mut self.runtime);

        // Debounced persistence
        if self.dirty_frames > 0 {
            self.dirty_frames += 1;
            if self.dirty_frames > 60 {
                state::persistence::save(&self.state);
                self.dirty_frames = 0;
            }
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        state::persistence::save(&self.state);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
