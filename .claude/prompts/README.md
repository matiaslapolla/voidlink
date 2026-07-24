# Implementation prompts — macOS shell + workspace/worktree restructure

Four parallel work streams, each a self-contained prompt for a fresh coding agent.
Written 2026-07-24 from the original 8-task brief.

## The streams

| # | Prompt | Branch | Covers | Size |
|---|--------|--------|--------|------|
| A | [macos-shell.md](macos-shell.md) | `feat/macos-shell` | Tasks 1, 2, 3 — icon geometry, rounded window, native title bar, `isMac` helper | small |
| B | [workspace-worktree-layout.md](workspace-worktree-layout.md) | `feat/workspace-worktree-layout` | Task 4 — workspaces → worktrees → tabs, vertical rail, new-worktree wizard, browser tab | large |
| C | [settings-ai-keys.md](settings-ai-keys.md) | `feat/settings-ai-keys` | Tasks 5, 6 — keychain-backed AI keys, settings section, sentence-case sweep | medium |
| D | [shortcuts-and-docs.md](shortcuts-and-docs.md) | `feat/shortcuts-and-docs` | Tasks 7, 8 — single-source keymap, cheat sheet, per-feature docs | medium |

## Merge order: A → C → B → D

- **A first** — smallest diff, and it introduces `frontend/src/api/platform.ts` (`isMac`) which D needs for accelerator rendering.
- **C second** — touches `SettingsDialog.tsx`, `settings.ts`, and a scatter of one-line uppercase removals. Merging it early keeps the sweep from colliding with B's new components.
- **B third** — by far the largest diff (`store/layout.ts`, `AppShell`, `MainSurface`, new rail + wizard + Rust module). Rebase it onto A and C rather than the reverse.
- **D last** — touches `App.tsx` and `registry.ts`, which B also rewrites; and its feature docs should describe the post-B UI.

## Worktrees

`.worktrees/` is already gitignored (`.gitignore:38`), so the checkouts stay inside the repo without polluting git status.

```bash
cd /Users/matiaslapolla/Developer/personal/voidlink
git worktree add .worktrees/macos-shell               -b feat/macos-shell
git worktree add .worktrees/workspace-worktree-layout -b feat/workspace-worktree-layout
git worktree add .worktrees/settings-ai-keys          -b feat/settings-ai-keys
git worktree add .worktrees/shortcuts-and-docs        -b feat/shortcuts-and-docs
```

Each worktree needs its own `frontend/node_modules` (`cd frontend && npm install`); `src-tauri/target` is per-worktree too, so the first `cargo check` in each is slow.

Clean up when a stream lands:

```bash
git worktree remove .worktrees/<name>
```

## Two decisions worth remembering

1. **The README's "No API keys" claim becomes untrue.** Stream C stores real provider keys in the macOS Keychain (never localStorage, never returned to the frontend) and injects them as env vars into the AI CLI voidlink already spawns. C is responsible for correcting the README rather than leaving the overclaim in place.
2. **The cmux-style browser tab needs Tauri's `unstable` feature.** Multiwebview child webviews are behind a Cargo feature flag on `tauri`, need `core:webview:*` capability entries, and always paint above the DOM — so an inactive browser tab must be explicitly hidden or it covers dialogs. It is phase 5 of stream B, separable, with an explicit instruction to stop and report rather than silently falling back to an iframe.
