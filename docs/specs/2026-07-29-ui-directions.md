# UI Directions — Islands & Contained Tabs

**Status:** D1 selected. D4 held as the documented alternative.
**Date:** 2026-07-29
**Scope:** Whole-shell visual redesign — JetBrains-style islands plus AI-browser-style contained tabs, across every surface of the app.
**Implementation:** `.claude/prompts/workbench-islands-ui.md` (D1).

---

## The two constraints that decide everything

Both come from the design references, and both happen to align with what VoidLink already does.

1. **On dark surfaces, elevation is lightness — never shadow.** A `box-shadow` on a dark island renders as a coloured halo, which is an explicit anti-pattern. VoidLink's tokens already ladder by lightness (`--background 0.200` → `--sidebar 0.213` → `--card 0.228` → `--popover 0.238`), so islands are a token change, not a new shadow system.
2. **Never nest a bordered container inside a bordered container.** Islands plus contained tabs is card-in-card by default. The boundary budget gets spent once — either the island has an edge or the tab card does, never both.

Unchanged in every direction: **Geist Variable** as the UI typeface, and `oklch(0.655 0.200 270)` as the accent. Varying either would be fake differentiation — a dense IDE with a deliberately frozen four-size type scale (MASTER §4, *"stop adding new sizes"*) does not have a typeface problem, and the accent already sits under the 3%-of-viewport rule.

Also unchanged: the motion tokens. `index.css`'s `--ease-out/in/in-out` are already byte-identical to the recommended three, and MASTER's 240ms duration ceiling is stricter than the reference's 420ms. MASTER wins.

---

## D1 — Recessed Canvas ← **selected**

Full islands. The JetBrains reading, executed correctly for dark surfaces.

```
┌──────────────────────────────────────────┐
│ ░░░░░░░░░░ canvas 0.150 ░░░░░░░░░░░░░░░░ │
│ ░┌────┐ ░┌───────────────────┐ ░┌──────┐░│
│ ░│rail│ ░│ [tab][tab] tab    │ ░│ git  │░│
│ ░│    │ ░├───────────────────┤ ░│      │░│
│ ░│    │ ░│  editor 0.210     │ ░│      │░│
│ ░└────┘ ░└───────────────────┘ ░└──────┘░│
│ ░░░░░░░░░ [ status bar island ] ░░░░░░░░ │
└──────────────────────────────────────────┘
```

| | |
|---|---|
| canvas | `oklch(0.150 0.006 270)` — drops *below* today's background |
| island | `oklch(0.210 0.005 270)` — within a hair of today's `--background` |
| raised | `oklch(0.245)` — palette, popovers, modals |
| gap | 6px between islands, 8px window inset |
| radius | 10px outer (existing `--radius`), 6px inner rows |
| borders | **none on islands** — lightness does the separation |
| elevation | `--elev-0/1/2` as lightness steps; no `box-shadow` except the modal |
| tabs | cards at 6px radius on the island surface; active tab keeps its `--primary` 2px underline |

**The load-bearing decision: the canvas recedes, the islands don't rise.** Raising the islands would lighten the terminal and diff bodies and cost text contrast on the two surfaces the user stares at for eight hours. Dropping the canvas leaves every reading surface at exactly the lightness it has today.

**Costs** ~14px vertical, ~14px horizontal.

**Argues with** MASTER §2.1 ("chrome should disappear") — this is the direction that spends the most pixel budget. §6 authorises it rather than forbidding it: *"If more floating surfaces arrive, define `shadow-sm/md/lg` tokens before adding them ad-hoc."* The tokens come first, which is what Wave 0 of the prompt does.

**Risk — light themes, and it is concrete.** `github-light` sets `--background: oklch(1.000 0.000 0)`. A canvas cannot recede below pure white by lightening, so light themes invert nothing — the rule stays "canvas darker than islands", islands take the theme's current `--background`, and the canvas is derived by darkening it. That works for all three light themes; it just means the derivation must be relative, not a hardcoded pair. (Separately: `oklch(1.000 0.000 0)` is a pure-white, zero-chroma base, which the colour reference bans twice over. It is left alone here — `github-light` matching GitHub is deliberate theme fidelity, not an accident, and changing it is a different decision.)

---

## D2 — Single Content Island *(not selected)*

The Arc/Dia reading: only the main content is contained; chrome stays flush to the window.

- canvas `oklch(0.200)` unchanged; rail, sidebars and status bar sit on it with borders removed
- content island `oklch(0.228)` — this is `--card`, finally used as MASTER §3 reserved it ("currently unused")
- 8px inset around the content only, 12px radius
- tabs sit on the canvas *above* the island, active tab merging into the island surface with no seam

Lower total pixel spend than D1 because only one rectangle is inset. Argues with nothing in MASTER. Rejected because it delivers contained tabs fully and islands only half — the sidebars stay flush.

---

## D3 — Seamed Islands *(not selected)*

Islands tuned so compact density survives untouched: canvas `oklch(0.175)`, islands `oklch(0.213)`, 4px gaps, 8px radius, borders softened from 10% to 6% alpha rather than removed. ~8px total cost, argues with nothing. Rejected as too likely to land as "did anything change?"

---

## D4 — Floating Chrome *(held — the fallback if D1 disappoints)*

Inverted: content is the canvas, and the chrome floats above it.

```
┌──────────────────────────────────────────┐
│ ┌──┐                              ┌────┐ │
│ │ra│   editor, full bleed 0.200   │git │ │
│ │il│   ← content runs underneath  │    │ │
│ │  │                              │    │ │
│ └──┘   ┌──────────────────┐       └────┘ │
│        │  status bar      │              │
└──────────────────────────────────────────┘
```

| | |
|---|---|
| content = canvas | `oklch(0.200)`, edge to edge, zero inset |
| floating chrome | `oklch(0.245)` + tight dark shadow `0 2px 8px oklch(0.10 0 0 / 0.4)` |
| gap | chrome inset 8px from window edges, overlapping content rather than displacing it |
| radius | 12px on chrome slabs |
| tabs | cards on a floating strip hovering over the editor |

The shadow is permitted here specifically because it is tight and dark rather than a coloured halo — the anti-pattern is the glow, not the shadow.

**Costs zero vertical pixels for the content** — chrome overlaps instead of pushing.

**Argues with** MASTER §2.1 in the opposite direction from D1: chrome doesn't shrink, it detaches.

**Why it is held rather than chosen.** Floating chrome occludes the first and last lines of a code buffer. That is fixable with scroll padding and a content inset matching the chrome footprint, but doing so gives back much of the pixel saving that motivates the direction. It is also the only direction that resembles neither JetBrains nor Arc — the strongest identity play, and the one most likely to need a second iteration.

**What switching to D4 would cost after D1 ships.** Less than it looks. Wave 0's token work (`--canvas`, the `--elev` ladder, the spacing and z-index scales), Wave 2's contained tabs, and Wave 3's polish pass are all direction-independent and carry over unchanged. What changes is Wave 1's geometry — which element owns the canvas, and whether chrome displaces or overlaps content — plus the addition of scroll padding on the editor and terminal. Roughly one wave of rework, not four. **Keep Wave 1's geometry decisions isolated in the shell components (`AppShell`, `WindowFrame`, `MainSurface`) rather than distributed into every panel, so this stays true.**
