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
| [Workspaces, worktrees, panes and tabs](./workspaces-and-tabs.md) | The four containers, splitting, MRU and jump-to-N, zen and maximize, tab activity and escalation, what persists where |

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
| [Event log](./event-log.md) | The append-only record of agent turns, commits and commands; its schema, attribution, and the timeline that reads it |
| [Mission Control](./mission-control.md) | The Lineup across every workspace, automatic check-ins, and hill charts |
| [Agent orchestration](./agent-orchestration.md) | Annotated diffs, fan-out to N worktrees, and "when X, run agent Y" |
| [Notifications and sound](./notifications.md) | OS banners and sound cues as a policy over the event log; the matrix, suppression, coalescing |
| [Secret scan](./secret-scan.md) | Pre-commit credential detection, the rule set, why it fails open |
| [Workspace snapshots](./snapshots.md) | Saving and restoring tab layouts, and what they don't capture |
| [Brain vault browser](./brain-vault.md) | Reading a `brain-kb` vault, quick capture, the `brain` CLI |
| [Embedded browser](./browser.md) | Browser tabs as child webviews, in-place navigation, history, the compositing constraint |

## Contributing

| Page | Covers |
|---|---|
| [Testing](./testing.md) | The two vitest projects, writing render tests, what belongs where |

## Configuration

| Page | Covers |
|---|---|
| [Settings](./settings.md) | Every tab, every key, where each one persists |
| [Themes](./themes.md) | The ten palettes, how one is applied, the token set |

## Not documented here

Deliberate omissions, so you know they're absent on purpose rather than
forgotten:

- **Leaf UI** — toasts, buttons, context menus, and the operation banner.
  They're described inside the feature pages that use them. The status bar is
  now a segment registry; its priority and overflow rules are under
  [workspaces, worktrees, panes and tabs](./workspaces-and-tabs.md).
- **The file tree.** Its behaviour is straightforward and its two interesting
  affordances (compare-with-default-branch, drag to terminal) are covered under
  [branch compare](./branch-compare.md) and [terminal](./terminal.md).
- **Leaf UI of the shell itself** — the splitter, the drop targets, the MRU
  overlay. Their behaviour is described under
  [workspaces, worktrees, panes and tabs](./workspaces-and-tabs.md).
- **Anything not yet on `main`.**
