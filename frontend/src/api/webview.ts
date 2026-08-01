import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// The frontend half of the embedded browser. Components never touch
/// `@tauri-apps/api/webview` or `invoke` directly — this is the only module
/// that knows a browser tab is a webview at all.
///
/// The webview itself is owned by `src-tauri/src/browser/mod.rs`, not by
/// JavaScript. That split exists because the JS `Webview` handle can position,
/// show, hide and close a webview and nothing else: no navigation, no history,
/// no page-load or title callbacks. A tab driven from here could only
/// "navigate" by closing the webview and building a new one, which discards
/// the page's session every time, and it could never learn where the page went
/// when the user clicked a link. Rust has all of it, so Rust owns the webview
/// and this module sends it commands keyed by the tab id.
///
/// Three properties of a child webview shape every caller:
///
///   1. It composites *above* the DOM. No z-index puts a dialog over it, so
///      anything that should hide it must call `hide` — covering it does
///      nothing.
///   2. It is positioned in window coordinates, not laid out. Its rectangle
///      has to be pushed on every reflow, which is what `show` does on its way
///      to revealing it.
///   3. **It takes the OS keyboard focus and does not give it back.** Once the
///      user clicks a page, keystrokes go to the page — the app's own webview
///      never sees them, so no keybinding here can rescue the address bar and
///      `HTMLElement.focus()` only moves focus *within* a webview that already
///      has it. `focusHost` is the only way back, and it has to be a Rust
///      command because the capability to focus a webview is deliberately not
///      granted to JavaScript.

export interface WebviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// A tab settled on a page — the user navigated, clicked a link, or a redirect
/// resolved. The traversal flags ride along because history lives in Rust;
/// re-deriving them here would mean keeping a second copy of the stack.
export interface BrowserNavigated {
  tabId: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/// A tab has *started* going somewhere. `on_page_load` only fires when the page
/// arrives, so without this the address bar showed the page being left for the
/// whole of every load and nothing on screen said a load was happening.
///
/// No traversal flags: the history has not folded this load in yet, and
/// provisional flags would flicker the buttons against a stack that has not
/// moved.
export interface BrowserNavigating {
  tabId: string;
  url: string;
}

export interface BrowserTitleChanged {
  tabId: string;
  title: string;
}

const NAVIGATED_EVENT = "voidlink://browser-navigated";
const NAVIGATING_EVENT = "voidlink://browser-navigating";
const TITLE_EVENT = "voidlink://browser-title";

/// Floor every dimension at one logical pixel — a zero-sized webview is a
/// platform error on some backends.
function sane(rect: WebviewRect): WebviewRect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

export const browserApi = {
  /// Create the tab's webview at `rect`, loading `url`.
  open(tabId: string, url: string, rect: WebviewRect): Promise<void> {
    return invoke<void>("browser_open", { tabId, url, rect: sane(rect) });
  },

  /// Navigate in place. Unlike the close-and-recreate this replaced, the page
  /// keeps its process — and with it any session it had established.
  navigate(tabId: string, url: string): Promise<void> {
    return invoke<void>("browser_navigate", { tabId, url });
  },

  reload(tabId: string): Promise<void> {
    return invoke<void>("browser_reload", { tabId });
  },

  /// Step through the tab's visited-URL stack. No-ops at either end rather
  /// than rejecting, so a keybinding firing on a disabled button is harmless.
  back(tabId: string): Promise<void> {
    return invoke<void>("browser_back", { tabId });
  },

  forward(tabId: string): Promise<void> {
    return invoke<void>("browser_forward", { tabId });
  },

  /// Position and reveal in one call — showing at a stale rectangle paints the
  /// old position for a frame.
  show(tabId: string, rect: WebviewRect): Promise<void> {
    return invoke<void>("browser_show", { tabId, rect: sane(rect) });
  },

  hide(tabId: string): Promise<void> {
    return invoke<void>("browser_hide", { tabId });
  },

  close(tabId: string): Promise<void> {
    return invoke<void>("browser_close", { tabId });
  },

  /// Hand the OS keyboard focus back to the app's own webview. Called before
  /// anything that expects to receive keystrokes, because the page has held
  /// them since the moment the user clicked it.
  focusHost(): Promise<void> {
    return invoke<void>("browser_focus_host");
  },

  /// Scale the page. Applied to the webview, so it outlives navigation within
  /// the tab and needs no script in the page.
  setZoom(tabId: string, factor: number): Promise<void> {
    return invoke<void>("browser_set_zoom", { tabId, factor });
  },

  /// Toggle the inspector, answering whether it is now open.
  toggleDevtools(tabId: string): Promise<boolean> {
    return invoke<boolean>("browser_toggle_devtools", { tabId });
  },

  /// Close browser webviews no live tab owns. Called on boot to sweep up
  /// anything a crash left floating above the UI.
  closeOrphans(): Promise<void> {
    return invoke<void>("browser_close_orphans");
  },

  onNavigated(handler: (e: BrowserNavigated) => void): Promise<UnlistenFn> {
    return listen<BrowserNavigated>(NAVIGATED_EVENT, (e) => handler(e.payload));
  },

  onNavigating(handler: (e: BrowserNavigating) => void): Promise<UnlistenFn> {
    return listen<BrowserNavigating>(NAVIGATING_EVENT, (e) => handler(e.payload));
  },

  onTitleChanged(handler: (e: BrowserTitleChanged) => void): Promise<UnlistenFn> {
    return listen<BrowserTitleChanged>(TITLE_EVENT, (e) => handler(e.payload));
  },
};
