/// Pure URL/label helpers for the embedded browser.
///
/// Split out of `BrowserPane` so this module is unit-testable in plain node —
/// the pane itself imports Solid and the Tauri bridge, neither of which exists
/// in a test runner.

/// Normalise whatever the user typed into something a webview will load.
/// A bare host becomes https; anything with a scheme is left alone.
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

/// The label shown on a browser tab: the page's own title once it has one,
/// falling back to the host while the first load is in flight, and to the raw
/// string if it isn't a parseable URL.
export function browserTabLabel(tab: { url: string; title?: string }): string {
  const title = tab.title?.trim();
  if (title) return title;
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "new tab";
  }
}
