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
//!
//! One thing this module cannot do, established by reading the pinned
//! dependency rather than inferred, because every "obvious" fix for it is a
//! guess dressed up as an event:
//!
//! **There is no load-failure signal, at any layer.** `PageLoadEvent` has two
//! variants, `Started` and `Finished`, and wry 0.55.1 never synthesises a third
//! from what the platform tells it. On macOS its `WKNavigationDelegate`
//! (`wkwebview/class/wry_navigation_delegate.rs`) implements
//! `didCommitNavigation` and `didFinishNavigation` and simply does not
//! implement `didFailProvisionalNavigation`. On Linux the `load-changed` match
//! sends `LoadEvent::Failed` to a `_ => ()` arm. On Windows it is worse than
//! absent: `NavigationCompleted` fires for failures too, and wry maps it to
//! `Finished` without consulting the event's `IsSuccess`, so a refused
//! connection arrives here indistinguishable from a page that loaded.
//!
//! So a DNS failure, a refused connection or a bad certificate produces
//! [`NAVIGATING_EVENT`], then nothing, forever. What this module emits instead
//! is the *commit* — [`COMMITTED_EVENT`], from `PageLoadEvent::Started`, which
//! was being discarded — so a load that never reached a server is at least
//! distinguishable from one that is merely slow. Deciding that a load has
//! *failed* still needs either a timeout (which lies about a slow page) or
//! polling `url()` (a poll where an event belongs); neither is here, and
//! neither should be added without measuring a real failure first.

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
const NAVIGATING_EVENT: &str = "voidlink://browser-navigating";
const COMMITTED_EVENT: &str = "voidlink://browser-committed";
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

/// How many entries one tab's back stack keeps.
///
/// The stack was unbounded, which is a slow leak rather than a bug: a tab left
/// on a page that redirects on a timer grows it forever, and every entry is an
/// owned `String`. Dropping the *oldest* entries is the only truncation that
/// costs nothing a user would notice — the far end of a long history is the
/// part nobody walks back to, and the alternative (refusing to record) would
/// break Back for the pages they actually are on.
const MAX_HISTORY: usize = 200;

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

        // Trim from the front, and move the cursor by exactly what was dropped
        // — a cursor left pointing at its old index would silently address a
        // different page, which is the one way this could corrupt rather than
        // merely forget.
        if self.entries.len() > MAX_HISTORY {
            let overflow = self.entries.len() - MAX_HISTORY;
            self.entries.drain(..overflow);
            self.cursor -= overflow;
        }
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

    /// Point the current entry at where the page actually ended up.
    ///
    /// Used when a traversal lands somewhere other than the entry it asked for
    /// — a Back to a URL that redirects. Pushing instead would truncate every
    /// forward entry, so Forward would stop working because a page you went
    /// *back* to moved; overwriting keeps the stack describing what is on
    /// screen and leaves the rest of it reachable.
    fn replace_current(&mut self, url: &str) {
        if let Some(entry) = self.entries.get_mut(self.cursor) {
            entry.clear();
            entry.push_str(url);
        } else {
            self.push(url);
        }
    }

    #[cfg(test)]
    fn current(&self) -> Option<&str> {
        self.entries.get(self.cursor).map(String::as_str)
    }
}

// ─── Store ────────────────────────────────────────────────────────────────────

/// How many outstanding traversals one tab remembers.
///
/// A traversal that never produces a page load — wry does not always fire one
/// for a navigation to a URL the webview considers it is already on — would
/// otherwise sit in the queue forever, and the next *genuine* navigation would
/// be mistaken for its late arrival and swallowed. Held-down Back is the only
/// thing that fills this at all, so anything past a couple of dozen is already
/// a queue that lost track and is better dropped than trusted.
const MAX_PENDING_TRAVERSALS: usize = 32;

pub(crate) struct TabState {
    label: String,
    history: History,
    /// The URLs back/forward asked for, in the order they were asked for,
    /// each held until the page load it causes settles.
    ///
    /// A queue rather than the boolean this started as. The boolean was set by
    /// every traversal and cleared by the first load to come back, so two
    /// traversals inside one page load — a held-down Back, a keybinding repeat
    /// — left the second load looking like a fresh navigation. Worse, a burst
    /// that wry *coalesced* into one load left the flag set forever, and the
    /// next address the user typed was then folded into history as if it had
    /// been a traversal, so Back skipped it.
    ///
    /// Matching by URL rather than by count is what makes both cases decidable:
    /// a load whose URL is somewhere in the queue is a traversal (and anything
    /// queued ahead of it was superseded), and a load whose URL is in neither
    /// the queue nor the future is a redirect off the traversal that is still
    /// outstanding.
    pending_traversals: std::collections::VecDeque<String>,
}

impl TabState {
    fn new(label: String) -> Self {
        Self {
            label,
            history: History::default(),
            pending_traversals: std::collections::VecDeque::new(),
        }
    }

    /// Record that a traversal to `url` has been issued.
    fn expect_traversal(&mut self, url: &str) {
        if self.pending_traversals.len() >= MAX_PENDING_TRAVERSALS {
            self.pending_traversals.pop_front();
        }
        self.pending_traversals.push_back(url.to_string());
    }

    /// Undo [`Self::expect_traversal`] when the navigation it was recorded for
    /// never got dispatched.
    fn cancel_traversal(&mut self) {
        self.pending_traversals.pop_back();
    }

    /// Fold a settled page load into this tab's history, answering the
    /// traversal flags the frontend's buttons enable off.
    ///
    /// Pure, and separated from [`on_page_settled`] for exactly that reason:
    /// the callback around it needs an `AppHandle` that no unit test in this
    /// repo can build, and the decision it makes — push, ignore, or overwrite —
    /// is the entire correctness of the back button.
    fn settle(&mut self, url: &str) -> (bool, bool) {
        match self.pending_traversals.iter().position(|u| u == url) {
            // Our traversal landed. Anything queued ahead of it was superseded
            // by a later Back before it ever loaded, so it is dropped too — the
            // cursor already moved for all of them.
            Some(index) => {
                self.pending_traversals.drain(..=index);
            }
            // A load nobody asked for, while a traversal is still outstanding:
            // the page we went back to redirected. The cursor is already on the
            // entry that redirected, so point it at where the page ended up
            // rather than pushing, which would discard everything ahead of it.
            None if !self.pending_traversals.is_empty() => {
                self.pending_traversals.pop_front();
                self.history.replace_current(url);
            }
            // An ordinary navigation: typed, clicked, or redirected into.
            None => self.history.push(url),
        }
        (self.history.can_go_back(), self.history.can_go_forward())
    }
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

/// The shape of both mid-flight events: a tab has *asked* to go somewhere
/// ([`NAVIGATING_EVENT`]) and a tab's document has *committed*
/// ([`COMMITTED_EVENT`]).
///
/// They are two events rather than one because the gap between them is the only
/// thing this engine can tell you about a load that is going wrong. See the
/// module header: a load that fails at DNS, connect or TLS produces the first
/// and never the second, so "asked but never committed" is as close to a
/// failure signal as the pinned dependency gets. A load that has committed and
/// not finished is a slow page; a load that has not committed has not reached a
/// server at all.
///
/// Carries no traversal flags. They are only meaningful once the history has
/// folded the load in, and sending a provisional pair would make the buttons
/// flicker against a stack that has not moved yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigatingPayload {
    tab_id: String,
    url: String,
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
    let nav_app = app.clone();
    let nav_tab = tab_id.clone();

    let builder = WebviewBuilder::<R>::new(&label, WebviewUrl::External(parsed))
        // The child renders untrusted remote pages: no drag-drop hijacking of
        // the host window, and no Tauri IPC surface (it holds no capability).
        .disable_drag_drop_handler()
        // Fires when the page *asks* to go somewhere. Returning true always:
        // this is an announcement, not a policy.
        //
        // A URL policy — blocking `file://`, confining a tab to one origin —
        // is one `return false` from possible here and deliberately is not
        // one. It cannot be built as a mechanism first: an allow-everything
        // policy object changes nothing, and the shape it would need depends
        // entirely on the unanswered question (a global scheme allowlist? a
        // per-tab origin confinement? a prompt?). Building the wrong one now
        // would be harder to remove than to write.
        //
        // Two things the next person should know before writing it. wry's
        // macOS navigation policy never checks `isMainFrame`, so this hook is
        // *more* powerful than an address-bar filter: it sees every iframe a
        // page loads, which is what a blocklist wants and is also why nothing
        // that names the tab may be driven from the event it emits. And
        // returning `false` cancels silently — the page simply does not move,
        // with no error anywhere — so a policy that blocks needs its own way
        // to say so or it will read as the app having frozen.
        .on_navigation(move |url| {
            let _ = nav_app.emit(
                NAVIGATING_EVENT,
                NavigatingPayload {
                    tab_id: nav_tab.clone(),
                    url: url.to_string(),
                },
            );
            true
        })
        .on_page_load(move |_webview: tauri::Webview<R>, payload: PageLoadPayload<'_>| {
            let url = payload.url().as_str();
            match payload.event() {
                // The document committed: a server answered and bytes are
                // arriving. Nothing was listening for this before, and it is
                // the only evidence the pinned engine offers that a load which
                // has not finished is a load that has actually *begun*.
                PageLoadEvent::Started => {
                    let _ = load_app.emit(
                        COMMITTED_EVENT,
                        NavigatingPayload {
                            tab_id: load_tab.clone(),
                            url: url.to_string(),
                        },
                    );
                }
                PageLoadEvent::Finished => on_page_settled(&load_app, &load_tab, url),
            }
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

    store.insert(tab_id, TabState::new(label));
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
        tab.settle(url)
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
/// already find the target queued. If the navigation itself fails the move is
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
                tab.expect_traversal(&url);
                (tab.label.clone(), url)
            }
        }
    };

    // The parse is inside the result chain, not a `?` above it: every entry in
    // the stack parsed once already, so a failure here is unreachable — but if
    // it ever happened, an early return would leave the cursor moved and the
    // traversal queued for a load that is never coming.
    let result = url::Url::parse(&target)
        .map_err(|e| e.to_string())
        .and_then(|parsed| {
            app.get_webview(&label)
                .ok_or_else(|| "browser tab not found".to_string())
                .and_then(|w| w.navigate(parsed).map_err(|e| e.to_string()))
        });

    if result.is_err() {
        if let Some(mut tab) = store.get_mut(tab_id) {
            tab.cancel_traversal();
            if backwards {
                tab.history.forward();
            } else {
                tab.history.back();
            }
        }
    }
    result
}

/// Give keyboard focus back to the app's own webview.
///
/// **This is the whole fix for the dead address bar**, and it is a fix that
/// cannot be replaced by anything on the frontend. A child webview is a sibling
/// native view, so once the user clicks into a page it holds the OS keyboard
/// focus and every keystroke goes to the page — including the ones aimed at the
/// address bar. The host webview cannot take focus back by itself: it never
/// receives the keys, so no keybinding of ours can fire, and
/// `HTMLElement.focus()` moves focus only *within* a webview that already has
/// it. Somebody outside both has to say which one is active, and on this
/// boundary that somebody is Rust.
///
/// Focuses by elimination rather than by the `main` label: the git window hosts
/// its own webview under a different label, and a command that hard-coded
/// `main` would silently focus the wrong window's UI.
#[tauri::command]
pub async fn browser_focus_host<R: Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    let host = window
        .webviews()
        .into_iter()
        .find(|w| !w.label().starts_with(LABEL_PREFIX))
        .ok_or("this window has no app webview")?;
    host.set_focus().map_err(|e| e.to_string())
}

/// Scale the page. Tauri applies this to the webview itself, so it survives
/// navigation within the tab and needs no script in the page.
#[tauri::command]
pub async fn browser_set_zoom<R: Runtime>(
    tab_id: String,
    factor: f64,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    webview.set_zoom(clamp_zoom(factor)).map_err(|e| e.to_string())
}

/// Zoom bounds. Below a quarter the page is unreadable and above five the
/// scrollbars are the only thing on screen — both are states a user reaches by
/// holding a button down and then cannot read their way out of.
fn clamp_zoom(factor: f64) -> f64 {
    if factor.is_nan() {
        return 1.0;
    }
    factor.clamp(0.25, 5.0)
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

/// Tear down a tab's webview. Closing a tab that is not open is **not** an
/// error, and this is the decision rather than an oversight.
///
/// The audit asked whether the silent `Ok(())` for an unknown `tab_id` was a
/// lie worth turning into an error. Every caller says no. There are three, all
/// in `BrowserPane.tsx`, and all three discard the result on purpose because
/// all three run during or after unmount, where there is no component left to
/// show a message on and nothing a user could do about one:
///
/// 1. cleanup's close, which by design *expects* to find nothing — that is the
///    whole shape of the open-still-in-flight race the `disposed` flag exists
///    for, so an error here would report the normal path as a failure;
/// 2. the in-flight `open` discovering the tab was closed under it;
/// 3. the same discovery on `navigate`'s retry path.
///
/// So an error would change nothing observable and would misdescribe the one
/// sequence this command exists to make safe. What *was* wrong is narrower and
/// is fixed here: the close was gated on finding a store entry, so a webview
/// whose entry had already been removed — a double close, anything the store
/// lost track of — was left on screen compositing above the whole UI with
/// nothing owning it. The label is derived from the tab id, so no lookup is
/// needed to name it, and closing by label makes this idempotent in the
/// direction that matters.
#[tauri::command]
pub async fn browser_close<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<(), String> {
    store.remove(&tab_id);
    if let Some(webview) = app.get_webview(&label_for(&tab_id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle the platform inspector against the page, answering whether it is now
/// open.
///
/// Available in every build on purpose — an embedded browser you cannot
/// inspect is only half a dev tool — which is why `devtools` is a feature on
/// the `tauri` dependency rather than relying on `debug_assertions`.
///
/// A toggle rather than an open: the inspector is a window the app put on the
/// user's screen, and the button that produced it is the obvious place to reach
/// for to make it go away. `open_devtools` on an already-open inspector does
/// nothing, so the old command's button was dead half the time it was pressed.
#[tauri::command]
pub async fn browser_toggle_devtools<R: Runtime>(
    tab_id: String,
    app: AppHandle<R>,
    store: tauri::State<'_, BrowserStore>,
) -> Result<bool, String> {
    let label = label_of(&store, &tab_id)?;
    let webview = app.get_webview(&label).ok_or("browser tab not found")?;
    if webview.is_devtools_open() {
        webview.close_devtools();
        Ok(false)
    } else {
        webview.open_devtools();
        Ok(true)
    }
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

    /// A page that redirects on a timer would otherwise grow the stack for as
    /// long as the tab is open.
    #[test]
    fn the_stack_is_capped_and_drops_the_oldest() {
        let mut h = History::default();
        for i in 0..MAX_HISTORY + 50 {
            h.push(&format!("https://{i}.test/"));
        }
        assert_eq!(h.entries.len(), MAX_HISTORY);
        assert_eq!(h.entries[0], "https://50.test/");
        assert_eq!(h.current(), Some("https://249.test/"));
    }

    /// The cursor is an index into a vector that just lost entries from its
    /// front. Moving it by anything other than the number dropped would leave
    /// Back addressing a different page than the one it names.
    #[test]
    fn capping_keeps_the_cursor_on_the_same_page() {
        let mut h = History::default();
        for i in 0..MAX_HISTORY {
            h.push(&format!("https://{i}.test/"));
        }
        h.back();
        h.back();
        let before = h.current().map(str::to_string);
        h.forward();
        h.forward();
        h.push("https://overflow.test/");
        assert_eq!(h.entries.len(), MAX_HISTORY);
        assert_eq!(h.current(), Some("https://overflow.test/"));
        h.back();
        h.back();
        h.back();
        assert_eq!(h.current().map(str::to_string), before);
    }

    #[test]
    fn zoom_is_clamped_and_survives_nonsense() {
        assert_eq!(clamp_zoom(1.0), 1.0);
        assert_eq!(clamp_zoom(0.0), 0.25);
        assert_eq!(clamp_zoom(-3.0), 0.25);
        assert_eq!(clamp_zoom(99.0), 5.0);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
    }

    // ─── Settling a page load ────────────────────────────────────────────────
    //
    // `on_page_settled` needs an `AppHandle` no unit test in this repo can
    // build, which is why this decision was moved onto `TabState` — the
    // callback around it is three lines of plumbing and the decision inside it
    // is the whole correctness of the back button.

    /// Drive a tab the way the real one is driven: traversals are recorded when
    /// issued, loads settle afterwards, in whatever order they arrive.
    fn tab(urls: &[&str]) -> TabState {
        let mut t = TabState::new("test".into());
        for u in urls {
            t.settle(u);
        }
        t
    }

    #[test]
    fn an_ordinary_load_is_pushed() {
        let mut t = tab(&["https://a.test/"]);
        assert_eq!(t.settle("https://b.test/"), (true, false));
        assert_eq!(t.history.current(), Some("https://b.test/"));
    }

    /// The traversal's own load must not be pushed, or Back would append the
    /// page you just came from and the cursor could never reach the start.
    #[test]
    fn a_traversals_own_load_is_not_pushed() {
        let mut t = tab(&["https://a.test/", "https://b.test/"]);
        t.history.back();
        t.expect_traversal("https://a.test/");
        assert_eq!(t.settle("https://a.test/"), (false, true));
        assert_eq!(t.history.entries.len(), 2);
        assert_eq!(t.history.current(), Some("https://a.test/"));
    }

    /// BR-H3. Two traversals inside one page load — a held-down Back, a
    /// keybinding repeat. The boolean this replaced was set twice and cleared
    /// once, so the second load looked like a fresh navigation.
    #[test]
    fn a_burst_of_traversals_settles_without_disturbing_the_stack() {
        let mut t = tab(&["https://a.test/", "https://b.test/", "https://c.test/"]);
        t.history.back();
        t.expect_traversal("https://b.test/");
        t.history.back();
        t.expect_traversal("https://a.test/");

        t.settle("https://b.test/");
        let flags = t.settle("https://a.test/");

        assert_eq!(flags, (false, true));
        assert_eq!(
            t.history.entries,
            vec!["https://a.test/", "https://b.test/", "https://c.test/"]
        );
        assert_eq!(t.history.current(), Some("https://a.test/"));
        assert!(t.pending_traversals.is_empty());
    }

    /// The worse half of the same bug. wry does not promise one load per
    /// `navigate`, so a burst can coalesce into a single load — and a queue
    /// that only matched the front would then keep an entry forever and eat the
    /// *next* address the user typed.
    #[test]
    fn a_coalesced_burst_drops_the_traversals_it_superseded() {
        let mut t = tab(&["https://a.test/", "https://b.test/", "https://c.test/"]);
        t.history.back();
        t.expect_traversal("https://b.test/");
        t.history.back();
        t.expect_traversal("https://a.test/");

        // Only the last one ever loads.
        t.settle("https://a.test/");
        assert!(t.pending_traversals.is_empty());

        // The next real navigation must still be recorded.
        t.settle("https://d.test/");
        assert_eq!(t.history.current(), Some("https://d.test/"));
        assert!(!t.history.can_go_forward());
    }

    /// Going back to a page that redirects. Pushing would discard everything
    /// ahead of the cursor, so Forward would stop working because a page you
    /// went *back* to moved.
    #[test]
    fn a_traversal_that_redirects_moves_the_entry_rather_than_the_stack() {
        let mut t = tab(&["https://a.test/", "https://b.test/", "https://c.test/"]);
        t.history.back();
        t.history.back();
        t.expect_traversal("https://a.test/");

        let flags = t.settle("https://a.test/moved");

        assert_eq!(flags, (false, true));
        assert_eq!(
            t.history.entries,
            vec!["https://a.test/moved", "https://b.test/", "https://c.test/"]
        );
        assert!(t.pending_traversals.is_empty());
    }

    /// A traversal whose navigation never got dispatched must not leave the
    /// queue expecting a load that is not coming.
    #[test]
    fn a_cancelled_traversal_leaves_nothing_outstanding() {
        let mut t = tab(&["https://a.test/", "https://b.test/"]);
        t.expect_traversal("https://a.test/");
        t.cancel_traversal();
        assert!(t.pending_traversals.is_empty());

        t.settle("https://c.test/");
        assert_eq!(t.history.current(), Some("https://c.test/"));
    }

    /// Held-down Back against a tab whose loads never arrive. The queue is a
    /// bound, not a log: past the cap it has already lost track, and an
    /// unbounded one would grow for as long as the key is held.
    #[test]
    fn the_traversal_queue_is_bounded() {
        let mut t = TabState::new("test".into());
        for i in 0..MAX_PENDING_TRAVERSALS + 10 {
            t.expect_traversal(&format!("https://{i}.test/"));
        }
        assert_eq!(t.pending_traversals.len(), MAX_PENDING_TRAVERSALS);
        assert_eq!(t.pending_traversals.front().unwrap(), "https://10.test/");
    }

    #[test]
    fn labels_are_namespaced_by_tab_id() {
        let label = label_for("abc-123");
        assert!(label.starts_with(LABEL_PREFIX));
        assert!(label.ends_with("abc-123"));
    }
}
