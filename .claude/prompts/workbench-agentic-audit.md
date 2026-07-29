<context>
VoidLink's workbench shell has been built out fast: a workspace rail, a split pane tree,
tab strips with drag and activity escalation, a priority-ordered status bar registry, a
command palette, a file finder, two quick-switchers, snapshots, an LSP-backed editor
window, a git sidebar and a BYO-CLI repo agent panel. Each part was designed well in
isolation. Nobody has yet asked the whole-surface question: given that the user is
increasingly *supervising agents* rather than typing every character, which of these
parts still earn their space, which are vestigial imports of the VS Code model, and what
is missing entirely.

This slice is that audit. The output is a written, ranked proposal — the input to the
next several implementation slices, not an implementation itself.

<task>
Audit every part of the workbench module and write a ranked add/keep/cut proposal to
`docs/specs/2026-07-29-workbench-100x.md`. **Write no production code.** No changes
under `frontend/src/` or `src-tauri/src/`; the only file this slice creates is the spec.

Read before judging. Cover, at minimum, each of these surfaces, naming the real file
behind each verdict:

- the workspace rail and the workspace → worktree model
- the pane split tree, its 4-group cap, drag/drop and the two-layer render
- the tab strip: tab kinds, pinning, preview tabs, MRU, closed-tab history
- the activity model and `escalate()` — what signals exist, what an agent produces that
  has no signal today
- the status bar segment registry, its priorities and overflow
- the command palette, file finder, tab switcher, worktree switcher, `QuickPick`
- keybindings, the keymap and its scope model
- snapshots and session restore
- the terminal sidebar, the PTY watch and terminal tabs
- the git sidebar, the changes pane and the git window
- the editor window: groups, breadcrumbs, LSP, find-in-files, external change detection
- the agent panel, its grounding sources and its BYO-CLI adapter
- the settings dialog and the empty-state registry
- focus modes: zen and maximize-pane

For each surface, answer three questions concretely:
1. **What does it cost?** Screen space, a keybinding, a persisted key, maintenance
   surface, a concept the user has to hold.
2. **What does it earn** in a session where three agents are running in three worktrees
   and the user is reviewing more than authoring?
3. **What would it be instead**, if it were designed for that session from scratch?

Then the additions. Be genuinely inventive here, and ground every idea in this
codebase's own primitives rather than in what other editors ship. Directions worth
pushing on — not a checklist, and not a ceiling:

- **Agent presence as a first-class signal.** `store/activity.ts` models per-tab
  signals; an agent working in a worktree the user is not looking at is exactly the
  "activity is never invisible" case (MASTER §7.5.3) and has no representation at all.
  What does the rail, the strip and the status bar look like when agents are things that
  have state?
- **Multi-worktree supervision.** Every tab surface is scoped to one worktree. What is
  the cross-worktree view — a board, an inbox, a diff queue — and what does it cost?
- **Review as the primary verb.** The workbench optimises for opening files. If the
  dominant action becomes "read a diff an agent produced, accept or redirect", which
  surfaces move to the centre and which move off-screen?
- **Provenance.** Which change came from which agent turn, and can the user see that
  where they see the change (git sidebar, blame overlay, tab strip) rather than in a
  chat log?
- **The palette as the command surface for agents**, not just for app actions.
- **Interruption economics.** What earns a toast, what earns a status segment, what
  earns nothing — under three concurrent agents, today's thresholds are probably wrong.
- **What to cut.** Name things honestly: a tab kind nobody opens, a keybinding that
  shadows a better one, a persisted key that outlived its feature, a pane that a status
  segment could replace. A proposal with no cuts is not an audit.

Structure the spec as: a one-paragraph thesis; **Keep** / **Cut** / **Add** sections;
then a ranked table of every proposal with leverage (what it unlocks), cost (rough size
and the files it touches), risk, and dependencies between items. Rank by leverage ÷
cost, and say which three you would build first and why. Where a proposal conflicts with
an existing design-system rule in `frontend/design-system/MASTER.md`, say so and argue
it rather than quietly contradicting it. Follow the house spec style in
`docs/specs/2026-05-05-branch-compare-design.md`.

Where a proposal depends on a Tauri, Monaco, xterm or libgit2 capability, check it with
context7 before proposing it — a ranked list containing an item that cannot be built is
worse than a shorter list.
</task>

<reuse>
Read these; they are the evidence base. Do not modify any of them.
- `frontend/design-system/MASTER.md` — the rules a proposal must argue with, especially
  §7.1 motion, §7.5.3 activity/liveness, §7.6 affordances, §11.5 identity risks.
- `docs/features/` — twenty-two feature docs, notably `workspaces-and-tabs.md`,
  `keyboard-shortcuts.md`, `command-palette.md`, `ai-commit-and-agent.md`,
  `snapshots.md`, `git-staging.md`, `terminal.md`, `browser.md`.
- `docs/specs/2026-05-05-branch-compare-design.md` — the house spec format.
- `frontend/src/store/layout/` — `panes.ts`, `tabs.ts` (`TAB_SPECS`, ten kinds),
  `navigation.ts`, `prefs.ts`, `persistence.ts`, `state.ts`, `workspaces.ts`.
- `frontend/src/store/activity.ts` and `terminalWatch.ts` — the signal model.
- `frontend/src/components/layout/` — `MainSurface.tsx`, `TabStrip.tsx`,
  `StatusBar.tsx`, `statusSegments.ts`, `WorkspaceRail.tsx`, `emptyStates.ts`,
  `freshness.ts`, `SnapshotManager.tsx`, `paneDrop.ts`.
- `frontend/src/commands/` — `registry.ts`, `actionIds.ts`, `keymap.ts`,
  `CommandPalette.tsx`, `QuickPick.tsx`, `fuzzy.ts`, `snapshots.ts`, `agent.ts`.
- `frontend/src/components/agent/AgentPanel.tsx` — the grounded repo agent and its
  source-attribution trail.
- `frontend/src/components/git/GitSidebar.tsx`, `changesNav.ts` — the review surface.
- `frontend/src/components/editor/` — `editorGroups.ts`, `lspBridge.ts`,
  `externalChanges.ts`, `documentSymbols.ts`.
- `.claude/prompts/README.md`, `workbench-100x.md`, `editor-100x.md` — the prior briefs,
  so the audit builds on them instead of re-proposing what already shipped.
- `git log --oneline -60` — what landed recently and what its commit bodies say was
  deliberately deferred. Several commits name unfinished edges explicitly (a `failed`
  activity signal that is unwired because `pty-exit` carries a unit payload, for one);
  harvest them.
</reuse>

<constraints>
- Read-only. The single writable path is `docs/specs/2026-07-29-workbench-100x.md`.
  Create no branch, run no migration, edit no source file, add no dependency.
- Every verdict names the file it applies to. A proposal that cannot name where it lands
  is not ranked, it is cut.
- Reuse before invent applies to the *proposals*: prefer extending `activity.ts`,
  `statusSegments.ts`, `registry.ts`, `QuickPick.tsx` and `panes.ts` over new parallel
  systems, and say which primitive each addition builds on.
- Check any library-dependent proposal against context7 before including it. Pinned:
  `tauri` =2.11.2 (`unstable` feature, multiwebview), `monaco-editor` ^0.55.1,
  `@xterm/xterm` ^6.0.0, `git2` 0.19, `solid-js` ^1.9.7.
- Rank everything you find; do not silently drop a low-severity or awkward finding.
  Dropping an item is a decision that needs a stated reason in the spec.
- Two proposals are in flight and must not be re-proposed as new: workbench layout
  grouping (named tab groups, layout presets, raising the group cap, auto-grouping) and
  VS Code-level editor configuration (settings schema, search, per-language overrides,
  JSON view). Reference them as assumed-landed dependencies where relevant.
- Deliver the audit as asked. If a framing here looks wrong, say so in one sentence in
  the spec's thesis and continue.
</constraints>

<assumptions>
- The reader is the sole developer on this codebase and will implement the top-ranked
  items himself via fresh agent prompts, so "cost" means his hours, not a team's.
- "Agentic" means BYO-CLI agents shelling out through the existing adapter in
  `commands/agent.ts`, plus external agents editing files in worktrees. No hosted
  agent runtime is assumed.
- Cuts are proposals, not permissions. Nothing is removed in this slice.
</assumptions>

<out_of_scope>
- Implementing anything. No source edits, no prototypes, no scaffolding.
- Writing follow-up implementation prompts — that is a later step, and only for the
  items actually picked.
- Redesigning the visual language or proposing new design tokens.
- Auditing the Rust backend beyond noting where a proposal needs one.
- Auditing the git window, the browser pane or the brain vault as products; they matter
  here only as workbench surfaces competing for the same space.
- Business, pricing, packaging or distribution questions.
- Benchmarks or performance profiling.
</out_of_scope>

<acceptance>
- `docs/specs/2026-07-29-workbench-100x.md` exists and contains: the thesis paragraph;
  Keep / Cut / Add sections covering every surface listed in `<task>`; a ranked table
  with leverage, cost, risk, files touched and dependencies; a named top three with
  reasoning; and at least three concrete cuts, each with the file and the reason.
- Every row in the table names at least one real file path that exists in the repo.
- `git status` shows exactly one new file. No source file is modified — this is the
  slice's own acceptance test.
- The final chat response is a ≤15-line summary: the top three, the three cuts, and any
  proposal context7 ruled out as unbuildable.
</acceptance>
