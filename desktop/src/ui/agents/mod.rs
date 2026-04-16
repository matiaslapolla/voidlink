//! Agent system UI (Phase 7B — autonomous-task chat MVP).
//!
//! Structure:
//! - `chat::show` — full per-chat view (status bar → messages → composer).
//! - `task_form::show` — task-creation form rendered before `StartTask`.
//! - `sidebar` helpers (in `crate::ui::sidebar` for now) open/list chats.
//! - `components/*` — `ChatMessage`, `TaskStatusBar`, `MessageComposer`.
//!
//! 7C will add `LiveDiffPanel`, 7D the orchestrator + PTY sessions.

pub mod chat;
pub mod components;
pub mod task_form;

use std::sync::Arc;

use crossbeam_channel::Sender;
use eframe::egui;

use crate::state::agents::{AgentAction, EguiEmitter};
use crate::theme::ThemePalette;

/// Context handed into every agent UI widget. Gives access to theme tokens,
/// the current repo path, the action channel, and the per-frame emitter
/// factory — without needing to drill `RuntimeState` + `AppState` through every
/// function signature.
pub struct AgentCtx<'a> {
    pub palette: ThemePalette,
    pub repo_path: Option<&'a str>,
    pub action_tx: &'a Sender<AgentAction>,
    /// Emitter factory — call this (at most once per `StartTask`) to get an
    /// `Arc<dyn EventEmitter>` bound to the UI's pipeline channel.
    pub make_emitter: Box<dyn Fn() -> Arc<EguiEmitter> + 'a>,
    /// Shared task store — injected into `run_agent_pipeline` so both the
    /// pipeline and any future status-query UI see the same map.
    pub tasks_store: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, voidlink_core::git_agent::AgentTaskState>,
        >,
    >,
    /// Lazily-built `MigrationState`. `None` when no provider / BYOK settings
    /// are available yet (we surface a friendly error in `TaskCreateForm`).
    pub migration: Option<voidlink_core::migration::MigrationState>,
    /// egui context, used by the composer for focus/repaint. Reserved for 7C
    /// (live-diff repaint on DiffUpdated) — allowed dead in 7B.
    #[allow(dead_code)]
    pub egui_ctx: &'a egui::Context,
}
