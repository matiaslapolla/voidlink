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
/// Two properties of a child webview shape every caller:
///
///   1. It composites *above* the DOM. No z-index puts a dialog over it, so
///      anything that should hide it must call `hide` — covering it does
///      nothing.
///   2. It is positioned in window coordinates, not laid out. Its rectangle
///      has to be pushed on every reflow, which is what `setRect` is for.

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

export interface BrowserTitleChanged {
  tabId: string;
  title: string;
}

const NAVIGATED_EVENT = "voidlink://browser-navigated";
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

  setRect(tabId: string, rect: WebviewRect): Promise<void> {
    return invoke<void>("browser_set_rect", { tabId, rect: sane(rect) });
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

  openDevtools(tabId: string): Promise<void> {
    return invoke<void>("browser_open_devtools", { tabId });
  },

  /// Close browser webviews no live tab owns. Called on boot to sweep up
  /// anything a crash left floating above the UI.
  closeOrphans(): Promise<void> {
    return invoke<void>("browser_close_orphans");
  },

  onNavigated(handler: (e: BrowserNavigated) => void): Promise<UnlistenFn> {
    return listen<BrowserNavigated>(NAVIGATED_EVENT, (e) => handler(e.payload));
  },

  onTitleChanged(handler: (e: BrowserTitleChanged) => void): Promise<UnlistenFn> {
    return listen<BrowserTitleChanged>(TITLE_EVENT, (e) => handler(e.payload));
  },
};
