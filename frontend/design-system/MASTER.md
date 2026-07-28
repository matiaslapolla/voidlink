# VoidLink Design System — Master

Source of truth for all UI in the VoidLink Tauri desktop app. Read this before building or refactoring any component. Page-specific overrides live in `design-system/pages/*.md` — they take precedence when present.

## 1. Product context

- **Type**: Desktop developer tool (Tauri + SolidJS webview, frameless window).
- **Scope**: Three features — workspace tabs, terminal sidebar, git panel. No feature work outside this scope.
- **Density**: Information-dense IDE chrome. Pixel budget matters; padding and type should be tight but never below touch/readability floors.
- **Platform**: Keyboard-first. Mouse is secondary. No touch.
- **Audience**: Developers. They expect keyboard shortcuts, reversible actions, and JetBrains/VSCode-class polish.

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
| `--background` | `bg-background` | App canvas, terminal surface, diff body |
| `--sidebar` | `bg-sidebar` | Left and right rails (TerminalSidebar, GitSidebar) |
| `--card` | `bg-card` | Inner elevated blocks (currently unused — reserve for future popovers-as-cards) |
| `--popover` | `bg-popover` | Modal body (SettingsDialog) |
| `--muted` | `bg-muted` | Input backgrounds, hunk headers |
| `--accent` | `bg-accent` | Hover/active row highlight — use with /40–/70 alpha |

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

Base font-size is set on `<html>` by the `ui.textSize` setting: `sm=13px`, `base=15px`, `xl=17px`. Tailwind `text-xs/sm/base` inherit from this; `text-[Npx]` bypasses it.

Current component usage:

| Size | Use | Notes |
|---|---|---|
| `text-xs` (0.75rem) | Tab labels, file rows, terminal row title, diff header, commit textarea | Default interactive text |
| `text-[11px]` | Commit button, git tab labels, branch rows, history rows | Minor actions |
| `text-[10px]` | Uppercase section headers, cwd subtext, diff line numbers, badges | Floor — anything smaller is too small |
| `text-[9px]` | HEAD badge | Avoid — promote to 10px if re-used |

**Rule**: stop adding new sizes. If you need smaller than `text-[10px]`, rethink the hierarchy. If you need a new intermediate size, add it as a utility class here first.

### Section label pattern (recurring)

```
text-[10px] uppercase tracking-wider font-semibold text-muted-foreground
```

Used in TerminalSidebar (Terminals, Diffs), GitSidebar (Staged, Changes), SettingsDialog (Section). Worth extracting as a `.ui-section-label` class in `index.css`.

## 5. Spacing & density

`index.css` exposes a density scale driven by `data-density` on `<html>` (compact / normal / comfortable). Components opt in via:

- `.density-row` — applies `--row-pad-y` to top/bottom padding
- `.density-section` — applies `--section-pad-y`
- `.density-gap > * + *` — applies `--row-gap` between children

**Values (normal)**: row-pad-y `0.375rem`, row-gap `0.25rem`, section-pad-y `0.5rem`.

**Rule**: any new row-style component that should respond to the density setting must use these classes. Don't hardcode `py-1.5` for a density-sensitive row.

Horizontal padding stays rem-based (Tailwind `px-2 / px-2.5 / px-3`) and scales naturally with textSize.

## 6. Radius & elevation

- `--radius: 0.625rem` (10px) is the lg base; Tailwind reads `--radius-sm/md/lg/xl` (60% / 80% / 100% / 140% of base).
- **Component usage**:
  - Inputs, buttons, rows → `rounded-md` (8px)
  - Tabs (top only) → `rounded-t-md`
  - Dialog → `rounded-md`
  - Toggle pills → `rounded-full`
  - Close icon buttons → `rounded` (4px) — smaller to match icon size
- **Elevation**: only the modal uses `shadow-xl`. No elevation scale exists. If more floating surfaces arrive, define `shadow-sm/md/lg` tokens before adding them ad-hoc.
- **Glow effect** (used for LED): `shadow-[0_0_6px_theme(colors.success)]`. Used once; don't generalize until reused.

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

The forced `!important` durations in `index.css` stay as the floor for the 145 existing `transition-colors` sites. New surfaces name a token.

**Exits run at ~75% of their enter** (`--ease-in`). A menu that closes as slowly as it opens feels stuck.

### 7.3 Rules

1. **Never `transition: all`.** Name the properties. (`transition-all` exists at 9 sites — do not add a tenth.)
2. **Animate `transform` and `opacity` only.** Never `width`, `height`, `top`, `left`, `margin`, `padding`. Expanding regions animate `grid-template-rows: 0fr → 1fr`.
3. **Focus rings appear instantly.** Never transition a focus ring's opacity, transform or width. Keyboard users need the indicator on the same frame.
4. **No bounce, overshoot or elastic easing on chrome.** Reserve overshoot for pointer-driven physical interactions only — and VoidLink currently has none that qualify.
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

Also honour `prefers-reduced-transparency: reduce` on any future `backdrop-filter` surface (raise opacity, drop the blur) and `prefers-contrast: more` (near-solid backgrounds, defined borders).

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
| `src/index.css` | Tokens, density vars, global transitions, scrollbar styling |
| `src/themes.css` | Named theme overrides (8 themes) |
| `src/store/theme.ts` | `THEMES` list + light/dark toggle |
| `src/store/settings.ts` | `ui.textSize` + `ui.density` + terminal prefs |
| `src/components/layout/` | Shell: TitleBar, TabBar, Sidebar, Surface, WindowFrame |
| `src/components/git/` | GitSidebar (changes/branches/history), GitDiffView |
| `src/components/terminal/TerminalPane.tsx` | xterm wrapper — theme currently hardcoded (TODO: derive from CSS vars) |
| `src/components/settings/SettingsDialog.tsx` | Settings modal |
