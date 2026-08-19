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
//! `Cmd+Z` / `Cmd+Shift+Z` get the same treatment, for the same reason. The
//! default menu's Undo/Redo items hardwire those accelerators, AppKit resolves
//! them before the keydown ever reaches the webview, and — unlike a plain
//! `<textarea>`, whose undo stack *is* `execCommand('undo')` — Monaco owns its
//! own undo stack and never sees the key to run its own binding against it.
//! Whether the accelerator actually fires depends on WKWebView's editing-action
//! validation (`canPerformAction:withSender:` for the `undo:`/`redo:`
//! selector), which is ambient state unrelated to which surface has focus —
//! hence "sometimes". `keymap.ts` was already correctly leaving `z` unclaimed
//! for exactly this reason (see its "Monaco's redo" note); the interception
//! was happening one layer up. So: custom, unaccelerated Undo/Redo items,
//! wired below to replicate the predefined ones' `execCommand` behaviour for
//! anyone who still reaches for the Edit menu, while the keyboard chord now
//! reaches Monaco (and every other surface) like any other key.
//!
//! Everything else is deliberately identical to Tauri's default. The Edit
//! submenu in particular has to stay: on macOS, cut/copy/paste/select-all in a
//! webview are driven by those menu items, and dropping the submenu silently
//! breaks clipboard support everywhere in the app. Undo/Redo don't share that
//! clipboard-permission restriction — `execCommand('undo'/'redo')` needs no
//! native forwarding to work from a plain keydown handler — so only their
//! accelerator needed to move, not their whole mechanism.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Menu id for the window-closing item. Matched in [`handle_event`].
pub(crate) const CLOSE_WINDOW_ID: &str = "voidlink:close-window";

/// `Cmd+Shift+W` on macOS, `Ctrl+Shift+W` elsewhere.
///
/// Shift is what keeps this off `Cmd+W`. Nothing in `keymap.ts` claims the
/// shifted chord, so the two cannot collide.
const CLOSE_WINDOW_ACCEL: &str = "CmdOrCtrl+Shift+W";

/// Menu ids for the custom, unaccelerated Undo/Redo items. Matched in
/// [`handle_event`].
pub(crate) const UNDO_ID: &str = "voidlink:undo";
pub(crate) const REDO_ID: &str = "voidlink:redo";

/// Fired at the focused window when Undo/Redo is *clicked* in the Edit menu.
/// The keyboard chord no longer needs this — see the module doc — but a click
/// still has to do something, and running the command is JS's job, not
/// Rust's. `main.tsx` listens, once, for every window.
const MENU_UNDO_REDO_EVENT: &str = "voidlink://menu-undo-redo";

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

    // No accelerator on either — see the module doc for why. `None` here is
    // what actually leaves `z`/`Z` unclaimed; `PredefinedMenuItem::undo/redo`
    // cannot be built without one.
    let undo = MenuItem::with_id(app, UNDO_ID, "Undo", true, None::<&str>)?;
    let redo = MenuItem::with_id(app, REDO_ID, "Redo", true, None::<&str>)?;

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
                    &undo,
                    &redo,
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
    } else if event.id() == UNDO_ID || event.id() == REDO_ID {
        let cmd = if event.id() == UNDO_ID { "undo" } else { "redo" };
        if let Some(window) = app.webview_windows().values().find(|w| {
            w.is_focused().unwrap_or(false)
        }) {
            let _ = window.emit(MENU_UNDO_REDO_EVENT, cmd);
        }
    }
}
