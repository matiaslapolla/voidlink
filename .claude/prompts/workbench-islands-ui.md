<context>
VoidLink is a Tauri 2 + SolidJS desktop development workbench with a mature design
system (`frontend/design-system/MASTER.md`) and a shell built out across many waves.
The visual layer is coherent but conventional: every panel is separated from its
neighbour by a 1px hairline, every surface is flush to the window edge, and tabs are
segments of a strip. It reads as a competent VS Code, which is not the product's
identity ambition.

This slice replaces the visual layer with **Direction D1, "Recessed Canvas"** — every
panel becomes a detached island floating on a canvas that sits *below* them, and tabs
become contained cards rather than strip segments. Routes, components, state and copy
are untouched. The four candidate directions and the reasoning behind the choice are
in `docs/specs/2026-07-29-ui-directions.md`; read it before starting, and read D4 in
it before making any Wave 1 geometry decision, because D4 is the documented fallback
and Wave 1 is the only wave that would have to be redone if it is ever taken.

Two constraints govern every decision here, both from the design references and both
already consistent with what this codebase does:

1. **On dark surfaces, elevation is lightness — never shadow.** A `box-shadow` on a
   dark island renders as a coloured halo. The token ladder already runs
   `--background 0.200` → `--sidebar 0.213` → `--card 0.228` → `--popover 0.238`.
2. **Never nest a bordered container inside a bordered container.** Islands plus
   contained tabs is card-in-card by default. Spend the boundary budget once: in D1
   the island has no border and the tab card carries the only edge.

The load-bearing idea: **the canvas recedes, the islands do not rise.** Raising the
islands would lighten the terminal and diff bodies and cost contrast on the two
surfaces the user reads for eight hours. Dropping the canvas leaves every reading
surface at exactly the lightness it has today.
</context>

<task>
Land D1 across the whole shell, in five waves. Each wave typechecks, lints and passes
its tests before the next begins.

**Wave 0 — tokens and the design system (riskiest, do first; no geometry yet).**

Add to `frontend/src/index.css`, and document each in `MASTER.md`:

- `--canvas` — the recessed surface between islands. **Derive it, do not hardcode a
  pair.** Eight named themes in `themes.css` each redefine `--background` independently
  (`github-light` sets `oklch(1.000 0.000 0)`), so ten hand-tuned canvas values would
  be ten things to keep in sync. Use a relative derivation from `--background` such
  that the canvas is always *darker* than the islands in both light and dark mode.
  `color-mix()` in oklch is the obvious mechanism; verify support in the Tauri webview
  on macOS before committing to it, and fall back to per-theme values only if it fails.
- An **elevation ladder as lightness**, not shadow: `--elev-0` (canvas), `--elev-1`
  (island), `--elev-2` (raised — palette, popovers, menus), `--elev-3` (modal). Islands
  take today's `--background`; nothing above the canvas gets darker than it is now.
- A **named spacing scale** (`--space-3xs` … `--space-lg`, 4pt base) and the
  island geometry constants: `--island-gap: 6px`, `--island-inset: 8px`,
  `--island-radius: 10px` (= today's `--radius`), `--island-radius-inner: 6px`.
- A **named z-index scale** — base / raised / dropdown / sticky / modal / toast /
  tooltip. Grep for existing ad-hoc `z-` values and migrate them; do not leave two
  systems.

Update `MASTER.md` in the same wave: §3 gains the canvas and elevation tiers (and
`--card`'s "currently unused" note is retired), §5 gains the spacing scale beside the
existing density scale, §6 is rewritten — it currently says *"No elevation scale
exists. If more floating surfaces arrive, define `shadow-sm/md/lg` tokens before
adding them ad-hoc,"* and this wave is that moment. Record explicitly that the answer
on dark is lightness rather than shadow, so the next person does not add `shadow-md`.

**No component changes in this wave.** The tokens exist and nothing consumes them yet.

**Wave 1 — shell geometry. Islands.**

Make the shell draw islands: rail, main surface, both sidebars and the status bar
become detached rounded panels on the canvas, separated by `--island-gap` with
`--island-inset` at the window edge, no borders.

**Keep every geometry decision inside `AppShell.tsx`, `WindowFrame.tsx` and
`MainSurface.tsx`.** Panels must not each decide their own inset or radius — that is
what keeps the D4 fallback a one-wave rework instead of a four-wave one.

Specific consequences to handle rather than discover:

- **`Splitter.tsx` now sits in a gap, not on a seam.** Its hit area (≥8px per MASTER
  §7.6) must span the gap without widening it, and the existing
  `calc(50% - 4.5px)` basis arithmetic in the editor split must be re-derived against
  the new gap — there is one constant, and it lives with the token.
- **Monaco and xterm must be remapped to the island surface, not the canvas.**
  `components/editor/monacoTheme.ts` derives Monaco themes from these tokens and
  `components/terminal/TerminalPane.tsx` themes xterm from them. If either keeps
  reading `--background`, the editor body will render at canvas lightness and the
  contrast argument above is lost. This is the single most likely thing to be missed.
- **The embedded browser pane cannot have rounded corners.** `BrowserPane.tsx` is an
  OS-level child webview painting above the DOM; a CSS radius on its container will not
  clip it. Give it a square-cornered island, or inset the webview inside a rounded
  container so the radius is visible around it. State which you chose and why.
- **Virtualized lists must keep their row heights.** `@tanstack/solid-virtual` in the
  git changes pane estimates a fixed 24px row. Island padding goes on the island, never
  on the row.
- **Focus rings become the primary boundary channel** now that islands have no border.
  Per MASTER §7.6's no-layout-shift rule, the ring must be inset and cost no geometry.
  Check `--ring` still clears 3:1 against both the island and the canvas.
- **Zen and maximize are render filters over an untouched tree** (`store/focusMode.ts`)
  — they must stay that way. Zen removes islands from the layout; it does not restyle
  them.

**Wave 2 — contained tabs.**

`TabStrip.tsx` tabs become cards: `--island-radius-inner`, seated on the island
surface, separated by `--space-3xs`, with the card edge as the only border in the
composition (the island has none). The active tab keeps its existing `--primary` 2px
rule. Preserve exactly, without regression: the drag payload and insertion caret, the
reserved activity slot (§7.5.3 rule 3 — a mark's arrival costs no layout), the dirty
mark replacing the close affordance in one shared 16px slot, preview tabs' italic
label, and pinning.

Apply the same containment to the editor window's strip (`components/editor/`) so the
two windows do not drift.

**Wave 3 — the polish pass.**

Every remaining surface, brought onto the new tokens and given its full nine
interaction states (MASTER §7.6 — a control missing an applicable state is
unfinished). Work through this inventory; nothing on it is optional, and report
anything you deliberately leave unchanged with the reason:

- **Shell** — `TitleBar`, `ViewSwitcher`, `WorkspaceRail` rows, `TerminalSidebar`,
  `StatusBar` chips, `StatusLed`, `EmptyState`, `SnapshotManager`
- **Overlays** — `CommandPalette`, `QuickPick`, `FileFinder`, `TabSwitcher`,
  `WorktreeSwitcher`, `TabCycleOverlay`, `ToastViewport`, `ShortcutsCheatSheet`,
  `SecretScanDialog`, `PromptHost` (all move to `--elev-2`; the modal to `--elev-3`)
- **Git** — `GitSidebar` sections and rows, `GitDiffView`, `SplitDiffRenderer`,
  `ContextMenu`, `OperationBanner`, `StatusBadge`, `CommitGraph`,
  `compare/`, `conflict/`, `stack/`, `worktree/NewWorktreeWizard`
- **Editor** — `EditorGroupsView`, `EditorHost`, `Breadcrumbs`, `EditorStatusBar`,
  `EditorEmptyState`, `MonacoPanes`, `MergeEditor`, `DiffTabView`, `GoToSymbol`,
  `LspLogDialog`
- **Panels** — `AgentPanel`, `BrainSurface`, `FileTree`, `FindPanel`,
  `MarkdownPreview`, `SettingsDialog`

Two typographic debts MASTER already flags, cleared here: promote the `text-[9px]`
HEAD badge to `text-[10px]` (§4 calls 10px the floor), and extract the repeated
`text-[10px] uppercase tracking-wider font-semibold text-muted-foreground` pattern
into a `.ui-section-label` class (§4 says it is "worth extracting").

**Motion**: add nothing that MASTER §7.1's frequency gate would not pass. Island
geometry does not animate — splits, zen, maximize and tab activation are all
keyboard-initiated and therefore instant. The only motion this wave may add is hover
tint at `--dur-tint` and the press feedback already specified in §7.6. If you believe a
transition is justified, argue it against the frequency gate in the commit body rather
than adding it quietly.

**Wave 4 — validation.**

Run the matrix and record it: **8 named themes × light/dark × 3 density modes**, plus
`prefers-reduced-motion: reduce`, `prefers-reduced-transparency: reduce` and
`prefers-contrast: more` (MASTER §7.4). For each combination confirm the canvas is
visibly recessed from the islands and text contrast on the island surface still meets
the §10 targets. The three light themes are the risk: `github-light`'s `--background`
is `oklch(1.000 0.000 0)`, so its canvas derivation has the least headroom of any
theme. If a theme cannot satisfy the rule by derivation, give that one theme explicit
values and say which and why — do not weaken the rule for all ten.

Then the slop check: the result must not read as generic AI design or as imported
JetBrains chrome. MASTER §11.5 names importing another IDE's chrome as this project's
identity risk; the specific test is that nothing in the diff copies a JetBrains or VS
Code widget rather than restyling VoidLink's own.
</task>

<reuse>
- `frontend/design-system/MASTER.md` — the authority. §3 colour tokens, §4 type scale
  and the section-label pattern, §5 density, §6 radius and elevation (rewritten in
  Wave 0), §7.1 frequency gate, §7.2 motion tokens, §7.4 reduced motion, §7.5.3
  activity vocabulary and the no-layout-shift rule, §7.6 nine states, §9 component
  patterns, §10 a11y, §11.5 identity risk.
- `docs/specs/2026-07-29-ui-directions.md` — D1's values and D4's fallback cost.
- `frontend/src/index.css` — existing tokens: `--radius: 0.625rem`, the three easings,
  the five durations, the `data-density` scale (`--row-pad-y` / `--row-gap` /
  `--section-pad-y`) and the `.density-row` / `.density-section` / `.density-gap`
  classes. Extend; do not build a second density or motion system.
- `frontend/src/themes.css` — eight themes, each redefining the surface tokens. The
  canvas derivation must work for all eight without editing them.
- `frontend/src/components/layout/Splitter.tsx` — the one resizable-seam primitive.
- `frontend/src/components/layout/StatusLed.tsx` — the §7.5.3 signal primitive with
  `highestSignal` and the `pending` modifier. Restyle, do not replace.
- `frontend/src/components/layout/emptyStates.ts` + `emptyStates.test.ts` — the
  registry whose test asserts no two states share an icon or sentence. Keep it passing.
- `frontend/src/components/editor/monacoTheme.ts` + `monacoTheme.test.ts` — Monaco
  themes derived from these tokens. Remap to the island surface.
- `frontend/src/components/terminal/TerminalPane.tsx` — xterm theming. Same remap.
- `frontend/src/store/focusMode.ts` — zen and maximize as render filters over an
  untouched pane tree. Preserve that property.
- `frontend/src/components/layout/statusSegments.ts` — the priority + overflow model.
  Restyle the chips; do not touch the ordering logic.
- `lucide-solid` — the only icon set (MASTER §8). Do not mix in another.
</reuse>

<constraints>
- **Semantic tokens only.** No component may inline an `oklch(...)`, a hex, a raw px
  radius or a raw ms duration. Everything goes through a token named in `MASTER.md`.
  This is MASTER §2.4 and it is the rule most likely to erode in a pass this wide.
- **This is a visual-layer redesign.** No route, store, action, keybinding, persisted
  shape or user-visible string changes. If a component's structure must change to hold
  an island, change the structure — but not what it does or says.
- **No new dependency.** No animation library, no shadow utility, no icon set, no CSS
  framework beyond the Tailwind v4 already present.
- Pinned: `tailwindcss` ^4.2.1 with `@tailwindcss/vite`, `solid-js` ^1.9.7,
  `monaco-editor` ^0.55.1, `@xterm/xterm` ^6.0.0, `@tanstack/solid-virtual` ^3.13.32,
  TypeScript ~5.9.3 under `erasableSyntaxOnly`. Before using any Tailwind v4 theme
  directive, `color-mix()` behaviour, Monaco theming API or xterm theme field, query
  context7 (`resolve-library-id` → `query-docs`) — Tailwind v4's token model in
  particular changed substantially from v3.
- Verify with `npm run build` from `frontend/` (it runs `tsc -b`). Plain
  `npx tsc --noEmit` at the frontend root compiles nothing — the root tsconfig is
  `"files": []` plus project references, and that vacuous check has already hidden
  eleven real errors once in this repo.
- Accessibility is not a Wave 4 afterthought: every restyled control keeps its focus
  ring, its `aria-*`, and its ≥3:1 boundary contrast as it is restyled.
- Build exactly these five waves. Routine calls are yours; check in only where two
  readings would mean materially different work. If a premise here looks wrong, say so
  in one sentence and continue as asked rather than widening or narrowing scope.
</constraints>

<assumptions>
- The canvas derivation is relative (`color-mix()` or equivalent) rather than ten
  hardcoded values, so themes stay independently authorable. If the webview cannot do
  it, per-theme values are the documented fallback.
- Islands have no border; the tab card carries the only edge. If a surface genuinely
  needs both, that is a card-in-card violation and the island's edge is the one to drop.
- Density modes survive unchanged — island padding is separate from row padding, and
  compact density stays as tight inside an island as it is today.
- The window inset applies inside the existing frameless-window chrome; the OS window
  shape and the macOS rounded-corner work are untouched.
</assumptions>

<out_of_scope>
- Any behaviour, state, or logic change. This wave restyles; it does not refactor.
- The workbench layout-grouping work (named tab groups, layout presets, raising the
  4-group cap, auto-grouping) — a separate in-flight prompt. If it has landed, style
  its surfaces; if it has not, do not build them.
- The editor configuration work (settings schema, search, per-language overrides, JSON
  view) — a separate in-flight prompt. `SettingsDialog.tsx` is restyled here, not
  restructured.
- Anything from `docs/specs/2026-07-29-workbench-100x.md`: agent runs, worktree-level
  escalation, the PTY exit code, cutting the browser tab. Style what exists today.
- Adding a theme picker to Settings, or authoring a ninth theme.
- Changing `github-light`'s pure-white `--background`. It is deliberate theme fidelity.
- The UI typeface, the type scale, and the accent hue — fixed, per the directions spec.
- New animation of any kind beyond hover tint and press feedback.
- Icon replacement or resizing beyond MASTER §8's existing size rules.
- Direction D4. It is documented as the fallback; do not hedge toward it.
</out_of_scope>

<acceptance>
- `emptyStates.test.ts` and `monacoTheme.test.ts` pass — the latter is the guard that
  Monaco is still reading real tokens after the remap.
- A token test asserting the derivation holds for all ten surface-defining blocks (the
  two base roots plus eight themes): canvas lightness is strictly below island
  lightness in every one. This is the rule the whole direction rests on, and it is
  checkable without a DOM.
- `npm run build` and `npx eslint .` clean from `frontend/`; `npm test` green.
- A grep-based check in CI or in the summary: no `oklch(`, no hex, no `z-[0-9]`, and no
  raw `ms` value in any file under `frontend/src/components/`.
- The Wave 4 matrix recorded as a table in the commit body or in
  `docs/specs/2026-07-29-ui-directions.md`: 8 themes × light/dark × 3 densities, plus
  the three `prefers-*` paths, each marked pass or with the specific failure.
- Screenshots of at least the workbench, the git sidebar, the editor window, the
  command palette and one empty state, in dark default and in `github-light`.
- Launch the app and drive it: split a pane, drag a tab between groups, open the
  palette, enter zen, enter maximize, resize every splitter, open a browser tab to
  confirm the webview corner treatment. **State explicitly in the summary whether this
  was done** — several prior waves in this repo shipped verified statically only, and
  a visual redesign verified by typecheck is not verified.
</acceptance>
