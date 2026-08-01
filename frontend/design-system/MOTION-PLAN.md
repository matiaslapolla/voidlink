# VoidLink — Microinteraction Overhaul Plan

Companion to `MASTER.md`. Where MASTER §7 states the *doctrine*, this document
records how far the codebase is from it, and the ordered work to close the gap.

**Platform scope: macOS only.** Linux/WebKitGTK and Windows/WebView2 constraints
are recorded where they would change a decision, but nothing here is gated on
them. When a second platform lands, re-read §P4 and §5 — they are the only
sections whose recommendations change.

Audit date: 2026-08-01. Measured against `frontend/src` at commit `690a480`.

---

## 0. The finding

MASTER §7 is a better motion doctrine than the app needs and than most desktop
tools ship. It contains the frequency gate, the token set, the exit-at-75% rule,
origin-aware popovers, asymmetric tooltip delays, and the ban on bounce. It was
written by someone who understood that a surface a user stares at for eight
hours pays a tax for every animation.

**It is roughly 15% implemented.**

The `--dur-*` and `--ease-*` tokens are defined at `index.css:123-131` and
consumed **twice** in ~56k lines of UI. Everything else inherits one global
`!important` floor:

```css
.transition-colors { transition-duration: 60ms !important;
                     transition-timing-function: linear !important; }
```

Linear easing on every state change in the product is the single loudest
"web page, not native app" signal the app emits — and it is emitted by the
compliance mechanism itself. The floor was correct as a stopgap for the 145
pre-existing `transition-colors` sites (§7.2 says so). It has since become the
ceiling, because nothing was ever migrated off it.

**This is a compliance problem, not a design problem.** The plan below adds
motion in exactly five places. Everything else stays at 60ms tint or 0ms,
because §7.1 is right.

### What is already correct

Recorded so a future refactor does not "fix" it:

| Rule | Evidence |
|---|---|
| §7.1 keyboard-initiated = 0ms | `commands/CommandPalette.tsx:19` cites it in a comment and honours it |
| §7.3.5 no uniform hover-scale | Zero `hover:scale-*` in the tree |
| §7.3.1 `transition-all` held at 9 | Still exactly 9, all in `GitSidebar.tsx` |
| §7.3.10 pointer-driven 1:1 | `layout/Splitter.tsx` — `setPointerCapture`, grab-offset, total-delta clamping so overshoot-and-return tracks exactly |
| §7.5.3 activity vocabulary | `layout/StatusLed.tsx` — closed signal set, reserved slot, colour never the only channel. The best-built component in the app |
| §7.5 live regions | `commands/ToastViewport.tsx` — dual polite/assertive regions, count aggregation |
| Focus ring coverage | 273 `focus-visible:` sites; `index.css:261` documents surviving an island edge |

---

## 1. Findings

Severity · confidence. Nothing dropped; low-severity items are recorded rather
than filtered so the decision to skip one is explicit.

### Cross-cutting

**F1 · No primitives layer · Critical · High**
278 raw `<button>` elements across 53 files. No `components/ui/`. Every button's
hover, press, focus, disabled and pending behaviour is hand-rolled at the call
site. This is *why* `transition-colors` reached 201 sites — it is the only thing
cheap enough to repeat. There is no single place to change, so no microinteraction
work is affordable until this exists.

**F2 · Motion tokens are decorative · Critical · High**
`--dur-tint|micro|short|long` and `--ease-out|in|in-out` have one consumer each.
§7.2 mandates naming a token; instead everything inherits the global linear floor.

**F3 · No tooltip primitive · High · High**
271 native `title=` attributes, zero `role="tooltip"`. Native `title` has an
OS-controlled delay that cannot be tuned, no keyboard-focus trigger, and no
styling — so §7.3.12 (600–800ms hover, **0ms focus**, instant on adjacent hover)
is not merely unimplemented but unimplementable. `WorkspaceRail.tsx:248,275,287`
carry real information in `title`, so this is functional, not cosmetic.

**F4 · Type scale is ad-hoc · High · High**
Six sizes between 10 and 14px: `text-[11px]` ×218, `text-[10px]` ×125,
`text-xs` ×100, `text-[12px]` ×76, `text-[13px]` ×52, `text-sm` ×17.
`text-xs` and `text-[12px]` are the same computed value written two ways across
176 sites. No named scale exists, so no one can pick correctly.

**F5 · `!important` outside `index.css` · Medium · High**
`WorkspaceRail.tsx:303` uses `hover:!opacity-100`. Named on MASTER's ban list.

### Menus

**F6 · Context menu has no enter/exit · High · High**
`git/ContextMenu.tsx` renders straight into the Portal. §7.1 budgets 120–180ms
for a 5–50×/session surface; §7.3.7 requires `scale(0.97)` + opacity from the
trigger's origin, never `scale(0)`. Currently it teleports.

**F7 · Context menu has no keyboard navigation · High · High**
`ContextMenu.tsx:39-41` handles Escape only. No arrow keys, no roving
`tabindex`, no typeahead, no focus moved into the menu on open. In an app whose
README leads with "your hands never leave the keyboard," the right-click menu is
mouse-only.

**F8 · Context menu dismiss is click-based · Medium · Med**
`ContextMenu.tsx:44-46` listens for `click`, deferred by `setTimeout(0)` to dodge
the opening click. Pointer-down is the native behaviour; a drag begun outside the
menu will not close it, and the zero-timeout guard is fragile.

**F9 · Eight dialogs, none native · Medium · High**
`SettingsDialog`, `SnapshotManager`, `BrainOverlay`, `GoToSymbol`, `LspLogDialog`,
`NewWorktreeWizard`, `ShortcutsCheatSheet`, `QuickPick` all put `role="dialog"` on
a div. Native `<dialog>` + `showModal()` provides focus trap, background `inert`,
Escape, and `::backdrop` — currently hand-rolled or absent.

**F10 · Modals do not animate · Medium · High**
The one surface where §7.1 explicitly grants full budget (<5×/session, up to
240ms) and it is unspent.

### Sidebars

**F11 · Collapse/expand is instant · High · High**
Zero uses of `grid-template-rows: 0fr → 1fr` — the exact technique §7.3.2 names.
Sections snap. §7.1 budgets 120–180ms.

**F12 · All 9 `transition-all` sites are in `GitSidebar.tsx` · Medium · High**
Held at the documented count, but concentrated. They hit the 80ms global floor so
nothing looks broken — this is correctness debt, not a feel bug.

**F13 · Splitter is compliant but incomplete · Medium · High**
The drag itself is the best interaction in the app. §7.6 "Applies to"
additionally requires a hover-widened hit area (≥8px, visual width unchanged), a
keyboard resize step, and double-click-to-reset. None present.

**F14 · Inconsistent hover treatment within one file · Low · High**
`WorkspaceRail.tsx:233` is `hover:bg-accent/50` with no transition (instant);
line 276 is the same effect with `transition-colors` (60ms). Two behaviours for
one gesture, 40 lines apart.

### Tabs

**F15 · Active indicator does not travel · High · High**
`TabStrip.tsx:131` renders the 2px `--primary` rule *inside* the active tab
(`absolute left-1.5 right-1.5 bottom-0`). Switching destroys it in one place and
creates it in another. A shared indicator that slides is the clearest native
signal a tab strip can emit, and it survives the frequency gate because it
*carries information* — it shows where you came from.

**F16 · Tab drag is HTML5 DnD, not pointer events · High · High**
`TabStrip.tsx:362-430` uses `onDragStart`/`onDragOver`/`dataTransfer`. §7.3.10
names tab drag-reorder explicitly as a surface that must follow the pointer every
frame with `setPointerCapture`, respect the grab offset, and reverse mid-motion.
HTML5 DnD gives the OS ghost image, no velocity, no 1:1 tracking, no
interruptibility. A directly-named doctrine violation, and the interaction that
most makes the tab strip feel like a web page.

**F17 · Segmented toggle has no thumb · Medium · Med**
`ViewSwitcher.tsx:42` changes colour only. A sliding pill encodes direction of
travel the same way F15 does.

**F18 · Tab open/close do not animate · Low · High**
Probably correct — frequently keyboard-initiated (§7.1). Recorded so the decision
is deliberate rather than accidental.

### Buttons

**F19 · Press state at 3 of 278 sites · Critical · High**
Only `active:scale-[0.96]` ×2 and `active:scale-[0.98]` ×1 exist. §7.6 requires
an immediate active/pressed treatment on every interactive element. This is the
primary reason the app does not feel like it is listening: a button with no press
state reads as a picture of a button. 275 sites affected.

**F20 · No pending-state vocabulary · High · Med**
27 `animate-spin`/`Loader` usages exist, but §7.6's *pending* contract — icon slot
swaps, label unchanged, control **stays focusable and in the tab order**, slot
reserved at rest so arrival causes no reflow — has no shared implementation.
`StatusLed` does exactly this via `<LedSlot>`; buttons have no equivalent.
(Confidence Med on per-site prevalence; High that no primitive exists.)

### Everything else

**F21 · Toasts have no enter or exit · High · High**
`ToastViewport.tsx` mounts rows directly. §7.1 grants 120–180ms; §7.3.11 requires
enter and exit along the same path — which also makes a future swipe-to-dismiss
legible. §7.3.8 applies: toasts are retriggerable, so transitions, not keyframes.

**F22 · No `backdrop-filter` anywhere · Medium · High**
MASTER §7.4 already flags this: scrims are flat `bg-black/40–/60`. On macOS this
is the highest native-feel-per-line change available. See §P4.

**F23 · `text-rendering: optimizeLegibility` · Low · Med**
`index.css:258`. Redundant beside the explicit
`font-feature-settings: 'kern' 1, 'liga' 1, 'calt' 1` on the same rule, and known
to cost layout work. The feature-settings line does the real job.

**F24 · Dead `font-family` declaration · Low · High**
`index.css:6` sets `system-ui` on `:root`; `index.css:256` overrides with
`@apply font-sans` (Geist Variable) on `html`. Harmless, misleading to read.

---

## 2. Phase 1 — Make the doctrine enforceable

**~1 week. Nothing here is visible to a user.** It is what makes phases 2–4 cost
days instead of months. Do not start Phase 2 before this lands; without it,
every subsequent change is a 278-site find-and-replace.

Create `frontend/src/components/ui/`:

### `Button.tsx`
Variants: `chrome` · `primary` · `ghost` · `danger`. All nine §7.6 states in one
place:

- Hover — tint shift only, `--dur-tint`, gated behind `@media (hover: hover)`
- Focus — `focus-visible:ring-2 ring-ring`, **instant**, never transitioned (§7.3.3)
- Active — immediate, no easing; chrome deepens tint, `primary` may `scale(0.98)`
- Pending — icon slot swaps to `animate-spin`, label unchanged, **stays focusable
  and in the tab order** (§7.6 forbids disabling to mean "busy"), slot reserved at
  rest so arrival causes no reflow
- Disabled — `opacity-40` **and** `cursor-not-allowed` **and** `aria-disabled`,
  plus a `title` stating *why*
- `border-width`, `padding`, `height` and icon-slot width constant across every
  state (the no-layout-shift rule)

Resolves F1, F19, F20.

### `Tooltip.tsx`
600–800ms hover delay; **0ms on keyboard focus**; instant with no transition on
adjacent triggers while the group is still hovered; dismissible on Escape;
hoverable and persistent per WCAG 1.4.13. Then codemod the 271 `title=` sites.
Resolves F3.

### `Menu.tsx`
Roving `tabindex`, arrow keys, typeahead, Home/End, Escape, **pointer-down**
dismiss, focus moved into the menu on open and restored to the trigger on close,
`transform-origin` set from the trigger. Resolves F6, F7, F8.

### `Dialog.tsx`
Wraps native `<dialog>` + `showModal()`. Migrate the eight hand-rolled dialogs.
Keep `transform-origin: center` — modals are §7.3.7's stated exception.
Resolves F9.

### `Disclosure.tsx`
The `grid-template-rows: 0fr → 1fr` primitive, `--dur-short` `--ease-in-out`.
Never animates `height`. Resolves F11.

### Type scale
Name the six sizes as tokens (`--text-micro` 10 · `--text-label` 11 ·
`--text-body` 12 · `--text-ui` 13 · `--text-lg` 14) and codemod the 588
arbitrary-value sites. Collapse `text-xs`/`text-[12px]` to one name.
Resolves F4.

### Retire the global floor
As each surface migrates onto a named token, **remove it from the
`!important` block** in `index.css:381-391`. The floor stays only for
not-yet-migrated `transition-colors` sites. This is the step that actually lets
`--ease-out` take effect anywhere; skipping it makes phases 2–4 invisible.
Resolves F2.

### Cleanups
F5 (`hover:!opacity-100` → a variant), F14 (one hover behaviour per gesture),
F23, F24.

---

## 3. Phase 2 — Spend the motion budget

**~1 week. Exactly five things move.** Everything else stays at 60ms tint or 0ms.
This restraint *is* the current pattern, not a compromise: Raycast ships no
palette animation at all, for the same reason §7.1 exists.

| Surface | Before | After | Why |
|---|---|---|---|
| Tab indicator | Re-rendered inside each active tab (`TabStrip.tsx:131`) | One shared indicator, `transform: translateX()` + width, `--dur-short` `--ease-out` | Carries *where you moved from*. Highest-value single animation in the app (F15) |
| Toast | Mounts directly | `translateY(100%)` → `0` + opacity, 180ms `--ease-out` in / 135ms `--ease-in` out, same path both ways | §7.3.11; enables swipe-to-dismiss later (F21) |
| Context menu | Renders instantly | `scale(0.97)` + opacity from trigger origin, 180ms in / 135ms out | §7.3.7; never from `scale(0)` (F6) |
| Modal | Appears instantly | Backdrop fade + `scale(0.96 → 1)`, `--dur-long`, origin **center** | The one surface granted full budget (F10) |
| Disclosure | Snaps | `grid-template-rows: 0fr → 1fr`, `--dur-short` `--ease-in-out` | §7.3.2 by name (F11) |

Optional, same phase: F17 sliding thumb on `ViewSwitcher`, using the same shared-
indicator mechanism built for F15.

**Explicitly unchanged:** command palette, tab switch, jump-to-tab-N, MRU cycle,
pane focus, stage/unstage, save. All keyboard-initiated. §7.1 is absolute here.

---

## 4. Phase 3 — Rebuild tab drag on pointer events

**~3–4 days.** The one genuinely physical interaction in the app, and currently
the least physical. Replace HTML5 DnD with the pattern `Splitter.tsx` already
proves is writable in this codebase.

- `setPointerCapture` + grab-offset respect + ~10px hysteresis before committing
  to a direction
- 1:1 tracking; a drop indicator tracks the nearest valid slot
- Track a short position/timestamp history so release velocity is available
- On release: project the resting point —
  `current + (v/1000)·d/(1−d)` with `d ≈ 0.998` — snap to the slot nearest the
  projection, then hand the release velocity to the settle animation
- Spring settle at `damping 1.0, response 0.3`. **This is the only place in the
  app permitted overshoot** (§7.3.4 reserves it for pointer-driven physical
  interaction), and even here keep bounce ≤ 0.2
- Rubber-band resistance at the strip's ends rather than a hard stop
- Reversible mid-flight: animate from the presentation value, never the target

Resolves F16.

**Spring implementation:** `solid-motionone` (5.8kb, maintained by
solidjs-community) is the ready option; `@motionone/solid` is deprecated — do not
add it. But this is *one* interaction, and a hand-rolled spring on
`requestAnimationFrame` avoids a dependency in a product whose whole pitch is a
single local binary. Decide at implementation time; do not add the dep
speculatively in Phase 1.

Also in this phase, since it is the same §7.6 "Applies to" clause: **F13** —
splitter hover-widened hit area (≥8px, visual width unchanged), keyboard resize
step, double-click-to-reset.

---

## 5. Phase 4 — Materials

**~3–4 days. Optional, and the highest native-feel-per-line change available on
macOS.** This is the item that most directly answers "why doesn't it feel like a
Mac app."

Introduce `backdrop-filter: blur() saturate()` on the title bar, command palette,
and menus, with content scrolling *beneath* them rather than opaque strips
consuming a fixed band.

- Material weight encodes hierarchy: heavier/darker for structural regions
  (sidebars), lighter for interactive chrome (palette, menus)
- **Never stack a light translucent surface on another** — legibility collapses
- Bigger surfaces read as thicker: stronger blur, deeper shadow than small chips
- Keep colour on a solid layer, never on the translucent foreground
- Prefer a scroll-edge fade where floating chrome overlaps content, rather than a
  1px divider
- Land the `prefers-reduced-transparency: reduce` hook in the same change —
  raise background opacity, drop the blur. MASTER §7.4 already specifies it
  belongs beside the `prefers-contrast` block in `index.css`

Resolves F22.

**Deferred platform constraint.** `backdrop-filter` under WebKitGTK is materially
more expensive than under WKWebView. macOS-only scope means this does not gate
the work — but when Linux lands, expect to gate materials per-platform rather
than tune them down globally.

---

## 6. Not in scope

Recorded so the omissions are decisions rather than oversights.

- **Layout & spacing** — six type sizes plus a `data-density` system with no named
  spacing scale is the same disease as F4, one layer down. Worth its own pass.
- **States & edge cases** — F20 is really a states-coverage question; loading,
  empty and error coverage across menus/tabs/panels was not audited.
- **Accessibility** — not audited beyond what motion work touches. Note that
  `index.css` zeroes all transitions under `prefers-reduced-motion` and exempts
  functional loops via `.motion-loop`, which is correct and rare.
- **Responsive** — desktop-only app; low value.
- **Cognitive load, UX copy** — not audited.

---

## 7. On "modern patterns"

The 2026 external canon mostly *confirms* MASTER §7 rather than revising it:
springs at stiffness 200–400 / damping 20–30 for physical interaction, layout
transitions held to 200–350ms, interruptibility as non-negotiable, and reduced
motion treated as a first-class state. §7 already says all of this, and its
frequency gate is stricter than the canon — correctly, for a tool used all day.

The one genuinely new platform capability worth tracking is the **View
Transitions API**. Same-document transitions ship in WebKit from Safari 18, which
would implement F15's sliding indicator with no JavaScript.

**Blocker before relying on it:** `tauri.conf.json` sets no
`minimumSystemVersion`, so the Tauri v2 default (macOS 10.13) applies and
WKWebView's version tracks the user's OS. Safari 18 means macOS 15+. Either set
an explicit deployment floor or feature-detect
(`if (document.startViewTransition)`) with the Phase 2 transform-based indicator
as the fallback. Do not make it the only implementation.

---

## References

- `MASTER.md` §7 (motion), §7.5 (liveness), §7.6 (interaction states) — governing
- [View Transition API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
- [solid-motionone](https://github.com/solidjs-community/solid-motionone)
- [Motion — Material Design 3](https://m3.material.io/styles/motion/overview/how-it-works)
- [Karl Koch — 10 Principles for Fluid UI](https://karlkoch.me/writing/10-principles-for-fluid-ui)
