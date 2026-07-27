import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { ArrowLeft, ArrowRight, RotateCw, Wrench } from "lucide-solid";
import { browserApi, type WebviewRect } from "@/api/webview";
import { isOverlayOpen } from "@/commands/overlay";
import { pushToast } from "@/commands/toast";
import type { BrowserTab } from "@/store/layout";
import { normalizeUrl } from "@/components/browser/url";

export { browserTabLabel, normalizeUrl } from "@/components/browser/url";

/// One embedded browser tab.
///
/// The page is a real Tauri child webview, not an iframe — it gets its own
/// process, its own cookie jar behaviour, and no `X-Frame-Options` problems.
/// The cost is that it is not part of the DOM at all: it paints above
/// everything, positioned in window coordinates. This component's whole job is
/// keeping that rectangle glued to a DOM anchor, getting it out of the way the
/// moment it shouldn't be seen, and relaying the user's intent to the Rust
/// module that actually owns the webview (`src-tauri/src/browser/mod.rs`).
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
  onTitleChange: (title: string) => void;
}) {
  let anchor: HTMLDivElement | undefined;
  let addressInput: HTMLInputElement | undefined;
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [address, setAddress] = createSignal(props.tab.url);
  const [canGoBack, setCanGoBack] = createSignal(false);
  const [canGoForward, setCanGoForward] = createSignal(false);
  const [rect, setRect] = createSignal<WebviewRect>({ x: 0, y: 0, width: 1, height: 1 });

  // Captured once: the pane is keyed by tab id upstream, so this never changes
  // for the life of the component, and the cleanup path must not depend on
  // props still being alive.
  const tabId = props.tab.id;

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

  function fail(message: string, prefix: string) {
    setError(message);
    pushToast(`${prefix}: ${message}`, "error", 6000);
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

    // Every tab hears every tab's events, so each one filters by id.
    const unlisteners: Promise<() => void>[] = [
      browserApi.onNavigated((e) => {
        if (e.tabId !== tabId) return;
        setError(null);
        setCanGoBack(e.canGoBack);
        setCanGoForward(e.canGoForward);
        // Don't yank the address out from under someone mid-type. The input
        // is the user's while it has focus; the page's the rest of the time.
        if (document.activeElement !== addressInput) setAddress(e.url);
        props.onUrlChange(e.url);
      }),
      browserApi.onTitleChanged((e) => {
        if (e.tabId !== tabId) return;
        props.onTitleChange(e.title);
      }),
    ];

    void (async () => {
      try {
        await browserApi.open(tabId, props.tab.url, measure());
        setReady(true);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), "Could not open the browser tab");
      }
    })();

    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      for (const p of unlisteners) void p.then((un) => un()).catch(() => {});
      void browserApi.close(tabId).catch(() => {});
    });
  });

  /// Single source of truth for "should the page be on screen". Anything that
  /// paints over the tab — a modal, a menu, another tab being active — has to
  /// route through here, because nothing in the DOM can cover a child webview.
  const shouldShow = () => props.active && !isOverlayOpen() && !error();

  createEffect(() => {
    if (!ready()) return;
    const visible = shouldShow();
    const target = rect();
    void (async () => {
      try {
        if (visible) await browserApi.show(tabId, target);
        else await browserApi.hide(tabId);
      } catch {
        // A webview can vanish under us (window closed, crash). Losing the
        // position update is harmless; the next effect run retries.
      }
    })();
  });

  async function navigate(url: string) {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    // The old title describes the page we're leaving. Cleared here rather than
    // on the navigated event, because the new page's title arrives *during*
    // its load — clearing on arrival would wipe the title we just received.
    props.onTitleChange("");
    try {
      if (ready()) {
        await browserApi.navigate(tabId, normalized);
      } else {
        // The first `open` failed. Retrying it is what the error state's "Try
        // again" button is for — navigating a webview that was never built
        // would just fail again with a less useful message.
        await browserApi.open(tabId, normalized, measure());
        setReady(true);
      }
      setError(null);
      // The address is confirmed by the navigated event once the page settles;
      // persisting it here too means a tab that fails to load still comes back
      // pointing where the user aimed it.
      props.onUrlChange(normalized);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), `Could not load ${normalized}`);
    }
  }

  function guarded(action: () => Promise<void>, what: string) {
    return () => {
      void action().catch((e: unknown) =>
        pushToast(`${what}: ${e instanceof Error ? e.message : String(e)}`, "error", 6000),
      );
    };
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      {/* Address bar. Lives *outside* the webview rectangle — anything drawn
          inside it would be hidden behind the page. */}
      <div class="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-border bg-sidebar">
        <button
          onClick={guarded(() => browserApi.back(tabId), "Back failed")}
          disabled={!canGoBack()}
          title="Back"
          aria-label="Back"
          class="p-1 rounded text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent/40 disabled:opacity-30"
        >
          <ArrowLeft class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={guarded(() => browserApi.forward(tabId), "Forward failed")}
          disabled={!canGoForward()}
          title="Forward"
          aria-label="Forward"
          class="p-1 rounded text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent/40 disabled:opacity-30"
        >
          <ArrowRight class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={guarded(() => browserApi.reload(tabId), "Reload failed")}
          title="Reload"
          aria-label="Reload page"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          <RotateCw class="w-3.5 h-3.5" />
        </button>
        <input
          ref={(el) => (addressInput = el)}
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
        <button
          onClick={guarded(() => browserApi.openDevtools(tabId), "Could not open devtools")}
          title="Open devtools"
          aria-label="Open devtools"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          <Wrench class="w-3.5 h-3.5" />
        </button>
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
