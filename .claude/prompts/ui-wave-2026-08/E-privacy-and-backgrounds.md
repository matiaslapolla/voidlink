# Stream E — Screencast privacy + translucency and background image

```text
<context>
Two asks that share one mechanism — a settings-driven visual layer over the shell.

1. **Screencast privacy.** Recording a demo means showing the workspace rail, which
   means showing client names, branch names and paths. Today the only options are
   "rename everything" or "don't show the rail". A per-workspace eye toggle that blurs
   that row's label and its worktree labels in place lets a recording show real,
   working software without leaking who it belongs to.

2. **Translucency + background image.** A gradable transparency setting plus a
   user-chosen background image, applied across the whole app. Implemented as a CSS
   layer only: the image is painted behind the app shell and the island surfaces become
   translucent over it via `color-mix`. The native window stays opaque — no
   `transparent: true`, no vibrancy, no `tauri.conf.json` window change. That decision
   is deliberate and reversible; see the research doc this stream also produces.

This stream consumes Stream D's surface tokens, so it lands after D.
</context>

<task>
1. **Per-workspace privacy blur.**
   - Add an eye / eye-off icon button to each workspace row in the rail. Toggling it
     blurs that workspace's name and every worktree label and path under it — a real
     CSS `filter: blur(...)`, applied in place, no layout shift (MASTER §7.6's
     no-layout-shift rule).
   - Persist the blurred workspace ids in `UiPrefs` as an array, in the same shape and
     for the same reason as `collapsedWorkspaces` (a `Set` stringifies to `{}`).
   - The button states which way it goes in its `title` and `aria-label`, and the blurred
     text is `aria-hidden` with an accessible substitute — a screen reader must not read
     out what the screen is hiding.
   - Add a registered action ("Blur active workspace") so it is reachable from the
     palette, following the `commands/registry.ts` idiom.

2. **Transparency + background image settings.**
   - Extend `UiSettings` in `frontend/src/store/settings.ts` with: a background image
     source (a path the user picks from their device), a surface-opacity value (a graded
     slider, not a boolean), and a background fit/position mode with a sensible default.
   - Pick the file with `@tauri-apps/plugin-dialog` (already a dependency) and load it
     through the Tauri asset protocol / `convertFileSrc` — not a `file://` URL, and not
     by reading it into a data URI.
   - Paint the image on the app's root background layer, below the islands, once — the
     same "geometry lives in one place" rule `AppShell.tsx` states for the island inset.
   - Apply opacity by mixing the region surface tokens toward transparency
     (`color-mix(in oklab, var(--surface-x) N%, transparent)`), so all eight named themes
     and both defaults get it without per-theme work. Do not hand-edit component classes
     to add `/50` opacity suffixes.
   - Render the controls in `SettingsDialog`'s UI pane (or Theme pane, whichever the
     existing section split makes right), using the shared row components in
     `components/settings/rows.tsx`.
   - Guard readability: at high transparency, text over a busy photo becomes unreadable.
     Ship a scrim (a token-driven translucent layer between the image and the islands)
     that keeps foreground/surface contrast at AA regardless of the image, and state how
     you verified it.

3. **Write the native-transparency research doc.** Save
   `docs/decisions/native-window-transparency.md` covering: what Tauri v2 offers on
   macOS (`transparent`, `NSVisualEffectMaterial` / vibrancy, `titleBarStyle`) and what
   it costs on Windows and under WebKitGTK; what `index.css` already documents about
   `backdrop-filter` being unreliable there; what specifically would have to change
   (`tauri.conf.json`, window creation in `src-tauri/src/window.rs`, the `.island` rules);
   the known regressions to watch for; and a concrete "try it if the CSS layer isn't
   convincing" experiment with a rollback. Doc only — do not implement any of it.
</task>

<reuse>
- `frontend/src/components/layout/WorkspaceRail.tsx` — the workspace row, its hover-
  revealed close button (the exact opacity/focus-visible idiom the eye button must
  match), `toggleCollapsed`/`toggleWorkspaceCollapsed`, `menuItems` for the context menu,
  and the `tooltip` directive import pattern (`void tooltip` — Solid erases an otherwise
  unused `use:` symbol).
- `frontend/src/store/layout/prefs.ts` — `UiPrefs`, `DEFAULT_PREFS`, `collapsedWorkspaces`
  (the array-not-Set precedent and the comment explaining it), the partial-blob parse.
- `frontend/src/store/layout/index.ts` — `toggleWorkspaceCollapsed` and its persistence
  path; add the privacy toggle beside it.
- `frontend/src/commands/registry.ts`, `frontend/src/commands/keymap.ts` — action
  registration so button and palette are one code path.
- `frontend/src/store/settings.ts` — `UiSettings` (~L198), `DEFAULTS.ui` (~L406),
  `updateUi` (~L644), `mergeDefaults`, and the effect that applies settings to `<html>`
  (`data-density`, text size, ~L620-635). The background/opacity settings apply the same
  way: to the root element, once.
- `frontend/src/components/settings/SettingsDialog.tsx` — `UiPane` (~L321), `ThemePane`
  (~L462), and the tab list (~L203-235).
- `frontend/src/components/settings/rows.tsx` — the existing row/control components.
  Do not write new slider or file-picker chrome if a row already exists.
- `frontend/src/index.css` — the `.island` rules, the derived `--canvas`, the
  `backdrop-filter` block (~L669-705) and its documented WebKitGTK caveat, the
  `prefers-reduced-transparency` / reduced-motion handling already there.
- Stream D's new per-region surface tokens — mix those, not `--background` directly.
- `docs/features/` and `docs/audits/` for the house style of a repo doc.
</reuse>

<constraints>
- CSS layer only. No `transparent: true`, no vibrancy, no window-decoration change in
  `src-tauri/tauri.conf.json` or `src-tauri/src/window.rs`. The native path is a written
  proposal in this stream, nothing more.
- Query context7 before writing any `@tauri-apps/plugin-dialog`, asset-protocol or
  `convertFileSrc` code (`resolve-library-id` → `query-docs`, Tauri v2). Do not write
  these from memory.
- Semantic tokens only in `src/components/**` — `tokenHygiene.test.ts` enforces it. The
  opacity mix belongs in `index.css` against a token, not as literals in component
  classes.
- Respect `prefers-reduced-transparency` and `prefers-reduced-motion`: a user who has
  asked for less should get the opaque surfaces regardless of the slider.
- Accessibility: blurred text must not be readable by a screen reader, and must not
  change the row's height or the rail's layout when toggled.
- Separation of concerns — settings state in `store/settings.ts`, the visual layer in
  `index.css` + the shell root, the controls in `components/settings/`. No component
  reads the image path directly to paint its own background.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two
  readings mean materially different work. If a premise here looks wrong, say so in one
  sentence and continue as asked.
</constraints>

<assumptions>
- Privacy blur is per workspace and covers that workspace's own labels and its worktree
  rows only. It does not redact repo paths in the title bar, the status bar or the file
  tree — that would be an app-wide screencast mode, which the user explicitly scoped out
  of this slice.
- One background image for the whole app, shared by all windows (workbench, editor, git)
  via the existing theme broadcast channel in `api/windows.ts`.
- The image path is stored, not a copy of the file; a path that no longer resolves falls
  back to the plain themed background without an error dialog.
</assumptions>

<out_of_scope>
- App-wide screencast redaction (title bar, status bar, file tree, terminal contents).
- Placeholder/fake-name substitution instead of blur.
- Per-workspace or per-theme background images.
- Video or animated backgrounds.
- Implementing native window transparency or vibrancy — the doc only.
- Any layout, docking or token change (Streams C and D own those).
</out_of_scope>

<acceptance>
- Toggling the eye on a workspace blurs its name and all its worktree labels, with no
  height change to any row and no reflow of the rail; the state survives a reload.
- The blurred labels are unreadable in a 1080p screen recording, and a screen reader
  reads the accessible substitute rather than the hidden text.
- The palette action toggles the same state as the button (one code path, asserted in a
  test).
- Picking an image from the device paints it behind the shell in all three windows; the
  opacity slider visibly grades island translucency across the range; both survive a
  reload; an unresolvable path falls back silently to the themed background.
- With the slider at maximum transparency over a high-contrast photo, foreground text
  still measures ≥ AA against its surface thanks to the scrim. Record the measurement.
- `prefers-reduced-transparency: reduce` yields opaque surfaces regardless of the slider.
- Unit tests: prefs round-trip for the blurred-workspace array (absent key defaults,
  unknown ids dropped); settings parse for the new `ui` keys (absent → default,
  out-of-range opacity → clamped).
- `docs/decisions/native-window-transparency.md` exists and covers all six points listed
  in the task.
- `cd frontend && npm run test` green; `npx tsc --noEmit` clean;
  `cd src-tauri && cargo check` clean.
</acceptance>
```
</content>
