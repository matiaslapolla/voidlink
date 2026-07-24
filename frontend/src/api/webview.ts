import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

/// Thin wrapper over Tauri's multiwebview API so components never touch
/// `@tauri-apps/api/webview` (or `invoke`) directly.
///
/// This is the **unstable** part of Tauri v2: `create_webview` is gated behind
/// the `unstable` Cargo feature on the `tauri` crate, which is why
/// `src-tauri/Cargo.toml` pins an exact version rather than a caret range.
/// Every call here can therefore fail at runtime on a mismatched build; the
/// caller is expected to surface that rather than swallow it.
///
/// A child webview always composites *above* the DOM — there is no z-index
/// that puts a dialog over it. Anything not currently visible must be moved
/// off-screen or hidden, never merely covered.

export interface WebviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Where we park a webview that shouldn't be visible. `hide()` is the primary
/// mechanism; this is the fallback for platforms where hide is a no-op.
const OFFSCREEN: WebviewRect = { x: -20000, y: -20000, width: 1, height: 1 };

export const webviewApi = {
  /// Create a child webview of the main window at `rect`, loading `url`.
  /// Resolves once Tauri reports the webview created, rejects with the
  /// backend's error otherwise.
  async createChild(label: string, url: string, rect: WebviewRect): Promise<Webview> {
    const parent = getCurrentWindow();
    const webview = new Webview(parent, label, {
      url,
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      // The child renders untrusted remote pages: no Tauri IPC surface, and no
      // drag-drop hijacking of the host window.
      dragDropEnabled: false,
    });
    await new Promise<void>((resolve, reject) => {
      void webview.once("tauri://created", () => resolve());
      void webview.once<{ message?: string }>("tauri://error", (e) =>
        reject(new Error(e.payload?.message ?? "failed to create webview")),
      );
    });
    return webview;
  },

  async setRect(webview: Webview, rect: WebviewRect): Promise<void> {
    await webview.setPosition(new LogicalPosition(rect.x, rect.y));
    await webview.setSize(
      new LogicalSize(Math.max(1, rect.width), Math.max(1, rect.height)),
    );
  },

  /// Hide a child webview. Falls back to parking it off-screen when the
  /// platform's `hide` doesn't take, because a stale child webview paints over
  /// every dialog and menu in the app.
  async hide(webview: Webview): Promise<void> {
    try {
      await webview.hide();
    } catch {
      await webviewApi.setRect(webview, OFFSCREEN);
    }
  },

  async show(webview: Webview, rect: WebviewRect): Promise<void> {
    await webviewApi.setRect(webview, rect);
    await webview.show();
  },

  async close(webview: Webview): Promise<void> {
    await webview.close();
  },

  /// Close any child webview matching `predicate`. Used on boot to sweep up
  /// webviews orphaned by a crash — they would otherwise float above the UI
  /// with nothing owning them.
  async closeOrphans(predicate: (label: string) => boolean): Promise<void> {
    const { getAllWebviews } = await import("@tauri-apps/api/webview");
    const all = await getAllWebviews();
    await Promise.all(
      all
        .filter((w) => predicate(w.label))
        .map((w) => w.close().catch(() => {})),
    );
  },
};
