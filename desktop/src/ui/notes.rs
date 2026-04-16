use eframe::egui;
use eframe::epaint::CornerRadius;

use crate::state::{AppState, NoteEntry, RuntimeState};
use crate::theme::ThemePalette;

// ─── Notes sidebar page ────────────────────────────────────────────────────

pub fn notes_sidebar_content(ui: &mut egui::Ui, state: &AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    let repo_root = state
        .active_workspace()
        .and_then(|ws| ws.repo_root.clone());

    let Some(repo_root) = repo_root else {
        ui.label(
            egui::RichText::new("No repository open")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    };

    // Refresh notes list
    if runtime.notes.needs_refresh {
        runtime.load_notes(&repo_root);
    }

    egui::ScrollArea::vertical().show(ui, |ui| {
        // New note button
        ui.add_space(4.0);
        let new_btn = ui.add(
            egui::Button::new(
                egui::RichText::new("+ New Note")
                    .size(11.0)
                    .color(p.primary),
            )
            .fill(p.primary.linear_multiply(0.1))
            .corner_radius(CornerRadius::same(4)),
        );

        if new_btn.clicked() {
            let title = format!("Untitled {}", runtime.notes.notes.len() + 1);
            match runtime.create_note(&repo_root, &title) {
                Ok(entry) => {
                    runtime.open_note(&entry);
                    // Start in edit mode
                    runtime.notes.edit_mode.insert(entry.id, true);
                }
                Err(e) => {
                    log::error!("Failed to create note: {}", e);
                }
            }
        }

        ui.add_space(8.0);
        ui.separator();
        ui.add_space(4.0);

        if runtime.notes.notes.is_empty() {
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("No notes yet")
                    .color(p.text_muted)
                    .size(11.0),
            );
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("Notes are stored as markdown files\nin .voidlink/notes/")
                    .color(p.text_muted)
                    .size(10.0),
            );
            return;
        }

        // Note list
        let notes: Vec<NoteEntry> = runtime.notes.notes.clone();
        let mut note_to_open: Option<NoteEntry> = None;
        let mut note_to_delete: Option<String> = None;

        for entry in &notes {
            let tab_key = format!("note:{}", entry.id);
            let is_open = runtime.tabs.iter().any(|t| t.id == tab_key);

            let resp = note_row(ui, entry, is_open, p);

            if resp.clicked {
                note_to_open = Some(entry.clone());
            }
            if resp.delete_clicked {
                note_to_delete = Some(entry.id.clone());
            }
        }

        if let Some(entry) = note_to_open {
            runtime.open_note(&entry);
        }
        if let Some(id) = note_to_delete {
            if let Err(e) = runtime.delete_note(&id) {
                log::error!("Failed to delete note: {}", e);
            }
        }
    });
}

struct NoteRowResponse {
    clicked: bool,
    delete_clicked: bool,
}

fn note_row(
    ui: &mut egui::Ui,
    entry: &NoteEntry,
    is_open: bool,
    p: ThemePalette,
) -> NoteRowResponse {
    let mut clicked = false;
    let mut delete_clicked = false;

    let desired_width = ui.available_width();
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(desired_width, 28.0),
        egui::Sense::click(),
    );

    // Hover / open highlight
    let bg = if response.hovered() {
        p.hover
    } else if is_open {
        p.surface_elevated
    } else {
        egui::Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, CornerRadius::same(3), bg);

    // Note icon + title
    let icon_pos = egui::pos2(rect.left() + 8.0, rect.center().y);
    ui.painter().text(
        icon_pos,
        egui::Align2::LEFT_CENTER,
        "\u{1F4DD}",
        egui::FontId::proportional(12.0),
        p.text_muted,
    );

    let title_pos = egui::pos2(rect.left() + 26.0, rect.center().y);
    let title_color = if is_open { p.text } else { p.text_secondary };
    ui.painter().text(
        title_pos,
        egui::Align2::LEFT_CENTER,
        &entry.title,
        egui::FontId::proportional(12.0),
        title_color,
    );

    // Delete button on hover
    if response.hovered() {
        let del_rect = egui::Rect::from_center_size(
            egui::pos2(rect.right() - 16.0, rect.center().y),
            egui::vec2(20.0, 20.0),
        );
        let del_resp = ui.allocate_rect(del_rect, egui::Sense::click());
        ui.painter().text(
            del_rect.center(),
            egui::Align2::CENTER_CENTER,
            "\u{2715}",
            egui::FontId::proportional(10.0),
            p.text_muted,
        );
        if del_resp.clicked() {
            delete_clicked = true;
        }
    }

    if response.clicked() {
        clicked = true;
    }

    NoteRowResponse {
        clicked,
        delete_clicked,
    }
}

// ─── Notes editor (center panel content for Note tabs) ─────────────────────

pub fn note_editor(
    ui: &mut egui::Ui,
    runtime: &mut RuntimeState,
    p: ThemePalette,
    note_id: &str,
) {
    let tab_key = format!("note:{}", note_id);
    let is_edit = *runtime
        .notes
        .edit_mode
        .get(note_id)
        .unwrap_or(&false);

    // Toolbar
    ui.horizontal(|ui| {
        ui.add_space(8.0);

        // Edit / Preview toggle
        let edit_label = if is_edit { "Editing" } else { "Edit" };
        let preview_label = if !is_edit { "Viewing" } else { "Preview" };

        let edit_btn = ui.add(
            egui::Button::new(
                egui::RichText::new(edit_label)
                    .size(11.0)
                    .color(if is_edit { p.primary_text } else { p.text_secondary }),
            )
            .fill(if is_edit { p.primary } else { egui::Color32::TRANSPARENT })
            .corner_radius(CornerRadius { nw: 4, ne: 0, sw: 4, se: 0 }),
        );
        if edit_btn.clicked() {
            runtime.notes.edit_mode.insert(note_id.to_string(), true);
        }

        let preview_btn = ui.add(
            egui::Button::new(
                egui::RichText::new(preview_label)
                    .size(11.0)
                    .color(if !is_edit { p.primary_text } else { p.text_secondary }),
            )
            .fill(if !is_edit { p.primary } else { egui::Color32::TRANSPARENT })
            .corner_radius(CornerRadius { nw: 0, ne: 4, sw: 0, se: 4 }),
        );
        if preview_btn.clicked() {
            runtime.notes.edit_mode.insert(note_id.to_string(), false);
        }

        ui.add_space(12.0);

        // Slash command hint in edit mode
        if is_edit {
            ui.label(
                egui::RichText::new("Type / for commands")
                    .size(10.0)
                    .color(p.text_muted),
            );
        }
    });

    ui.add(egui::Separator::default().spacing(2.0));

    if is_edit {
        note_edit_view(ui, runtime, p, &tab_key, note_id);
    } else {
        note_preview_view(ui, runtime, p, &tab_key);
    }
}

fn note_edit_view(
    ui: &mut egui::Ui,
    runtime: &mut RuntimeState,
    p: ThemePalette,
    tab_key: &str,
    note_id: &str,
) {
    let tab_id = tab_key.to_string();

    // "Insert block" button above the editor
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        let insert_btn = ui.add(
            egui::Button::new(
                egui::RichText::new("/ Insert block")
                    .size(10.0)
                    .color(p.text_muted),
            )
            .fill(egui::Color32::TRANSPARENT),
        );
        if insert_btn.clicked() {
            runtime.notes.slash_popup_open = !runtime.notes.slash_popup_open;
        }
    });

    // Slash command popup
    if runtime.notes.slash_popup_open {
        slash_command_popup(ui, runtime, p, &tab_id, note_id);
    }

    if let Some(tab) = runtime.tabs.iter_mut().find(|t| t.id == tab_id) {
        egui::ScrollArea::both()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                let response = ui.add(
                    egui::TextEdit::multiline(&mut tab.content)
                        .font(egui::FontId::monospace(13.0))
                        .desired_width(f32::INFINITY)
                        .desired_rows(30)
                        .frame(false)
                        .lock_focus(true)
                        .margin(egui::Margin::symmetric(12, 8)),
                );

                if response.changed() {
                    tab.dirty = true;
                }
            });
    }
}

fn note_preview_view(
    ui: &mut egui::Ui,
    runtime: &mut RuntimeState,
    _p: ThemePalette,
    tab_key: &str,
) {
    let tab_id = tab_key.to_string();
    let markdown = runtime
        .tabs
        .iter()
        .find(|t| t.id == tab_id)
        .map(|t| t.content.clone())
        .unwrap_or_default();

    egui::ScrollArea::both()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.add_space(8.0);
            egui::Frame::NONE
                .inner_margin(egui::Margin::symmetric(16, 8))
                .show(ui, |ui| {
                    egui_commonmark::CommonMarkViewer::new()
                        .show(ui, &mut runtime.notes.commonmark_cache, &markdown);
                });
        });
}

// ─── Slash command popup ───────────────────────────────────────────────────

const SLASH_COMMANDS: &[(&str, &str, &str)] = &[
    ("heading1", "Heading 1", "# "),
    ("heading2", "Heading 2", "## "),
    ("heading3", "Heading 3", "### "),
    ("bullet", "Bullet List", "- "),
    ("numbered", "Numbered List", "1. "),
    ("task", "Task List", "- [ ] "),
    ("code", "Code Block", "```\n\n```"),
    ("divider", "Divider", "---\n"),
    ("quote", "Blockquote", "> "),
];

fn slash_command_popup(
    ui: &mut egui::Ui,
    runtime: &mut RuntimeState,
    p: ThemePalette,
    tab_id: &str,
    _note_id: &str,
) {
    let popup_id = egui::Id::new("slash_command_popup");

    egui::Area::new(popup_id)
        .order(egui::Order::Foreground)
        .current_pos(ui.ctx().input(|i| {
            i.pointer.latest_pos().unwrap_or(egui::pos2(200.0, 200.0))
        }))
        .show(ui.ctx(), |ui| {
            egui::Frame::popup(ui.style())
                .inner_margin(egui::Margin::symmetric(4, 4))
                .corner_radius(CornerRadius::same(6))
                .show(ui, |ui| {
                    ui.set_min_width(180.0);

                    ui.label(
                        egui::RichText::new("Insert Block")
                            .size(11.0)
                            .color(p.text_muted)
                            .strong(),
                    );
                    ui.add_space(2.0);

                    let mut close = false;

                    for &(_, label, insertion) in SLASH_COMMANDS {
                        let resp = ui.add(
                            egui::Button::new(
                                egui::RichText::new(label)
                                    .size(12.0)
                                    .color(p.text),
                            )
                            .fill(egui::Color32::TRANSPARENT)
                            .min_size(egui::vec2(172.0, 24.0)),
                        );

                        if resp.clicked() {
                            // Append the block at the end of content
                            let tid = tab_id.to_string();
                            if let Some(tab) =
                                runtime.tabs.iter_mut().find(|t| t.id == tid)
                            {
                                if !tab.content.ends_with('\n') {
                                    tab.content.push('\n');
                                }
                                tab.content.push_str(insertion);
                                tab.dirty = true;
                            }
                            close = true;
                        }
                    }

                    if close
                        || ui.ctx().input(|i| i.key_pressed(egui::Key::Escape))
                    {
                        runtime.notes.slash_popup_open = false;
                    }
                });
        });
}
