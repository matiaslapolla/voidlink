import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { ArrowLeft, ArrowRight, Loader2, RotateCw, Wrench, ZoomIn, ZoomOut } from "lucide-solid";
import { browserApi, type WebviewRect } from "@/api/webview";
import { isOverlayOpen } from "@/commands/overlay";
import { pushToast } from "@/commands/toast";
import type { BrowserTab } from "@/store/layout";
import { normalizeUrl } from "@/components/browser/url";

export { browserTabLabel, normalizeUrl } from "@/components/browser/url";

/// The scale ladder, matching what a browser's own zoom does. A ladder rather
/// than a multiplier so the steps are reproducible and 100% is always exactly
/// reachable — compounding 1.1× lands on 0.99 and never comes home.
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

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
  /// Whether the pane group this tab lives in is on screen at all.
  ///
  /// `active` answers "is this the front tab of its group"; this answers "is
  /// its group being rendered". They come apart the moment panes exist — a
  /// group that has been maximized away is not covered by anything, it is
  /// simply not drawn, and a child webview that is not told to hide would go
  /// on painting over whatever replaced it. Defaults to `true` for callers
  /// with no groups.
  groupVisible?: boolean;
  onUrlChange: (url: string) => void;
  onTitleChange: (title: string) => void;
  /// Persist the page scale. Optional so a caller with no store still gets a
  /// working zoom for the life of the tab.
  onZoomChange?: (zoom: number) => void;
}) {
  let anchor: HTMLDivElement | undefined;
  let addressInput: HTMLInputElement | undefined;
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [address, setAddress] = createSignal(props.tab.url);
  const [canGoBack, setCanGoBack] = createSignal(false);
  const [canGoForward, setCanGoForward] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [devtoolsOpen, setDevtoolsOpen] = createSignal(false);
  const [zoom, setZoom] = createSignal(props.tab.zoom ?? 1);
  const [rect, setRect] = createSignal<WebviewRect>({ x: 0, y: 0, width: 1, height: 1 });

  // Captured once: the pane is keyed by tab id upstream, so this never changes
  // for the life of the component, and the cleanup path must not depend on
  // props still being alive.
  const tabId = props.tab.id;

  /// Set by cleanup, read by the `open` that may still be in flight.
  ///
  /// Closing a tab while its webview is still being built used to leak it: the
  /// close command found no store entry (the open had not inserted one yet),
  /// did nothing, and the open then finished and put a child webview on screen
  /// that no component owned — which the Rust module's own header calls a far
  /// worse failure than losing a page. Nothing could dismiss it before the next
  /// boot swept it as an orphan.
  let disposed = false;

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
      browserApi.onNavigating((e) => {
        if (e.tabId !== tabId) return;
        setLoading(true);
        // The address bar's job during a load is to name where you are going,
        // not where you were. Same focus rule as below: the input belongs to
        // whoever is typing in it.
        if (!addressHasFocus()) setAddress(e.url);
      }),
      browserApi.onNavigated((e) => {
        if (e.tabId !== tabId) return;
        setError(null);
        setLoading(false);
        setCanGoBack(e.canGoBack);
        setCanGoForward(e.canGoForward);
        // Don't yank the address out from under someone mid-type. The input
        // is the user's while it has focus; the page's the rest of the time.
        if (!addressHasFocus()) setAddress(e.url);
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
        // The tab was closed while its webview was being built. Nothing owns
        // what just got created, so close it here — the close command that ran
        // during cleanup found no store entry and did nothing.
        if (disposed) {
          void browserApi.close(tabId).catch(() => {});
          return;
        }
        setReady(true);
        if (zoom() !== 1) void browserApi.setZoom(tabId, zoom()).catch(() => {});
      } catch (e) {
        if (disposed) return;
        fail(e instanceof Error ? e.message : String(e), "Could not open the browser tab");
      }
    })();

    onCleanup(() => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      for (const p of unlisteners) void p.then((un) => un()).catch(() => {});
      void browserApi.close(tabId).catch(() => {});
    });
  });

  /// Whether the address input holds focus *and* the host webview is the one
  /// receiving keys.
  ///
  /// `document.activeElement` alone is not enough. A webview keeps its last
  /// active element while the OS focus sits in a sibling webview, so after the
  /// user clicks the page the input still looks focused here — and the guard
  /// built on it would stop the address bar updating for the rest of the tab's
  /// life, on every link the user then clicked.
  function addressHasFocus(): boolean {
    return document.hasFocus() && document.activeElement === addressInput;
  }

  /// Take the OS keyboard focus back from the page, then put it where the click
  /// aimed it.
  ///
  /// Both halves are needed and in this order. Without the Rust call the host
  /// never receives keystrokes at all; without the re-focus afterwards the
  /// click's own focus was applied to a webview that did not have the OS focus
  /// yet, and the platform hands it to whatever it considers first responder.
  function reclaimFocus(target: EventTarget | null) {
    void browserApi
      .focusHost()
      .then(() => {
        if (disposed) return;
        if (target === addressInput) {
          addressInput?.focus();
          addressInput?.select();
        }
      })
      .catch(() => {
        // Focus is best-effort: on a platform where this fails the address bar
        // is no worse off than it was, and a toast per click would be noise.
      });
  }

  /// Single source of truth for "should the page be on screen". Anything that
  /// paints over the tab — a modal, a menu, another tab being active — has to
  /// route through here, because nothing in the DOM can cover a child webview.
  const shouldShow = () =>
    props.active && (props.groupVisible ?? true) && !isOverlayOpen() && !error();

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

  /// Step the page scale through a fixed ladder rather than by a multiplier,
  /// so repeated presses land on the same values every time and "back to 100%"
  /// is always reachable by pressing the other button.
  function stepZoom(direction: 1 | -1) {
    const index = ZOOM_STEPS.findIndex((s) => s >= zoom() - 0.001);
    const at = index === -1 ? ZOOM_STEPS.length - 1 : index;
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + direction))];
    if (next === zoom()) return;
    setZoom(next);
    props.onZoomChange?.(next);
    void browserApi.setZoom(tabId, next).catch((e: unknown) => {
      pushToast(`Zoom failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
    });
  }

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
        // Same race as the mount path: a retry can land after the tab closed.
        if (disposed) {
          void browserApi.close(tabId).catch(() => {});
          return;
        }
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
          inside it would be hidden behind the page.

          `pointerdown` on the whole strip rather than on the input alone:
          every control in here either expects keys or expects the host to be
          the active webview, and the page has held the OS focus since the user
          last clicked it. On the *down* rather than the click, so the focus
          request is already in flight while the button is still held. */}
      <div
        onPointerDown={(e) => reclaimFocus(e.target)}
        class="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-border bg-sidebar"
      >
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
        {/* One control, two states. A separate spinner would mean the strip
            reflowing every time a page starts loading, and the thing you reach
            for to stop waiting is the same thing you reach for to try again. */}
        <button
          onClick={guarded(() => browserApi.reload(tabId), "Reload failed")}
          title={loading() ? "Loading…" : "Reload"}
          aria-label="Reload page"
          aria-busy={loading()}
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          <Show when={loading()} fallback={<RotateCw class="w-3.5 h-3.5" />}>
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          </Show>
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
          onClick={() => stepZoom(-1)}
          disabled={zoom() <= ZOOM_STEPS[0]}
          title="Zoom out"
          aria-label="Zoom out"
          class="p-1 rounded text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent/40 disabled:opacity-30"
        >
          <ZoomOut class="w-3.5 h-3.5" />
        </button>
        {/* Only while it is not 100%: a percentage that never changes is a
            permanent piece of chrome saying nothing. */}
        <Show when={zoom() !== 1}>
          <button
            onClick={() => {
              setZoom(1);
              props.onZoomChange?.(1);
              void browserApi.setZoom(tabId, 1).catch(() => {});
            }}
            title="Reset zoom"
            aria-label={`Zoom ${Math.round(zoom() * 100)} percent, reset`}
            class="px-1 text-[10px] tabular-nums rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
          >
            {Math.round(zoom() * 100)}%
          </button>
        </Show>
        <button
          onClick={() => stepZoom(1)}
          disabled={zoom() >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          title="Zoom in"
          aria-label="Zoom in"
          class="p-1 rounded text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent/40 disabled:opacity-30"
        >
          <ZoomIn class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={guarded(async () => {
            setDevtoolsOpen(await browserApi.toggleDevtools(tabId));
          }, "Could not toggle devtools")}
          title={devtoolsOpen() ? "Close devtools" : "Open devtools"}
          aria-label={devtoolsOpen() ? "Close devtools" : "Open devtools"}
          aria-pressed={devtoolsOpen()}
          class="p-1 rounded hover:bg-accent/40"
          classList={{
            "text-primary": devtoolsOpen(),
            "text-muted-foreground hover:text-foreground": !devtoolsOpen(),
          }}
        >
          <Wrench class="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Anchor: an empty box whose viewport rect the child webview tracks.

          **The one pane a CSS radius cannot reach.** Under Direction D1 every
          pane is clipped to its island's rounded corners, but this page is an
          OS-level child webview composited *above* the DOM — `border-radius`
          on any ancestor does nothing to it, and a square page inside a
          rounded island is the artifact.

          Of the two options the directions spec allows — a square-cornered
          island for this tab, or insetting the webview so the radius stays
          visible around it — this takes the inset, because a radius that
          changes when you switch tabs draws more attention than 10px of
          padding does. The inset is bottom-only: the top corners are already
          covered by the address bar above, so only the island's two bottom
          corners are ever at risk, and lifting the page clear of them costs
          nothing horizontally. `rect` is measured from this element, so the
          webview follows without any second constant. */}
      <div
        ref={(el) => (anchor = el)}
        class="flex-1 min-h-0 relative"
        style={{ "margin-bottom": "var(--island-radius)" }}
      >
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
