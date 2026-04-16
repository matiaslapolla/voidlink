//! ED-F PR refresh + merge worker.
//!
//! Keeps the UI thread snappy by dispatching `list_prs_impl`, `get_pr_impl`,
//! and `merge_pr_impl` calls onto a worker thread. The worker posts results
//! back into a `ResponseQueue` which the main loop drains each frame.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;

use crossbeam_channel::{bounded, Receiver, Sender};
use eframe::egui;

use crate::state::sessions::PullRequestInfo;

#[derive(Debug, Clone)]
pub enum PrRequest {
    /// Refresh a single PR by number.
    GetOne {
        session_id: String,
        repo_path: String,
        pr_number: u32,
    },
    /// List open PRs for a repo — used when we don't yet know a PR number.
    List {
        session_id: String,
        repo_path: String,
        head_branch: String,
    },
    // NOTE: ED-F MVP ships refresh-only. Merging requires `MigrationState`
    // which is not held by the worker today; see `TODO(ED-F-merge-wiring)`
    // in `ui/pr/pr_header_band.rs` for the plan to plumb it through.
}

#[derive(Debug, Clone)]
pub enum PrResponse {
    Updated {
        session_id: String,
        pr: Option<PullRequestInfo>,
    },
    Merged {
        session_id: String,
        result: Result<(), String>,
    },
    Error {
        session_id: String,
        message: String,
    },
}

pub struct PrWorker {
    tx: Sender<PrRequest>,
    pub responses: Arc<Mutex<VecDeque<PrResponse>>>,
}

impl Default for PrWorker {
    fn default() -> Self {
        Self::spawn(None)
    }
}

impl PrWorker {
    pub fn spawn(ctx: Option<&egui::Context>) -> Self {
        let (tx, rx) = bounded::<PrRequest>(32);
        let responses: Arc<Mutex<VecDeque<PrResponse>>> = Arc::default();
        let r2 = responses.clone();
        let ctx_cloned = ctx.cloned();

        thread::Builder::new()
            .name("voidlink-pr-worker".into())
            .spawn(move || Self::run(rx, r2, ctx_cloned))
            .ok();

        Self { tx, responses }
    }

    pub fn dispatch(&self, req: PrRequest) {
        // Drop on full channel — user can retry.
        let _ = self.tx.try_send(req);
    }

    /// Drain pending responses (caller applies them to AppState).
    pub fn drain(&self) -> Vec<PrResponse> {
        let mut guard = match self.responses.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        guard.drain(..).collect()
    }

    fn run(
        rx: Receiver<PrRequest>,
        responses: Arc<Mutex<VecDeque<PrResponse>>>,
        ctx: Option<egui::Context>,
    ) {
        while let Ok(req) = rx.recv() {
            let out = Self::handle(req);
            if let Some(resp) = out {
                if let Ok(mut guard) = responses.lock() {
                    guard.push_back(resp);
                }
                if let Some(ctx) = ctx.as_ref() {
                    ctx.request_repaint();
                }
            }
        }
    }

    fn handle(req: PrRequest) -> Option<PrResponse> {
        match req {
            PrRequest::GetOne {
                session_id,
                repo_path,
                pr_number,
            } => {
                match voidlink_core::git_review::get_pr_impl(repo_path, pr_number) {
                    Ok(core) => Some(PrResponse::Updated {
                        session_id,
                        pr: Some(PullRequestInfo::from_core(&core)),
                    }),
                    Err(e) => Some(PrResponse::Error {
                        session_id,
                        message: e,
                    }),
                }
            }
            PrRequest::List {
                session_id,
                repo_path,
                head_branch,
            } => {
                match voidlink_core::git_review::list_prs_impl(
                    repo_path,
                    Some("open".to_string()),
                ) {
                    Ok(list) => {
                        let matched = list.iter().find(|p| p.head_branch == head_branch);
                        Some(PrResponse::Updated {
                            session_id,
                            pr: matched.map(PullRequestInfo::from_core),
                        })
                    }
                    Err(e) => Some(PrResponse::Error {
                        session_id,
                        message: e,
                    }),
                }
            }
        }
    }
}
