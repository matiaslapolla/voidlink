//! The application menu.
//!
//! This exists for one reason: to get `Cmd+W` back.
//!
//! Tauri installs [`Menu::default`] when an app sets no menu of its own. That
//! default puts `PredefinedMenuItem::close_window` in both the File and the
//! Window submenus, and muda hardwires `Cmd+W` onto it. On macOS a menu
//! accelerator is resolved by AppKit *before* the key event is dispatched to
//! the webview, so the capture-phase listener in `keybindings.ts` never saw
//! `Cmd+W` — the window just closed, taking every terminal with it.
//!
//! So we rebuild the default menu with one change: nothing claims `Cmd+W`.
//! The chord falls through to the webview and `tab.close` in `keymap.ts`
//! handles it, which keeps the keymap the single source of truth for what
//! shortcuts do. Closing the *window* moves to `Cmd+Shift+W`, which needs a
//! custom item because the predefined one cannot be re-accelerated.
//!
//! Everything else is deliberately identical to Tauri's default. The Edit
//! submenu in particular has to stay: on macOS, cut/copy/paste/select-all in a
//! webview are driven by those menu items, and dropping the submenu silently
//! breaks clipboard support everywhere in the app.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

/// Menu id for the window-closing item. Matched in [`handle_event`].
pub(crate) const CLOSE_WINDOW_ID: &str = "voidlink:close-window";

/// `Cmd+Shift+W` on macOS, `Ctrl+Shift+W` elsewhere.
///
/// Shift is what keeps this off `Cmd+W`. Nothing in `keymap.ts` claims the
/// shifted chord, so the two cannot collide.
const CLOSE_WINDOW_ACCEL: &str = "CmdOrCtrl+Shift+W";

/// Build the app menu.
pub(crate) fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let close_window = MenuItem::with_id(
        app,
        CLOSE_WINDOW_ID,
        "Close window",
        true,
        Some(CLOSE_WINDOW_ACCEL),
    )?;

    // No `close_window` here — the default menu's copy in this submenu is the
    // second place Cmd+W was bound.
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &close_window,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            // Required for clipboard support in the webview on macOS.
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Route a menu click. Only our custom items land here — predefined items are
/// handled natively and never reach this.
pub(crate) fn handle_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() == CLOSE_WINDOW_ID {
        // The focused window, not "main" — with the git window open, Cmd+Shift+W
        // should close whichever one the user is actually looking at.
        if let Some(window) = app.webview_windows().values().find(|w| {
            w.is_focused().unwrap_or(false)
        }) {
            let _ = window.close();
        }
    }
}
