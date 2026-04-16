//! Shader & effects module (polish plan §7).
//!
//! ED-G MVP ships two CPU-only items:
//!   - `gradient_background` — animated 3-stop drift behind the CentralPanel.
//!   - `glow_stripe` / neon pulse — helpers already inlined in
//!     `widgets/status_dot.rs` and `pr/pr_header_band.rs`.
//!
//! The wgpu-backed `shader_background` + `command_palette_backdrop` shader
//! paths are deferred — they need cross-OS testing (R2 in the plan's risk
//! register) before going into production.

pub mod gradient_background;

use serde::{Deserialize, Serialize};

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FxPreference {
    /// No fx — flat surfaces. Fastest on underpowered GPUs.
    Solid,
    /// CPU gradients + glows. Default.
    Soft,
    /// All effects including shader-backed hero panels (wgpu required).
    Full,
}

impl Default for FxPreference {
    fn default() -> Self {
        FxPreference::Soft
    }
}

impl FxPreference {
    pub const ALL: &[FxPreference] = &[
        FxPreference::Solid,
        FxPreference::Soft,
        FxPreference::Full,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            FxPreference::Solid => "Solid",
            FxPreference::Soft => "Soft",
            FxPreference::Full => "Full",
        }
    }

    /// Shorthand: true when the user opted into anything beyond flat surfaces.
    pub fn wants_gradient(&self) -> bool {
        !matches!(self, FxPreference::Solid)
    }
}
