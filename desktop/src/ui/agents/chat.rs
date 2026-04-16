//! Full agent chat view (Phase 7B).
//!
//! Layout:
//!   ┌── status bar ──────────────────────────────────────────┐
//!   │  [spinner]  running  — implementing   ai/foo-xyz  Cancel│
//!   ├─────────────────────────────────────────────────────────┤
//!   │                                                         │
//!   │   scrollable messages (or TaskCreateForm)               │
//!   │                                                         │
//!   ├─────────────────────────────────────────────────────────┤
//!   │  composer (disabled while running / terminal)           │
//!   └─────────────────────────────────────────────────────────┘
//!
//! Right-side `LiveDiffPanel` is reserved for 7C.

use eframe::egui;

use super::components::{composer, diff_panel, event_timeline, pr_draft, status_bar, typing};
use super::{task_form, AgentCtx};
use crate::state::agents::{AgentAction, ChatTabState};
use crate::ui::widgets;

/// Min/max panel width for the right-side LiveDiffPanel (plan §7C step 5).
const DIFF_PANEL_MIN: f32 = 240.0;
const DIFF_PANEL_MAX: f32 = 640.0;

pub fn show(ui: &mut egui::Ui, chat: &mut ChatTabState, ctx: &mut AgentCtx) {
    let p = ctx.palette;

    // The LiveDiffPanel is only useful once the task has started — hide it for
    // the initial `TaskCreateForm` state so the form has the full width.
    let show_diff_panel = chat.form.is_none();

    // Use a nested SidePanel *inside* the region allocated to this chat tab.
    // We need a stable id derived from the task so multiple chats don't fight
    // over a single persisted width.
    let panel_id = egui::Id::new(("agent_diff_panel", chat.task_id.clone()));

    if show_diff_panel {
        let initial_width = chat
            .files_panel_width
            .clamp(DIFF_PANEL_MIN, DIFF_PANEL_MAX);

        let panel_resp = egui::SidePanel::right(panel_id)
            .resizable(true)
            .min_width(DIFF_PANEL_MIN)
            .max_width(DIFF_PANEL_MAX)
            .default_width(initial_width)
            .show_inside(ui, |ui| {
                diff_panel::show(ui, chat, ctx);
            });

        // Persist the user-resized width onto the chat so it survives tab
        // switches (SidePanel already persists via `egui::Memory`, but we keep
        // a mirror on `ChatTabState` for the plan's contract).
        let new_width = panel_resp.response.rect.width();
        if (new_width - chat.files_panel_width).abs() > 0.5 {
            chat.files_panel_width = new_width.clamp(DIFF_PANEL_MIN, DIFF_PANEL_MAX);
        }
    }

    // Remaining area → chat column (status bar + messages + composer).
    egui::CentralPanel::default()
        .frame(egui::Frame::NONE.fill(p.background))
        .show_inside(ui, |ui| {
            ui.vertical(|ui| {
                // ── Status bar ──────────────────────────────────────────────
                if chat.form.is_none() {
                    let cancel_clicked = status_bar::show(ui, chat, p);
                    if cancel_clicked {
                        let _ = ctx.action_tx.send(AgentAction::CancelTask {
                            task_id: chat.task_id.clone(),
                            tasks_store: ctx.tasks_store.clone(),
                        });
                    }
                }

                // ── Form OR messages ────────────────────────────────────────
                let messages_rect_height = {
                    let reserved = if chat.form.is_some() { 0.0 } else { 60.0 };
                    (ui.available_height() - reserved).max(100.0)
                };

                egui::Frame::NONE.fill(p.editor_bg).show(ui, |ui| {
                    ui.set_min_height(messages_rect_height);
                    ui.set_max_height(messages_rect_height);
                    if chat.form.is_some() {
                        let _ = task_form::show(ui, chat, ctx);
                    } else {
                        render_messages(ui, chat, ctx);
                    }
                });

                // ── Composer ───────────────────────────────────────────────
                if chat.form.is_none() {
                    let (disabled, placeholder) = if chat.is_running() {
                        (true, "Agent is busy — follow-ups ignored in 7B")
                    } else if chat.is_terminal() {
                        (true, "Task finished. Start a new task from the sidebar.")
                    } else {
                        (true, "Task pending…")
                    };
                    let _ = composer::show(
                        ui,
                        &mut chat.composer_buffer,
                        disabled,
                        placeholder,
                        p,
                    );

                    // ED-D composer footer: auto-accept toggle + token meter +
                    // model selector. Visual only in ED-D; wired to real state
                    // in ED-E/ED-F.
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;
                        let _ = widgets::auto_accept_toggle(ui, &p, &mut chat.auto_accept);
                        let _ = widgets::token_budget_meter(
                            ui,
                            &p,
                            chat.tokens_used,
                            chat.context_window,
                        );
                        let _ = widgets::model_selector(
                            ui,
                            &p,
                            &chat.model_name,
                            chat.is_running(),
                        );
                    });
                }
            });
        });
}

fn render_messages(ui: &mut egui::Ui, chat: &mut ChatTabState, ctx: &mut AgentCtx) {
    let p = ctx.palette;

    // StepProgress sits above the scroll area so it stays pinned.
    event_timeline::show_step_progress(ui, chat, &p);

    let scroll = egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .stick_to_bottom(true);

    let scroll_response = scroll.show(ui, |ui| {
        ui.add_space(8.0);
        event_timeline::show_timeline(ui, chat, &p);

        // TypingIndicator tail — rendered while the pipeline is still running,
        // signalling a live pending step.
        if chat.is_running() {
            ui.add_space(4.0);
            typing::show(ui, &p);
        }

        // PrDraftCard — only rendered once the task is terminal and we have
        // either a url, a draft, or an auto_pr=false context.
        if chat.is_terminal() {
            ui.add_space(10.0);
            pr_draft::show(ui, chat, ctx);
        }
        ui.add_space(12.0);
    });

    // ED-D: detect whether the user has scrolled away from the bottom. The
    // scroll state gives us the current offset; if we're more than a screen
    // of content away from the end, surface the pill.
    let state = scroll_response.state;
    let offset_from_bottom = (state.offset.y - state.offset.y).abs(); // reserved
    let _ = offset_from_bottom;
    let near_bottom = scroll_response
        .inner_rect
        .height()
        .max(1.0)
        >= (scroll_response.content_size.y - state.offset.y) - 4.0;
    chat.show_scroll_to_bottom_pill = !near_bottom && !chat.messages.is_empty();
    if near_bottom {
        chat.unread_since_scroll = 0;
    }

    if chat.show_scroll_to_bottom_pill {
        // Floating pill at the bottom-center of the chat column.
        let area = egui::Area::new(egui::Id::new(("scroll_pill", &chat.task_id)))
            .anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -12.0))
            .order(egui::Order::Foreground);
        area.show(ui.ctx(), |ui| {
            let clicked = widgets::scroll_to_bottom_pill(
                ui,
                &p,
                true,
                chat.unread_since_scroll,
            );
            if clicked {
                chat.scroll_to_bottom = true;
                chat.unread_since_scroll = 0;
            }
        });
    }

    if chat.scroll_to_bottom {
        ui.ctx().request_repaint();
        chat.scroll_to_bottom = false;
    }
}
