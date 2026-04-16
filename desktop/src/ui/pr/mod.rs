//! ED-F PR chrome widgets.
//!
//! Top-of-rail band + file-list panel. Reads from `Session.pr`; dispatches
//! merge + refresh actions via the worker channels in `state/sessions_worker.rs`.

pub mod pr_header_band;
pub mod pr_changes_panel;

pub use pr_header_band::{pr_header_band, PrHeaderEvents};
pub use pr_changes_panel::{pr_changes_panel, PrChangesTab};
