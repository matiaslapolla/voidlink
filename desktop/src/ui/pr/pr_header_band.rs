//! Solid PR band. Parity: Conductor `PR #1432 ↗ Ready to merge [Merge]`.
//!
//! Color is animated between `pr_ready_bg`, `pr_conflict_bg`, `pr_draft_bg`,
//! and `pr_failing_bg` via `motion::animate_color` whenever the underlying
//! session status flips. The [Merge] button is disabled unless
//! `mergeable == Clean` and state is `Open`.

use eframe::egui::{self, Color32, CornerRadius, RichText, Sense};

use crate::motion;
use crate::state::{Mergeable, PrState, PullRequestInfo, SessionStatus};
use crate::theme::ThemePalette;

pub struct PrHeaderEvents {
    pub merge_clicked: bool,
    pub open_external: bool,
    pub refresh_clicked: bool,
}

pub fn pr_header_band(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    anim_id_salt: &str,
    pr: &PullRequestInfo,
    derived_status: SessionStatus,
) -> PrHeaderEvents {
    let mut events = PrHeaderEvents {
        merge_clicked: false,
        open_external: false,
        refresh_clicked: false,
    };

    // Target band colours from the session status.
    let (target_bg, fg) = band_colors(palette, derived_status);
    let anim_id = egui::Id::new(("pr_band_color", anim_id_salt));
    let bg = motion::animate_color(ui.ctx(), anim_id, target_bg, motion::dur::PR_BAND);

    let avail = ui.available_rect_before_wrap();
    let band_h = 40.0_f32;
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(avail.width(), band_h), Sense::hover());

    if ui.is_rect_visible(rect) {
        ui.painter().rect_filled(rect, CornerRadius::same(8), bg);

        // Optional subtle glow for ReadyToMerge.
        if matches!(derived_status, SessionStatus::ReadyToMerge) {
            paint_glow(ui, rect, palette.pr_ready_glow);
        }

        // Left: PR number + status phrase.
        let phrase = status_phrase(derived_status, pr);
        ui.painter().text(
            egui::pos2(rect.min.x + 12.0, rect.center().y),
            egui::Align2::LEFT_CENTER,
            format!("PR #{}   {}", pr.number, phrase),
            egui::FontId::proportional(12.5),
            fg,
        );
    }

    // Overlay interactive controls using Area to paint on top of the band.
    let overlay_id = egui::Id::new(("pr_band_overlay", anim_id_salt));
    egui::Area::new(overlay_id)
        .fixed_pos(egui::pos2(rect.max.x - 180.0, rect.min.y + 7.0))
        .order(egui::Order::Middle)
        .show(ui.ctx(), |ui| {
            ui.horizontal(|ui| {
                // Refresh glyph.
                if ui
                    .small_button(
                        RichText::new("\u{21BB}")
                            .size(12.0)
                            .color(fg),
                    )
                    .on_hover_text("Refresh PR")
                    .clicked()
                {
                    events.refresh_clicked = true;
                }

                // Open in browser.
                if ui
                    .small_button(
                        RichText::new("\u{2197}")
                            .size(12.0)
                            .color(fg),
                    )
                    .on_hover_text("Open in browser")
                    .clicked()
                {
                    events.open_external = true;
                }

                let can_merge = matches!(pr.state, PrState::Open)
                    && matches!(pr.mergeable, Mergeable::Clean)
                    && !pr.draft;
                let btn_label = if pr.draft { "Mark ready" } else { "Merge" };
                let btn = egui::Button::new(
                    RichText::new(btn_label)
                        .size(12.0)
                        .strong()
                        .color(fg),
                )
                .fill(Color32::from_rgba_unmultiplied(
                    fg.r(),
                    fg.g(),
                    fg.b(),
                    32,
                ))
                .corner_radius(CornerRadius::same(6))
                .min_size(egui::vec2(74.0, 24.0));
                let r = ui.add_enabled(can_merge, btn);
                let r = if can_merge {
                    r
                } else if pr.draft {
                    r.on_hover_text("Draft PR — mark ready to enable merging.")
                } else {
                    r.on_hover_text(match pr.mergeable {
                        Mergeable::Conflicts => "Merge conflicts — resolve first.",
                        Mergeable::Blocked => "Merge blocked by branch protection.",
                        _ => "Merge not available.",
                    })
                };
                if r.clicked() && can_merge {
                    events.merge_clicked = true;
                }
            });
        });

    events
}

fn band_colors(p: &ThemePalette, status: SessionStatus) -> (Color32, Color32) {
    match status {
        SessionStatus::ReadyToMerge | SessionStatus::PrMerged => (p.pr_ready_bg, p.pr_ready_fg),
        SessionStatus::MergeConflicts => (p.pr_conflict_bg, p.pr_conflict_fg),
        SessionStatus::DraftPr => (p.pr_draft_bg, p.pr_draft_fg),
        SessionStatus::ChecksFailing | SessionStatus::Failed => (p.pr_failing_bg, p.pr_failing_fg),
        SessionStatus::ChecksRunning | SessionStatus::PrOpen => (p.pr_draft_bg, p.pr_draft_fg),
        _ => (p.surface_elevated, p.text_muted),
    }
}

fn status_phrase(status: SessionStatus, pr: &PullRequestInfo) -> String {
    match status {
        SessionStatus::ReadyToMerge => "Ready to merge".to_string(),
        SessionStatus::MergeConflicts => "Merge conflicts".to_string(),
        SessionStatus::DraftPr => "Draft".to_string(),
        SessionStatus::ChecksFailing => "Checks failing".to_string(),
        SessionStatus::ChecksRunning => "Checks running".to_string(),
        SessionStatus::PrMerged => "Merged".to_string(),
        SessionStatus::PrClosed => "Closed".to_string(),
        SessionStatus::PrOpen => "Open".to_string(),
        _ => pr.title.clone(),
    }
}

/// Inline `fx::glow_stripe` approximation — layered low-alpha expands around
/// the band rect. Called only when `status == ReadyToMerge`. Pulses via
/// `motion::pulse_sine`.
fn paint_glow(ui: &egui::Ui, rect: egui::Rect, tint: Color32) {
    let pulse = motion::pulse_sine(ui.ctx(), motion::dur::STATUS_DOT_PULSE);
    let base_alpha = tint.a() as f32;
    for i in 1..=4 {
        let expand = i as f32 * 1.2;
        let alpha = ((1.0 - i as f32 / 5.0) * (0.5 + 0.5 * pulse) * base_alpha)
            .clamp(0.0, 255.0) as u8;
        let c = Color32::from_rgba_unmultiplied(tint.r(), tint.g(), tint.b(), alpha);
        ui.painter().rect_filled(
            rect.expand(expand),
            CornerRadius::same((8.0 + expand) as u8),
            c,
        );
    }
    ui.ctx()
        .request_repaint_after(std::time::Duration::from_millis(50));
}
