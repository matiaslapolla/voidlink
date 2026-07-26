//! Secondary application windows.
//!
//! voidlink is two apps sharing one binary, in the same way Cursor splits its
//! agent surface from its editor: the `main` window is the code workbench, and
//! the `git` window is a standalone git client. They are separate OS windows
//! so you can put them on separate displays or spaces and Cmd-Tab between
//! them, rather than one hiding the other behind a toggle.
//!
//! The two webviews are separate JS contexts and cannot share a Solid store.
//! `main` stays the sole writer of persisted layout state; the git window
//! hydrates read-only and takes its active repository from an event the main
//! window broadcasts. See `frontend/src/api/gitWindow.ts` for that protocol.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Window label for the git client. The frontend switches on this at render
/// time (`getCurrentWindow().label`), which is why there is no separate HTML
/// entry point or query string — one bundle, two roots.
pub(crate) const GIT_WINDOW_LABEL: &str = "git";

/// Open the git window, or focus it if it is already open.
///
/// Returns `true` when a new window was created, so the caller can tell
/// "opened" from "brought to front" without querying window state.
#[tauri::command]
pub async fn open_git_window<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    if let Some(existing) = app.get_webview_window(GIT_WINDOW_LABEL) {
        // Unminimise first — `set_focus` on a minimised window is a no-op on
        // macOS and the user would see nothing happen.
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(false);
    }

    let builder = WebviewWindowBuilder::new(
        &app,
        GIT_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Voidlink Git")
    .inner_size(1100.0, 760.0)
    .min_inner_size(880.0, 600.0)
    .resizable(true)
    .center();

    // Match the main window's chrome so the two read as one app. Kept in sync
    // with the `main` entry in tauri.conf.json by hand — the config is static
    // and this window is built at runtime.
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 14.0));

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder.build().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Close the git window if it is open. Idempotent.
#[tauri::command]
pub async fn close_git_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(GIT_WINDOW_LABEL) {
        existing.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the git window is currently open. Lets the main window render an
/// accurate "open" vs "focus" affordance after a reload.
#[tauri::command]
pub async fn is_git_window_open<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview_window(GIT_WINDOW_LABEL).is_some())
}

/// Bring the workbench window to the front.
///
/// Used when the git window hands an action back to `main` — creating a
/// worktree, for instance, opens a wizard that spawns a terminal, and those
/// belong to the workbench. Without this the wizard would open behind the
/// window the user is looking at.
#[tauri::command]
pub async fn focus_main_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
