# Feature reference

Per-feature reference documentation, written against the source. Each page
covers what the feature does, when you'd reach for it, how to use it, its
keyboard shortcuts, and — at length — its real gotchas and limits.

These are reference pages, not a tutorial. For a guided walkthrough in Spanish,
see [`../manual-de-uso.md`](../manual-de-uso.md). For design documents behind
individual features, see [`../specs/`](../specs).

## Core

| Page | Covers |
|---|---|
| [Keyboard shortcuts](./keyboard-shortcuts.md) | The full keymap, how the matcher works, binding scopes, adding a binding |
| [Command palette and file finder](./command-palette.md) | `Mod+K`, `Mod+P`, prompts, toasts, fuzzy matching, overlay stacking |
| [Editor and markdown preview](./editor-and-preview.md) | Monaco hosting, language detection, saving, the preview pipeline |
| [Terminal](./terminal.md) | PTY spawning, the environment rebuild, xterm addons, deep links |

## Git

| Page | Covers |
|---|---|
| [Git window](./git-window.md) | The standalone git client window and how it stays in sync |
| [Staging and hunk-level apply](./git-staging.md) | Status, stage/unstage, commit, amend, commit identity, hunk staging and discard, stash creation |
| [Branches, safe checkout, and sync](./branches-and-sync.md) | Branch CRUD, auto-stash on switch, fetch/pull/push, remotes, auth |
| [Branch compare](./branch-compare.md) | Two-ref diffing, merge-base mode, the changed-file tree |
| [Commit graph](./commit-graph.md) | The DAG view and the lane-assignment algorithm |
| [Inline blame](./blame.md) | Per-line authorship overlay in the editor |
| [Conflict resolution](./conflicts.md) | Operation detection, the conflict tab, continue and abort |
| [Merge, rebase, cherry-pick, revert, reset, stash, tags](./history-rewriting.md) | Everything that moves or rewrites refs |
| [Stacked PRs](./stacked-prs.md) | Stack metadata, restack, submit to GitHub |
| [Worktrees](./worktrees.md) | Listing, status badges, creating, removing |

## AI and tooling

| Page | Covers |
|---|---|
| [AI commit and repo agent](./ai-commit-and-agent.md) | The bring-your-own-CLI bridge, prompt assembly, failure modes |
| [Secret scan](./secret-scan.md) | Pre-commit credential detection, the rule set, why it fails open |
| [Workspace snapshots](./snapshots.md) | Saving and restoring tab layouts, and what they don't capture |
| [Brain vault browser](./brain-vault.md) | Reading a `brain-kb` vault, quick capture, the `brain` CLI |
| [Embedded browser](./browser.md) | Browser tabs as child webviews, in-place navigation, history, the compositing constraint |

## Configuration

| Page | Covers |
|---|---|
| [Settings](./settings.md) | Every tab, every key, where each one persists |
| [Themes](./themes.md) | The ten palettes, how one is applied, the token set |

## Not documented here

Deliberate omissions, so you know they're absent on purpose rather than
forgotten:

- **Leaf UI** — toasts, buttons, context menus, the status bar, and the
  operation banner. They're described inside the feature pages that use them.
- **The file tree.** Its behaviour is straightforward and its two interesting
  affordances (compare-with-default-branch, drag to terminal) are covered under
  [branch compare](./branch-compare.md) and [terminal](./terminal.md).
- **The workspace and tab model itself.** Worth its own page; not written yet.
- **Anything not yet on `main`.** These pages describe the shipped
  workspace-tab-bar UI.
