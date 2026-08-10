# VoidLink Design System — Master

Source of truth for all UI in the VoidLink Tauri desktop app. Read this before building or refactoring any component. Page-specific overrides live in `design-system/pages/*.md` — they take precedence when present.

## 1. Product context

- **Type**: Desktop developer tool (Tauri + SolidJS webview, frameless window). Three OS windows — workbench, editor, git — over one store.
- **Density**: Information-dense IDE chrome. Pixel budget matters; padding and type should be tight but never below touch/readability floors.
- **Platform**: Keyboard-first. Mouse is secondary. No touch.
- **Audience**: Developers. They expect keyboard shortcuts, reversible actions, and JetBrains/VSCode-class polish.

### Scope

VoidLink is becoming an **AI Agent OS for engineers**: a workbench where agents
are peers in the pane tree rather than a chat box bolted to the side, and where
what everyone — human and agent — did is recorded and legible.

This section used to read *"Three features — workspace tabs, terminal sidebar,
git panel. No feature work outside this scope."* That stopped being true a while
before it was corrected: the agent panel, the embedded browser, the brain vault
and the event log all shipped against a document that said they were out of
scope, which meant every one of them was designed with the rules bent rather
than applied. **A scope statement the codebase contradicts does not restrain
anything — it only teaches people to skip §1.**

The surfaces this system governs, all of them equally:

| Surface | What it is |
|---|---|
| Workspace, worktree, pane and tab chrome | The four containers and everything that arranges them |
| Terminal | PTY panes and the terminal sidebar |
| Git | Status, staging, branches, graph, compare, conflicts, worktrees, stacks |
| Editor and diff | Monaco hosting, diff and merge views, blame, markdown preview |
| Agent | The thread tab, the slide-over, the roster |
| Event log | The timeline over what happened — commits, agent turns, commands |
| Mission Control | The cross-workspace lineup, check-ins, hill charts, fan-out runs and triggers. The one surface deliberately **not** scoped to the active worktree |
| Brain vault | The `brain-kb` reader |
| Embedded browser | Browser tabs as child webviews |
| Settings, palette, overlays | Configuration and the command surfaces |

**The rule that replaces the old one.** Scope is not a fixed list of features —
it is a constraint on how any new surface earns its place:

1. It renders inside the island system (§6) as a peer of the surfaces above, or
   it states in its own doc why it cannot.
2. It obeys §7.5 liveness and §7.6 interaction states. A new surface is where
   these are most often quietly skipped.
3. It adds no new visual vocabulary — no new elevation, no new radius, no new
   z-layer — without adding the token here first.

A surface that cannot meet those three does not need a scope exemption; it needs
a design.

## 2. Design principles

1. **Chrome should disappear.** The user is here for the terminal and the diff, not the UI. Every pixel of padding and every animation must justify itself.
2. **Keyboard is the primary input.** Every mouse action must have a keyboard path. No hover-only affordances on destructive or navigational controls.
3. **Reversible by default.** Destructive ops (close workspace, kill terminal, discard changes, force push) need confirmation or undo. Cheap ops (stage/unstage) don't.
4. **Semantic tokens, never raw hex.** All colors go through CSS variables defined in `index.css` / `themes.css`. Components should not inline `oklch(...)` or hex.
5. **One primary action per surface.** The git panel has one primary CTA (Commit). The settings dialog has one (Done). Don't compete.
6. **Alive means truthful, not animated.** A tool feels alive when it always tells you the real current state of your repo, your buffers and your background work — not when it moves. In a surface the user looks at for eight hours, motion is a cost. Liveness is bought with §7.5 (presence, freshness, acknowledgement), and it is *spent* by §7 (motion). Reach for §7.5 first.
7. **Proactive means the app speaks first.** If VoidLink knows something the user would want to know — a background command finished, a fetch found you 12 commits behind, a file changed under an open buffer, a language server died — it surfaces it without being asked, at the lowest interruption level that will actually be seen (§7.5). Silence about known state is a bug.

## 3. Color tokens

Defined in `src/index.css` (dark = `:root`, light = `:root.light`) and overridden by named themes in `src/themes.css` via `[data-theme="..."]`. Never hardcode colors in components — use Tailwind's semantic utilities backed by these vars.

### Surfaces

| Token | Tailwind | Purpose |
|---|---|---|
| `--canvas` | `bg-canvas` | **The recessed surface islands float on.** The window body, the shell inset, the gaps between panes. Never a reading surface. |
| `--background` | `bg-background` | The **editor/main surface**: editor body, terminal pane box, diff body, pane group |
| `--sidebar` | `bg-sidebar` | The **docked panels** — `TerminalSidebar`, `GitSidebar`, and other side panels (`FindPanel`, `FilesPanel`, `AgentDashboard`, `BrowserPane`'s toolbar). Nothing else reads this token — see the region surfaces below for what used to share it. |
| `--surface-rail` | `bg-surface-rail` | The workspace rail (`WorkspaceRail.tsx`) |
| `--surface-tabstrip` | `bg-surface-tabstrip` | The tab strip band atop a pane group (`TabStrip.tsx`) |
| `--surface-statusbar` | `bg-surface-statusbar` | The status bar (`StatusBar.tsx`) |
| `--card` | `bg-card` | Inner elevated blocks. Still unclaimed; `--popover` covers today's floating surfaces. |
| `--popover` | `bg-popover` | Overlay body — palette, menus, popovers. Aliased as `--elev-2`. |
| `--muted` | `bg-muted` | Input backgrounds, hunk headers |
| `--accent` | `bg-accent` | Hover/active row highlight — use with /40–/70 alpha |

### The canvas, and why it is derived

Direction D1 makes every panel a
detached island on a canvas that sits **below** it. The load-bearing sentence
is *"the canvas recedes, the islands do not rise"*: raising the islands would
lighten the terminal and diff bodies and cost contrast on the two surfaces the
user reads for eight hours, so `--background` is exactly the value it always
was and only `--canvas` is new.

`--canvas` is **derived, never hand-authored per theme**:

```css
:root       { --canvas: color-mix(in oklab, var(--background) 85%, black); }
:root.light { --canvas: color-mix(in oklab, var(--background) 96%, black); }
```

Eight named themes redefine `--background` independently, so ten hardcoded
canvas/island pairs would be ten things to keep in sync. Two mix ratios instead
of one because the available headroom differs by mode: a 15% mix at `L ≈ 0.14`
is a much smaller absolute step than at `L = 1.0`.

**Darkening, not lightening, is the rule** — and `github-light` is why.
Its `--background` is `oklch(1.000 0.000 0)`: pure white, with nowhere to go
up. Every theme can go down. `src/canvasTokens.test.ts` asserts the invariant
for all ten surface-defining blocks (the two base roots plus the eight themes)
without needing a DOM. Adding a ninth theme fails that test until it is listed.

### Region surfaces, and why they are derived too

Before this scale existed, `--sidebar` meant four different things — the
rail, both docked panels, and the tab strip — so those four regions, plus the
status bar (which also just borrowed `--sidebar`), all painted the exact same
lightness. Geometrically five separate regions; visually one grey field with
only `--island-gap` cutting into it.

`--surface-rail`, `--surface-tabstrip` and `--surface-statusbar` give the
rail, the tab strip and the status bar back an identity `--sidebar` never
should have lent them. `--sidebar` itself is unchanged and now means only the
docked panels (`TerminalSidebar`, `GitSidebar`, `FindPanel`, `FilesPanel`,
`AgentDashboard`, `BrowserPane`'s toolbar); `--background` is unchanged and
still means the editor/main surface.

Same derivation mechanism as `--canvas` — one `color-mix()` per mode in
`index.css`, never restated in `themes.css`:

```css
:root       {
  --surface-statusbar: color-mix(in oklab, var(--background) 90%,   black);
  --surface-rail:      color-mix(in oklab, var(--background) 95%,   black);
  --surface-tabstrip:  color-mix(in oklab, var(--background) 95%,   black);
}
:root.light {
  --surface-statusbar: color-mix(in oklab, var(--background) 97.5%, black);
  --surface-rail:      color-mix(in oklab, var(--background) 99%,   black);
  --surface-tabstrip:  color-mix(in oklab, var(--background) 99%,   black);
}
```

Because these reference `var(--background)` and are declared only once, at
`:root`/`:root.light`, every named theme inherits a coherent, ordered set the
moment it redefines `--background` — the same `var()` cascade indirection
`--canvas` relies on, extended by `src/canvasTokens.test.ts`'s new invariant
(`keeps every region strictly between canvas and island`) to all ten
surface-defining blocks.

**Measured, default dark** (`--background` L = 0.200, `--canvas` L = 0.170):

| Token | L | vs `--canvas` | vs `--background` | `--muted-foreground` contrast | `--foreground` contrast |
|---|---|---|---|---|---|
| `--surface-statusbar` | 0.180 | +0.010 | −0.020 | 5.59:1 | 16.25:1 |
| `--surface-rail` | 0.190 | +0.020 | −0.010 | 5.49:1 | 15.96:1 |
| `--surface-tabstrip` | 0.190 | +0.020 | −0.010 | 5.49:1 | 15.96:1 |

**Measured, default light** (`--background` L = 0.980, `--canvas` L = 0.9408):

| Token | L | vs `--canvas` | vs `--background` | `--muted-foreground` contrast | `--foreground` contrast |
|---|---|---|---|---|---|
| `--surface-statusbar` | 0.9555 | +0.0147 | −0.0245 | 6.73:1 | 17.14:1 |
| `--surface-rail` | 0.9702 | +0.0294 | −0.0098 | 7.13:1 | 18.16:1 |
| `--surface-tabstrip` | 0.9702 | +0.0294 | −0.0098 | 7.13:1 | 18.16:1 |

All six pairs clear WCAG AA for both the 12px status-bar/tab-strip text
(4.5:1) and the 13px rail text (also held to 4.5:1 here, though 3:1 would
suffice at that size) by a wide margin — every one is at least 5.4:1. Ratios
computed from the actual oklch → linear-sRGB conversion (Björn Ottosson's
OKLab matrices), not lightness alone, since `--foreground` and
`--muted-foreground` carry nonzero chroma.

**Light mode's known limitation.** `--canvas` only recedes 4% of lightness in
light mode (vs. dark mode's 15%), and that 4% band is where a theme's
independently hand-tuned `--sidebar` often already sits (default light
`--sidebar` is 2% below `--background`; `github-light`'s is 3% below). The
new region tokens' light-mode ratios (97.5% / 99%) are chosen to guarantee
the ordering `canvas < statusbar < rail/tabstrip < background` holds for
every theme — that part is a structural invariant, checked by
`canvasTokens.test.ts`. What is **not** guaranteed is clearance from each
theme's own `--sidebar` value: in `github-light`, `--surface-statusbar`
(L=0.975) sits 0.005 above that theme's `--sidebar` (L=0.970) — distinct,
but the closest gap in the whole scale. This is a judgment call made under
the format's real headroom limit, not an oversight; visually confirm the
light themes rather than trusting the numbers alone (see the unverified note
in the stream's report).

### Elevation tiers

Elevation is **lightness**, not shadow — see §6.

| Token | Value | Used by |
|---|---|---|
| `--elev-0` | `var(--canvas)` | the recessed surface between islands |
| `--elev-1` | `var(--background)` | an island — unchanged from before islands existed |
| `--elev-2` | `var(--popover)` | palette, popovers, menus, toasts |
| `--elev-3` | `--popover` mixed 6% toward white | modals only |

`--elev-1` is the name Monaco reads (`components/editor/monacoTheme.ts`) for
`editor.background`, `editorGutter.background` and `peekViewEditor.background`.
That is a contract with a test: an editor painted at `--canvas` reads as a hole
punched in the shell instead of a panel floating on it, and it is the single
most likely thing to be broken by a future token rename. `TerminalPane.tsx`'s
xterm palette is literal and therefore structurally immune; if it is ever
derived, it must read `--elev-1` too.

### Text

| Token | Tailwind | Purpose |
|---|---|---|
| `--foreground` | `text-foreground` | Primary body text |
| `--muted-foreground` | `text-muted-foreground` | Labels, secondary text, icons at rest |
| `--primary-foreground` | `text-primary-foreground` | Text on primary-colored surfaces |

### Accents & status

| Token | Tailwind | Use for |
|---|---|---|
| `--primary` | `bg-primary` / `text-primary` | Commit button, active tab underline, HEAD branch, toggled segment |
| `--destructive` | `text-destructive` | Errors, deletions in diff, close-window button, ↓behind branches |
| `--success` | `text-success` | Additions in diff, staged group header, ↑ahead, healthy LED |
| `--warning` | `text-warning` | Renames, "• changes" marker, busy LED |
| `--info` | `text-info` | Modified files, diff tab icon |
| `--border` | `border-border` | All separators, input borders |
| `--ring` | `ring-ring` | Focus rings |

**Status-on-tinted-bg rule**: for diff/inline-highlight patterns where foreground text sits on a 10% tinted background of the same hue (e.g. `bg-success/10 text-success`), validate contrast — the default oklch lightness pair is borderline. Prefer `text-foreground` on a darker tint bg when rows need to meet 4.5:1.

### Named themes

Eight named themes live in `src/themes.css`: `github-dark`, `github-light`, `monokai`, `solarized-dark`, `solarized-light`, `nord`, `dracula`, `one-dark`. Applied via `data-theme` on `<html>`. Tokens are identical across themes — the theme only changes the values.

**Gap**: the theme store exports these but SettingsDialog has no picker UI yet. Adding a theme picker is the correct way to surface them.

## 4. Typography

- **Family (UI)**: `Geist Variable` (loaded via `@fontsource-variable/geist`). Tailwind `font-sans` resolves to it.
- **Family (terminal/diff)**: user-configurable monospace stack (default includes `JetBrainsMono Nerd Font`).
- **Font features**: `kern`, `liga`, `calt` enabled globally in `index.css`. Terminal ligatures are opt-in via settings (perf).

### Type scale

**Named, and machine-checked.** There used to be six spellings for five sizes —
`text-[11px]` ×218, `text-[10px]` ×125, `text-xs` ×100, `text-[12px]` ×76,
`text-[13px]` ×52, `text-sm` ×17 — and no name to pick correctly from, which is
why the count kept growing. The scale is now six names defined once in
`index.css`:

| Utility | Size | Use |
|---|---|---|
| `text-micro` | 10px | Section headers, cwd subtext, diff line numbers, badges. **Floor** — anything smaller is too small |
| `text-label` | 11px | Commit button, git tab labels, branch rows, history rows — minor actions |
| `text-body` | 12px | Tab labels, file rows, terminal row title, diff header, commit textarea — default interactive text |
| `text-ui` | 13px | Section headers in the git sidebar, menu rows, dialog titles |
| `text-title` | 14px | The step above chrome |
| `text-heading` | 20px | One site: the document title in `brain/BrainSurface.tsx` |
| ~~`text-[9px]`~~ | — | **Retired.** The only surviving 9px is `.dev-chrome-badge` in `index.css`, literal by design so a `make dev` window can never be mistaken for the installed bundle. Do not reintroduce it. |

**How they scale.** Each is `calc(Npx * var(--text-scale))`, and
`store/settings.ts` writes `--text-scale` onto `<html>` beside `font-size` from
the `ui.textSize` setting (`sm` 14 / `base` 16 / `xl` 18, so 0.875 / 1 / 1.125).
The authored number is the size that surface already had at the default
setting, and the whole scale moves together when the preference changes —
which is what that setting always claimed to do and, before the scale was
named, did for only about a fifth of the app's text.

**Rule**: stop adding sizes. Two tests in `src/tokenHygiene.test.ts` fail the
build on `text-[Npx]` and on Tailwind's own `text-xs`/`text-sm`/`text-lg`
scale under `src/components/`, so a seventh step has to be argued for in this
table before it can be used.

### Section label pattern (recurring)

**Extracted.** `.ui-section-label` in `index.css` is the one definition:

```css
.ui-section-label {
  font-size: 11px;
  letter-spacing: 0.01em;
  font-weight: 600;
  color: var(--muted-foreground);
}
```

Used in TerminalSidebar (Terminals, Diffs), GitSidebar (Staged, Changes) and
SettingsDialog. Note it is **sentence case, not caps**: weight and colour carry
the hierarchy, and the generous tracking that made all-caps legible is dialled
back to near-neutral because sentence case does not need it. Do not re-inline
the old `text-[10px] uppercase tracking-wider font-semibold` string.

## 5. Spacing & density

`index.css` exposes a density scale driven by `data-density` on `<html>` (compact / normal / comfortable). Components opt in via:

- `.density-row` — applies `--row-pad-y` to top/bottom padding
- `.density-section` — applies `--section-pad-y`
- `.density-gap > * + *` — applies `--row-gap` between children

**Values (normal)**: row-pad-y `0.375rem`, row-gap `0.25rem`, section-pad-y `0.5rem`.

**Rule**: any new row-style component that should respond to the density setting must use these classes. Don't hardcode `py-1.5` for a density-sensitive row.

Horizontal padding stays rem-based (Tailwind `px-2 / px-2.5 / px-3`) and scales naturally with textSize.

### The named spacing scale

Orthogonal to density, and added with the islands. Density governs the **row**
rhythm *inside* an island and scales with the user's preference; this scale
names the fixed boxes chrome is built out of, on a 4pt base:

| Token | px | Typical use |
|---|---|---|
| `--space-3xs` | 2 | gap between tab cards |
| `--space-2xs` | 4 | icon-to-label, chip inner gap |
| `--space-xs` | 6 | tight row padding |
| `--space-sm` | 8 | standard control padding |
| `--space-md` | 12 | panel padding |
| `--space-lg` | 16 | dialog padding |

**Rule**: these do not replace Tailwind's `p-*` / `gap-*` scale for ordinary
work. Reach for a name when the value is *shared geometry* — something a second
component has to agree with — rather than local padding.

### Island geometry

Four constants, and they live in exactly one place:

| Token | Value |
|---|---|
| `--island-gap` | `6px` — between two islands, and the width of the channel a splitter sits in |
| `--island-inset` | `8px` — from the window edge |
| `--island-radius` | `var(--radius)` (10px) — an island's outer corner |
| `--island-radius-inner` | `6px` — a tab card, or anything seated *on* an island |

**Only `AppShell.tsx`, `MainSurface.tsx` and the `.island` class in `index.css`
may compose these into layout.** A panel that decides its own inset or radius
is the regression to watch for: the held alternative (D4, "floating chrome" —
content is the canvas and the chrome floats above it, full-bleed underneath) is
one wave of rework only for as long as the geometry lives in the shell. Scatter
it into every panel and there is no one wave. Everything else about D1 —
the token ladder, the contained tabs, the polish pass — is
direction-independent and carries over unchanged.

JavaScript reads `--island-gap` in exactly one function, `islandGapPx()` in
`Splitter.tsx`, because the pane-split ratio arithmetic has to subtract the
gaps. Do not add a second reader and do not retype the number.

## 6. Radius & elevation

### Radius

- `--radius: 0.625rem` (10px) is the lg base; Tailwind reads `--radius-sm/md/lg/xl` (60% / 80% / 100% / 140% of base).
- **Component usage**:
  - Islands → `--island-radius` via the `.island` class, never a per-panel value
  - Tab cards, and anything seated *on* an island → `--island-radius-inner` (6px)
  - Inputs, buttons, rows → `rounded-md` (8px)
  - Dialog → `rounded-md`
  - Toggle pills → `rounded-full`
  - Close icon buttons → `rounded` (4px) — smaller to match icon size

### Elevation is lightness. Do not add `shadow-md`.

This section used to say *"No elevation scale exists. If more floating
surfaces arrive, define `shadow-sm/md/lg` tokens before adding them ad-hoc."*
Islands are that moment, and the answer is **not** a shadow scale.

On a dark surface a `box-shadow` renders as a coloured halo. VoidLink is dark
by default and six of its eight named themes are dark, so a shadow ladder
would be an anti-pattern in six themes to buy separation in two. The token
ladder already runs by lightness (`--canvas` → `--background` → `--sidebar` →
`--popover`), so the elevation scale is that ladder, named: `--elev-0/1/2/3`
in §3.

**The next person's shortcut is to add `shadow-md` to something. Don't.** If a
surface needs to separate from what is under it, move it up the lightness
ladder.

Three exceptions, and they are the whole list:

1. **Modals and other scrimmed overlays** keep `shadow-xl` — one level, not
   two. They sit over a `bg-black/40`–`/60` scrim which is itself doing most
   of the separating; a heavier second tier (`shadow-2xl`) was decoration and
   has been removed.
2. **Unscrimmed portalled surfaces** — context menus, the tab overflow
   popover, tooltips, toasts — keep `shadow-lg`. They float over arbitrary
   live content with no scrim, and on a light theme lightness alone does not
   separate them.
3. **Islands take no shadow, ever.** That is the direction, not a preference.

- **Glow effect** (used for the LED): `shadow-[0_0_6px_theme(colors.success)]`. Used once; don't generalize until reused.

### z-index

One scale, named in `index.css`. The numbers are exactly the ones the app was
already using, so naming them changed no stacking order anywhere.

| Token | Value | Surface |
|---|---|---|
| — | `z-0/10/20/30` | in-island stacking: base / raised / sticky / dropdown. Tailwind's own scale; leave as is. |
| `--z-panel` | 50 | edge slide-overs — the agent panel. Above the workbench, below the window frame: it is chrome the user opened, not an overlay that blocks them. |
| `--z-frame` | 60 | native window-resize strips |
| `--z-modal` | 70 | settings, snapshot manager |
| `--z-overlay` | 80 | palette, quick pick, cheat sheet, pickers |
| `--z-cycle` | 85 | held-modifier tab cycle |
| `--z-dialog` | 90 | secret scan and other blocking dialogs |
| `--z-toast` | 100 | toast viewport |
| `--z-prompt` | 110 | text prompt — a modal raised over a modal |
| `--z-wizard` | 9998 | the worktree wizard, below the menus it opens |
| `--z-menu` | 9999 | portalled menus, context menus, tooltips |
| `--z-drag` | 10000 | the drag ghost, above everything it explains |

**Rule**: no new `z-[<number>]`. `src/tokenHygiene.test.ts` fails the build on
one. If a surface genuinely needs a new layer, add a name here first.

## 7. Motion

Motion in VoidLink is rationed, not decorative. The governing question is never "would this look nice moving?" but **"how many times per session will the user see it?"** — because an animation the user triggers 200 times a day is a 200×-per-day tax on their perceived speed.

### 7.1 The frequency gate (apply before writing any transition)

| How often the user sees it | Budget | Examples |
|---|---|---|
| **Keyboard-initiated, any frequency** | **0ms. No animation. Ever.** | Command palette open/close, `Cmd+P`, tab next/prev, jump-to-tab-N, MRU cycle, pane focus, stage/unstage, save |
| **> 50× per session** | 0–60ms, colour/tint only | Row hover, tab hover, focus ring, sidebar row selection |
| **5–50× per session** | 120–180ms | Context menu, tooltip, popover, sidebar collapse, toast enter, badge appear |
| **< 5× per session** | up to 240ms | Modal, first paint of a new pane, split creation, zen enter/exit |

**240ms is a hard ceiling.** Anything longer needs a written reason in the component. A keyboard-driven surface that animates is a bug, not a flourish — the user's hand has already moved on.

### 7.2 Tokens

Define in `index.css`; never inline a `cubic-bezier` or a raw ms value in a component.

```css
:root {
  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);   /* entering  — decelerate into place */
  --ease-in:     cubic-bezier(0.7, 0, 0.84, 0);   /* leaving   — accelerate away */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);  /* toggles   — there and back */

  --dur-instant: 0ms;    /* keyboard-initiated — see 7.1 */
  --dur-tint:   60ms;    /* hover/active colour shift (today's .transition-colors) */
  --dur-micro: 120ms;    /* press feedback, toggle, badge in/out */
  --dur-short: 180ms;    /* popover, tooltip, menu, sidebar collapse */
  --dur-long:  240ms;    /* modal, pane split, zen — the ceiling */
}
```

The forced `!important` durations in `index.css` stay as the floor for the
`transition-colors` sites that have not migrated. **A surface leaves the floor
by naming its own token**, and the floor's selectors are
`:not([data-motion])` — so migrating one surface is one attribute rather than an
edit to a block two hundred sites still depend on. `grep -c data-motion` against
`grep -c transition-colors` is how much of this section is real.

Exits also have names: `--dur-short-out` (135ms) and `--dur-long-out` (180ms)
are the 75% below, so "75% of 180" is never written as a literal at a call
site.

**Exits run at ~75% of their enter** (`--ease-in`). A menu that closes as slowly as it opens feels stuck.

### 7.3 Rules

1. **Never `transition: all`.** Name the properties. (`transition-all` exists at 9 sites — do not add a tenth.)
2. **Animate `transform` and `opacity` only.** Never `width`, `height`, `top`, `left`, `margin`, `padding`. Expanding regions animate `grid-template-rows: 0fr → 1fr`.
3. **Focus rings appear instantly.** Never transition a focus ring's opacity, transform or width. Keyboard users need the indicator on the same frame.
4. **No bounce, overshoot or elastic easing on chrome.** Reserve overshoot for pointer-driven physical interactions only. The splitter drag qualifies and takes none; tab drag-reorder will qualify when it moves off HTML5 DnD (MOTION-PLAN Phase 3), and is the only place in the app that will be permitted any.
5. **No uniform hover-scale.** `hover:scale-*` across unrelated elements is the single loudest generic-UI tell. Hover is a tint shift.
6. **One hover effect per element.** Not translate + scale + shadow + colour.
7. **Never animate from `scale(0)`.** Popovers and menus enter at `scale(0.97)` + `opacity: 0`, from their trigger's `transform-origin` — not from centre. Modals are the exception: they keep `transform-origin: center`.
8. **Transitions, not keyframes, for anything retriggerable.** Toasts, badges and tab states can fire in rapid succession; keyframes restart from zero, transitions retarget from the current value.
9. **Keyframes are reserved for functional loops** — `animate-spin` on an in-flight refresh, `animate-pulse` on a genuinely indeterminate region. Both must stop when the work stops. A spinner that spins when nothing is loading is a lie about state (§7.5).
10. **Pointer-driven motion tracks 1:1 and is interruptible.** Splitter drags, tab drag-reorder and any future sheet follow the pointer every frame with `setPointerCapture`, respect the grab offset, and can be reversed mid-motion. Never run a fixed-duration animation for something the user is holding.
11. **Enter and exit along the same path.** A panel that slides in from the right dismisses to the right.
12. **Tooltip delays are asymmetric.** Hover delays 600–800ms so a pointer crossing the toolbar doesn't fire ten tooltips; **keyboard focus shows it at 0ms** — a keyboard user asked for it explicitly. Once one tooltip is open, adjacent ones open instantly with no delay and no transition until the group is left. Equal hover and focus delays are a tell.

### 7.4 Reduced motion

`index.css` already zeroes transition and animation durations under `prefers-reduced-motion: reduce`. Two additions for new work:

- **Functional loops keep running** — spinners and indeterminate shimmers still animate (slower is fine); they carry state, not decoration. Exempt them from the global zeroing explicitly rather than losing the state signal.
- **Presence signals must not depend on motion.** An LED that only reads as "running" because it pulses is invisible under reduced motion. Every pulsing signal also differs in colour or fill (§7.5).

`prefers-contrast: more` is **handled**, and islands are why. D1 separates
panels by lightness alone, which is precisely the channel a user asking for
more contrast is telling us they cannot rely on — so under that query
`index.css` gives `.island` a 1px `--border` **outline** (negative offset, so
it costs no geometry per §7.6) and the edge comes back.

`prefers-reduced-transparency: reduce` is **handled**, and materials are why.
`index.css` defines two weights — `.material-chrome` for small floating chrome
(menus, tooltips, portal popovers) and `.material-structural` for the large
scrimmed panels and the modal — and under that query both go to full opacity
with the blur dropped entirely. Not softened: a legibility request answered
with a half-measure is still a background the user has told us they cannot read
through.

Three material rules, in `index.css` beside the definitions: never stack one
translucent surface on another, bigger surfaces read as thicker (more blur, the
deeper shadow), and colour stays on a solid layer — a tint on the translucent
foreground picks up whatever is behind it and stops meaning anything.

The title bar takes no material. Under D1 it sits on the canvas with nothing
behind it, so a blur there costs a compositor pass and shows nothing.

## 7.5 Liveness & presence

This is where VoidLink earns "alive". Motion (§7) is the smallest part of it; this section is the rest.

### 7.5.1 The four channels

| Channel | Contract |
|---|---|
| **Acknowledgement** | Every user action produces a visible response within **80ms** — the perceptual threshold below which cause and effect read as simultaneous. The response may be the result, an optimistic state, or the control entering its pending state. Never nothing. |
| **Truth** | Every value derived from disk or git declares its freshness (§7.5.4). A stale number rendered as if it were live is the primary "dead UI" failure in a git client. |
| **Attention** | Work happening where the user isn't looking reports itself where the user *is* looking, escalating until it's visible (§7.5.3). |
| **Anticipation** | Surfaces show what's next or what's possible before being asked: ahead/behind counts, dirty markers, conflict warnings before a merge, the destructive-scope warning before a write. |

### 7.5.2 Progress taxonomy

Choose by expected duration. Do not use a global indicator for a local operation.

| Expected | Treatment |
|---|---|
| **< 80ms** | Nothing. Render the result. |
| **80–400ms** | The invoking control's own pending state: icon slot swaps to a spinner, label unchanged, control stays focusable. No global indicator, no toast, no layout shift. |
| **400ms – 3s** | Determinate bar when total is knowable; otherwise `animate-pulse` on the affected region only. The region stays readable — never blank it. Never block the rest of the shell. |
| **> 3s, or backgroundable** | Hand it to the status bar and/or a tab badge, release the UI immediately, and report completion through §7.5.3. Blocking the shell on a long git operation is forbidden. |

Every control that can enter a pending state **reserves its icon slot at rest**, so the spinner's arrival causes no reflow.

### 7.5.3 Activity vocabulary

A closed set. Do not invent a new dot.

| Signal | Mark | Token | Clears when |
|---|---|---|---|
| Dirty / unsaved | Filled dot, replaces the close affordance | `--warning` | Saved |
| Running | LED, pulsing | `--warning` | Process exits |
| Finished while you were away | LED, solid | `--success` | Tab receives focus |
| Failed | LED, solid | `--destructive` | Explicitly acknowledged — never on focus alone |
| Bell / attention requested | LED, solid | `--info` | Tab receives focus |
| Stale | Ghosted value (60% opacity) + refresh affordance | `--muted-foreground` | Refreshed |

Rules:

1. **Activity is never invisible.** A signal on a tab in a hidden group escalates to the group header; a signal in a hidden group escalates to the status bar. A user must never have to open a pane to discover something happened in it.
2. **Precedence when a tab carries several signals**: failed > running > bell > finished > dirty. Show one mark, the highest.
3. **Badges never move layout.** The mark occupies a slot reserved at rest.
4. **Colour is never the only channel.** Each signal differs in fill *and* motion *and* position, so it survives reduced motion, colourblindness, and the eight themes.
5. Reuse the existing LED glyph and its `shadow-[0_0_6px_...]` glow (§6) rather than introducing a second status shape. If it generalises past two uses, promote it to a `<StatusLed>` primitive.

### 7.5.4 Freshness contract

Every git-derived or disk-derived value renders in exactly one of three states, and the state is visible:

- **Live** — backed by a watcher or refreshed on the event that changes it. Renders normally.
- **Refreshing** — `animate-pulse` on the value itself, not on its container. Old value stays visible underneath; never flash to a skeleton or a dash.
- **Stale** — 60% opacity plus a refresh affordance, with the reason available on hover (`Last read 4m ago`).

A component that cannot say which of the three it is has a bug, not a styling gap.

### 7.5.5 Interruption levels

Pick the lowest level that will actually be seen.

| Level | Surface | Use for |
|---|---|---|
| **Ambient** | Badge, LED, status-bar segment | Anything the user did not just ask for. Never steals focus. |
| **Transient** | Toast, 5–8s, with an Undo or Retry affordance where one exists | Failures, and effects the user cannot see from where they are |
| **Blocking** | Modal | Destructive *and* irreversible only (force push, discard, delete workspace), or credential entry |

- **Silent success is the default.** If the user can see the effect, do not toast it. A toast for a completed stage-file is noise; a toast for a background fetch that found 12 new commits is the point.
- **Undo beats confirm** for anything reversible: do the thing, toast with Undo. Reserve confirmation for the genuinely irreversible, and make it type the name of what's being destroyed.

### 7.5.6 Optimistic updates

Permitted for reversible, local, fast operations: stage/unstage, pin tab, reorder tab, rename, toggle a setting, collapse a section.

Forbidden for network operations and history rewriting: push, force push, fetch, pull, rebase, discard, reset, branch delete. These show a pending state and wait for the real result.

On failure of an optimistic update: revert the visual state, then a transient toast naming what failed and offering Retry. Never leave the optimistic state standing.

## 7.6 Interaction states

Every interactive element has **nine** states here — the standard eight plus *pending*, which an IDE needs constantly and which VoidLink currently has no vocabulary for. A control missing any applicable state is unfinished.

| State | Treatment |
|---|---|
| Default | Base styling |
| Hover | Tint shift only, `--dur-tint`. Gate behind `@media (hover: hover)`. |
| Focus | `focus-visible:ring-2 ring-ring`, instant, ≥3:1 against both element and surface |
| Active / pressed | Immediate, no easing. Chrome buttons deepen the tint; the primary CTA may use `scale(0.98)`. |
| **Pending** | Icon slot swaps to `animate-spin`; label unchanged; control stays focusable and stays in the tab order. Never disable as a way of saying "busy". |
| Disabled | `opacity-40` **and** `cursor-not-allowed` **and** `aria-disabled` — three channels. Plus a `title` explaining *why*. A disabled control with no stated reason is an anti-pattern. |
| Error | `--destructive` border, message text, `aria-invalid`. Never colour alone. |
| Success | Quiet. Value settles; no celebration for an ordinary operation. |
| Empty | See §9.7 |

### The no-layout-shift rule

**`border-width` is constant across every state.** Default, hover, focus, error, disabled — always the same. State changes go to `background-color`, `outline` or `border-color`. Inputs reserve `outline: 2px solid transparent` at rest so the focus ring costs no geometry.

Also constant across states: `padding`, `height`, and the icon slot's width. Any state change that reflows is a bug the eye catches even when the user can't name it.

### Applies to

Chrome button (§9.1), row (§9.2), segmented toggle (§9.3), pill toggle (§9.4), primary CTA (§9.5), every text input, and any new splitter, drop target or tab. The splitter additionally needs a hover-widened hit area (≥8px, visual width unchanged), a keyboard resize step, and double-click-to-reset.

## 8. Iconography

- **Library**: `lucide-solid`. Use only Lucide icons — don't mix icon sets.
- **Sizes**:
  - `w-3 h-3` (12px) — inside small buttons, status icons
  - `w-3.5 h-3.5` (14px) — default for chrome buttons (titlebar, tabs, git tabs)
  - `w-4 h-4` (16px) — emphasis (collapsed rail branch icon)
  - `w-5 h-5` / `w-6 h-6` — empty states only
- **No emoji as icons.** Ever.
- **Stroke**: use Lucide defaults; don't set custom strokeWidth.

## 9. Component patterns

### 9.1 Chrome button (titlebar, git tab toggles, row close)

Icon-only, subtle hover, must have `title` *and* an accessible label.

```tsx
<button
  onClick={...}
  aria-label="Close terminal"
  title="Close terminal"
  class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring"
>
  <X class="w-3.5 h-3.5" />
</button>
```

**Rule**: every icon-only button needs `aria-label`. `title` alone is not accessible.

### 9.2 Row (terminal, file, history, diff-tab)

Clickable row with optional trailing action. **Use `<button>` when the row is primarily a selection action**, not `<div role="button">` or bare `<div onClick>`. The current codebase uses divs — migrate on touch.

Trailing destructive action (close/kill) must stay visible at reduced contrast, not `opacity-0`. Keyboard users cannot reach `opacity-0` controls.

### 9.3 Segmented toggle (diff mode, text size, density, cursor style)

Two or three options, active state = tinted primary.

```
bg-primary/15 border-primary/40 text-primary   // active
border-border text-muted-foreground            // inactive
```

### 9.4 Pill toggle (settings On/Off)

Full-radius pill, same color semantics as segmented.

### 9.5 Primary CTA

One per surface. Commit button, dialog Done button.

```
bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40
```

### 9.6 Modal

`z-[70]`, centered, `bg-black/50` scrim. Currently missing: focus trap, escape-to-close, `role="dialog" aria-modal="true" aria-labelledby`, initial focus. These are required — add them before the next new modal ships.

### 9.7 Empty state

Centered icon + short message. See `TerminalSurface.tsx` / `TerminalSidebar.tsx`. Use distinct icons per reason (no repo vs. nothing open) so users can tell them apart.

## 10. Accessibility rules (non-negotiable)

1. **Every icon-only button has `aria-label`.** Audit: titlebar, tab close, terminal row close, diff close, git refresh/collapse, file row action.
2. **Every clickable `<div>` becomes a `<button>`** (or gets `role="button"`, `tabIndex={0}`, and keyboard handlers). Specifically: WorkspaceTabBar tab, TerminalSidebar rows, GitSidebar FileRow and HistoryPane rows.
3. **Focus-visible ring on all interactive elements.** Currently only inputs/textareas have `focus:ring-1`. Add `focus-visible:ring-2 focus-visible:ring-ring` to the chrome-button base.
4. **Hover-only actions are forbidden for keyboard-reachable controls.** Replace `opacity-0 group-hover:opacity-100` with `opacity-60 group-hover:opacity-100`, or move the action into a context menu.
5. **Modals**: focus trap + escape + `role="dialog"` + `aria-labelledby` pointing to the title.
6. **Text inputs need `<label htmlFor>`**, not placeholder-only. This includes the commit textarea and the workspace rename input.
7. **Destructive confirmations**: close workspace, kill terminal (if busy), discard changes, force push. Quick stage/unstage is safe — no confirm.
8. **Color-plus-icon**: diff rows already have `+`/`-` gutter chars — keep them at ≥70% opacity so colorblind users don't rely on red/green alone.
9. **`prefers-reduced-motion`**: gate any animation longer than the global 80ms behind the media query. Presence signals (§7.5.3) must remain legible without motion — pulse is never the only difference between two states.
10. **Live regions for proactive announcements.** Anything the app surfaces unprompted (§7.5.5 ambient and transient) needs an `aria-live` region: `polite` for ambient status and toasts, `assertive` only for failures. A badge that only exists visually is invisible to a screen reader — and "proactive" that only works for sighted users isn't proactive.
11. **Pending is not disabled.** A control doing work stays focusable and in the tab order (§7.6). Removing it from the tab order mid-operation drops keyboard focus into nowhere.
12. **Status colour is never the only channel.** `--success` / `--warning` / `--destructive` LEDs must also differ in fill or position, so they survive both colourblindness and all eight themes — several of which shift these hues substantially.
13. **Contrast on tinted status backgrounds.** The `bg-success/10 text-success` pattern is borderline at the default oklch pair (§3). Validate every status-on-tint pair at 4.5:1 in the two extreme themes (`solarized-light`, `monokai`), not just the default dark.

## 11. Anti-patterns (do not ship)

- New hex / oklch literals in component files — go through tokens.
- New `text-[Xpx]` sizes without adding them to the table in §4.
- Interactive `<div>`s. Always `<button>` / `<a>` / input elements.
- Emoji used as an icon.
- New keyframe animations for anything that isn't a functional loop (§7.3.9).
- Destructive action hidden behind hover-only opacity.
- Modal without focus trap.
- `!important` outside `index.css` (the forced transition durations are the only intentional uses).
- **Animating a keyboard-initiated transition** (§7.1). Palette, tab switch, jump-to-tab, MRU cycle, save — instant, always.
- **`transition: all` / `transition-all`** on any new surface (§7.3.1).
- **A uniform `hover:scale-*`** across unrelated elements (§7.3.5).
- **A spinner or pulse running while nothing is in flight** — it's a false statement about state (§7.5.4).
- **A stale git-derived number rendered as if it were live** (§7.5.4).
- **A background signal that only exists inside a hidden pane** (§7.5.3 rule 1).
- **A toast for an effect the user can already see** (§7.5.5).
- **Optimistic UI on a network or history-rewriting operation** (§7.5.6).
- **A disabled control with no stated reason** (§7.6).
- **Disabling a control to indicate "busy"** — that's the pending state (§7.6).
- A state change that shifts `border-width`, `padding`, `height` or an icon slot (§7.6).
- A second status-indicator shape competing with the LED (§7.5.3 rule 5).
- **A `box-shadow` on an island** (§6). Elevation is lightness here.
- **`shadow-md` / `shadow-sm` / a new shadow tier** (§6). There are two: `shadow-xl` scrimmed, `shadow-lg` unscrimmed.
- **A panel restating `--island-gap`, `--island-inset` or a radius** (§5). Geometry lives in the shell.
- **A hardcoded colour in a data visualisation** — the commit graph's lane colours are `--chart-*`, so the graph changes with the theme like everything around it (§11.5).

## 11.5 Brand & visual identity

VoidLink ships eight borrowed editor themes, so **identity cannot live in colour** — a user on `solarized-light` and a user on `dracula` must both recognise the app. The identity lives in the things that survive a theme swap:

1. **Density as a stance.** Tight rows, a 10px floor, `text-[10px] uppercase tracking-wider` section labels. VoidLink is denser than VS Code and admits it. Do not loosen spacing to look "modern".
2. **The LED as the status glyph.** One shape carries every liveness signal (§7.5.3) across the whole app — terminal health, background work, tab activity, sync state. It is the most recognisable mark in the product; keep it singular.
3. **Tinted-primary selection.** `bg-primary/15 border-primary/40 text-primary` is the app's "this one is active" idiom, in segmented controls, pills and tabs alike. Not fills, not underline-only, not shadows.
4. **Geist Variable against a Nerd Font mono.** UI type is a single humanist sans; everything repo-derived (paths, hashes, diffs, terminal) is mono. The seam between the two is deliberate — it tells you what's VoidLink and what's your repo.
5. **Frameless macOS chrome.** The window is the app; no redrawn title bars, no fake IDE chrome inside the app's own UI.

The identity risk to guard against: as the editor and workbench grow, they drift toward VS Code's proportions by default, because Monaco brings them. Monaco themes must be derived from VoidLink's tokens (not stock `vs`/`vs-dark`), and Monaco chrome — breadcrumbs, tab strip, status segment — must use VoidLink's row, label and LED patterns rather than Monaco's.



## 12. File map

| File | Role |
|---|---|
| `src/index.css` | Tokens (colour, canvas, elevation, spacing, island geometry, z-index), density vars, `.island`, global transitions, scrollbar styling |
| `src/canvasTokens.test.ts` | Asserts the canvas is darker than the island in all ten surface-defining blocks |
| `src/tokenHygiene.test.ts` | Fails the build on an inline hex, `oklch()`, `z-[N]`, raw ms or raw px radius under `src/components/` |
| `src/components/layout/AppShell.tsx` | The island composition — inset, gaps, slots. One of the three files that own D1's geometry |
| `src/themes.css` | Named theme overrides (8 themes) |
| `src/store/theme.ts` | `THEMES` list + light/dark toggle |
| `src/store/settings.ts` | `ui.textSize` + `ui.density` + terminal prefs |
| `src/components/layout/` | Shell: TitleBar, TabBar, Sidebar, Surface, WindowFrame |
| `src/components/git/` | GitSidebar (changes/branches/history), GitDiffView |
| `src/components/terminal/TerminalPane.tsx` | xterm wrapper — theme currently hardcoded (TODO: derive from CSS vars) |
| `src/components/settings/SettingsDialog.tsx` | Settings modal |
