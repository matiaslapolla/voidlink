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

Global transitions are forced in `index.css`:

```css
.transition-colors  { transition-duration: 60ms;  timing: linear; }
.transition-opacity { transition-duration: 80ms;  timing: linear; }
.transition-all     { transition-duration: 80ms; }
```

This is intentional — IDE chrome should not feel animated. Follow these rules:

1. **No new keyframe animations without reason.** The RefreshCw button should spin *only when actually refreshing*, not decoratively.
2. **State changes are color/opacity only.** Never animate layout (width/height/top/left).
3. **Respect `prefers-reduced-motion`.** Any animation longer than the global 60–80ms (currently: none, but e.g. future toast slide-in) must check the media query.
4. **Instant for critical feedback.** Button pressed state should be immediate, not eased.

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
9. **`prefers-reduced-motion`**: gate any animation longer than the global 80ms behind the media query.

## 11. Anti-patterns (do not ship)

- New hex / oklch literals in component files — go through tokens.
- New `text-[Xpx]` sizes without adding them to the table in §4.
- Interactive `<div>`s. Always `<button>` / `<a>` / input elements.
- Emoji used as an icon.
- New keyframe animations.
- Destructive action hidden behind hover-only opacity.
- Modal without focus trap.
- `!important` outside `index.css` (the forced transition durations are the only intentional uses).

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
