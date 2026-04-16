//! UI widget primitives introduced by ED-A (polish plan §3).
//!
//! Each sub-module exposes one small, reusable egui widget that does not
//! itself reach into `AppState` / `RuntimeState`. Composition happens at the
//! panel/page level.

pub mod auto_accept_toggle;
pub mod badge;
pub mod branch_chip;
pub mod delta_count;
pub mod file_badge;
pub mod kbd;
pub mod keyboard_hint_chip;
pub mod model_selector;
pub mod scroll_to_bottom_pill;
pub mod status_dot;
pub mod tab_subtitle;
pub mod toast_host;
pub mod token_budget_meter;
pub mod tool_call_group;

pub use auto_accept_toggle::auto_accept_toggle;
pub use badge::{badge, BadgeTone};
pub use branch_chip::branch_chip;
pub use delta_count::delta_count;
pub use file_badge::file_badge;
pub use kbd::kbd;
pub use keyboard_hint_chip::keyboard_hint_chip;
pub use model_selector::model_selector;
pub use scroll_to_bottom_pill::scroll_to_bottom_pill;
pub use status_dot::{status_dot, StatusDotState};
pub use tab_subtitle::{tab_subtitle, SubtabEntry};
pub use toast_host::toast_host;
pub use token_budget_meter::token_budget_meter;
pub use tool_call_group::{tool_call_group, ToolCallGroupState};
