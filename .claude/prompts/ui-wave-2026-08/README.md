# UI wave — August 2026

Six self-contained prompts for fresh coding agents, written 2026-08-07 from a ten-item
brief. Each file's fenced `text` block is the prompt: paste the block, not the file.

## The streams

| # | Prompt | Branch | Covers (brief item) | Size |
|---|--------|--------|---------------------|------|
| A | [A-vertical-tabs-and-titlebar.md](A-vertical-tabs-and-titlebar.md) | `fix/vertical-tabs-editor` | 10 — editor split-view bug + markdown-preview icon placement; 4 — window-icon alignment | small |
| B | [B-pane-resize-gaps.md](B-pane-resize-gaps.md) | `feat/pane-resize-gaps` | 5 — TerminalSidebar sections, editor sidebar width, editor split fraction | small–medium |
| C | [C-sidebar-docking-and-detach.md](C-sidebar-docking-and-detach.md) | `feat/sidebar-docking` | 8 — files/git as two sidebars in vertical tabs; 9 — per-sidebar dock side + detach to a child window; 3 — collapsible workspace rail with an icon | large |
| D | [D-surface-contrast-tokens.md](D-surface-contrast-tokens.md) | `feat/surface-contrast-tokens` | 2 — per-region surface tokens, retuned defaults, derived named themes | medium–large |
| E | [E-privacy-and-backgrounds.md](E-privacy-and-backgrounds.md) | `feat/privacy-and-backgrounds` | 1 — per-workspace screencast blur; 7 — graded transparency + custom background image (+ native-transparency research doc) | medium |
| F | [F-ghostty-terminal-plan.md](F-ghostty-terminal-plan.md) | `docs/ghostty-plan` | 6 — plan to replace xterm.js with Ghostty's VT engine, incl. the settings surface | doc only |

## Merge order: A → B → C → D → E

- **A first.** Smallest diff, and it fixes the vertical-tab orientation that C then
  builds on. Shipping C's two-sidebar layout on a broken orientation would hide which
  change caused what.
- **B second.** Touches `Splitter` callers and `store/layout/prefs.ts`; landing it before
  C means C inherits one persistence shape instead of racing it.
- **C third.** By far the largest diff — `AppShell`, `App.tsx`, `store/layout/*`,
  `api/windows.ts`, `main.tsx`. Rebase it onto A and B rather than the reverse.
- **D fourth.** Sweeps class names across most components; running it after the layout
  moves avoids re-tinting components C is about to relocate.
- **E last.** Consumes D's surface tokens for the translucency mix.
- **F is independent** — documentation only, no source files touched. Run it any time,
  including in parallel with everything above.

## Decisions already made (don't re-litigate in the prompts)

- **Privacy** is per-workspace CSS blur, not app-wide redaction and not placeholder names.
- **Transparency** is a CSS layer only. The native `transparent: true` / vibrancy path is
  written up as `docs/decisions/native-window-transparency.md` in Stream E and left
  unimplemented, to try if the CSS layer isn't convincing.
- **Detachable** means a real Tauri child window, plus left/right edge docking. No
  in-window floating panels, no top/bottom edges.
- **Tokens** are retuned by hand for default dark and default light only; the eight named
  themes derive from the new scale rather than being hand-authored ten times.
- **Ghostty** is a plan, not an implementation.

## Worktrees

`.worktrees/` is gitignored, so the checkouts stay inside the repo.

```bash
cd /Users/matiaslapolla/Developer/personal/voidlink
git worktree add .worktrees/vertical-tabs-editor   -b fix/vertical-tabs-editor
git worktree add .worktrees/pane-resize-gaps       -b feat/pane-resize-gaps
git worktree add .worktrees/sidebar-docking        -b feat/sidebar-docking
git worktree add .worktrees/surface-contrast       -b feat/surface-contrast-tokens
git worktree add .worktrees/privacy-backgrounds    -b feat/privacy-and-backgrounds
git worktree add .worktrees/ghostty-plan           -b docs/ghostty-plan
```

Each worktree needs its own `frontend/node_modules` (`cd frontend && npm install`), and
`src-tauri/target` is per-worktree, so the first `cargo check` in each is slow.

```bash
git worktree remove .worktrees/<name>
```
</content>
