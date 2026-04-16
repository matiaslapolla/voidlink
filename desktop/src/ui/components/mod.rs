//! Shared UI components used across multiple panels.
//!
//! These primitives are extracted from existing panels so that both
//! `ui::git_panel` and `ui::agents::components::diff_panel` can reuse the
//! exact same visual treatment for diff rendering (Phase 7C).

pub mod diff_rows;
