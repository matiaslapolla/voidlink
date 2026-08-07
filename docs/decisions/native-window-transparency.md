# Native window transparency — why this stream didn't reach for it

Stream E (screencast privacy + backgrounds, 2026-08) needed the app shell to
show a user-picked image behind translucent islands. It shipped that as a
CSS layer only — `#root`'s own background paints the image, and the island
surfaces (`--color-background`, `--color-sidebar`, `--color-card`,
`--color-popover`, `--color-elev-*`) mix toward transparent over it via
`color-mix()`, all driven from `store/settings.ts` and `index.css`. The
native window itself stays exactly what it is today: opaque, undecorated
per-platform per `tauri.conf.json`, no `transparent: true`.

This is the research this stream also owed: what the native path would have
looked like, what it costs, and a reversible way to try it later if the CSS
layer turns out not to be convincing enough. **Nothing below is implemented.**

## What Tauri v2 offers on macOS

Three related but separable knobs, all in `tauri.conf.json`'s
`app.windows[]` entry (or the equivalent `WebviewWindowBuilder` calls in
`src-tauri/src/window.rs` for the two satellite windows, which are built at
runtime rather than from static config):

- **`transparent: true`** — makes the window's own backing layer see-through.
  On its own this paints whatever is behind the OS window (the desktop, other
  apps), not a blur — you get a hole, not a material.
- **`windowEffects`** — a config block (`effects`, `state`, `radius`,
  `color`) that asks the OS to composite a real material behind the window.
  On macOS this is `NSVisualEffectView` under the hood, exposed through the
  `window-vibrancy` crate that `tauri` already depends on transitively (it's
  in `Cargo.lock` today, pulled in by the `tauri` crate itself — adding no
  new dependency to enable). The effect list includes `titlebar`, `sidebar`,
  `hudWindow`, `menu`, `popover`, `sheet`, `windowBackground`, and several
  more named after the AppKit material they map to. This is the piece that
  would actually produce macOS's frosted-glass look, not just a hole.
- **`titleBarStyle`** — already in use today (`"Overlay"`, set in both
  `tauri.conf.json`'s `main` entry and `window.rs`'s satellite builder for
  macOS). A **`Transparent`** variant exists too, for a window whose title
  bar background disappears entirely rather than just overlaying the
  content — a different, more aggressive look than what's shipped.

`windowEffects` requires `transparent: true` on the same window per Tauri's
own docs. The two are not independent — you cannot get the material without
also opening the transparency hole underneath it.

## What it costs on Windows and under WebKitGTK

- **Windows.** `windowEffects` supports `mica` and `tabbed` on Windows 11
  only, and `blur`/`acrylic` on Windows 10 and 11 — but Tauri's own
  reference notes these "may experience performance issues during window
  resizing or dragging." `Webview::setBackgroundColor`'s transparency and
  alpha handling is separately documented as having "platform-specific
  limitations on Windows." voidlink doesn't ship Windows today (macOS-only
  scope per `index.css`'s own materials note, quoted below), but a
  transparency decision made now is exactly the kind of thing that gets
  re-litigated expensively once a Windows build exists — better to know the
  shape of the cost up front than to discover it mid-port.
- **Linux (WebKitGTK).** Tauri's `windowEffects` reference states these
  effects are **unsupported on Linux** outright — there's no fallback
  material, only the transparency hole with nothing composited into it. On
  top of that, GTK's WebKitGTK is materially slower at real-time compositing
  than WKWebView (macOS) or WebView2 (Windows); voidlink already has direct
  evidence of this at the CSS level, not just the window level (next
  section).

## What `index.css` already documents about `backdrop-filter`

This app already ships CSS-level translucency (the `.material-chrome` /
`.material-structural` classes — palette, popovers, the command menu — via
`backdrop-filter: blur() saturate()`), and the file has carried a standing
note about it since that shipped:

> Deferred platform constraint: `backdrop-filter` under WebKitGTK is
> materially more expensive than under WKWebView. macOS-only scope means this
> does not gate the work, but when Linux lands, expect to gate materials
> per-platform rather than tune them down globally.

Two things follow from this for the native-window question specifically.
First, the same constraint applies one level up: if `backdrop-filter` inside
a WKWebView-hosted page is already the expensive case Linux will need gating
for, native `windowEffects` — a *heavier* compositor-level operation running
per-frame on every window, not just the surfaces that opt in — is not going
to be cheaper. Second, the note's own resolution ("macOS-only scope means
this does not gate the work") is the same reasoning this doc leans on: ship
the thing that works well on the one platform in scope, and treat the other
two as a gate to add later rather than a reason not to ship at all.

## What would have to change to build the native path

1. **`tauri.conf.json`** — add `"transparent": true` to the `main` window
   entry, and a `windowEffects` block (`effects: ["hudWindow"]` or similar,
   plus `state` and `radius`) on the same entry. CSP is currently `null`
   (disabled) so no CSP change is needed here, unlike the asset-protocol
   change this stream *did* make (which required `img-src`-equivalent scope
   config, not CSP, since CSP stays off).
2. **`src-tauri/src/window.rs`** — the two satellite windows (`git`,
   `editor`) are built at runtime via `WebviewWindowBuilder`, not from
   static config, and the file already carries a comment that their chrome
   is "kept in sync with the `main` entry in tauri.conf.json by hand." A
   `transparent()` + vibrancy call would need to be added to the
   `#[cfg(target_os = "macos")]` branch there (lines ~96–101) to keep the
   promise that comment makes — a transparent main window with two opaque
   satellites would read as a bug, not a design.
3. **The `.island` rules in `index.css`** — with `windowEffects` doing the
   material, the CSS-layer scrim and the `color-mix()` opacity mix this
   stream shipped would need to either be dropped in favour of the native
   material, or carefully layered *under* it (native material behind, CSS
   islands on top, same as today) rather than fighting it — two blurred,
   translucent layers stacked is exactly the "never stack one translucent
   surface on another" rule `index.css`'s own Materials section already
   states, because legibility collapses when text reads through both.
4. **`AppShell.tsx`** — the "geometry lives in one place" island-inset rule
   this file documents would gain a second concern (is the material native
   or CSS, and does that change per platform), which is exactly the kind of
   per-platform branching the WebKitGTK note above says to expect *later*,
   not now.

## Known regressions to watch for

- **Click-through and hit-testing.** A transparent region can stop receiving
  pointer events on some platform/compositor combinations unless explicitly
  configured otherwise — a translucent island that silently stops being
  clickable is a worse bug than an opaque one that never had the problem.
- **Screenshot/screen-recording tools that flatten transparency to black.**
  Directly relevant to this stream's other feature (screencast privacy):
  some capture pipelines composite a transparent window against black rather
  than the desktop, which would make a "translucent" window recording look
  broken rather than stylish — worth checking explicitly given this app's
  own screencasting use case.
- **Resize/drag performance**, per Tauri's own Windows note above, and per
  the WebKitGTK cost `index.css` already flags for Linux.
- **`titleBarStyle: Transparent` interacting with `hiddenTitle: true`** and
  the custom traffic-light positioning voidlink already sets — both are
  macOS-only knobs already in play (`tauri.conf.json`'s `main` entry,
  `window.rs`'s satellite builder) and a title-bar-transparency change is
  exactly the kind of edit likely to shift the traffic-light position or the
  overlay's hit area without an obvious cause.
- **Vibrancy tinting the app's own colour tokens.** The Materials section's
  "colour stays on a solid layer" rule exists because a translucent surface
  picks up whatever is behind it — a native material sitting behind every
  themed surface, across eight named themes, is a much bigger version of the
  same risk this app already designs around at the CSS layer.

## A concrete experiment, with a rollback

If the CSS-layer approach this stream shipped doesn't hold up (report:
"it never actually looks translucent, it looks smudged" or similar), the
smallest experiment that would answer the question without committing the
app to it:

1. Behind a **build-time flag**, not a settings toggle — this is a platform
   experiment, not a user preference — set `transparent: true` and
   `windowEffects: { effects: ["hudWindow"], radius: 10 }` on the `main`
   window entry only (not the satellites, to keep the blast radius small).
2. Temporarily disable the CSS scrim + `color-mix()` opacity mix
   (`html[data-bg-image]` block in `index.css`) so the native material is
   what's actually being judged, not a hybrid of both.
3. Run it on macOS only, for a few days of real use — resize the window,
   drag it, switch spaces, and specifically try a screen recording of it
   (§"Known regressions" above).
4. **Rollback is a one-line revert**: the build flag defaults off, so
   deleting it (or reverting the two config edits) returns the window to
   exactly what `tauri.conf.json` and `window.rs` already say today — no
   migration, no persisted state to undo, because nothing about this
   experiment would be stored in `UiSettings` or any other persisted key.

If it holds up, the follow-on work is sections 1–4 above, done for real:
config, `window.rs`'s satellite parity, the `.island` layering decision, and
the `AppShell.tsx` per-platform branch — plus retesting every one of the
"known regressions" against the actual shipped themes, not the one material
tried in the experiment.
