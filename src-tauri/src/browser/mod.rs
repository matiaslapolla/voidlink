//! Embedded browser tabs.
//!
//! Each tab is a real Tauri child webview of the workbench window, not an
//! iframe: its own process, its own cookie jar, no `X-Frame-Options` to fight.
//!
//! The webview is created *here* rather than from JavaScript, and that is the
//! whole point of this module. The JS `Webview` handle in `@tauri-apps/api`
//! exposes position, size, show/hide and close — and nothing else. No
//! `loadUrl`, no history, no page-load or title callbacks. A frontend that
//! owns the webview can therefore only "navigate" by closing it and building a
//! new one, which throws away the page's session on every keystroke of the
//! address bar, and it never learns where the page actually went when the user
//! clicked a link.
//!
//! `WebviewBuilder` on the Rust side has all of it, so Rust owns the webview
//! and the frontend drives it through commands keyed by the *frontend's* tab
//! id. Labels are derived from that id (`voidlink-browser-<uuid>`) so a crash
//! leaves recognisable orphans for [`browser_close_orphans`] to sweep.
//!
//! Two things are deliberate:
//!
//! - **The child webview gets no capability.** `capabilities/default.json` is
//!   scoped to the `main` webview label precisely so a page the user loads
//!   cannot reach an app command. Nothing here widens that.
//! - **History is tracked by this module, not by the page.** Driving
//!   back/forward would otherwise mean evaluating `history.back()` inside an
//!   untrusted remote document. We keep a URL stack instead and navigate to
//!   entries, so no script of ours ever enters the page.

use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::webview::{PageLoadEvent, PageLoadPayload, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};

/// Label namespace for browser child webviews. Anything with this prefix is
/// ours and nothing else in the app may use it — [`browser_close_orphans`]
/// closes on the strength of this alone.
const LABEL_PREFIX: &str = "voidlink-browser-";

const NAVIGATED_EVENT: &str = "voidlink://browser-navigated";
const TITLE_EVENT: &str = "voidlink://browser-title";

fn label_for(tab_id: &str) -> String {
    format!("{LABEL_PREFIX}{tab_id}")
}

// ─── History ──────────────────────────────────────────────────────────────────

/// A tab's visited-URL stack with a cursor, the model a browser's back/forward
/// pair actually implements: going back then navigating somewhere new discards
/// the forward entries rather than branching.
#[derive(Debug, Default)]
pub(crate) struct History {
    entries: Vec<String>,
    cursor: usize,
}

impl History {
    /// Record a page the user arrived at by navigating *forward* — typing an
    /// address, clicking a link, following a redirect.
    ///
    /// Re-landing on the current entry (a reload, or a load event firing twice
    /// for one navigation) is a no-op, so reloading never grows the stack.
    fn push(&mut self, url: &str) {
        if self.entries.get(self.cursor).map(String::as_str) == Some(url) {
            return;
        }
        if !self.entries.is_empty() {
            self.entries.truncate(self.cursor + 1);
        }
        self.entries.push(url.to_string());
        self.cursor = self.entries.len() - 1;
    }

    fn back(&mut self) -> Option<String> {
        if self.cursor == 0 {
            return None;
        }
        self.cursor -= 1;
        self.entries.get(self.cursor).cloned()
    }

    fn forward(&mut self) -> Option<String> {
        if self.cursor + 1 >= self.entries.len() {
            return None;
        }
        self.cursor += 1;
        self.entries.get(self.cursor).cloned()
    }

    fn can_go_back(&self) -> bool {
        self.cursor > 0
    }

    fn can_go_forward(&self) -> bool {
        self.cursor + 1 < self.entries.len()
    }

    #[cfg(test)]
    fn current(&self) -> Option<&str> {
        self.entries.get(self.cursor).map(String::as_str)
    }
}

// ─── Store ────────────────────────────────────────────────────────────────────

pub(crate) struct TabState {
    label: String,
    history: History,
    /// Set while a back/forward-issued navigation is in flight.
    ///
    /// Without it the page load that traversal *causes* would look identical to
    /// a fresh navigation and get pushed, so Back would append the page you
    /// just came from and the cursor could never reach the start of the stack.
    traversing: bool,
}

pub(crate) type BrowserStore = Arc<DashMap<String, TabState>>;

pub(crate) fn new_store() -> BrowserStore {
    Arc::new(DashMap::new())
}

// ─── Wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn position(&self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }

    /// A zero-width webview is a platform error on some backends, so every
    /// dimension is floored at one logical pixel.
    fn size(&self) -> LogicalSize<f64> {
        LogicalSize::new(self.width.max(1.0), self.height.max(1.0))
    }
}

/// Emitted whenever a tab settles on a page. Carries the traversal flags with
/// it so the frontend never has to re-derive them from a history it does not
/// own — the buttons enable off exactly the state that drives them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigatedPayload {
    tab_id: String,
    url: String,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitlePayload {
    tab_id: String,
    title: String,
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Create the child webview for `tab_id` at `rect`, loading `url`.
///
/// Parented to the window that invoked the command, so the git window could
/// host its own tabs without this module knowing about it.
#[tauri::command]
pub async fn browser_open<R: Runtime>(
    tab_id: String,
    url: String,
    rect: Rect,
    app: AppHandle<R>,
    window: tauri::Window<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("{url}: {e}"))?;
    let label = label_for(&tab_id);

    // A stale entry means a previous pane never cleaned up (hot reload, a
    // crash between close and unmount). Reuse of a live label fails inside
    // wry with a far less obvious message, so clear it out first.
    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.close();
    }
    store.remove(&tab_id);

    let load_app = app.clone();
    let load_tab = tab_id.clone();
    let title_app = app.clone();
    let title_tab = tab_id.clone();

    let builder = WebviewBuilder::<R>::new(&label, WebviewUrl::External(parsed))
        // The child renders untrusted remote pages: no drag-drop hijacking of
        // the host window, and no Tauri IPC surface (it holds no capability).
        .disable_drag_drop_handler()
        .on_page_load(move |_webview: tauri::Webview<R>, payload: PageLoadPayload<'_>| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            on_page_settled(&load_app, &load_tab, payload.url().as_str());
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_app.emit(
                TITLE_EVENT,
                TitlePayload {
                    tab_id: title_tab.clone(),
                    title,
                },
            );
        });

    window
        .add_child(builder, rect.position(), rect.size())
        .map_err(|e| e.to_string())?;

    store.insert(
        tab_id,
        TabState {
            label,
            history: History::default(),
            traversing: false,
        },
    );
    Ok(())
}

/// Fold a settled page load into the tab's history and tell the frontend.
///
/// Runs on whatever thread wry delivers the callback on, so it takes the
/// entry lock, mutates, and drops it *before* emitting — an emit while holding
/// a `DashMap` guard is a deadlock waiting for a listener on the same shard.
fn on_page_settled<R: Runtime>(app: &AppHandle<R>, tab_id: &str, url: &str) {
    let Some(store) = app.try_state::<BrowserStore>() else {
        return;
    };
    let flags = {
        let Some(mut tab) = store.get_mut(tab_id) else {
            return;
        };
        if tab.traversing {
            // The cursor already moved when back()/forward() chose this URL.
            tab.traversing = false;
        } else {
            tab.history.push(url);
        }
        (tab.history.can_go_back(), tab.history.can_go_forward())
    };

    let _ = app.emit(
        NAVIGATED_EVENT,
        NavigatedPayload {
            tab_id: tab_id.to_string(),
            url: url.to_string(),
            can_go_back: flags.0,
            can_go_forward: flags.1,
        },
    );
}

/// Navigate in place. Unlike close-and-recreate this keeps the webview's
/// process, and with it any session the page had established.
#[tauri::command]
pub async fn browser_navigate<R: Runtime>(
    tab_id: String,
    url: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("{url}: {e}"))?;
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    webview.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    traverse(&tab_id, &app, &store, true)
}

#[tauri::command]
pub async fn browser_forward<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    traverse(&tab_id, &app, &store, false)
}

/// Move the cursor and navigate to whatever it landed on.
///
/// The cursor moves *before* the navigation so a page load racing back in can
/// see `traversing` already set. If the navigation itself fails the move is
/// rolled back, otherwise the stack would silently drift from what is on
/// screen.
fn traverse<R: Runtime>(
    tab_id: &str,
    app: &AppHandle<R>,
    store: &BrowserStore,
    backwards: bool,
) -> Result<(), String> {
    let (label, target) = {
        let mut tab = store.get_mut(tab_id).ok_or("browser tab not found")?;
        let target = if backwards {
            tab.history.back()
        } else {
            tab.history.forward()
        };
        match target {
            // Already at the end of the stack. Not an error — the button is
            // disabled, but a keyboard binding can still fire.
            None => return Ok(()),
            Some(url) => {
                tab.traversing = true;
                (tab.label.clone(), url)
            }
        }
    };

    let parsed = url::Url::parse(&target).map_err(|e| e.to_string())?;
    let result = app
        .get_webview(&label)
        .ok_or_else(|| "browser tab not found".to_string())
        .and_then(|w| w.navigate(parsed).map_err(|e| e.to_string()));

    if result.is_err() {
        if let Some(mut tab) = store.get_mut(tab_id) {
            tab.traversing = false;
            if backwards {
                tab.history.forward();
            } else {
                tab.history.back();
            }
        }
    }
    result
}

#[tauri::command]
pub async fn browser_set_rect<R: Runtime>(
    tab_id: String,
    rect: Rect,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    webview
        .set_position(rect.position())
        .map_err(|e| e.to_string())?;
    webview.set_size(rect.size()).map_err(|e| e.to_string())
}

/// Position and reveal in one call.
///
/// A child webview composites above the entire DOM, so showing it at a stale
/// rectangle paints the old position for a frame. Setting the rect first makes
/// that unobservable.
#[tauri::command]
pub async fn browser_show<R: Runtime>(
    tab_id: String,
    rect: Rect,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    webview
        .set_position(rect.position())
        .map_err(|e| e.to_string())?;
    webview.set_size(rect.size()).map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())
}

/// Where a webview goes when `hide` is a no-op on the platform. There is no
/// z-index that covers a child webview, so "hidden" has to be true off-screen
/// rather than merely obscured.
const OFFSCREEN: Rect = Rect {
    x: -20000.0,
    y: -20000.0,
    width: 1.0,
    height: 1.0,
};

#[tauri::command]
pub async fn browser_hide<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    if webview.hide().is_err() {
        let _ = webview.set_position(OFFSCREEN.position());
        let _ = webview.set_size(OFFSCREEN.size());
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_close<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    if let Some((_, tab)) = store.remove(&tab_id) {
        if let Some(webview) = app.get_webview(&tab.label) {
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Open the platform inspector against the page.
///
/// Available in every build on purpose — an embedded browser you cannot
/// inspect is only half a dev tool — which is why `devtools` is a feature on
/// the `tauri` dependency rather than relying on `debug_assertions`.
#[tauri::command]
pub async fn browser_open_devtools<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    webview.open_devtools();
    Ok(())
}

/// Close browser webviews the store has no entry for.
///
/// Called on boot. A child webview orphaned by a crash floats above the whole
/// UI with nothing owning it and no way to dismiss it — worse than any page
/// we could lose by closing it.
#[tauri::command]
pub async fn browser_close_orphans<R: Runtime>(
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let live: std::collections::HashSet<String> =
        store.iter().map(|e| e.value().label.clone()).collect();
    for (label, webview) in app.webviews() {
        if label.starts_with(LABEL_PREFIX) && !live.contains(&label) {
            let _ = webview.close();
        }
    }
    Ok(())
}

fn label_of(store: &BrowserStore, tab_id: &str) -> Result<String, String> {
    store
        .get(tab_id)
        .map(|t| t.label.clone())
        .ok_or_else(|| "browser tab not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(urls: &[&str]) -> History {
        let mut h = History::default();
        for u in urls {
            h.push(u);
        }
        h
    }

    #[test]
    fn empty_history_cannot_traverse() {
        let mut h = History::default();
        assert!(!h.can_go_back());
        assert!(!h.can_go_forward());
        assert_eq!(h.back(), None);
        assert_eq!(h.forward(), None);
    }

    #[test]
    fn first_page_is_not_a_back_target() {
        let h = history(&["https://a.test/"]);
        assert_eq!(h.current(), Some("https://a.test/"));
        assert!(!h.can_go_back());
        assert!(!h.can_go_forward());
    }

    #[test]
    fn back_and_forward_move_the_cursor_without_pushing() {
        let mut h = history(&["https://a.test/", "https://b.test/", "https://c.test/"]);
        assert_eq!(h.back().as_deref(), Some("https://b.test/"));
        assert!(h.can_go_back());
        assert!(h.can_go_forward());
        assert_eq!(h.back().as_deref(), Some("https://a.test/"));
        assert!(!h.can_go_back());
        assert_eq!(h.entries.len(), 3);

        assert_eq!(h.forward().as_deref(), Some("https://b.test/"));
        assert_eq!(h.forward().as_deref(), Some("https://c.test/"));
        assert!(!h.can_go_forward());
        assert_eq!(h.entries.len(), 3);
    }

    #[test]
    fn navigating_after_back_truncates_the_forward_entries() {
        let mut h = history(&["https://a.test/", "https://b.test/", "https://c.test/"]);
        h.back();
        h.push("https://d.test/");
        assert_eq!(h.current(), Some("https://d.test/"));
        assert!(!h.can_go_forward());
        assert_eq!(
            h.entries,
            vec!["https://a.test/", "https://b.test/", "https://d.test/"]
        );
    }

    /// A reload fires the same page-load callback as a navigation. If that
    /// pushed, Back would walk through duplicates of one page.
    #[test]
    fn reloading_the_current_page_does_not_grow_the_stack() {
        let mut h = history(&["https://a.test/", "https://b.test/"]);
        h.push("https://b.test/");
        h.push("https://b.test/");
        assert_eq!(h.entries.len(), 2);
        assert!(!h.can_go_forward());
    }

    /// Going back to a page and reloading it must not truncate what is ahead.
    #[test]
    fn reload_after_back_keeps_the_forward_entries() {
        let mut h = history(&["https://a.test/", "https://b.test/"]);
        h.back();
        h.push("https://a.test/");
        assert!(h.can_go_forward());
        assert_eq!(h.current(), Some("https://a.test/"));
    }

    #[test]
    fn labels_are_namespaced_by_tab_id() {
        let label = label_for("abc-123");
        assert!(label.starts_with(LABEL_PREFIX));
        assert!(label.ends_with("abc-123"));
    }
}
