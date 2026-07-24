# Stream D — keyboard shortcuts + documentation

Branch: `feat/shortcuts-and-docs` · Worktree: `.worktrees/shortcuts-and-docs` · Merge order: **4th** (depends on A's `isMac`; document B's rail only if B merged first)

---

<context>
voidlink is a local-first Tauri v2 + SolidJS git workbench that sells itself as keyboard-first, but the keyboard layer is thinner than the pitch: `frontend/src/commands/keybindings.ts` is 48 lines with a flat first-match-wins matcher, the ~20 bindings are hand-written inline in `App.tsx`, and each palette action's `shortcutLabel` is a hand-typed string that can drift out of sync with the binding that actually fires. There is also no cheat sheet, so shortcuts are undiscoverable.
Documentation is similarly uneven: `README.md` (English) is a good marketing overview, `docs/manual-de-uso.md` (Spanish) is a long user manual, and `docs/specs/` holds two design docs. There is no per-feature reference, and the git surface — the most complex part of the app — has the least.
This stream makes the keymap a single source of truth, widens shortcut coverage, makes shortcuts discoverable, and gives every medium/high-complexity feature a doc.
</context>

<task>
1. Turn the keymap into one declarative source of truth that both fires the binding and renders the palette's accelerator label, so they cannot drift.
2. Widen shortcut coverage substantially across editor, terminal, tabs, git, navigation, and window/layout.
3. Add a discoverable shortcuts cheat sheet, plus a Keyboard section in the settings dialog listing every binding.
4. Write per-feature documentation under `docs/features/` for every medium and high complexity feature, with the git suite covered properly, and wire it into the README and the existing manual's table of contents.
</task>

<reuse>
- `frontend/src/commands/keybindings.ts` — `KeyBinding { meta?, shift?, alt?, key, run }`, the `matches()` comparator (meta means Cmd-or-Ctrl; a handler returning `true` allows the default), and `useKeybindings()` which installs a capture-phase `keydown` listener. Extend this; do not write a second key handler.
- `frontend/src/commands/registry.ts` — `Action { id, label, group?, description?, shortcutLabel?, enabled?, run }`, `registerActions()` (returns an unregister fn), `getActions()`, `getAction(id)`, and the palette/file-finder open-state signals. `shortcutLabel` is the field that should become *derived* from the keymap rather than hand-typed.
- `frontend/src/App.tsx` — the action catalog is registered in a `createEffect` in `AppInner` (~line 58) and the binding list passed to `useKeybindings` sits ~lines 560-690. Existing bindings to preserve: ⌘K palette, ⌘P file finder, ⌘W close tab, ⇧⌘T reopen closed tab, ⇧⌘R, ⌘1-9 tab select, ⌘T new terminal, ⇧⌘←/→ tab cycle, ⌥⌘←/→, ⌘B, ⌘J, ⌘\, ⌥⌘B, ⇧⌘M, ⇧⌘A.
- `frontend/src/commands/CommandPalette.tsx` — renders actions grouped by `group` with the accelerator at line 160; the cheat sheet should reuse this dialog's overlay/focus-trap idiom rather than inventing another.
- `frontend/src/components/settings/SettingsDialog.tsx` (728 lines) — add the Keyboard section here, matching the existing section components.
- `frontend/src/api/platform.ts` — the `isMac` accessor introduced by the `feat/macos-shell` stream; use it to render ⌘/⌥/⇧/⌃ on macOS and Ctrl/Alt/Shift/Ctrl elsewhere. If that stream has not merged yet, rebase onto it rather than duplicating platform detection.
- `frontend/src/commands/` — existing command modules to bind against: `terminalHistory.ts` (`repeatLastCommand`), `aiCommit.ts` (`requestAiCommitDraft`), `agent.ts` (`toggleAgentPanel`), `snapshots.ts`, `secretScan.ts`, `toast.ts`.
- `frontend/src/components/editor/blameOverlay.ts` — `toggleBlame` / `blameEnabled`, already bound.
- Docs to build on: `README.md` (structure and voice — English, feature sections with emoji headers), `docs/manual-de-uso.md` (Spanish user manual with a numbered table of contents), `docs/specs/2026-05-05-branch-compare-design.md` and `docs/specs/2026-05-17-stacked-prs-design.md` (existing design-doc format — follow it for anything new).
- Feature surfaces that need docs, all real files in this repo: git staging & hunk-level apply (`src-tauri/src/git/staging.rs`, `apply_hunk.rs`), branch compare (`components/git/compare/`), stacked PRs (`src-tauri/src/git/stack/`, `components/git/stack/`), conflicts (`git/conflict.rs`, `components/git/conflict/`), commit graph (`git/graph.rs`, `components/git/history/`, `lanes.ts`), blame (`git/blame.rs`, `editor/blameOverlay.ts`), worktrees (`git/worktree.rs`), rebase/merge/cherry-pick/reset/stash/tag (`git/rebase.rs`, `merge.rs`, `pick.rs`, `reset.rs`, `stash.rs`, `tag.rs`), safe checkout (`git/safe_checkout.rs`), AI commit + repo agent (`git/ai_commit.rs`, `git/agent.rs`, `components/agent/AgentPanel.tsx`), secret scan, snapshots, terminal (`components/terminal/`, the PTY layer), editor & preview, brain vault (`src-tauri/src/brain/`, `components/brain/`), themes (`store/theme.ts`, `themes.css`), settings.
</reuse>

<constraints>
- Query context7 before any library API work. Pinned: Solid 1.9.7, `@tauri-apps/api ^2.10.1`, Tailwind v4.2.1, TS 5.9.3, `lucide-solid ^0.576.0`.
- Single source of truth: one `frontend/src/commands/keymap.ts` exporting entries of `{ actionId, binding, group }`. `useKeybindings` consumes it, and the palette's `shortcutLabel` is *derived* from it via a formatter — delete the hand-typed `shortcutLabel` strings. A binding whose `actionId` has no registered action, or an action id bound twice, must be caught (a dev-time assertion or a unit test), not silently ignored.
- Keep the existing bindings working and keep their current key combos. Widening means adding, not remapping — a remap needs an explicit note in the summary.
- Do not steal keys the editor and terminal need. Monaco owns most editing chords when focused, and xterm needs a wide range of control sequences; bindings that would break typing in a terminal must be scoped, and the current capture-phase listener means you must check what a new binding intercepts before adding it. Verify in a running terminal, don't assume.
- The cheat sheet reads from the same keymap so it can never be stale; group by the keymap's `group`, support filtering, and dismiss on Escape.
- Separation of concerns: keymap data separate from the matcher, separate from the rendering. No key handling inside feature components.
- Docs are reference material, written from the actual code — read the source before documenting a feature; do not describe behaviour you have not verified. Each `docs/features/<slug>.md` gets: what it does, when you'd use it, how to use it (concrete steps), keyboard shortcuts, and gotchas/limits. Add `docs/features/README.md` as an index, link it from the main `README.md`, and add a pointer entry in `docs/manual-de-uso.md`'s table of contents.
- New docs are in English (matching `README.md`); do not translate the whole Spanish manual.
- Labels: sentence case only. No `uppercase` classes, no all-caps text in anything you add (including doc headings rendered in the UI).
- No screenshots — text and code blocks only.
</constraints>

<assumptions>
- Cheat sheet opens on ⇧⌘/ (i.e. ⌘?) with ⌘/ as the alternate, both from the keymap.
- "Medium and high complexity" is interpreted as: every git operation surface, the terminal, the editor + preview, the agent/AI features, the brain vault, worktrees, secret scan, snapshots, themes, settings, and the command palette. Simple leaf UI (toasts, buttons) gets no doc.
- Chord sequences (⌘K followed by a letter) are optional; prefer breadth of single bindings plus a discoverable cheat sheet, and only add chords if you run out of sensible single combos.
- The frontend has no test runner (`frontend/package.json` has only `dev`/`build`/`lint`/`preview`). Adding `vitest` for the pure keymap logic — matcher, formatter, duplicate detection — is acceptable and encouraged.
</assumptions>

<out_of_scope>
- Window chrome and icon (`feat/macos-shell`), the workspace/worktree layout restructure (`feat/workspace-worktree-layout`), AI key storage (`feat/settings-ai-keys`). If the layout stream has merged first, document the new rail and wizard; if not, do not pre-emptively document a UI that does not exist yet.
- User-remappable keybindings (a JSON keymap the user edits). Structure the keymap so that becomes possible later, but do not build the editor UI.
- Vim/emacs modes.
- Translating existing Spanish docs.
</out_of_scope>

<acceptance>
- `cd frontend && npx tsc --noEmit` clean; `npm run lint` no new errors.
- Unit tests for the pure keymap logic: `matches()` against representative events, the accelerator formatter producing ⌘⇧P on macOS and Ctrl+Shift+P elsewhere, and a test that fails if two entries bind the same combo or reference an unregistered action id.
- Every action shown in the ⌘K palette with an accelerator has that accelerator derived from `keymap.ts` — verified by the fact that no `shortcutLabel` string literals remain in the codebase.
- Manual verification, reported with what you actually observed: the cheat sheet opens, lists every binding grouped and filterable, and closes on Escape; the Keyboard section appears in settings; every pre-existing shortcut still fires; typing normally in a terminal tab and in the Monaco editor is unaffected by the new bindings.
- `docs/features/` contains one file per feature in the list above plus an index, each written against the real code, linked from `README.md`, with a pointer added to `docs/manual-de-uso.md`'s table of contents.
- Report explicitly which features you documented and any you deliberately skipped, with the reason.
</acceptance>
