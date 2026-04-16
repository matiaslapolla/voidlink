//! Command palette (Ctrl+K / Cmd+K). Fuzzy-matched quick actions.
//!
//! Keeps the match & render logic self-contained so the palette has no
//! external crate deps. Matching is a simple subsequence score + prefix boost
//! — good enough for ≤ a few hundred commands.

use eframe::egui::{self, Color32, CornerRadius, Key, Modifiers, RichText, Sense, Stroke};

use crate::motion;
use crate::state::{AppState, RuntimeState, SessionStatus, SidebarPage};
use crate::theme::{Theme, ThemePalette};

#[derive(Debug, Clone)]
pub struct PaletteState {
    pub open: bool,
    pub query: String,
    pub selected_idx: usize,
}

impl Default for PaletteState {
    fn default() -> Self {
        Self {
            open: false,
            query: String::new(),
            selected_idx: 0,
        }
    }
}

/// A generated command entry.
struct Entry {
    label: String,
    subtitle: Option<String>,
    action: Action,
}

#[derive(Clone)]
enum Action {
    SetTheme(Theme),
    SetSidebarPage(SidebarPage),
    ToggleBottomPane,
    ToggleLeftSidebar,
    ToggleRightSidebar,
    CloseActiveTab,
    SaveActiveTab,
    SelectSession(String, String), // (workspace_id, session_id)
    SetFxPreference(crate::fx::FxPreference),
    ShowToast(String),
}

/// Called once per frame from the main update loop. Handles Ctrl/Cmd+K to
/// toggle, paints the scrim + palette when open, and applies the chosen
/// action.
pub fn show(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState) {
    // Shortcut: Ctrl+K (Linux/Windows) or Cmd+K (macOS).
    let toggle = ctx.input(|i| {
        let k = i.key_pressed(Key::K);
        let mods = if cfg!(target_os = "macos") {
            i.modifiers.mac_cmd
        } else {
            i.modifiers.ctrl
        };
        k && mods && !i.modifiers.shift
    });

    let mem_id = egui::Id::new("command_palette");
    let mut palette: PaletteState = ctx
        .data(|d| d.get_temp::<PaletteState>(mem_id))
        .unwrap_or_default();

    if toggle {
        palette.open = !palette.open;
        palette.query.clear();
        palette.selected_idx = 0;
    }

    // Esc closes.
    if palette.open && ctx.input(|i| i.key_pressed(Key::Escape)) {
        palette.open = false;
    }

    if !palette.open {
        ctx.data_mut(|d| d.insert_temp(mem_id, palette));
        return;
    }

    let p = state.theme.palette();

    // Scrim: full-screen translucent rect (with fade via animate_value).
    let anim_id = egui::Id::new("command_palette_scrim");
    let t = ctx.animate_value_with_time(anim_id, 1.0, motion::dur::PALETTE_IN);
    let t = motion::ease_out_expo(t);

    egui::Area::new(egui::Id::new("command_palette_scrim_layer"))
        .fixed_pos(ctx.screen_rect().min)
        .order(egui::Order::Middle)
        .interactable(true)
        .show(ctx, |ui| {
            let scrim = p.command_palette_scrim;
            let alpha = (scrim.a() as f32 * t) as u8;
            let scrim_color =
                Color32::from_rgba_unmultiplied(scrim.r(), scrim.g(), scrim.b(), alpha);
            ui.painter()
                .rect_filled(ctx.screen_rect(), 0.0, scrim_color);

            // Click-outside to close.
            let resp = ui.allocate_rect(ctx.screen_rect(), Sense::click());
            if resp.clicked() {
                palette.open = false;
            }
        });

    // Palette body.
    let entries = build_entries(state);
    let ranked = filter_and_rank(&entries, &palette.query);
    palette.selected_idx = palette.selected_idx.min(ranked.len().saturating_sub(1));

    let palette_w = 520.0_f32;
    let palette_h = 360.0_f32;
    let screen = ctx.screen_rect();
    let origin = egui::pos2(
        screen.center().x - palette_w * 0.5,
        screen.top() + screen.height() * 0.22,
    );

    let mut picked_action: Option<Action> = None;

    egui::Area::new(egui::Id::new("command_palette_body"))
        .fixed_pos(origin)
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            let rect = egui::Rect::from_min_size(origin, egui::vec2(palette_w, palette_h));
            ui.painter().rect_filled(rect, CornerRadius::same(12), p.surface);
            ui.painter().rect_stroke(
                rect,
                CornerRadius::same(12),
                Stroke::new(1.0, p.border),
                egui::StrokeKind::Inside,
            );

            ui.allocate_new_ui(egui::UiBuilder::new().max_rect(rect.shrink(14.0)), |ui| {
                // Query input.
                let query_id = egui::Id::new("command_palette_input");
                let input = ui.add(
                    egui::TextEdit::singleline(&mut palette.query)
                        .hint_text(
                            RichText::new("Type a command… (Esc to close)")
                                .color(p.text_muted),
                        )
                        .font(egui::TextStyle::Body)
                        .desired_width(ui.available_width())
                        .id(query_id),
                );
                input.request_focus();

                ui.add_space(10.0);

                // Keyboard navigation.
                let (up, down, enter) = ctx.input(|i| {
                    (
                        i.key_pressed(Key::ArrowUp),
                        i.key_pressed(Key::ArrowDown),
                        i.key_pressed(Key::Enter),
                    )
                });
                if up && palette.selected_idx > 0 {
                    palette.selected_idx -= 1;
                }
                if down && palette.selected_idx + 1 < ranked.len() {
                    palette.selected_idx += 1;
                }
                if enter {
                    if let Some(idx) = ranked.get(palette.selected_idx).copied() {
                        picked_action = Some(entries[idx].action.clone());
                    }
                }

                // Results list.
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        if ranked.is_empty() {
                            ui.add_space(20.0);
                            ui.vertical_centered(|ui| {
                                ui.label(
                                    RichText::new("No matches")
                                        .size(12.0)
                                        .color(p.text_muted),
                                );
                            });
                        }

                        for (row_idx, &entry_idx) in ranked.iter().enumerate() {
                            let is_selected = row_idx == palette.selected_idx;
                            let entry = &entries[entry_idx];
                            let row_h = 36.0_f32;
                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                egui::vec2(ui.available_width(), row_h),
                                Sense::click(),
                            );
                            if is_selected && ui.is_rect_visible(row_rect) {
                                ui.painter().rect_filled(
                                    row_rect,
                                    CornerRadius::same(6),
                                    p.hover,
                                );
                            }

                            ui.painter().text(
                                egui::pos2(row_rect.min.x + 12.0, row_rect.min.y + 8.0),
                                egui::Align2::LEFT_TOP,
                                &entry.label,
                                egui::FontId::proportional(13.0),
                                p.text,
                            );
                            if let Some(sub) = entry.subtitle.as_deref() {
                                ui.painter().text(
                                    egui::pos2(row_rect.min.x + 12.0, row_rect.min.y + 22.0),
                                    egui::Align2::LEFT_TOP,
                                    sub,
                                    egui::FontId::proportional(10.5),
                                    p.text_muted,
                                );
                            }

                            if row_resp.clicked() {
                                picked_action = Some(entry.action.clone());
                            }
                            if row_resp.hovered() {
                                palette.selected_idx = row_idx;
                            }
                        }
                    });
            });
        });

    // Close + apply action.
    if let Some(action) = picked_action {
        palette.open = false;
        apply(action, state, runtime, &p);
    }

    ctx.data_mut(|d| d.insert_temp(mem_id, palette));
}

fn apply(
    action: Action,
    state: &mut AppState,
    runtime: &mut RuntimeState,
    _palette: &ThemePalette,
) {
    match action {
        Action::SetTheme(theme) => {
            state.theme = theme;
            runtime
                .toasts
                .info(format!("Theme: {}", theme.name()));
        }
        Action::SetSidebarPage(page) => {
            state.sidebar_page = page;
            state.layout.left_sidebar_open = true;
        }
        Action::ToggleBottomPane => {
            state.layout.bottom_pane_open = !state.layout.bottom_pane_open;
        }
        Action::ToggleLeftSidebar => {
            state.layout.left_sidebar_open = !state.layout.left_sidebar_open;
        }
        Action::ToggleRightSidebar => {
            state.layout.right_sidebar_open = !state.layout.right_sidebar_open;
        }
        Action::CloseActiveTab => {
            let id = runtime.active_tab_id.clone();
            runtime.close_tab(&id);
        }
        Action::SaveActiveTab => {
            if let Err(e) = runtime.save_active_tab() {
                runtime.toasts.error("Save failed", Some(e));
            }
        }
        Action::SelectSession(ws_id, sid) => {
            state.active_session_by_workspace.insert(ws_id, sid);
        }
        Action::SetFxPreference(pref) => {
            state.fx_preference = pref;
            runtime
                .toasts
                .info(format!("FX: {}", pref.label()));
        }
        Action::ShowToast(msg) => {
            runtime.toasts.info(msg);
        }
    }
}

fn build_entries(state: &AppState) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();

    // Themes.
    for &theme in Theme::ALL {
        out.push(Entry {
            label: format!("Theme: {}", theme.name()),
            subtitle: Some("Change theme".into()),
            action: Action::SetTheme(theme),
        });
    }

    // Sidebar pages.
    for &page in SidebarPage::ALL {
        out.push(Entry {
            label: format!("Go to {}", page.label()),
            subtitle: Some("Sidebar page".into()),
            action: Action::SetSidebarPage(page),
        });
    }

    // Panel toggles.
    out.push(Entry {
        label: "Toggle bottom pane".into(),
        subtitle: Some("Ctrl+J".into()),
        action: Action::ToggleBottomPane,
    });
    out.push(Entry {
        label: "Toggle left sidebar".into(),
        subtitle: Some("Ctrl+B".into()),
        action: Action::ToggleLeftSidebar,
    });
    out.push(Entry {
        label: "Toggle right sidebar".into(),
        subtitle: Some("Ctrl+\\".into()),
        action: Action::ToggleRightSidebar,
    });
    out.push(Entry {
        label: "Close active tab".into(),
        subtitle: Some("Ctrl+W".into()),
        action: Action::CloseActiveTab,
    });
    out.push(Entry {
        label: "Save active tab".into(),
        subtitle: Some("Ctrl+S".into()),
        action: Action::SaveActiveTab,
    });

    // FX preferences.
    for &pref in crate::fx::FxPreference::ALL {
        out.push(Entry {
            label: format!("FX Preference: {}", pref.label()),
            subtitle: Some("Background effects".into()),
            action: Action::SetFxPreference(pref),
        });
    }

    // Sessions across workspaces.
    for ws in &state.workspaces {
        for sid in &ws.repository_ids {
            for session in state.sessions.sessions_for_repo(sid) {
                out.push(Entry {
                    label: format!("Session: {}", session.name),
                    subtitle: Some(format!(
                        "{} · {}",
                        ws.name,
                        session_status_label(session.status)
                    )),
                    action: Action::SelectSession(ws.id.clone(), session.id.clone()),
                });
            }
        }
    }

    // Help entry.
    out.push(Entry {
        label: "Print keyboard shortcuts".into(),
        subtitle: Some("Ctrl+K · Esc closes".into()),
        action: Action::ShowToast(
            "Shortcuts: Ctrl+K palette · Ctrl+B sidebar · Ctrl+J bottom · Ctrl+S save".to_string(),
        ),
    });

    out
}

fn session_status_label(s: SessionStatus) -> &'static str {
    s.label()
}

/// Subsequence-match + small prefix bonus. Returns indices into `entries`
/// sorted by descending score; empty query returns everything in order.
fn filter_and_rank(entries: &[Entry], query: &str) -> Vec<usize> {
    if query.trim().is_empty() {
        return (0..entries.len()).collect();
    }
    let q = query.trim().to_lowercase();
    let mut scored: Vec<(usize, i64)> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let hay = e.label.to_lowercase();
            fuzzy_score(&hay, &q).map(|s| (i, s))
        })
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored.into_iter().map(|(i, _)| i).collect()
}

fn fuzzy_score(hay: &str, needle: &str) -> Option<i64> {
    let mut score: i64 = 0;
    let mut prev_matched = false;
    let mut iter = hay.chars().enumerate();
    for nc in needle.chars() {
        let mut matched_here = false;
        for (i, hc) in iter.by_ref() {
            if hc == nc {
                score += if prev_matched { 5 } else { 1 };
                if i == 0 {
                    score += 10;
                }
                prev_matched = true;
                matched_here = true;
                break;
            }
            prev_matched = false;
        }
        if !matched_here {
            return None;
        }
    }
    Some(score)
}

/// Modifier/key combo helper used by callers that want to guard the toggle
/// check differently. Currently unused but kept so external call sites (e.g.
/// a future menu bar item) can share the decision.
#[allow(dead_code)]
pub fn toggle_combo() -> (Modifiers, Key) {
    if cfg!(target_os = "macos") {
        (Modifiers::MAC_CMD, Key::K)
    } else {
        (Modifiers::CTRL, Key::K)
    }
}
