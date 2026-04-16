# VoidLink egui UI/UX Parity Guide

**Goal.** Bring the `desktop/` (eframe + egui 0.31) crate to visual and interaction parity with the polished `frontend/` (SolidJS + Tailwind + Kobalte + tw-animate) app. This is a practical, actionable reference — not a sales doc. Read top to bottom once, then jump to specific sections as you build.

This guide extends `docs/rust-native.md` (which catalogues the trade-offs) with concrete implementations. Where `rust-native.md` says "glassmorphism is lost" — this doc says *how* to fake it acceptably. Where it says "themes are portable" — this doc gives you the full token tables.

---

## Table of Contents

1. [Visual Foundations](#1-visual-foundations)
2. [Motion & Interaction](#2-motion--interaction)
3. [Component Library](#3-component-library)
4. [Layout Patterns](#4-layout-patterns)
5. [Theme Matrix](#5-theme-matrix)
6. [Font Embedding](#6-font-embedding)
7. [Snappy UX Requirements](#7-snappy-ux-requirements)
8. [Accessibility](#8-accessibility)
9. [Phased Rollout Checklist](#9-phased-rollout-checklist)

---

## 1. Visual Foundations

### 1.1 The `ThemeTokens` struct — single source of truth

The current `desktop/src/theme/mod.rs` has ~20 fields in `ThemePalette`. That's too few. The frontend carries 50+ named CSS variables. We expand to the table below. All themes must supply all fields — no fallbacks at the call site.

Place in `desktop/src/theme/tokens.rs`:

```rust
use eframe::egui::Color32;

#[derive(Debug, Clone, Copy)]
pub struct ThemeTokens {
    pub is_dark: bool,

    // --- Base surfaces (app shell, panels, cards) ---
    pub background:        Color32, // --background        app shell base
    pub surface:           Color32, // --card              panels, cards
    pub surface_elevated:  Color32, // --popover           popovers, menus, tooltip bg
    pub surface_sunken:    Color32, // --muted             wells, subtle fills
    pub sidebar_bg:        Color32, // --sidebar           left sidebar surface
    pub status_bar_bg:     Color32, // status bar bottom
    pub title_bar_bg:      Color32, // title bar top
    pub editor_bg:         Color32, // --editor-bg         CodeMirror surface
    pub editor_gutter_bg:  Color32, // --editor-gutter-bg
    pub editor_tab_bar_bg: Color32, // --editor-tab-bar-bg
    pub tab_active_bg:     Color32, // active editor tab
    pub tab_inactive_bg:   Color32, // inactive editor tab

    // --- Text ---
    pub text:            Color32, // --foreground       primary text
    pub text_secondary:  Color32, // labels
    pub text_muted:      Color32, // --muted-foreground helpers, captions
    pub text_disabled:   Color32, // 50% of muted
    pub text_inverse:    Color32, // text on primary bg (primary_foreground)

    // --- Borders & dividers ---
    pub border:          Color32, // --border           subtle 8–12% alpha
    pub border_strong:   Color32, // focused/active borders
    pub border_focus:    Color32, // focus ring outline
    pub divider:         Color32, // same as border, semantic alias

    // --- Primary accent (brand) ---
    pub primary:           Color32, // --primary
    pub primary_hover:     Color32, // primary @ 92% lightness
    pub primary_pressed:   Color32, // primary @ 88% lightness
    pub primary_fg:        Color32, // --primary-foreground
    pub primary_ring:      Color32, // focus ring tint (primary @ 50% alpha)
    pub primary_subtle:    Color32, // primary @ 10–15% alpha (badges)

    // --- Semantic ---
    pub success:         Color32,
    pub success_subtle:  Color32,
    pub warning:         Color32,
    pub warning_subtle:  Color32,
    pub danger:          Color32, // --destructive
    pub danger_subtle:   Color32,
    pub info:            Color32,
    pub info_subtle:     Color32,

    // --- Interaction states (neutral) ---
    pub hover:           Color32, // row/button hover (neutral)
    pub pressed:         Color32, // 1 shade darker than hover
    pub selection_bg:    Color32, // text selection fill (primary @ 30% alpha)
    pub selection_fg:    Color32, // text on selection

    // --- Scrollbar ---
    pub scrollbar_track: Color32, // transparent by default
    pub scrollbar_thumb: Color32, // 45% lightness neutral, 50% alpha
    pub scrollbar_thumb_hover: Color32,

    // --- Editor line numbers ---
    pub editor_line_number:        Color32,
    pub editor_line_number_active: Color32,

    // --- Shell gradient (for faux-glass backdrop) ---
    pub shell_gradient_top:    Color32,
    pub shell_gradient_mid:    Color32,
    pub shell_gradient_bottom: Color32,

    // --- Ambient glow (behind glass panels) ---
    pub glow_primary:   Color32, // primary @ 10% alpha
    pub glow_secondary: Color32, // success @ 7% alpha

    // --- Glass overlay tokens ---
    pub glass_fill:       Color32, // panel bg @ 55% alpha
    pub glass_border:     Color32, // white @ 6% alpha
    pub glass_highlight:  Color32, // white @ 3% alpha inset

    // --- Nav icon hues (sidebar rail) ---
    pub icon_scan:       Color32,
    pub icon_repository: Color32,
    pub icon_context:    Color32,
    pub icon_workflow:   Color32,
    pub icon_agent:      Color32,
    pub icon_prompt:     Color32,
    pub icon_terminal:   Color32,
}
```

That's 57 fields. Stick to this. Do not introduce "one-off" colors in component code — if a component needs a new color, add it to `ThemeTokens`.

### 1.2 sRGB values per theme

All OKLch values from `frontend/src/index.css` + `frontend/src/themes.css` converted to sRGB 8-bit. Three themes filled; the other seven (GitHub Dark/Light, Monokai, Solarized Dark/Light, Dracula, One Dark) follow the same structure — see §5.

#### Dark (default)

| Token | Hex | rgba |
|---|---|---|
| `background` | `#12121f` | 18, 18, 31 |
| `surface` | `#1c1c2f` | 28, 28, 47 |
| `surface_elevated` | `#26263a` | 38, 38, 58 |
| `surface_sunken` | `#1a1a2b` | 26, 26, 43 |
| `sidebar_bg` | `#151523` | 21, 21, 35 |
| `status_bar_bg` | `#151523` | 21, 21, 35 |
| `title_bar_bg` | `#0f0f1c` | 15, 15, 28 |
| `editor_bg` | `#0f0f1c` | 15, 15, 28 |
| `editor_gutter_bg` | `#0f0f1c` | 15, 15, 28 |
| `editor_tab_bar_bg` | `#13131f` | 19, 19, 31 |
| `tab_active_bg` | `#20203a` | 32, 32, 58 |
| `tab_inactive_bg` | `#16162a` | 22, 22, 42 |
| `text` | `#ebebf5` | 235, 235, 245 |
| `text_secondary` | `#afafc3` | 175, 175, 195 |
| `text_muted` | `#6a6a87` | 106, 106, 135 |
| `text_disabled` | `#404055` | 64, 64, 85 |
| `text_inverse` | `#f5f5ff` | 245, 245, 255 |
| `border` | `rgba(255,255,255,0.12)` | 255, 255, 255, 30 |
| `border_strong` | `rgba(255,255,255,0.22)` | 255, 255, 255, 56 |
| `border_focus` | `#6366f1` | 99, 102, 241 |
| `divider` | `rgba(255,255,255,0.12)` | 255, 255, 255, 30 |
| `primary` | `#6366f1` | 99, 102, 241 |
| `primary_hover` | `#7173f3` | 113, 115, 243 |
| `primary_pressed` | `#5559df` | 85, 89, 223 |
| `primary_fg` | `#f5f5ff` | 245, 245, 255 |
| `primary_ring` | `rgba(99,102,241,0.50)` | 99, 102, 241, 128 |
| `primary_subtle` | `rgba(99,102,241,0.14)` | 99, 102, 241, 36 |
| `success` | `#22c55e` | 34, 197, 94 |
| `success_subtle` | `rgba(34,197,94,0.14)` | 34, 197, 94, 36 |
| `warning` | `#eab308` | 234, 179, 8 |
| `warning_subtle` | `rgba(234,179,8,0.14)` | 234, 179, 8, 36 |
| `danger` | `#ef4444` | 239, 68, 68 |
| `danger_subtle` | `rgba(239,68,68,0.14)` | 239, 68, 68, 36 |
| `info` | `#3b82f6` | 59, 130, 246 |
| `info_subtle` | `rgba(59,130,246,0.14)` | 59, 130, 246, 36 |
| `hover` | `#2d2d46` | 45, 45, 70 |
| `pressed` | `#232338` | 35, 35, 56 |
| `selection_bg` | `rgba(99,102,241,0.30)` | 99, 102, 241, 77 |
| `selection_fg` | `#ebebf5` | 235, 235, 245 |
| `scrollbar_track` | `rgba(0,0,0,0)` | transparent |
| `scrollbar_thumb` | `rgba(115,115,130,0.5)` | 115, 115, 130, 128 |
| `scrollbar_thumb_hover` | `rgba(150,150,170,0.7)` | 150, 150, 170, 179 |
| `editor_line_number` | `#5a5a75` | 90, 90, 117 |
| `editor_line_number_active` | `#b0b0c5` | 176, 176, 197 |
| `shell_gradient_top` | `#0c0c1c` | 12, 12, 28 |
| `shell_gradient_mid` | `#11111f` | 17, 17, 31 |
| `shell_gradient_bottom` | `#0a0a18` | 10, 10, 24 |
| `glow_primary` | `rgba(99,102,241,0.10)` | 99, 102, 241, 25 |
| `glow_secondary` | `rgba(34,197,94,0.07)` | 34, 197, 94, 18 |
| `glass_fill` | `rgba(18,18,31,0.55)` | 18, 18, 31, 140 |
| `glass_border` | `rgba(255,255,255,0.07)` | 255, 255, 255, 18 |
| `glass_highlight` | `rgba(255,255,255,0.04)` | 255, 255, 255, 10 |
| `icon_scan` | `#d9a048` | 217, 160, 72 |
| `icon_repository` | `#5fa3d9` | 95, 163, 217 |
| `icon_context` | `#c97ad9` | 201, 122, 217 |
| `icon_workflow` | `#48b88a` | 72, 184, 138 |
| `icon_agent` | `#8a7ad9` | 138, 122, 217 |
| `icon_prompt` | `#d98948` | 217, 137, 72 |
| `icon_terminal` | `#7ad98a` | 122, 217, 138 |

#### Light

| Token | Hex |
|---|---|
| `background` | `#f9f9fc` |
| `surface` | `#ffffff` |
| `surface_elevated` | `#f5f5f8` |
| `surface_sunken` | `#eeeef2` |
| `sidebar_bg` | `#f7f7fa` |
| `status_bar_bg` | `#f7f7fa` |
| `title_bar_bg` | `#f7f7fa` |
| `editor_bg` | `#fdfdff` |
| `editor_gutter_bg` | `#f7f7fa` |
| `editor_tab_bar_bg` | `#f2f2f7` |
| `tab_active_bg` | `#ffffff` |
| `tab_inactive_bg` | `#ededf3` |
| `text` | `#141423` |
| `text_secondary` | `#505064` |
| `text_muted` | `#8c8ca0` |
| `text_disabled` | `#c0c0ce` |
| `text_inverse` | `#ffffff` |
| `border` | `rgba(0,0,0,0.12)` |
| `border_strong` | `rgba(0,0,0,0.22)` |
| `border_focus` | `#4f46e5` |
| `primary` | `#4f46e5` |
| `primary_hover` | `#5f57ec` |
| `primary_pressed` | `#413acb` |
| `primary_fg` | `#ffffff` |
| `primary_subtle` | `rgba(79,70,229,0.10)` |
| `success` | `#16a34a` |
| `warning` | `#ca8a04` |
| `danger` | `#dc2626` |
| `info` | `#2563eb` |
| `hover` | `#eeeef5` |
| `pressed` | `#e4e4ec` |
| `selection_bg` | `rgba(79,70,229,0.22)` |
| `scrollbar_thumb` | `rgba(80,80,100,0.35)` |
| `editor_line_number` | `#99999f` |
| `editor_line_number_active` | `#404055` |
| `shell_gradient_top` | `#edecf5` |
| `shell_gradient_mid` | `#f2f1f8` |
| `shell_gradient_bottom` | `#ebeaf3` |
| `glow_primary` | `rgba(79,70,229,0.08)` |
| `glow_secondary` | `rgba(22,163,74,0.06)` |
| `glass_fill` | `rgba(250,250,252,0.60)` |
| `glass_border` | `rgba(0,0,0,0.06)` |
| `glass_highlight` | `rgba(255,255,255,0.50)` |

(Remaining shared tokens: same as Dark with inverted luminance; `border_strong` uses `rgba(0,0,0,0.22)`; icon hues retarget to ~55% L.)

#### Nord

| Token | Hex | Nord name |
|---|---|---|
| `background` | `#2e3440` | nord0 |
| `surface` | `#3b4252` | nord1 |
| `surface_elevated` | `#434c5e` | nord2 |
| `surface_sunken` | `#353b49` | between nord0 and nord1 |
| `sidebar_bg` | `#2a2f3a` | darker than nord0 |
| `status_bar_bg` | `#2e3440` | nord0 |
| `title_bar_bg` | `#2e3440` | nord0 |
| `editor_bg` | `#2e3440` | nord0 |
| `editor_gutter_bg` | `#2e3440` | nord0 |
| `editor_tab_bar_bg` | `#3b4252` | nord1 |
| `tab_active_bg` | `#434c5e` | nord2 |
| `tab_inactive_bg` | `#353b49` | – |
| `text` | `#eceff4` | nord6 |
| `text_secondary` | `#d8dee9` | nord4 |
| `text_muted` | `#7b8394` | raised nord3 |
| `text_disabled` | `#4c566a` | nord3 |
| `text_inverse` | `#2e3440` | nord0 |
| `border` | `#434c5e` | nord2 |
| `border_strong` | `#4c566a` | nord3 |
| `primary` | `#88c0d0` | nord8 |
| `primary_hover` | `#97cbd9` | – |
| `primary_pressed` | `#72acbd` | – |
| `primary_fg` | `#2e3440` | nord0 |
| `primary_subtle` | `rgba(136,192,208,0.15)` | – |
| `success` | `#a3be8c` | nord14 |
| `warning` | `#ebcb8b` | nord13 |
| `danger` | `#bf616a` | nord11 |
| `info` | `#81a1c1` | nord9 |
| `hover` | `#4c566a` | nord3 |
| `pressed` | `#434c5e` | nord2 |
| `selection_bg` | `rgba(136,192,208,0.30)` | – |
| `scrollbar_thumb` | `rgba(76,86,106,0.8)` | nord3 |
| `editor_line_number` | `#4c566a` | nord3 |
| `editor_line_number_active` | `#d8dee9` | nord4 |
| `shell_gradient_top` | `#262b34` | – |
| `shell_gradient_mid` | `#2e3440` | nord0 |
| `shell_gradient_bottom` | `#23272f` | – |
| `glow_primary` | `rgba(136,192,208,0.10)` | – |
| `glow_secondary` | `rgba(163,190,140,0.07)` | – |
| `glass_fill` | `rgba(46,52,64,0.55)` | – |

### 1.3 Typography

Use **Geist** (body) + **Geist Mono** (code). Geist is SIL OFL 1.1 — safe to embed. Variable fonts are not supported by `ab_glyph`; ship four static weights.

**Required TTF files** (add to `desktop/assets/fonts/`):

- `Geist-Regular.ttf`
- `Geist-Medium.ttf`
- `Geist-SemiBold.ttf`
- `Geist-Bold.ttf`
- `GeistMono-Regular.ttf`
- `GeistMono-Medium.ttf`

See §6 for the `FontDefinitions` wiring.

**Font size scale** (use constants, not literals):

| Role | px | egui `FontId` |
|---|---|---|
| Micro (badges, timestamps) | 11 | `FontId::new(11.0, Proportional)` |
| Small (secondary labels, tab titles) | 12 | `FontId::new(12.0, Proportional)` |
| Body (default) | 13 | `FontId::new(13.0, Proportional)` |
| Heading small (section titles) | 15 | `FontId::new(15.0, Proportional)` with Medium weight family |
| Heading medium | 16 | — |
| Heading large (welcome) | 18 | — |
| Code small | 12 | `FontId::new(12.0, Monospace)` |
| Code body | 13 | `FontId::new(13.0, Monospace)` |

egui does not expose letter-spacing or line-height per `TextStyle` directly. `Style::spacing.item_spacing.y` controls inter-row gap; tune to ~4.0 for body, ~2.0 for dense lists. For line height inside wrapped text, use `LayoutJob` and set `Section::format::extra_letter_spacing` and `line_height`.

Map `TextStyle::{Small, Body, Button, Heading, Monospace}` in `Theme::apply`:

```rust
use egui::{FontFamily, FontId, TextStyle};
let mut style = (*ctx.style()).clone();
style.text_styles = [
    (TextStyle::Small,     FontId::new(11.0, FontFamily::Proportional)),
    (TextStyle::Body,      FontId::new(13.0, FontFamily::Proportional)),
    (TextStyle::Button,    FontId::new(13.0, FontFamily::Proportional)),
    (TextStyle::Heading,   FontId::new(15.0, FontFamily::Name("GeistMedium".into()))),
    (TextStyle::Monospace, FontId::new(12.0, FontFamily::Monospace)),
].into();
ctx.set_style(style);
```

### 1.4 Spacing scale

Match the Tailwind scale used in the frontend. Define once:

```rust
#[derive(Copy, Clone)]
pub enum Space { Xxs, Xs, Sm, Md, Lg, Xl, Xxl, Xxxl }

impl Space {
    pub fn px(self) -> f32 {
        match self {
            Self::Xxs => 2.0,  Self::Xs => 4.0,  Self::Sm => 6.0,
            Self::Md => 8.0,   Self::Lg => 12.0, Self::Xl => 16.0,
            Self::Xxl => 20.0, Self::Xxxl => 24.0,
        }
    }
}

pub fn space(s: Space) -> f32 { s.px() }
```

Rules:

- Inter-item (list rows, buttons in a cluster): `Space::Sm` (6px).
- Section padding: `Space::Md` (8px) for compact, `Space::Lg` (12px) for cards.
- Dialog body padding: `Space::Xxl` (20px) horizontal, `Space::Xl` (16px) vertical.
- Panel outer margin: `0` — rely on borders, not gaps.
- Item spacing between form fields: `Space::Lg` (12px).

Apply globally where possible via `Style::spacing`:

```rust
style.spacing.item_spacing = egui::vec2(6.0, 4.0);
style.spacing.button_padding = egui::vec2(10.0, 4.0); // md button
style.spacing.menu_margin = egui::Margin::same(4);
style.spacing.window_margin = egui::Margin::same(0);
style.spacing.indent = 16.0;
```

### 1.5 Corner radii

Frontend uses `--radius: 0.625rem` (10px) as base, with scaled variants. Map to egui `CornerRadius::same(u8)`:

| Role | Token | Value |
|---|---|---|
| Pills, badges, small chips | `sm` | 4 |
| Buttons, inputs, list rows | `md` | 6 |
| Cards, panels, popovers | `lg` | 8 |
| Modals, dialogs | `xl` | 10 |
| Window / app shell | `2xl` | 12 |

Define:

```rust
pub mod radius {
    use eframe::epaint::CornerRadius;
    pub const SM:  CornerRadius = CornerRadius::same(4);
    pub const MD:  CornerRadius = CornerRadius::same(6);
    pub const LG:  CornerRadius = CornerRadius::same(8);
    pub const XL:  CornerRadius = CornerRadius::same(10);
    pub const XXL: CornerRadius = CornerRadius::same(12);
}
```

### 1.6 Shadows, glows, and faux depth

egui has no real drop shadow blur. You have two tools:

1. **`egui::epaint::Shadow`** — a solid-offset "shadow" already supported on menus/windows. It is a flat offset, no blur. OK for popovers.
2. **Painter tricks** — multi-layer rects with decreasing alpha for a soft-blur simulation.

**Menu/popover shadow** (global):

```rust
style.visuals.popup_shadow = egui::epaint::Shadow {
    offset: [0, 4],
    blur: 12,
    spread: 0,
    color: egui::Color32::from_black_alpha(60),
};
```

egui 0.31 supports `blur` in `Shadow` via the `epaint` backend on the wgpu renderer — verify in your eframe setup. On the glow backend `blur` may degrade to offset only.

**Soft drop shadow helper** (for cards that need more than menu shadow):

```rust
pub fn soft_shadow(painter: &egui::Painter, rect: egui::Rect, r: CornerRadius) {
    for i in 1..=3 {
        let offset = egui::vec2(0.0, i as f32);
        let alpha = 30 - (i * 8) as u8;
        let shadow_rect = rect.translate(offset).expand(i as f32 * 0.5);
        painter.rect_filled(shadow_rect, r, Color32::from_black_alpha(alpha));
    }
}
```

Draw **before** the card fill, on the same painter layer or a lower layer.

**Inset top highlight** (glass aesthetic) — draw a 1px bright line along the top inside edge:

```rust
pub fn inset_top_highlight(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
    let y = rect.top() + 1.0;
    painter.line_segment(
        [egui::pos2(rect.left() + 1.0, y), egui::pos2(rect.right() - 1.0, y)],
        egui::Stroke::new(1.0, color),
    );
}
```

Call with `tokens.glass_highlight` after drawing the panel fill.

### 1.7 Glassmorphism replacement

Real backdrop blur is not feasible (see `rust-native.md` §1.1). Fake it.

**Strategy: "Solid mode" and "Faux glass mode"** as a user preference (`AppState::glass_enabled: bool`).

**Solid mode (default, recommended):** Every panel uses opaque `tokens.surface`, `tokens.sidebar_bg`, etc. No transparency. Feels clean, performs best.

**Faux glass mode:** Same panel layout, but:

- App shell fills the root `CentralPanel` with a **vertical gradient** using `tokens.shell_gradient_{top,mid,bottom}` painted in 3 bands of 6–10 rows each on the root painter.
- Panels use `tokens.glass_fill` (alpha 55% of surface) instead of opaque surface.
- Each panel gets `inset_top_highlight(rect, tokens.glass_highlight)`.
- Two radial "glow orbs" drawn behind everything: one in top-left using `tokens.glow_primary`, one in bottom-right using `tokens.glow_secondary`. Implement as a single large `circle_filled` with very low alpha — not a true radial gradient, but cheap and matches the frontend's ambient depth.

```rust
pub fn paint_shell_backdrop(painter: &egui::Painter, rect: egui::Rect, t: &ThemeTokens) {
    // 3-band vertical gradient
    let bands = [t.shell_gradient_top, t.shell_gradient_mid, t.shell_gradient_bottom];
    let h = rect.height() / 3.0;
    for (i, color) in bands.iter().enumerate() {
        let band = egui::Rect::from_min_size(
            egui::pos2(rect.left(), rect.top() + h * i as f32),
            egui::vec2(rect.width(), h),
        );
        painter.rect_filled(band, 0, *color);
    }
    // Glow orbs — cheap large-radius low-alpha circles
    let r1 = rect.width() * 0.35;
    painter.circle_filled(
        egui::pos2(rect.left() + rect.width() * 0.15, rect.top() + rect.height() * 0.20),
        r1, t.glow_primary,
    );
    painter.circle_filled(
        egui::pos2(rect.left() + rect.width() * 0.85, rect.top() + rect.height() * 0.85),
        r1 * 0.9, t.glow_secondary,
    );
}
```

The orbs look like orbs because the alpha is low (~10% and ~7%). You lose the frontend's 40px Gaussian blur, but the perceived ambient mood carries.

**Trade-off disclosure**: The faux-glass mode costs you roughly one full-screen overdraw per frame. On a 1440p panel that's measurable but not painful on modern GPUs. If you hit frame budget issues, paint the backdrop to a texture and blit it — or just live in Solid mode.

---

## 2. Motion & Interaction

egui has no CSS transitions. You animate manually but ergonomically via `Context::animate_value_with_time` and `animate_bool_with_time`.

### 2.1 Frame pacing pattern

```rust
// Idle when nothing is animating. Request repaint at 60fps when something is.
let anim_t = ctx.animate_bool_with_time(row_id, hovered, 0.08);
if anim_t > 0.0 && anim_t < 1.0 {
    ctx.request_repaint(); // keep us in animation loop
}
```

`animate_bool_with_time` returns a smooth 0→1 float; egui internally schedules repaints for you as long as you keep calling it each frame. The `ctx.request_repaint()` call above is defensive belt-and-suspenders for nested animations.

### 2.2 Timings (steal from `frontend/src/index.css`)

| Interaction | Duration | Curve |
|---|---|---|
| Hover color | 60 ms | linear |
| Opacity reveal | 80 ms | linear |
| Button press (translate-y: 1px) | 80 ms | ease-out |
| Focus ring fade-in | 120 ms | ease-out |
| Tab switch | 140 ms | ease-out-expo (`animate_value_with_time` – egui's built-in ease) |
| Panel collapse | 180 ms | ease-snap |
| Dialog enter (scale 0.95→1.0, opacity 0→1) | 100 ms | ease-out-expo |
| Dialog exit | 60 ms | linear |
| Context menu enter | 100 ms | ease-out-expo |

egui's `animate_bool_with_time` uses ease-out by default (quadratic). Close enough — don't try to write custom easing unless the built-in looks visibly off.

### 2.3 Micro-interactions

**Button press** — Use an id-keyed float that tracks 0 when unpressed, 1 when pressed, and shift button content by 1px when pressed.

```rust
let id = response.id.with("press");
let pressed = ctx.animate_bool_with_time(id, response.is_pointer_button_down_on(), 0.06);
let y_offset = pressed * 1.0;
ui.painter().text(
    rect.center() + egui::vec2(0.0, y_offset),
    egui::Align2::CENTER_CENTER,
    label, font, color,
);
```

**Hover bg raise** — Interpolate between `tokens.surface` and `tokens.hover`:

```rust
let t = ctx.animate_bool_with_time(id, hovered, 0.06);
let bg = lerp_color(tokens.surface, tokens.hover, t);
painter.rect_filled(rect, radius::MD, bg);
```

with

```rust
fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let lerp_u8 = |x: u8, y: u8| -> u8 {
        (x as f32 + (y as f32 - x as f32) * t).round() as u8
    };
    Color32::from_rgba_premultiplied(
        lerp_u8(a.r(), b.r()), lerp_u8(a.g(), b.g()),
        lerp_u8(a.b(), b.b()), lerp_u8(a.a(), b.a()),
    )
}
```

**Focus ring** — 2px outline, fades in over 120ms when `response.has_focus()` becomes true. Draw as a rectangle stroke slightly expanded from the base rect with `tokens.primary_ring`:

```rust
let focus_t = ctx.animate_bool_with_time(id.with("focus"), response.has_focus(), 0.12);
if focus_t > 0.0 {
    let mut ring = tokens.primary_ring;
    let [r, g, b, a] = ring.to_array();
    ring = Color32::from_rgba_unmultiplied(r, g, b, (a as f32 * focus_t) as u8);
    painter.rect_stroke(rect.expand(2.0), radius::MD, egui::Stroke::new(2.0, ring), egui::StrokeKind::Outside);
}
```

---

## 3. Component Library

Each component below specifies: purpose, props/state, visual spec, egui implementation pattern, interaction states. Implement in `desktop/src/ui/widgets/`. Use free functions first; only promote to `Widget` trait if you need chaining.

### 3.1 Button

**Purpose.** Primary interactive element. Five variants × three sizes = 15 combinations.

**Props.**

```rust
pub struct Button<'a> {
    label: &'a str,
    variant: ButtonVariant,   // Primary, Secondary, Ghost, Destructive, Outline, Link
    size: ButtonSize,          // Sm (h=24), Md (h=28), Lg (h=32)
    icon: Option<&'a str>,     // emoji or unicode
    disabled: bool,
    full_width: bool,
}
```

**Visual spec.**

| Variant | Bg (rest) | Bg (hover) | Bg (pressed) | Text | Border |
|---|---|---|---|---|---|
| Primary | `primary` | `primary_hover` | `primary_pressed` | `primary_fg` | none |
| Secondary | `surface_elevated` | `hover` | `pressed` | `text` | `border` |
| Ghost | transparent | `hover` | `pressed` | `text` | none |
| Outline | transparent | `hover` | `pressed` | `text` | `border` |
| Destructive | `danger_subtle` | danger @ 20% | danger @ 30% | `danger` | none |
| Link | transparent | transparent (underline on hover) | — | `primary` | none |

Sizes (height / horizontal padding / text size):

| Size | Height | Pad-x | Text |
|---|---|---|---|
| `Sm` | 24 | 10 | 11–12 |
| `Md` | 28 | 10 | 13 |
| `Lg` | 32 | 12 | 13 |

Border radius `radius::MD` (6). Disabled: `ui.set_enabled(false)` + reduce alpha to 50%.

**Implementation skeleton.**

```rust
impl<'a> egui::Widget for Button<'a> {
    fn ui(self, ui: &mut egui::Ui) -> egui::Response {
        let tokens = ui.ctx().data(|d| d.get_temp::<ThemeTokens>(egui::Id::NULL)).unwrap();
        let height = self.size.height();
        let galley = ui.painter().layout_no_wrap(
            self.label.to_string(),
            FontId::proportional(self.size.text_size()),
            tokens.text,
        );
        let desired = egui::vec2(galley.size().x + self.size.pad_x() * 2.0, height);
        let (rect, response) = ui.allocate_exact_size(desired, egui::Sense::click());
        // paint bg using lerp_color(rest, hover, t) / lerp with pressed via two animations
        // paint border if variant requires
        // paint text centered
        // paint focus ring if has_focus
        response
    }
}
```

**Interaction.** Hover: animate to hover bg over 60ms. Pressed: animate to pressed bg + 1px text offset over 80ms. Focused: 2px primary ring expand(2) over 120ms.

### 3.2 IconButton

A square button. Same variants as Button. `size = IconSm(24), IconMd(28), IconLg(32)`. Takes an icon glyph instead of a label. Always has a tooltip.

```rust
pub fn icon_button(ui: &mut egui::Ui, icon: &str, tooltip: &str, size: IconSize) -> egui::Response {
    let r = /* allocate + paint as Ghost variant square */;
    r.on_hover_text(tooltip)
}
```

Use `response.on_hover_text_at_pointer` if you want the tooltip to follow the cursor; otherwise default tooltip positioning is fine.

### 3.3 Tabs / TabBar

**Purpose.** Editor tab strip. Each tab: icon, label (truncated with ellipsis), close button (visible on hover), dirty dot (unsaved marker).

**Props.** `tabs: &[TabInfo]`, `active: &TabId`, `on_select`, `on_close`, `on_reorder`.

**Visual spec.**

- Tab strip bg: `editor_tab_bar_bg`.
- Active tab: `tab_active_bg`, text `text`, top 2px strip in `primary` color.
- Inactive tab: `tab_inactive_bg`, text `text_secondary`.
- Hover (inactive): lerp to `hover`.
- Gap between tabs: 1px divider (`border`).
- Height: 32.
- Close button: 16×16, `Ghost` variant, appears on hover or when tab is dirty. On tab hover fade in opacity over 80ms.
- Overflow: horizontal `ScrollArea::horizontal().auto_shrink([false, true])` with styled scrollbar thumb 4px.

**Drag-reorder** — consider `egui_dnd` crate. If you want to stay dependency-light, implement a custom drag: on drag_started, track `drag_from_id`. On pointer move, find hovered tab's index, swap if different. Paint ghost tab at pointer. See `egui` docs for `Sense::drag()` and `response.drag_started()`.

For full dockable layout (not just tab reorder), `egui_dock` is the de-facto choice.

### 3.4 Dialog / Modal

**Purpose.** Centered modal with scrim and focus trap.

egui ships `egui::Window`. It is movable by default and has no scrim. You want it **modal**.

```rust
pub fn modal<R>(
    ctx: &egui::Context,
    id: egui::Id,
    open: &mut bool,
    title: &str,
    body: impl FnOnce(&mut egui::Ui) -> R,
) {
    if !*open { return; }

    let screen = ctx.screen_rect();
    let scrim_id = id.with("scrim");

    // 1) Scrim — paint before window
    let scrim_layer = egui::LayerId::new(egui::Order::Background, scrim_id);
    ctx.layer_painter(scrim_layer).rect_filled(
        screen, 0,
        Color32::from_black_alpha(140),
    );

    // 2) Window
    let t = ctx.animate_bool_with_time(id.with("anim"), true, 0.10);
    let scale = 0.95 + 0.05 * t;
    egui::Window::new(title)
        .id(id)
        .collapsible(false)
        .resizable(false)
        .movable(false)
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .fixed_size(egui::vec2(480.0 * scale, 0.0)) // autosize vertically
        .frame(egui::Frame::window(&ctx.style())
            .fill(tokens.surface_elevated)
            .stroke(egui::Stroke::new(1.0, tokens.border))
            .corner_radius(radius::XL)
            .shadow(egui::epaint::Shadow {
                offset: [0, 12], blur: 32, spread: 0,
                color: Color32::from_black_alpha(100),
            }))
        .show(ctx, |ui| {
            ui.style_mut().spacing.item_spacing = egui::vec2(0.0, 12.0);
            ui.add_space(4.0);
            ui.label(egui::RichText::new(title).size(16.0).strong());
            ui.add_space(4.0);
            body(ui);
        });

    // 3) Esc-to-close
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        *open = false;
    }

    // 4) Click scrim to close
    let pointer = ctx.input(|i| (i.pointer.any_pressed(), i.pointer.interact_pos()));
    if let (true, Some(pos)) = pointer {
        let win_rect = ctx.memory(|m| m.area_rect(id)).unwrap_or(egui::Rect::NOTHING);
        if !win_rect.contains(pos) {
            *open = false;
        }
    }
}
```

Focus trap: when modal is open, `ctx.memory_mut(|m| m.stop_text_input())` on open, and manually set `ctx.memory_mut(|m| m.request_focus(first_interactive_id))`. egui's Tab navigation will stay inside the open window's children.

### 3.5 Tooltip

egui has `response.on_hover_text("...")`. This is fine for most cases. For the frontend's arrow + background match, wrap:

```rust
pub fn tip(response: egui::Response, tokens: &ThemeTokens, msg: &str) -> egui::Response {
    response.on_hover_ui(|ui| {
        ui.style_mut().visuals.window_fill = tokens.text; // inverse
        ui.style_mut().visuals.override_text_color = Some(tokens.background);
        egui::Frame::none()
            .fill(tokens.text)
            .corner_radius(radius::SM)
            .inner_margin(egui::Margin::symmetric(8, 4))
            .show(ui, |ui| {
                ui.label(egui::RichText::new(msg).size(11.0));
            });
    })
}
```

Delay: egui uses a fixed ~0.5s hover delay for tooltips. To customize, track hover time yourself:

```rust
style.interaction.tooltip_delay = 0.4;
style.interaction.tooltip_grace_time = 0.3;
```

No arrow — faking a triangle arrow is `painter.add(egui::Shape::convex_polygon(points, fill, stroke))`. Not critical for parity; skip unless the design demands it.

### 3.6 ContextMenu

egui has `response.context_menu(|ui| { ... })` which opens a popup on right-click. Use it. Style once in `Theme::apply` via `style.visuals.menu_corner_radius`, `style.visuals.popup_shadow`, `style.spacing.menu_margin`.

For items:

```rust
pub fn menu_item(ui: &mut egui::Ui, label: &str, shortcut: Option<&str>, destructive: bool) -> bool {
    let text_color = if destructive { tokens.danger } else { tokens.text };
    let response = ui.add(egui::Button::new(
        egui::RichText::new(label).color(text_color)
    ).frame(false).min_size(egui::vec2(ui.available_width(), 22.0)));
    if let Some(sc) = shortcut {
        // paint shortcut on right
    }
    response.clicked()
}

pub fn menu_separator(ui: &mut egui::Ui) {
    ui.add_space(4.0);
    ui.separator();
    ui.add_space(4.0);
}
```

### 3.7 Input / TextField

**Visual spec.** Height 28, border 1px `border`, border on focus `primary`, radius `md`, bg `surface`. Placeholder `text_muted`. Error state: border `danger`, ring `danger_subtle`.

```rust
pub struct TextField<'a> {
    pub value: &'a mut String,
    pub label: Option<&'a str>,
    pub hint: Option<&'a str>,
    pub error: Option<&'a str>,
    pub placeholder: &'a str,
    pub prefix_icon: Option<&'a str>,
    pub suffix_icon: Option<&'a str>,
}

impl<'a> egui::Widget for TextField<'a> {
    fn ui(self, ui: &mut egui::Ui) -> egui::Response {
        ui.vertical(|ui| {
            if let Some(l) = self.label {
                ui.label(egui::RichText::new(l).size(11.0).color(tokens.text_secondary));
                ui.add_space(4.0);
            }
            // prefix icon layout via horizontal strip
            let r = ui.add(
                egui::TextEdit::singleline(self.value)
                    .hint_text(self.placeholder)
                    .desired_width(f32::INFINITY)
                    .margin(egui::vec2(10.0, 6.0))
                    .frame(true),
            );
            if let Some(err) = self.error {
                ui.add_space(4.0);
                ui.label(egui::RichText::new(err).size(11.0).color(tokens.danger));
            } else if let Some(h) = self.hint {
                ui.add_space(4.0);
                ui.label(egui::RichText::new(h).size(11.0).color(tokens.text_muted));
            }
            r
        }).inner
    }
}
```

To fully restyle the TextEdit's frame, you must set `style.visuals.widgets.inactive.bg_fill = tokens.surface` etc. in `Theme::apply`. TextEdit borrows `Visuals::selection` for highlight.

### 3.8 Select / Combobox

egui ships `ComboBox` — use it. Restyle via `visuals.widgets.open` for dropdown bg. The dropdown panel picks up `popup_shadow` and `menu_corner_radius`.

### 3.9 Checkbox / Switch / RadioGroup

- **Checkbox** — `ui.checkbox(&mut state, "label")`. Restyle box size via custom widget: 14×14 rounded square, primary fill when checked, white checkmark glyph (`\u{2713}`).
- **Switch** — no native. Implement: allocate `(36, 20)`, animate thumb position `animate_bool_with_time`, draw track (rounded pill) and circle thumb.
- **RadioGroup** — `ui.radio_value(...)` works. Restyle similarly.

Switch code:

```rust
pub fn switch(ui: &mut egui::Ui, on: &mut bool) -> egui::Response {
    let size = egui::vec2(36.0, 20.0);
    let (rect, mut resp) = ui.allocate_exact_size(size, egui::Sense::click());
    if resp.clicked() { *on = !*on; resp.mark_changed(); }
    let t = ui.ctx().animate_bool_with_time(resp.id, *on, 0.12);
    let track_color = lerp_color(tokens.surface_elevated, tokens.primary, t);
    ui.painter().rect_filled(rect, CornerRadius::same(10), track_color);
    let thumb_x = rect.left() + 2.0 + t * (rect.width() - 20.0);
    let thumb_center = egui::pos2(thumb_x + 8.0, rect.center().y);
    ui.painter().circle_filled(thumb_center, 8.0, Color32::WHITE);
    resp
}
```

### 3.10 ListItem / TreeItem

The file tree row. Full-width clickable, hover bg on whole row, 20px height, 12px text, optional icon on left, optional badge on right. Selected state: `primary_subtle` bg.

Current `desktop/src/ui/sidebar.rs::render_tree_node` already does this roughly — promote to a reusable widget.

```rust
pub struct ListRow<'a> {
    icon: Option<&'a str>,
    label: &'a str,
    selected: bool,
    badge: Option<(&'a str, Color32)>,
    indent: u8,
}
```

Guidelines:

- Height 22 (not 20 — easier to read).
- Full-width allocate (`ui.available_width()`) so hover bg goes edge-to-edge.
- Selected row: `primary_subtle` bg + 2px left accent strip in `primary`.
- Hover (not selected): `hover` bg, 60ms fade.

### 3.11 Card / Panel

`Frame::none().fill(surface).stroke(border).corner_radius(radius::LG).inner_margin(Margin::same(12)).shadow(soft)`. Create helper `fn card(ui, body)` that wraps.

### 3.12 StatusBar chips

Small pills with icon + text. Height 20, radius `sm`, bg `transparent`, hover `hover`. Clickable for panel toggles. Text size 11.

### 3.13 Toast / Notification

egui has no built-in toast. Use a dedicated overlay area:

```rust
egui::Area::new("toasts")
    .anchor(egui::Align2::RIGHT_BOTTOM, [-16.0, -16.0])
    .interactable(true)
    .show(ctx, |ui| {
        for toast in &mut state.toasts.iter_mut() {
            // render card with title, message, and optional action
        }
    });
```

Each toast: `surface_elevated` bg, `border` 1px, radius `lg`, 8px shadow. Slide-in from right using `animate_value_with_time` on x-offset. Auto-dismiss after 5s — track `created_at: Instant` and pop from the vec when elapsed > 5s. Request repaint every 100ms while toasts are visible (`ctx.request_repaint_after(Duration::from_millis(100))`).

### 3.14 ProgressBar

Determinate: `egui::ProgressBar::new(fraction).show_percentage().corner_radius(radius::SM)` — configure fill to `primary`. Height 6px for thin, 12px for normal.

Indeterminate: draw a 30% wide bar sliding left→right over 1200ms, loop. Use `ctx.input(|i| i.time)` modulo duration.

```rust
let w = rect.width();
let t = (ctx.input(|i| i.time) / 1.2).fract() as f32;
let bar_w = w * 0.3;
let x = -bar_w + (w + bar_w) * t;
painter.rect_filled(
    egui::Rect::from_min_size(egui::pos2(rect.left() + x, rect.top()), egui::vec2(bar_w, rect.height())),
    radius::SM,
    tokens.primary,
);
ctx.request_repaint();
```

### 3.15 Spinner

`egui::Spinner::new().size(16.0).color(tokens.primary)`. Wrap if you want a specific size constant.

### 3.16 Badge / Pill

Small inline tag. Text 10–11, bg variants:

- Neutral: `surface_elevated` bg, `text_secondary` text.
- Primary: `primary_subtle` bg, `primary` text.
- Success/Warning/Danger: `{s}_subtle` bg, `{s}` text.

Padding `(6, 2)`, radius `sm`.

For keyboard shortcut pills (welcome screen): monospace font, `surface_elevated` bg, `border` 1px, radius `sm`, text 11. E.g. `[⌘K]`.

```rust
pub fn kbd(ui: &mut egui::Ui, keys: &str) {
    egui::Frame::none()
        .fill(tokens.surface_elevated)
        .stroke(egui::Stroke::new(1.0, tokens.border))
        .corner_radius(radius::SM)
        .inner_margin(egui::Margin::symmetric(6, 2))
        .show(ui, |ui| {
            ui.label(egui::RichText::new(keys).size(11.0).monospace().color(tokens.text_secondary));
        });
}
```

### 3.17 Divider

`ui.add(egui::Separator::default().spacing(8.0))` — already styled via `visuals.widgets.noninteractive`. Vertical: `ui.separator()` inside a horizontal layout.

### 3.18 ScrollArea wrapper

Default egui scrollbars are draggable and visible. Match frontend: hidden by default, 6px wide on hover. egui 0.31 supports this via `ScrollStyle::solid()` and the new overlay style:

```rust
pub fn styled_scroll<R>(
    ui: &mut egui::Ui,
    id_source: impl std::hash::Hash,
    body: impl FnOnce(&mut egui::Ui) -> R,
) -> R {
    let mut style = ui.ctx().style().scroll_style;
    style.bar_width = 6.0;
    style.floating = true;
    style.bar_inner_margin = 2.0;
    style.interact_extra_width = 4.0;
    ui.scope(|ui| {
        ui.spacing_mut().scroll = style;
        egui::ScrollArea::vertical()
            .id_salt(id_source)
            .auto_shrink([false, false])
            .show(ui, body)
    }).inner.inner
}
```

For the tab-strip horizontal scroll, override to always visible, 4px, primary color thumb.

### 3.19 CommandPalette (⌘K)

A modal with a search input and filtered list of commands.

**Layout.** 480×(auto, max 420) centered, top 20% from screen top.

**Structure.**

```rust
pub struct CommandPaletteState {
    pub open: bool,
    pub query: String,
    pub selected: usize,
    pub commands: Vec<Command>,
}
```

- Input at top, auto-focused.
- List of results below (max ~8 visible), keyboard-nav: Up/Down, Enter to run, Esc to close.
- Use `fuzzy_matcher` crate or simple substring match.
- Selected row: `primary_subtle` bg + primary left strip.

Render inside `modal()` helper from §3.4. On open, call `ctx.memory_mut(|m| m.request_focus(query_id))`.

### 3.20 SlashCommandMenu (notes editor)

Inline popup triggered when the user types `/` at the start of a line in the notes editor. Same widget as ContextMenu but positioned relative to cursor. Use `egui::Area::new("slash_menu").fixed_pos(cursor_pos_in_screen)`.

### 3.21 SplitPane / ResizeHandle

egui's `SidePanel`/`TopBottomPanel` with `.resizable(true)` give you this for free. The resize handle is a thin invisible strip at the edge with a pointer-cursor affordance.

If you need split inside a panel (not just between panels), use `egui::Layout` with `allocate_at_least` and a manually-sensed drag handle:

```rust
pub fn horizontal_split<L, R>(
    ui: &mut egui::Ui, id: egui::Id,
    fraction: &mut f32,
    left: L, right: R,
) where L: FnOnce(&mut egui::Ui), R: FnOnce(&mut egui::Ui) {
    let total = ui.available_width();
    let left_w = (total * *fraction).clamp(120.0, total - 120.0);
    ui.horizontal(|ui| {
        ui.allocate_ui_with_layout(
            egui::vec2(left_w, ui.available_height()),
            egui::Layout::top_down(egui::Align::Min),
            left,
        );
        // 4px handle
        let (hrect, hresp) = ui.allocate_exact_size(
            egui::vec2(4.0, ui.available_height()),
            egui::Sense::drag(),
        );
        if hresp.hovered() || hresp.dragged() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
            ui.painter().rect_filled(hrect, 0, tokens.primary_ring);
        }
        if hresp.dragged() {
            *fraction = ((left_w + hresp.drag_delta().x) / total).clamp(0.1, 0.9);
        }
        ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), ui.available_height()),
            egui::Layout::top_down(egui::Align::Min),
            right,
        );
    });
}
```

---

## 4. Layout Patterns

### 4.1 Title bar

Current `desktop/src/ui/title_bar.rs` is close. Checklist:

- Height **36** (not 38) — matches frontend's `h-9`.
- Left cluster: app glyph (colored `primary`), "VoidLink" wordmark (strong 13pt), 1px divider, workspace selector (ComboBox, 160 width), truncated repo path (11pt, `text_muted`, ellipsis-truncated).
- Right cluster: theme picker (ComboBox 110 width), three window controls: min, max, close.
- Close button: red hover `#e83c3c`, white icon on hover. Already in current code — keep.
- Min/Max: `hover` bg only. Icons 12pt.
- Bottom border: 1px `border`.
- Drag region: entire bar except interactive widgets. The current implementation's broad StartDrag is OK but can accidentally drag on button clicks — tighten by only calling `StartDrag` when the pointer isn't on any interactive child.

### 4.2 Sidebar

Current code has the icon-rail + content pattern. Refinements:

- Icon rail width: 40 collapsed, 36 when expanded alongside content.
- Icon buttons 32×32 with `Ghost` variant styling, tooltip on hover.
- Active page: icon color `primary`, 2px left accent strip in `primary`. Use `painter.rect_filled` for the strip before icon paint.
- Content pane: 200–400 resizable. Default 240.
- Section header (e.g. "Explorer"): 13pt strong, `text`, padding 8px horizontal, bottom 4px. Divider below.
- Category groups (e.g. "Branches" inside Git): `ui.collapsing()` — but restyle the triangle. Use a custom `CollapsingHeader` that renders a chevron in `text_secondary`.

### 4.3 Center / tabbed workspace

- Tab bar top (see §3.3).
- Content area: editor, prompt studio, migration view, etc.
- Default to empty state when no tabs open: centered welcome screen with keyboard shortcuts (use `kbd` helper) and recent workspaces.

### 4.4 Right panel

Collapsible. Default width 300. Uses same frame style as sidebar (no rail, just content). Header 28px tall with title + close button.

### 4.5 Bottom pane

Terminal / output. `TopBottomPanel::bottom("bottom_pane").resizable(true).default_height(240.0)`. Tab strip at top using the same `TabBar` widget as editor.

### 4.6 Status bar

Height 22. Two clusters:

- Left: file name, cursor position ("Ln 42, Col 18"), language badge, git branch chip.
- Right: problems count, layout toggles (sidebar / right / bottom panel toggles as `IconButton`), version.

All entries are `chips` — 11pt, padding `(6, 2)`, hover `hover`, click to toggle.

---

## 5. Theme Matrix

**Tier-1 (ship now):** Dark, Light, Nord. Full sRGB tables in §1.2.

**Tier-2 (add later, same shape):**

| Theme | Primary | Background | Notes |
|---|---|---|---|
| GitHub Dark | `#58a6ff` | `#0d1117` | cooler blue; sidebar `#010409` (darker than bg) |
| GitHub Light | `#0969da` | `#ffffff` | sidebar `#f6f8fa` |
| Monokai | `#a6e22e` | `#272822` | green primary, yellow accent `#e6db74` |
| Solarized Dark | `#268bd2` | `#002b36` | dark teal bg |
| Solarized Light | `#268bd2` | `#fdf6e3` | cream bg |
| Dracula | `#bd93f9` | `#282a36` | purple primary |
| One Dark | `#61afef` | `#282c34` | blue-gray |

To add any: (1) create `desktop/src/theme/<name>.rs` with a `palette()` returning a `ThemeTokens`, (2) register in `Theme` enum's `ALL` and `palette()` match, (3) reference OKLch source in `frontend/src/themes.css` and convert with the [OKLch→sRGB converter](https://oklch.com) (or `palette` crate at runtime).

**Conversion shortcut**: for a one-shot run, use the `oklab` crate and a small helper in `build.rs`:

```rust
use oklab::{Oklch, srgb_from_oklab};
fn okch_to_srgb(l: f32, c: f32, h_deg: f32) -> [u8; 3] {
    let h = h_deg.to_radians();
    let oklab = oklab::Oklab { l, a: c * h.cos(), b: c * h.sin() };
    let srgb = srgb_from_oklab(oklab);
    [
        (srgb.r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (srgb.g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (srgb.b.clamp(0.0, 1.0) * 255.0).round() as u8,
    ]
}
```

### Theme switching

Single entry point, replacing current `Theme::apply`:

```rust
impl Theme {
    pub fn apply(&self, ctx: &egui::Context) {
        let tokens = self.tokens();
        // 1) stash tokens for widgets to read
        ctx.data_mut(|d| d.insert_temp(egui::Id::NULL, tokens));
        // 2) build Visuals from tokens
        let visuals = visuals_from_tokens(&tokens);
        ctx.set_visuals(visuals);
        // 3) build Style (fonts, spacing)
        let mut style = (*ctx.style()).clone();
        apply_spacing(&mut style);
        apply_text_styles(&mut style);
        ctx.set_style(style);
        // 4) request one full repaint
        ctx.request_repaint();
    }
}
```

`ctx.data()` lets any widget retrieve the tokens without threading them through every function signature:

```rust
let tokens: ThemeTokens = ui.ctx()
    .data(|d| d.get_temp(egui::Id::NULL))
    .unwrap_or_default();
```

---

## 6. Font Embedding

Add to `desktop/Cargo.toml`:

```toml
[dependencies]
eframe = "0.31"
# no extra font crates needed — ab_glyph ships with eframe
```

Place fonts in `desktop/assets/fonts/`. Register in `main.rs` before building the app:

```rust
fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();

    fonts.font_data.insert(
        "GeistRegular".to_string(),
        egui::FontData::from_static(include_bytes!("../assets/fonts/Geist-Regular.ttf")).into(),
    );
    fonts.font_data.insert(
        "GeistMedium".to_string(),
        egui::FontData::from_static(include_bytes!("../assets/fonts/Geist-Medium.ttf")).into(),
    );
    fonts.font_data.insert(
        "GeistSemiBold".to_string(),
        egui::FontData::from_static(include_bytes!("../assets/fonts/Geist-SemiBold.ttf")).into(),
    );
    fonts.font_data.insert(
        "GeistMonoRegular".to_string(),
        egui::FontData::from_static(include_bytes!("../assets/fonts/GeistMono-Regular.ttf")).into(),
    );

    // Proportional family: Regular first, fall back to egui default for emoji/CJK glyphs
    fonts.families
        .entry(egui::FontFamily::Proportional)
        .or_default()
        .insert(0, "GeistRegular".to_string());

    // Monospace family
    fonts.families
        .entry(egui::FontFamily::Monospace)
        .or_default()
        .insert(0, "GeistMonoRegular".to_string());

    // Named families for heavier weights (use in headings, emphasis)
    fonts.families.insert(
        egui::FontFamily::Name("GeistMedium".into()),
        vec!["GeistMedium".into(), "GeistRegular".into()],
    );
    fonts.families.insert(
        egui::FontFamily::Name("GeistSemiBold".into()),
        vec!["GeistSemiBold".into(), "GeistRegular".into()],
    );

    ctx.set_fonts(fonts);
}
```

Call from the eframe `CreationContext` closure in `main.rs` before applying the theme.

**Fallback chain** (the default egui fonts `Hack`, `Ubuntu-Light`, `NotoEmoji-Regular`, `emoji-icon-font` remain at the end of each family). They cover emoji + symbols used in the current title bar (`\u{2715}`, `\u{25A1}`, `\u{2500}`).

**License.** Geist is Open Font License (OFL-1.1). Embedding via `include_bytes!` is permitted. Include a `NOTICE` block in the repo root or `desktop/assets/fonts/LICENSE.txt`.

---

## 7. Snappy UX Requirements

### 7.1 Frame discipline

- Idle: don't paint. egui already does this unless something requests repaint.
- During animations: call `ctx.request_repaint()` (the `animate_*_with_time` helpers do this for you).
- Long-running work (file scan, git status, search): **never** on the UI thread. Spawn a `std::thread` or `tokio` task (the core crate uses tokio) and channel results back via `crossbeam_channel` or `std::sync::mpsc`. Poll the channel each frame; on new message, apply + repaint.

```rust
// Worker pattern
pub struct AsyncWork<T> {
    rx: crossbeam_channel::Receiver<T>,
}
impl<T: Send + 'static> AsyncWork<T> {
    pub fn spawn(ctx: egui::Context, f: impl FnOnce() -> T + Send + 'static) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        std::thread::spawn(move || {
            let result = f();
            let _ = tx.send(result);
            ctx.request_repaint(); // wake UI
        });
        Self { rx }
    }
    pub fn poll(&self) -> Option<T> { self.rx.try_recv().ok() }
}
```

### 7.2 Large lists — `ScrollArea::show_rows`

For the file tree with thousands of rows, terminal scrollback (100k lines), search results, migration graph nodes:

```rust
egui::ScrollArea::vertical()
    .auto_shrink([false, false])
    .show_rows(ui, row_height, items.len(), |ui, row_range| {
        for i in row_range {
            render_item(ui, &items[i]);
        }
    });
```

egui computes visible rows from scroll offset and only calls your closure for those. `row_height` must be constant. For variable-height rows, use `show_viewport` and track cumulative y-offsets yourself.

### 7.3 Virtualization thresholds

| Surface | Threshold | Strategy |
|---|---|---|
| File tree | >500 visible rows (after expand) | `show_rows` with 22px constant height |
| Terminal history | >1000 lines | `alacritty_terminal` grid + visible-window render only |
| Search results | >200 matches | `show_rows` + lazy-fetch line context |
| Migration graph | >2000 nodes | viewport culling — only paint nodes inside `ui.clip_rect()` |

### 7.4 Debounce expensive work

```rust
pub struct Debouncer { last_change: Option<Instant>, delay: Duration }
impl Debouncer {
    pub fn touch(&mut self) { self.last_change = Some(Instant::now()); }
    pub fn ready(&mut self) -> bool {
        if let Some(t) = self.last_change {
            if t.elapsed() >= self.delay {
                self.last_change = None;
                return true;
            }
        }
        false
    }
}
```

Use on text input for search / filter: touch on every keystroke, check each frame, run the query when ready. 150ms is a good default.

---

## 8. Accessibility

### 8.1 Keyboard navigation

- **Tab / Shift+Tab** — native in egui. Every `Button`, `TextEdit`, `Checkbox` is Tab-navigable. Custom widgets must opt in via `Sense::focusable_noninteractive()` or by returning a `Response` with `sense` including `Sense::click()`.
- **Arrow keys in lists/menus** — not automatic. In `CommandPalette`, ContextMenu, Tab bar, you must handle them:
  ```rust
  if ctx.input(|i| i.key_pressed(egui::Key::ArrowDown)) { state.selected += 1; }
  if ctx.input(|i| i.key_pressed(egui::Key::ArrowUp))   { state.selected = state.selected.saturating_sub(1); }
  if ctx.input(|i| i.key_pressed(egui::Key::Enter))     { /* run */ }
  ```
- **Escape** — close dialog / popover / context menu. Consume via `ctx.input_mut(|i| i.consume_key(...))`.

### 8.2 Focus-visible ring

See §2.3. Always render the ring — don't hide it behind "only when Tab was used." egui's `response.has_focus()` is true whether focus arrived via click or Tab, which is acceptable.

### 8.3 AccessKit

egui integrates AccessKit (the platform accessibility bridge). It is enabled by default in eframe as of 0.27+. Verify in your `eframe::NativeOptions`:

```rust
NativeOptions { viewport: ViewportBuilder::default(), ..Default::default() }
```

Custom widgets should set their `Response` role via:

```rust
response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, enabled, label));
```

Call inside your widget `ui()` method just before returning the response.

---

## 9. Phased Rollout Checklist

Each phase has: **Files**, **LOC target**, **Done means**, **Verification**.

### Phase A — Foundations (fonts + tokens + base Visuals)

- **Files:** `desktop/src/theme/tokens.rs` (new), `desktop/src/theme/dark.rs`, `desktop/src/theme/light.rs`, `desktop/src/theme/nord.rs` (rewrite), `desktop/src/theme/mod.rs` (refactor), `desktop/src/main.rs` (install_fonts), `desktop/assets/fonts/*.ttf` (new).
- **LOC:** ~600 new, ~150 changed.
- **Done:**
  - `ThemeTokens` with 57 fields populated for Dark, Light, Nord.
  - Geist regular/medium/semibold + Geist Mono embedded.
  - `Theme::apply` sets visuals, text styles, spacing from tokens.
  - `ctx.data` carries the active `ThemeTokens`.
- **Verify:** Run the app. Switch themes via the title bar combobox. Confirm all surfaces repaint. Confirm body text is Geist (compare vs screenshot of frontend at same zoom).

### Phase B — Primitive widgets

- **Files:** `desktop/src/ui/widgets/mod.rs` (new), `desktop/src/ui/widgets/button.rs`, `desktop/src/ui/widgets/input.rs`, `desktop/src/ui/widgets/badge.rs`, `desktop/src/ui/widgets/tooltip.rs`, `desktop/src/ui/widgets/spinner.rs`, `desktop/src/ui/widgets/switch.rs`, `desktop/src/ui/widgets/kbd.rs`.
- **LOC:** ~900 new.
- **Done:** Each widget matches §3.1–3.9, 3.16, 3.18. Each has a short `examples` rustdoc block.
- **Verify:** Create `desktop/src/ui/widgets/gallery.rs` (debug-only) that renders all variants. Screenshot vs frontend equivalents side-by-side.

### Phase C — Layout primitives

- **Files:** `desktop/src/ui/widgets/card.rs`, `desktop/src/ui/widgets/divider.rs`, `desktop/src/ui/widgets/scroll.rs`, `desktop/src/ui/widgets/list_row.rs`.
- **LOC:** ~400 new.
- **Done:** `card()` helper, `styled_scroll()` helper, `ListRow` widget. Reuse in sidebar and git panel.
- **Verify:** File tree uses `ListRow` and shows hover / selected states matching frontend.

### Phase D — Complex widgets

- **Files:** `desktop/src/ui/widgets/modal.rs`, `desktop/src/ui/widgets/context_menu.rs`, `desktop/src/ui/widgets/tabs.rs`, `desktop/src/ui/widgets/command_palette.rs`, `desktop/src/ui/widgets/toast.rs`.
- **LOC:** ~1200 new.
- **Done:**
  - `modal()` with scrim, focus trap, Esc close.
  - `TabBar` with close buttons, overflow scroll, drag-reorder (minimum: swap adjacent by drag).
  - `CommandPalette` with fuzzy filter and keyboard nav.
  - Toast overlay with auto-dismiss and slide-in animation.
- **Verify:** Cmd+K opens palette and filters commands at interactive rate (<16 ms/frame with 1000 commands).

### Phase E — Motion pass

- **Files:** every widget — sprinkle `animate_bool_with_time` where a static state is shown.
- **LOC:** ~300 changed.
- **Done:** Hover transitions (60ms), button press (80ms), focus ring (120ms), tab switch (140ms), dialog (100ms in, 60ms out), panel collapse (180ms) all use animated lerps instead of hard snaps.
- **Verify:** Record screen at 60fps while clicking around, compare perceived snappiness to frontend recording.

### Phase F — Theme matrix fill-out

- **Files:** `desktop/src/theme/github_dark.rs`, `github_light.rs`, `monokai.rs`, `solarized_dark.rs`, `solarized_light.rs`, `dracula.rs`, `one_dark.rs`.
- **LOC:** ~60 per theme × 7 = ~420.
- **Done:** `Theme::ALL` enumerates all 10. Title bar combo shows all 10.
- **Verify:** Iterate through each theme — confirm no theme has a "missing" color (default-constructed token). Run clippy + cargo test.

---

## Appendix — Quick Reference

### Where the frontend defines it → where it goes in egui

| Frontend | egui |
|---|---|
| `frontend/src/index.css` tokens | `desktop/src/theme/tokens.rs` + `dark.rs`, `light.rs` |
| `frontend/src/themes.css` | `desktop/src/theme/<theme>.rs` files |
| `@fontsource-variable/geist` | `desktop/assets/fonts/Geist-*.ttf` + `install_fonts` |
| Tailwind `rounded-lg` | `radius::MD` (6) |
| Tailwind `h-8 px-2.5` | `button_padding + height` via `ButtonSize::Md` |
| `data-[highlighted]:bg-accent` | `Response.hovered()` + `lerp_color` + animate_bool_with_time |
| `active:translate-y-px` | 1px text offset while `is_pointer_button_down_on()` |
| `focus-visible:ring-3` | 2px stroke outside rect, animated alpha |
| Kobalte Dialog | `modal()` helper (§3.4) |
| Kobalte ContextMenu | `response.context_menu()` + styled items |
| Kobalte Tooltip | `response.on_hover_text` / `on_hover_ui` |
| `backdrop-filter: blur` | Not available — use faux-glass (§1.7) |
| `box-shadow: 0 4px 12px` | `Shadow { offset: [0, 4], blur: 12, .. }` + `soft_shadow` helper |
| `tw-animate-css` fade/zoom | `animate_bool_with_time` on scale/opacity |
| CSS `transition-colors` 60ms | `lerp_color` over 0.06 s |
| `ScrollArea` w/ hidden scrollbar | `styled_scroll` with `floating: true` and `bar_width: 6.0` |

### Things to never do

- Hard-code hex codes in widget code. Always pull from `ThemeTokens`.
- Block the UI thread on file I/O, git commands, or HTTP. Always go through a worker.
- Use `std::thread::sleep` anywhere in the UI loop.
- Build a custom easing function until you've confirmed the built-in `animate_*` looks visibly wrong at the intended duration.
- Ship a theme with default-constructed `Color32::default()` fields. Audit each theme file to ensure every field is explicit.
- Try to replicate real backdrop blur. Ship faux-glass or solid. Move on.
