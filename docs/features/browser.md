# Embedded browser

## What it does

Browser tabs that live beside your editor and terminal tabs, backed by real
Tauri child webviews — not iframes. Each tab is its own webview process with
its own cookie jar, so `X-Frame-Options` and `frame-ancestors` never apply and
a page you log into stays logged in.

The webview is created and driven from Rust (`src-tauri/src/browser/mod.rs`).
The frontend owns tab state and sends commands keyed by the tab id; it never
holds a webview handle.

## When you'd use it

Keeping a dev server, a docs page, or a dashboard open in the same window as
the code — without the alt-tab, and without a second app's worth of chrome.

## How to use it

1. `+` tab menu → **New browser tab**. It opens at `https://example.com`; there
   is no prompt, because one fewer modal is one fewer thing fighting the child
   webview for the top of the paint stack.
2. Type in the address bar and press Enter. Bare hosts get `https://`;
   `localhost` and `127.0.0.1` get `http://` (dev servers don't do TLS).
3. Back / Forward / Reload sit left of the address bar; zoom and the devtools
   wrench sit right of it. Reload becomes a spinner while a page is loading.
4. Zoom steps through a fixed ladder, per tab, and is remembered across a
   reload. The percentage appears between the two buttons only when it isn't
   100%, and clicking it resets.
5. The wrench toggles the inspector rather than only opening it.
6. Close with the X on the tab, or middle-click the tab.

### Clicking the address bar after using the page

This works, and it takes a Rust command to make it work — worth knowing because
it is the feature's sharpest edge. A child webview is a sibling *native* view,
so once you click a page it holds the OS keyboard focus and every keystroke goes
there. Clicking anywhere in the address strip asks Rust to hand focus back
(`browser_focus_host`) before the click takes effect.

**There is no keyboard route back.** A shortcut can't rescue the address bar,
because while the page holds focus the app never receives the keystroke that
would trigger it. The pointer is the only channel, and that is why there is no
`Mod+L`.

The tab label is the page's own title once it reports one, falling back to the
host until then.

## How it works

### Why Rust owns the webview

The JS `Webview` handle in `@tauri-apps/api` can position, size, show, hide and
close a webview. That is the entire surface. There is no `loadUrl`, no history,
and no page-load or title callback.

A frontend-owned tab can therefore only "navigate" by closing the webview and
building a new one at the new URL — which destroys the page's process and every
session it held, on every Enter and every Reload — and it never learns where the
page went when you clicked a link, so the address bar only ever showed what you
typed.

`WebviewBuilder` on the Rust side has `navigate`, `reload`, `on_page_load`,
`on_document_title_changed` and `open_devtools`. Moving creation across the
boundary is what buys all of it. The cost is the `unstable` Cargo feature on
`tauri` (multiwebview is gated behind it), which is why `Cargo.toml` pins
`tauri = "=2.11.2"` exactly rather than with a caret — unstable APIs are allowed
to break across patch releases.

### Commands and events

| Command | Does |
|---|---|
| `browser_open` | `Window::add_child` a webview at a rect, register it in the store |
| `browser_navigate` | `Webview::navigate` — in place, session preserved |
| `browser_reload` / `browser_back` / `browser_forward` | Reload, or step the history cursor |
| `browser_show` / `browser_hide` | Position and reveal, or get out of the way |
| `browser_focus_host` | Hand the OS keyboard focus back to the app's own webview |
| `browser_set_zoom` | Scale the page, clamped to 0.25–5 |
| `browser_close` / `browser_close_orphans` | Teardown, and crash recovery on boot |
| `browser_toggle_devtools` | Platform inspector for the page, answering its own state |

Three events flow back, all carrying the tab id because every tab hears every
tab's events:

- `voidlink://browser-navigating` — `{ tabId, url }`, emitted when a page
  *starts* going somewhere. Without it the address bar named the page being left
  for the whole of every load, and nothing on screen said a load was happening.
  No traversal flags: the history hasn't folded the load in yet, and provisional
  flags would flicker the buttons against a stack that hasn't moved.
- `voidlink://browser-navigated` — `{ tabId, url, canGoBack, canGoForward }`,
  emitted when a page load finishes. The traversal flags ride along so the
  frontend never keeps a second copy of the history to derive them from.
- `voidlink://browser-title` — `{ tabId, title }`.

### History is ours, not the page's

Back and forward walk a `Vec<String>` with a cursor held per tab in Rust, and
navigate to entries. They do **not** call `history.back()` in the page, because
doing that would mean evaluating our script inside an untrusted remote document.
No script of VoidLink's ever enters a browser tab.

The stack behaves the way a browser's does: navigating after going back
truncates the forward entries rather than branching, and reloading the current
page doesn't grow it. A flag on the tab marks a traversal in flight, so the page
load that back/forward *causes* moves the cursor instead of pushing — without it
Back would append the page you just left and could never reach the start.

### The compositing constraint

A child webview paints above the entire DOM. There is no z-index that puts a
dialog, popover or context menu over it.

Everything that follows from that:

- The address bar and its buttons are drawn **outside** the webview's rectangle,
  in a strip above it. Anything drawn inside would be invisible.
- Every modal surface registers with `commands/overlay.ts`, and `BrowserPane`
  hides the webview while the count is above zero. Covering it does nothing;
  it has to actually be hidden.
- The rectangle is pushed on every reflow — a `ResizeObserver` on the anchor
  element catches pane and sidebar changes, and window `resize`/`scroll`
  listeners catch what the observer can't see.
- `hide()` is a no-op on some platforms, so the Rust side falls back to parking
  the webview at `-20000, -20000`.

### Lifecycle

The webview is created on mount and closed on cleanup, so switching worktrees
discards the page along with its pane. That is deliberate: a child webview with
no component owning it floats above the whole UI with no way to dismiss it,
which is a far worse failure than losing scroll position. `browser_close_orphans`
runs on boot and closes any `voidlink-browser-*` webview the store has no entry
for, which is what cleans up after a crash.

## What it doesn't do

- **No bookmarks, home page, or start page.** The address bar is the interface.
- **No downloads or print.**
- **No find-in-page**, and this is the one item here the engine genuinely cannot
  do: `wry` exposes no find, and the alternative is evaluating script inside the
  page — which this feature refuses on purpose (see *Security*).
- **No search fallback.** Input that isn't an address becomes `https://<what you
  typed>` and fails to parse; it doesn't go to a search engine.
- **No per-tab profiles or incognito.** Tabs share the app's cookie jar.
- **No persisted history.** The back/forward stack is in memory, capped at 200
  entries, and dies with the tab; only the current URL, title and zoom are
  persisted.
- **No load-failure state.** A DNS or TLS failure happens inside the page, after
  the navigate command has already returned, so the spinner keeps going and the
  old page stays on screen.
- **Back is a page stack, not a route stack.** A single-page app navigating via
  `pushState` fires no page load, so Back steps to the last full load rather
  than the previous SPA route.
- **No scroll position across worktree switches** — see Lifecycle above.
- **No command palette entry or keybinding.** The `+` tab menu is the only way
  to open one.

## Security

- The child webview holds **no capability**. `capabilities/default.json` is
  scoped by webview *label* (`"webviews": ["main"]`) rather than by window,
  precisely so a page the user loads cannot reach an app command — a
  window-scoped capability would hand every grant to whatever site is open.
- `disable_drag_drop_handler()` keeps a page from hijacking drops on the host
  window.
- No `eval` into the page, ever. That is why history is app-tracked.

## Where the code is

| Path | Role |
|---|---|
| `src-tauri/src/browser/mod.rs` | Webview lifecycle, history stack, commands, events |
| `frontend/src/api/webview.ts` | The only module that knows a tab is a webview |
| `frontend/src/components/browser/BrowserPane.tsx` | Address bar, anchor rect, visibility |
| `frontend/src/components/browser/url.ts` | `normalizeUrl`, `browserTabLabel` |
| `frontend/src/store/layout.ts` | `BrowserTab`, the tab actions, persistence |
| `frontend/src/commands/overlay.ts` | The open-modal count the pane hides on |

The 2026-07-31 audit —
[`docs/audits/2026-07-31-embedded-browser.md`](../audits/2026-07-31-embedded-browser.md)
— covers what shipped, the nine findings that were deliberately left open, and
the seams for wiring this into the workbench.
