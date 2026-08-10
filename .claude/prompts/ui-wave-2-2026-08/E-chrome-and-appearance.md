# Stream E — three things that look wrong

Branch: `fix/chrome-appearance`. Independent; merge late.

```text
<context>
Three appearance bugs from testing. They are unrelated to each other and to the
layout streams, and they share a branch only because they touch the same two
files (`index.css`, `store/settings.ts`) and nothing else does.

**1. The macOS traffic lights are still misaligned.** A previous wave set
`trafficLightPosition: { x: 12, y: 9 }` in `src-tauri/tauri.conf.json` against a
32px title bar (`h-8` in `TitleBar.tsx`). The value was computed, never seen
rendered, and the user reports it "did not work at all". Note also that
`src-tauri/src/window.rs`'s `open_satellite` sets `(12.0, 14.0)` for every
runtime-built window — so the workbench and its satellites disagree by 5px, and
at most one of them can be right.

**2. The editor theme sometimes inverts against the UI.** `monacoTheme.ts`
defines exactly two Monaco themes, `voidlink-dark` and `voidlink-light`, read
from live CSS custom properties so all ten app themes work with no code change.
`monacoThemeName(mode)` picks by `ThemeMode`. Something in that chain reports
the wrong mode in some situations — the suspects are the pre-paint script in
`frontend/index.html` (which duplicates the light-theme list because it runs
before any module), the satellite windows (separate JS contexts that hydrate
once at module eval and are *reused*, not recreated), and the three named light
themes that are not the string "light": `light`, `github-light`,
`solarized-light`.

**3. The background image and transparency do nothing.** This one is diagnosed.
`frontend/src/index.css` paints the image on `#root`, and
`components/layout/AppShell.tsx`'s root element carries `bg-canvas` — an opaque
element filling the viewport directly on top of it. The image is behind it and
has never been visible. The same reason makes the opacity slider look inert:
the island surfaces do mix toward transparent, but what they reveal is the
opaque canvas layer, whose colour is a near neighbour of theirs. Compounding it,
`--color-canvas` is absent from the `html[data-bg-image]` mix list, so even
without the AppShell element the canvas would stay solid.
</context>

<task>
1. Align the macOS window buttons in every window, workbench and satellites
   alike, and make the two sources of truth agree. Measure it — take an actual
   screenshot of a running window and read the pixels. Do not ship a computed
   value; that is what produced the current one.

2. Find why the Monaco theme inverts, fix that cause, and make the inversion
   impossible to reintroduce: one function owns "is this theme light or dark",
   and `frontend/index.html`'s duplicated `LIGHT_THEMES` list is checked against
   it by a test rather than by a comment asking the next person to remember.

3. Make the background image and the opacity slider actually visible:
   - the canvas layer must not sit opaque over the image when one is set;
   - add `--color-canvas` to the `html[data-bg-image]` mix and to the
     `prefers-reduced-transparency: reduce` reset beside it;
   - re-check the contrast claim in that CSS block's comment against whatever
     the layering becomes, and correct the comment if the numbers move.
</task>

<reuse>
- `src-tauri/tauri.conf.json` — the `main` window's `titleBarStyle: "Overlay"`,
  `hiddenTitle: true`, `trafficLightPosition`.
- `src-tauri/src/window.rs` — `open_satellite`'s macOS branch, which duplicates
  that chrome by hand for runtime-built windows and says so in a comment. Both
  places must end up with the same number, and the comment should say how they
  are kept in step.
- `frontend/src/components/layout/TitleBar.tsx` — `h-8`, and the macOS left
  padding `pl-[78px]` whose comment claims the lights end at 66px. If the
  position moves, that number moves.
- `frontend/src/components/editor/monacoTheme.ts` — `VOIDLINK_DARK`,
  `VOIDLINK_LIGHT`, `monacoThemeName`, `THEME_TOKEN_NAMES`, `readCssTokens`,
  and its header comment on the Monaco-drift risk (MASTER.md §11.5). Everything
  below `readCssTokens` is pure and node-testable; keep it that way.
- `frontend/src/store/theme.ts` — the theme table, `ThemeMode`, `applyTheme`,
  `bridgeThemeAcrossWindows`. This is where "one function owns light-vs-dark"
  belongs.
- `frontend/index.html` — the pre-paint script and its `LIGHT_THEMES` array, and
  the comment explaining why it cannot import.
- `frontend/src/index.css` — the `@theme inline` `--color-*` aliases (~line
  359), `#root`'s `background-color: var(--canvas)` (~line 410), and the whole
  "Background image + island translucency" block (~lines 755–875) including its
  scrim rationale and its measured contrast figures.
- `frontend/src/store/settings.ts` — the effect that writes `--ui-bg-image`,
  `--ui-surface-opacity` and `data-bg-fit` (~line 710), its `Image()` probe for
  a path that no longer resolves, and `bridgeUiVisualAcrossWindows`.
- `frontend/src/components/layout/AppShell.tsx` — the `bg-canvas` root and its
  stated rule that island-inset geometry lives in one place.
- `frontend/src/canvasTokens.test.ts` — the invariant that the canvas is
  strictly darker than the island surfaces across all ten themes. Do not weaken
  it to make the background work.
- `frontend/src/components/editor/monacoTheme.test.ts` — extend, don't replace.
</reuse>

<constraints>
- Query context7 for Tauri v2 (Rust `=2.11.2`, JS `@tauri-apps/api ^2.10.1`) on
  `trafficLightPosition` before changing it: when it is applied, whether it
  survives fullscreen exit and window re-key on macOS, and whether it can be set
  after window creation. There is a real chance the config value is applied once
  and then re-laid-out by AppKit, in which case the fix is not a different
  number. Your training data on this lags; do not guess.
- Query context7 for `monaco-editor` (`^0.55.1`) on `defineTheme` / `setTheme`
  semantics before changing when themes are redefined.
- Do not weaken the AA contrast guarantee. The fixed 92% scrim exists because
  the worst case without it measures 1.3:1. If your change alters what sits
  between the image and the islands, recompute the worst case
  (`oklch → oklab → linear sRGB`, composited as CSS actually will) and put the
  new figures in the comment. If it drops below 4.5:1, the change is wrong.
- `prefers-reduced-transparency: reduce` must still produce a fully opaque UI
  with no image, not a softened version of the effect.
- No raw colour literals in `src/components/**` (`tokenHygiene.test.ts`).
- Solid, not React.
- Build exactly this stream. Do not touch the sidebars, the pane tree, the tab
  strip, the board, or window lifecycle.
</constraints>

<assumptions>
- The traffic-light fix may require a title-bar height change. If 32px cannot
  hold the OS buttons at a natural position, changing `h-8` is in scope and
  preferable to a bar that only looks right at one number.
- "Some situations" for the Monaco inversion includes at least: the editor
  window opened before a theme change, and the three named light themes. If you
  cannot reproduce it, fix the two structural hazards anyway (the duplicated
  light list, and satellite theme hydration) and say what you could not
  reproduce.
- The scrim stays fixed and non-adjustable. It is not a second slider.
</assumptions>

<out_of_scope>
- Native macOS window transparency / `NSVisualEffectView` — there is a decision
  doc at `docs/decisions/native-window-transparency.md` and this stream stays on
  the CSS layer.
- New surface colour tokens or contrast retuning beyond adding `--color-canvas`
  to the existing mix.
- Windows/Linux window chrome (they draw their own buttons in `TitleBar.tsx`).
- The asset-protocol scope in `tauri.conf.json` (`"allow": ["**/*"]`) — a
  separate open decision.
- Monaco syntax-token colours; only the light/dark selection is in scope.
</out_of_scope>

<acceptance>
- Screenshot evidence, in the PR body or a comment, of the traffic lights in a
  running workbench window and a running satellite window, vertically centred in
  the title bar. This is the acceptance criterion the previous attempt lacked.
- The window can be dragged from immediately right of the lights; nothing
  overlaps them.
- `tauri.conf.json` and `window.rs` carry the same position, with a comment
  naming the other.
- Setting a background image makes it visible behind the islands in all four
  window roots. Moving the opacity slider from end to end changes the visible
  result across its whole range.
- Deleting or moving the image file and reloading falls back to the themed
  background silently — the existing `Image()` probe; keep its test.
- macOS → Accessibility → Reduce transparency: fully opaque, no image.
- `canvasTokens.test.ts` still passes unmodified.
- A unit test that `frontend/index.html`'s `LIGHT_THEMES` list equals the
  `mode: "light"` entries in `store/theme.ts`. It should fail if either drifts.
- A unit test that every one of the ten themes resolves to the Monaco theme
  matching its mode.
- `cargo check` clean; `npm run test`, `npx vitest run --project browser`,
  `npx tsc --noEmit`, `npx eslint .` clean; `npm run build` succeeds.
</acceptance>
```
