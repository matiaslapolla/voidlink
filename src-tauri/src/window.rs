//! Secondary application windows.
//!
//! voidlink is three apps sharing one binary, in the same way Cursor splits its
//! agent surface from its editor: the `main` window is the workbench (terminals,
//! workspaces, agents), the `git` window is a standalone git client, and the
//! `editor` window is the code editor. They are separate OS windows so you can
//! put them on separate displays or spaces and Cmd-Tab between them, rather
//! than one hiding the other behind a toggle.
//!
//! The webviews are separate JS contexts and cannot share a Solid store.
//! `main` stays the sole writer of persisted layout state; the satellites
//! hydrate read-only and take their active repository — and, for the editor,
//! their tab list — from events the main window broadcasts. See
//! `frontend/src/api/windows.ts` for that protocol.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Window label for the git client. The frontend switches on this at render
/// time (`getCurrentWindow().label`), which is why there is no separate HTML
/// entry point or query string — one bundle, three roots.
pub(crate) const GIT_WINDOW_LABEL: &str = "git";

/// Window label for the code editor. Same one-bundle-many-roots arrangement as
/// the git window above.
pub(crate) const EDITOR_WINDOW_LABEL: &str = "editor";

/// Geometry + title for a satellite window. Grouped in one struct so the
/// per-window `open_*` commands below stay a single line of intent each.
struct SatelliteSpec {
    label: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

const GIT_SPEC: SatelliteSpec = SatelliteSpec {
    label: GIT_WINDOW_LABEL,
    title: "Voidlink Git",
    width: 1100.0,
    height: 760.0,
    min_width: 880.0,
    min_height: 600.0,
};

/// Wider and taller than the git window: this one carries a file tree, a tab
/// strip, a side-by-side diff, and a git panel across a single row.
const EDITOR_SPEC: SatelliteSpec = SatelliteSpec {
    label: EDITOR_WINDOW_LABEL,
    title: "Voidlink Editor",
    width: 1300.0,
    height: 860.0,
    min_width: 900.0,
    min_height: 600.0,
};

/// Window label for the detached file-explorer panel.
///
/// A *panel* window, not a satellite app: it hosts one sidebar that the
/// workbench would otherwise draw in a column, at roughly a column's width. The
/// git sidebar has no entry here on purpose — it detaches into the git window
/// above, because that window already *is* the git panel with a whole window
/// around it (see `SIDEBAR_WINDOW_LABEL` in `frontend/src/api/windows.ts`).
pub(crate) const FILES_PANEL_WINDOW_LABEL: &str = "panel-files";

const FILES_PANEL_SPEC: SatelliteSpec = SatelliteSpec {
    label: FILES_PANEL_WINDOW_LABEL,
    title: "Voidlink Files",
    width: 360.0,
    height: 820.0,
    min_width: 240.0,
    min_height: 400.0,
};

/// Window label for the detached agent dashboard.
///
/// The agent board is the one other sidebar with a window of its own, because
/// it is the one other sidebar that can be a *consumer*: the workbench already
/// broadcasts `AgentBoardSnapshot` (see `publishAgentBoard`), so a panel window
/// renders the real board rather than its own empty store.
///
/// The terminals list deliberately has none. Every control on it — new
/// terminal, select, kill — writes the workbench's session state and spawns or
/// reaps a PTY, and a satellite's store is an unpersisted private copy with no
/// terminal surface attached. There is no snapshot channel for it, so each of
/// those buttons would be the silent no-op `requestOpenWorktreeOnMain` exists
/// to fix. Same reasoning, and the same verdict, as the workspace rail.
pub(crate) const AGENTS_PANEL_WINDOW_LABEL: &str = "panel-agents";

/// Wider than the files panel: the board lays cards out in columns, and at a
/// file tree's width the columns stack into one long ribbon.
const AGENTS_PANEL_SPEC: SatelliteSpec = SatelliteSpec {
    label: AGENTS_PANEL_WINDOW_LABEL,
    title: "Voidlink Agents",
    width: 420.0,
    height: 820.0,
    min_width: 280.0,
    min_height: 400.0,
};

/// Every window a sidebar may be detached into, by label.
///
/// An allowlist rather than a label passed straight through from the frontend:
/// `open_panel_window` is a command any webview in this app can invoke, and a
/// free-form label would let it build windows this app has no capability entry
/// for — which is to say, windows with no permissions and no way to say so.
const PANEL_SPECS: &[&SatelliteSpec] = &[&FILES_PANEL_SPEC, &AGENTS_PANEL_SPEC];

fn panel_spec(label: &str) -> Option<&'static SatelliteSpec> {
    PANEL_SPECS.iter().copied().find(|spec| spec.label == label)
}

/// Window title, with a dev marker appended when this is a `cargo tauri dev`
/// run.
///
/// `#[cfg(dev)]` — not `debug_assertions`, which is also set for
/// `tauri build --debug` and would mark a real bundle. The frontend paints its
/// title bars purple on the same condition (`import.meta.env.DEV`); this covers
/// the places only the OS draws: the window list, Mission Control, Cmd-Tab.
pub(crate) fn dev_title(title: &str) -> String {
    if tauri::is_dev() {
        format!("{title} (dev)")
    } else {
        title.to_string()
    }
}

/// Open a satellite window, or focus it if it is already open.
///
/// Returns `true` when a new window was created, so the caller can tell
/// "opened" from "brought to front" without querying window state.
fn open_satellite<R: Runtime>(app: &AppHandle<R>, spec: &SatelliteSpec) -> Result<bool, String> {
    if let Some(existing) = app.get_webview_window(spec.label) {
        // Unminimise first — `set_focus` on a minimised window is a no-op on
        // macOS and the user would see nothing happen.
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(false);
    }

    let builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App("index.html".into()))
        .title(dev_title(spec.title))
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .resizable(true)
        .center();

    // Match the main window's chrome so every window reads as one app. Kept in
    // sync with the `main` entry in tauri.conf.json by hand — the config is
    // static and these windows are built at runtime.
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

/// Close a satellite window if it is open. Idempotent.
///
/// **`destroy`, not `close` — this is the detach-lifecycle crash.** The failure
/// was not a panic in our code; it was Tauri's close protocol re-entering
/// itself, and it is worth writing down because `close()` reads like the right
/// call:
///
/// `Window::close()` does not close a window. It raises `CloseRequested`, and
/// tauri 2.11.2's own per-window handler (`tauri/src/manager/window.rs`, in
/// `on_window_event`) does this:
///
/// ```text
/// if window.has_js_listener(WINDOW_CLOSE_REQUESTED_EVENT) { api.prevent_close(); }
/// window.emit_to_window(WINDOW_CLOSE_REQUESTED_EVENT, &())?;
/// ```
///
/// Every window we detach into registers exactly that listener — it is how a
/// panel says "dock me back" as it goes (`PanelApp`, `GitApp`). So Tauri
/// *always* prevented the close and delegated the decision to the webview,
/// whose `onCloseRequested` wrapper finishes by calling `destroy()` — a command
/// no capability file granted (`core:window:allow-destroy` was missing from
/// every one of them). The result, from either side:
///
///   • the traffic light did nothing, and the rejected `destroy()` surfaced
///     only as an unhandled rejection inside an event listener;
///   • `close_panel_window` from the workbench did nothing either, while
///     `dockSidebarBack` had already cleared the detached flag — so the panel
///     was drawn in the shell *and* still live in a window that could not be
///     dismissed, two copies of one surface writing to one webview each;
///   • closing `main` then ran `kill_all_ptys` (see `lib.rs`'s
///     `on_window_event`) while the undismissable satellite kept the process
///     alive, leaving an app with no workbench, no shells, and no way out
///     except force-quit.
///
/// `destroy()` is the unconditional form: it raises no `CloseRequested`, so it
/// cannot be prevented and — the part that matters for re-entrancy — the
/// closing webview never emits the dock-back the workbench would handle as a
/// *second* close. A close asked for by the workbench therefore runs one way
/// only, and a close asked for by the OS still runs the JS path exactly once.
fn close_satellite<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(label) {
        existing.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring an existing window to the front. Silent no-op when it isn't open —
/// callers use this to follow up an action they forwarded, and a window that
/// closed in between is not an error worth surfacing.
fn focus_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Git window ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_git_window<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    open_satellite(&app, &GIT_SPEC)
}

#[tauri::command]
pub async fn close_git_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    close_satellite(&app, GIT_WINDOW_LABEL)
}

/// Whether the git window is currently open. Lets the main window render an
/// accurate "open" vs "focus" affordance after a reload.
#[tauri::command]
pub async fn is_git_window_open<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview_window(GIT_WINDOW_LABEL).is_some())
}

// ─── Editor window ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_editor_window<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    open_satellite(&app, &EDITOR_SPEC)
}

#[tauri::command]
pub async fn close_editor_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    close_satellite(&app, EDITOR_WINDOW_LABEL)
}

#[tauri::command]
pub async fn is_editor_window_open<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview_window(EDITOR_WINDOW_LABEL).is_some())
}

/// Bring the editor window to the front.
///
/// Used when the workbench hands a file to the editor — a terminal deep-link,
/// the file finder, a click in the git sidebar. Without this the file would
/// open in a window the user cannot see.
#[tauri::command]
pub async fn focus_editor_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    focus_window(&app, EDITOR_WINDOW_LABEL)
}

// ─── Detached sidebar panels ─────────────────────────────────────────────────

/// Open (or focus) the window a detached sidebar lives in.
///
/// An unknown label is an error rather than a silently-built window: the label
/// decides which capability entry applies, and a window outside `PANEL_SPECS`
/// would come up with none.
#[tauri::command]
pub async fn open_panel_window<R: Runtime>(
    app: AppHandle<R>,
    label: String,
) -> Result<bool, String> {
    let spec = panel_spec(&label).ok_or_else(|| format!("unknown panel window: {label}"))?;
    open_satellite(&app, spec)
}

#[tauri::command]
pub async fn close_panel_window<R: Runtime>(
    app: AppHandle<R>,
    label: String,
) -> Result<(), String> {
    let spec = panel_spec(&label).ok_or_else(|| format!("unknown panel window: {label}"))?;
    close_satellite(&app, spec.label)
}

#[tauri::command]
pub async fn is_panel_window_open<R: Runtime>(
    app: AppHandle<R>,
    label: String,
) -> Result<bool, String> {
    let spec = panel_spec(&label).ok_or_else(|| format!("unknown panel window: {label}"))?;
    Ok(app.get_webview_window(spec.label).is_some())
}

// ─── Workbench ───────────────────────────────────────────────────────────────

/// Bring the workbench window to the front.
///
/// Used when a satellite hands an action back to `main` — creating a worktree,
/// for instance, opens a wizard that spawns a terminal, and those belong to the
/// workbench. Without this the wizard would open behind the window the user is
/// looking at.
#[tauri::command]
pub async fn focus_main_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    focus_window(&app, "main")
}
