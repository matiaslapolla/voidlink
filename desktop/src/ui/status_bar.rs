//! VS Code-style status bar (ED-G §8.5).
//!
//! Segment layout, left → right:
//!   [branch]  [sync ↑/↓]  [problems]   …   [line:col]  [lang]  [FX pref]  [theme]  [⌘K]

use eframe::egui::{self, CornerRadius, RichText, Sense};

use crate::fx::FxPreference;
use crate::state::{AppState, RuntimeState, TabKind};
use crate::theme::{Theme, ThemePalette};

pub fn status_bar(ctx: &egui::Context, state: &mut AppState, runtime: &RuntimeState) {
    let p = state.theme.palette();

    egui::TopBottomPanel::bottom("status_bar")
        .exact_height(26.0)
        .frame(
            egui::Frame::NONE
                .fill(p.status_bar_bg)
                .stroke(egui::Stroke::new(1.0, p.border))
                .inner_margin(egui::Margin::symmetric(10, 3)),
        )
        .show(ctx, |ui| {
            ui.horizontal_centered(|ui| {
                // ── Left-to-right segments ─────────────────────────────────
                branch_segment(ui, &p, runtime);
                ui.add_space(8.0);

                sync_segment(ui, &p, runtime);
                ui.add_space(8.0);

                problems_segment(ui, &p);
                ui.add_space(12.0);

                file_info_segment(ui, &p, runtime);

                // ── Right side (reverse layout) ────────────────────────────
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    palette_hint(ui, &p);
                    ui.add_space(8.0);
                    theme_segment(ui, &p, state);
                    ui.add_space(8.0);
                    fx_segment(ui, &p, state);
                    ui.add_space(8.0);
                    language_segment(ui, &p, runtime);
                    ui.add_space(8.0);
                    line_col_segment(ui, &p, runtime);
                });
            });
        });
}

// ─── Segments ────────────────────────────────────────────────────────────────

fn branch_segment(ui: &mut egui::Ui, p: &ThemePalette, runtime: &RuntimeState) {
    let branch = runtime
        .git_panel
        .repo_info
        .as_ref()
        .and_then(|i| i.current_branch.clone());
    let label = match branch {
        Some(b) => format!("\u{2442} {}", b),
        None => "\u{2442} —".to_string(),
    };
    segment_label(ui, p, &label, p.text_secondary, "Current branch");
}

fn sync_segment(ui: &mut egui::Ui, p: &ThemePalette, runtime: &RuntimeState) {
    // ED-G MVP: no ahead/behind data is piped through yet. Show neutral
    // synced glyph; later phases populate real counts via git_review poller.
    let _ = runtime;
    segment_label(ui, p, "\u{2195} 0 0", p.text_muted, "Sync status");
}

fn problems_segment(ui: &mut egui::Ui, p: &ThemePalette) {
    // Placeholder until LSP re-lands; shows zeros so the segment is visible.
    segment_label(
        ui,
        p,
        &format!("\u{2715} {}   \u{26A0} {}", 0, 0),
        p.text_muted,
        "Problems",
    );
}

fn file_info_segment(ui: &mut egui::Ui, p: &ThemePalette, runtime: &RuntimeState) {
    let text = build_file_info(runtime);
    segment_label(ui, p, &text, p.text_muted, "");
}

fn line_col_segment(ui: &mut egui::Ui, p: &ThemePalette, runtime: &RuntimeState) {
    // Without a `TextEditOutput` wired into the center editor, we can't know
    // the cursor's line/col. Render `Ln —, Col —` until ED-G.1 upgrades the
    // center editor. Still a visible segment so the bar layout lands.
    let _ = runtime;
    segment_label(ui, p, "Ln —, Col —", p.text_muted, "Line / column");
}

fn language_segment(ui: &mut egui::Ui, p: &ThemePalette, runtime: &RuntimeState) {
    let text = runtime
        .active_tab()
        .and_then(|t| match &t.kind {
            TabKind::File { path } => path
                .extension()
                .and_then(|e| e.to_str())
                .map(ext_to_language),
            TabKind::Note { .. } => Some("Markdown"),
            _ => None,
        })
        .unwrap_or("");
    if text.is_empty() {
        return;
    }
    segment_label(ui, p, text, p.text_muted, "Language mode");
}

fn theme_segment(ui: &mut egui::Ui, p: &ThemePalette, state: &mut AppState) {
    let label = state.theme.name();
    if segment_button(ui, p, label, p.text_muted, "Cycle theme") {
        let current = Theme::ALL.iter().position(|t| *t == state.theme).unwrap_or(0);
        let next = Theme::ALL[(current + 1) % Theme::ALL.len()];
        state.theme = next;
    }
}

fn fx_segment(ui: &mut egui::Ui, p: &ThemePalette, state: &mut AppState) {
    let label = format!("FX: {}", state.fx_preference.label());
    if segment_button(ui, p, &label, p.text_muted, "Cycle fx preference") {
        let current = FxPreference::ALL
            .iter()
            .position(|x| *x == state.fx_preference)
            .unwrap_or(0);
        state.fx_preference = FxPreference::ALL[(current + 1) % FxPreference::ALL.len()];
    }
}

fn palette_hint(ui: &mut egui::Ui, p: &ThemePalette) {
    let keys = if cfg!(target_os = "macos") { "\u{2318} K" } else { "Ctrl+K" };
    segment_label(
        ui,
        p,
        &format!("\u{2318} {}", keys),
        p.text_muted,
        "Command palette",
    );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn segment_label(
    ui: &mut egui::Ui,
    _p: &ThemePalette,
    label: &str,
    color: eframe::egui::Color32,
    tooltip: &str,
) {
    let r = ui.add(egui::Label::new(
        RichText::new(label).size(10.5).color(color),
    ));
    if !tooltip.is_empty() {
        let _ = r.on_hover_text(tooltip);
    }
}

fn segment_button(
    ui: &mut egui::Ui,
    p: &ThemePalette,
    label: &str,
    color: eframe::egui::Color32,
    tooltip: &str,
) -> bool {
    let text = RichText::new(label).size(10.5).color(color);
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Body,
    );
    let padding = egui::vec2(6.0, 2.0);
    let size = galley.size() + padding * 2.0;
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    if ui.is_rect_visible(rect) {
        if response.hovered() {
            ui.painter()
                .rect_filled(rect, CornerRadius::same(3), p.surface_elevated);
        }
        ui.painter().galley(rect.min + padding, galley, color);
    }
    let _ = response.clone().on_hover_text(tooltip);
    response.clicked()
}

fn build_file_info(runtime: &RuntimeState) -> String {
    match runtime.active_tab() {
        Some(tab) => match &tab.kind {
            TabKind::File { path } => {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let lines = tab.content.lines().count();
                let dirty = if tab.dirty { " \u{25CF}" } else { "" };
                format!("{} \u{2014} {} lines{}", name, lines, dirty)
            }
            TabKind::Welcome => "Welcome".to_string(),
            _ => tab.label.clone(),
        },
        None => String::new(),
    }
}

fn ext_to_language(ext: &str) -> &'static str {
    match ext {
        "rs" => "Rust",
        "ts" => "TypeScript",
        "tsx" => "TSX",
        "js" => "JavaScript",
        "jsx" => "JSX",
        "py" => "Python",
        "go" => "Go",
        "toml" => "TOML",
        "md" => "Markdown",
        "json" => "JSON",
        "yaml" | "yml" => "YAML",
        "sh" => "Shell",
        "rb" => "Ruby",
        "sql" => "SQL",
        "html" => "HTML",
        "css" => "CSS",
        _ => "Plain",
    }
}
