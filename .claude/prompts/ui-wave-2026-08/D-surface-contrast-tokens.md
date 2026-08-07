# Stream D — Surface contrast: new per-region tokens

```text
<context>
VoidLink's shell is a set of floating islands on a recessed canvas (Direction D1,
`frontend/design-system/MASTER.md` §3 and §6). The geometry says "these are separate
panels"; the colour does not. Almost every island paints `--background` or `--sidebar`,
which sit within a few hundredths of lightness of each other, so the rail, the file
explorer, the editor, the terminal, the git panel and the status bar all read as one
grey field with gaps cut into it. The user cannot tell at a glance which region has
focus or which panel they are pointing at.

The fix is a proper per-region surface scale — tokens that say *which part of the app*
a surface is, derived from the existing elevation model rather than bolted beside it —
retuned for real contrast in the two default themes, with the eight named themes
deriving from it instead of being hand-authored ten times.

Two tests already guard this and must stay green: `canvasTokens.test.ts` (the canvas is
strictly darker than the islands, in all ten surface-defining blocks) and
`tokenHygiene.test.ts` (no raw colour literals under `src/components/**`).

This lands after the layout streams — it touches class names across many components and
would collide with anything moving those components around.
</context>

<task>
1. **Run the design pass first.** Invoke the `design-wizard` skill and route to
   `hallmark` for a contrast/hierarchy audit of the workbench. Feed it the current token
   table (`frontend/src/index.css` `:root` and `:root.light`), MASTER §3/§6, and
   screenshots of the workbench in default dark and default light. Output: a proposed
   token set with concrete oklch values and a stated contrast rationale per region.

2. **Add per-region surface tokens.** Extend the elevation scale in
   `frontend/src/index.css` with tokens that name the region rather than the widget —
   the rail, the sidebars, the editor/main surface, the terminal, the status bar, the
   tab strip — plus their foreground and border pairs where the region needs one.
   Derive them from `--background` / `--canvas` the way `--canvas` is itself derived
   (relative `color-mix`, not ten hand-authored constants), so a theme that defines a
   background gets a coherent set for free. Document the derivation where the tokens are
   defined; `canvasTokens.test.ts`'s header explains why relative derivation is the only
   thing that works for `github-light` (pure-white background, no room to recede by
   lightening) — the new tokens have the same constraint.

3. **Retune the two default themes** (`:root` and `:root.light` in `index.css`) so the
   regions are distinguishable at a glance without any island getting brighter than the
   text it carries — MASTER §6 says elevation is lightness, and forbids adding
   `shadow-md` to fake it.

4. **Make the eight named themes derive.** `frontend/src/themes.css` currently restates
   every variable per theme. Give each named theme the new surface tokens by derivation
   from the background it already declares, rather than hand-authoring 8 × N values.
   Where a theme's own identity demands a specific value, override just that one and say
   why in a comment.

5. **Sweep the components onto the new tokens.** Replace `bg-background` / `bg-sidebar`
   / `bg-card` uses that mean "this region" with the region's token. Leave uses that
   genuinely mean "a card on a surface" alone.

6. **Update MASTER.md §3** to document the new scale as the source of truth, and add the
   new invariant to `canvasTokens.test.ts`.
</task>

<reuse>
- `frontend/design-system/MASTER.md` — §3 Color tokens (Surfaces, "The canvas, and why it
  is derived", Elevation tiers, Text, Accents & status, Named themes), §6 Radius &
  elevation, §11 Anti-patterns, §12 File map. This is the document being amended, not
  a reference to work around.
- `frontend/src/index.css` — the `:root` block (`--background`, `--card`, `--popover`,
  `--muted`, `--accent`, `--border`, `--input`, `--ring`), the derived `--canvas`, the
  `--elev-0`…`--elev-3` tier, the `--sidebar*` family, `--island-gap`/`--island-inset`/
  `--island-radius`, and the `.island` / `.island-slot` rules.
- `frontend/src/themes.css` — the eight named themes and the header explaining why every
  block is qualified by its mode class (`:root.dark[data-theme="…"]`, 0-3-0 specificity).
  Do not weaken those selectors.
- `frontend/src/canvasTokens.test.ts` — `blockFor`, `oklchLightness`, and the list of ten
  surface-defining blocks. Extend this test; it is the mechanism that keeps D1 true.
- `frontend/src/tokenHygiene.test.ts` — the literal ban and its documented exemptions
  (the xterm ANSI palette is exempt on purpose; do not route it through semantic tokens).
- `frontend/src/store/theme.ts` — `THEMES`, `ThemeDef.preview` (the four preview colours
  per theme, which must still match what the theme paints).
- `frontend/src/components/settings/SettingsDialog.tsx` — `ThemePane` (~L462), which
  renders those previews.
- The components carrying the region backgrounds today: `components/layout/AppShell.tsx`,
  `WorkspaceRail.tsx`, `TerminalSidebar.tsx`, `StatusBar.tsx`, `TabStrip.tsx`,
  `MainSurface.tsx`, `components/git/GitSidebar.tsx`, `components/terminal/TerminalPane.tsx`.
</reuse>

<constraints>
- Semantic tokens, never raw values, in `src/components/**` — `tokenHygiene.test.ts`
  fails the build otherwise.
- Elevation is lightness. No `shadow-md`, no `backdrop-filter` added to a region surface
  (MASTER §6, §11; `index.css` already documents that `backdrop-filter` is unreliable
  under WebKitGTK and gates it accordingly).
- Derive, don't enumerate. A new token defined ten times by hand is the thing this stream
  exists to remove.
- Contrast is a requirement, not a preference: every foreground/surface pair must clear
  WCAG AA for its text size (MASTER §10). State the measured ratios for the new pairs.
- The eight named themes must still look like themselves. GitHub Dark must still read as
  GitHub Dark.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two
  readings mean materially different work. If a premise here looks wrong, say so in one
  sentence and continue as asked.
</constraints>

<assumptions>
- Scope of hand-tuning is the two default themes; the eight named themes get the new
  tokens by derivation, with per-theme overrides only where derivation visibly breaks the
  theme's identity.
- No new named themes, and no changes to the accent/status hues (`--destructive`,
  `--success`, `--warning`, `--info`, `--notify`) unless a contrast measurement forces it.
</assumptions>

<out_of_scope>
- Typography, spacing, radius or motion tokens.
- Any layout change — this stream changes what surfaces are painted, not where they are.
- The terminal's 16-slot ANSI palette (exempt by design; see `tokenHygiene.test.ts`).
- Monaco's editor theme mapping.
- Adding, removing or renaming a named theme.
- Transparency and background images — Stream E owns those, and it consumes these tokens.
</out_of_scope>

<acceptance>
- In default dark and default light, screenshot the workbench with rail + files sidebar +
  two split editor groups + terminal + git sidebar + status bar visible. Every region is
  distinguishable from its neighbours without relying on the gap alone.
- `canvasTokens.test.ts` extended with the new invariant and green across all ten
  surface-defining blocks — including `github-light`.
- `tokenHygiene.test.ts` green (no literal crept in during the sweep).
- The eight named themes render without a region collapsing into its neighbour; the
  `ThemePane` preview swatches still match what each theme paints.
- Measured contrast ratios for every new foreground/surface pair recorded in MASTER §3,
  all ≥ AA for their text size.
- `cd frontend && npm run test` green; `npx tsc --noEmit` clean.
</acceptance>
```
</content>
