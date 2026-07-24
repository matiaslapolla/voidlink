import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Webview } from "@tauri-apps/api/webview";
import { RotateCw } from "lucide-solid";
import { webviewApi, type WebviewRect } from "@/api/webview";
import { isOverlayOpen } from "@/commands/overlay";
import { pushToast } from "@/commands/toast";
import type { BrowserTab } from "@/store/layout";

/// Labels are namespaced so `closeOrphans` can recognise ours after a crash
/// without touching anything else Tauri owns.
export const BROWSER_WEBVIEW_PREFIX = "voidlink-browser-";

/// Normalise whatever the user typed into something a webview will load.
/// A bare host becomes https; anything with a scheme is left alone.
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

/// One embedded browser tab.
///
/// The page is a real Tauri child webview, not an iframe — it gets its own
/// process, its own cookie jar behaviour, and no `X-Frame-Options` problems.
/// The cost is that it is not part of the DOM at all: it paints above
/// everything, positioned in window coordinates. This component's whole job is
/// keeping that rectangle glued to a DOM anchor and getting it out of the way
/// the moment it shouldn't be seen.
///
/// The webview is created on mount and closed on cleanup, which means
/// switching worktrees discards the page (the pane unmounts with its
/// worktree's tab list). That is deliberate: an orphaned child webview floats
/// above the UI with nothing owning it, which is a far worse failure than
/// losing scroll position.
export function BrowserPane(props: {
  tab: BrowserTab;
  active: boolean;
  onUrlChange: (url: string) => void;
}) {
  let anchor: HTMLDivElement | undefined;
  const [webview, setWebview] = createSignal<Webview | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [address, setAddress] = createSignal(props.tab.url);
  const [rect, setRect] = createSignal<WebviewRect>({ x: 0, y: 0, width: 1, height: 1 });

  const label = `${BROWSER_WEBVIEW_PREFIX}${props.tab.id}`;

  function measure(): WebviewRect {
    if (!anchor) return { x: 0, y: 0, width: 1, height: 1 };
    const r = anchor.getBoundingClientRect();
    // CSS pixels are logical pixels, and the main webview fills the window's
    // content area, so the anchor's viewport rect *is* the child's position.
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    };
  }

  onMount(() => {
    setRect(measure());

    // ResizeObserver catches sidebar collapse and pane resizes; the window
    // listeners catch OS-level moves the observer never sees.
    const ro = new ResizeObserver(() => setRect(measure()));
    if (anchor) ro.observe(anchor);
    const onReflow = () => setRect(measure());
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);

    void (async () => {
      try {
        const wv = await webviewApi.createChild(label, props.tab.url, measure());
        setWebview(wv);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        pushToast(`Could not open the browser tab: ${message}`, "error", 6000);
      }
    })();

    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      const wv = webview();
      if (wv) void webviewApi.close(wv).catch(() => {});
    });
  });

  /// Single source of truth for "should the page be on screen". Anything that
  /// paints over the tab — a modal, a menu, another tab being active — has to
  /// route through here, because nothing in the DOM can cover a child webview.
  const shouldShow = () => props.active && !isOverlayOpen() && !error();

  createEffect(() => {
    const wv = webview();
    if (!wv) return;
    const visible = shouldShow();
    const target = rect();
    void (async () => {
      try {
        if (visible) await webviewApi.show(wv, target);
        else await webviewApi.hide(wv);
      } catch {
        // A webview can vanish under us (window closed, crash). Losing the
        // position update is harmless; the next effect run retries.
      }
    })();
  });

  async function navigate(url: string) {
    const wv = webview();
    const normalized = normalizeUrl(url);
    if (!wv || !normalized) return;
    try {
      // No `loadUrl` on the JS Webview handle in 2.11 — recreating is the
      // supported path, and it also resets any auth state the old page held.
      await webviewApi.close(wv);
      setWebview(null);
      const next = await webviewApi.createChild(label, normalized, measure());
      setWebview(next);
      setError(null);
      props.onUrlChange(normalized);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      pushToast(`Could not load ${normalized}: ${message}`, "error", 6000);
    }
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      {/* Address bar. Lives *outside* the webview rectangle — anything drawn
          inside it would be hidden behind the page. */}
      <div class="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-border bg-sidebar">
        <button
          onClick={() => void navigate(address())}
          title="Reload"
          aria-label="Reload page"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          <RotateCw class="w-3.5 h-3.5" />
        </button>
        {/* No back/forward: Tauri 2.11 exposes no webview history API to
            JavaScript, and a button that silently does nothing is worse than
            no button. */}
        <input
          value={address()}
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate(e.currentTarget.value);
          }}
          spellcheck={false}
          aria-label="Address"
          placeholder="example.com"
          class="flex-1 min-w-0 rounded border border-border bg-muted/40 px-2 py-1 text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Anchor: an empty box whose viewport rect the child webview tracks. */}
      <div ref={(el) => (anchor = el)} class="flex-1 min-h-0 relative">
        <Show when={error()}>
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground px-6 text-center">
            <p class="text-[13px]">This page could not be loaded.</p>
            <p class="text-[11px] text-destructive break-words max-w-md">{error()}</p>
            <button
              onClick={() => void navigate(address())}
              class="mt-1 flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-md border border-border hover:bg-accent/40 hover:text-foreground transition-colors"
            >
              <RotateCw class="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
