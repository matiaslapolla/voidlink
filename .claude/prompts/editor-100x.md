<context>
VoidLink is a local-first Tauri 2 + Solid.js git workbench. Its editor is honest about being minimal: `docs/features/editor-and-preview.md` says outright "It is a code editor, not an IDE — there is no language server, no formatter, and no find-in-files." One Monaco instance shared by all file tabs, options hardcoded in `SHARED_EDITOR_OPTIONS`, zero registered Monaco actions, no editor settings anywhere in the Settings dialog. Every other module in the app (terminal, git suite, stacks) is deep; the editor is the shallow one, and it is the surface users sit in most.

Goal: make the editor a first-class module — configurable, intelligent, navigable, and visually current with the rest of the app.
</context>

<task>
Rebuild the editor module across six waves, in this order. Each wave lands and is verifiable on its own; do not start a wave before the previous one typechecks and its tests pass.

**Wave 0 — Design foundation (small, first).**
Waves 1–3 all ship visible surfaces (a settings pane, split panes, a find-results panel, breadcrumbs). Building them against stock Monaco chrome and retrofitting the design system in Wave 4 means building them twice, so the visual substrate lands first:
- **Monaco themes from VoidLink tokens.** Define `voidlink-dark` / `voidlink-light` via `monaco.editor.defineTheme`, with colours read from the computed CSS custom properties in `index.css` / `themes.css` rather than hardcoded — so all eight named themes work without eight theme definitions. Re-apply on `useTheme().mode()` change and on `data-theme` change. This replaces stock `vs` / `vs-dark` everywhere, including `MonacoPanes.tsx`, `DiffTabView.tsx` and `MergeEditor.tsx`.
- **Motion and status tokens.** Add the `--ease-*` and `--dur-*` tokens from `frontend/design-system/MASTER.md` §7.2 to `index.css` if the workbench prompt has not already landed them (they are shared; whichever prompt lands first adds them, the second reuses them and does not redefine them).
- **A `<StatusLed>` primitive** in `frontend/src/components/layout/`, extracted from the existing terminal LED, implementing the §7.5.3 signal vocabulary. Both the editor's LSP indicator and the workbench's tab activity badges consume it. Same shared-ownership rule: first prompt to land builds it.
No behavior change in this wave. It is tokens, one primitive, and a theme definition.

**Wave 1 — Editor settings, reactive end to end.**
Add `EditorSettings` to `frontend/src/store/settings.ts` (alongside `TerminalSettings`) with defaults matching today's `SHARED_EDITOR_OPTIONS`: fontFamily, fontSize, lineHeight, fontLigatures, tabSize, insertSpaces, wordWrap (`off | on | bounded`), wordWrapColumn, minimap, stickyScroll, bracketPairColorization, renderWhitespace (`none | selection | boundary | all`), indentGuides, lineNumbers (`on | off | relative`), cursorStyle, cursorBlinking, smoothScrolling, scrollBeyondLastLine, formatOnSave, trimTrailingWhitespaceOnSave, insertFinalNewlineOnSave, autoSave (`off | afterDelay | onFocusChange`), autoSaveDelayMs. Add `updateEditor(patch)` to `useSettings()` and a `mergeDefaults` entry in `load()` so existing saved settings gain the key.
Turn `SHARED_EDITOR_OPTIONS` into a function that derives Monaco options from the store, and push changes into every live surface via `updateOptions` — the shared editor in `editorController`, and the panes in `MonacoPanes.tsx` — so a settings change applies without a reload. Add an `EditorPane` + `<TabButton>` to `SettingsDialog.tsx` modeled on `TerminalPane`.

**Wave 2 — Editing ergonomics and keymap.**
Register VoidLink Monaco actions on the shared editor (format document, duplicate line up/down, move line up/down, toggle line comment, transform case, sort lines, jump to matching bracket, add cursor above/below/at-next-occurrence) and expose each through the existing `commands/registry.ts` action list so `Cmd+K` finds them, with `commands/keymap.ts` entries where a binding is warranted. Implement save-time transforms (format-on-save via `editor.getAction("editor.action.formatDocument")`, trim trailing whitespace, insert final newline) inside `editorController.save`. Implement auto-save honoring the `autoSave` mode. Add an optional Vim mode (`monaco-vim`) behind an editor setting, lazily imported so it costs nothing when off.

**Wave 3 — Workbench features.**
- Split panes: allow the editor view to hold 1–2 (horizontal or vertical) editor groups, each with its own active file, sharing `editorController`'s model cache. Extend `editorController` to own N editors keyed by group id rather than a single `this.editor`; keep the existing single-group behavior as the default.
- Find-in-files: a Rust command `fs_search_files(root, query, opts)` in `src-tauri/src/fs/` using the existing `ignore` crate (already a dependency, already used for the file tree) for gitignore-aware traversal, returning file/line/column/preview matches; a results panel with click-to-open and an optional replace-across-matches path.
- Go-to-symbol in the active file, and breadcrumbs above the editor, both built on the Monaco document-symbol provider (real symbols once Wave 5 lands; a lightweight fallback until then).
- Session restore: persist per-file cursor position, scroll top and folded regions, restored on reopen.
- External change detection: watch open files and, on an out-of-band change, reload a clean buffer silently and prompt on a dirty one.

**Wave 4 — Modern editor UI.**
Bring the editor surface up to the design system: a redesigned tab strip (overflow handling, drag-to-reorder, dirty/preview affordances, per-tab close, middle-click close), the breadcrumb bar, an editor-scoped status segment (language, line:col, indent, encoding, LSP status), and a styled empty state. Monaco theming already landed in Wave 0. Reuse `frontend/src/components/layout/TabStrip.tsx` and `StatusBar.tsx` rather than forking new ones; follow `frontend/design-system/MASTER.md` and the `<design>` section below.

`TabStrip.tsx` is also rewritten by `.claude/prompts/workbench-100x.md` Wave 2 (group-aware drop targets). **The workbench prompt owns TabStrip's structure and drag model; this prompt owns only the per-tab content — dirty dot, preview italic, activity mark, close affordance.** Do not restructure the strip here. If the workbench prompt has not landed, add the per-tab content in a way that survives its rewrite (props on `TabDescriptor`, not layout changes).

**Wave 5 — Language intelligence (riskiest; last).**
An LSP bridge: a Rust module `src-tauri/src/lsp/` that spawns a language server as a child process, speaks LSP framing over its stdio, and relays messages to the frontend as Tauri events; a frontend client that wires those to Monaco providers (completion, hover, signature help, definition, references, document symbols, diagnostics, formatting) via `monaco-languageclient` or a hand-rolled provider layer — decide based on what the context7 docs for `monaco-languageclient` show about running without a VS Code shim under Vite, and state the choice in a comment.
Ship with two servers, discovered on `PATH` and overridable in Settings → Editor: `rust-analyzer` for `.rs` and `typescript-language-server` for TS/JS. Absent binaries degrade to today's behavior with a clear status indicator — never a hard error, never a blocked editor.
</task>

<reuse>
- `frontend/src/components/editor/editorController.ts` — the singleton owning the model cache, dirty tracking, `save`, `reconcile`, `subscribe/notify`, and `getMonaco()/getEditor()` (already documented as the hook for external overlays). Extend it; do not build a parallel controller.
- `frontend/src/components/editor/monaco.ts` — `loadMonaco()` (the single memoised import that configures `MonacoEnvironment` before any worker is touched), `SHARED_EDITOR_OPTIONS`, `inferLanguage(path)`. Every new Monaco surface awaits `loadMonaco()`; never `import("monaco-editor")` directly and never re-assign `MonacoEnvironment`.
- `frontend/src/components/editor/MonacoPanes.tsx` — `MonacoPane` / `MonacoDiffPane` and the `scratchUri` scheme that keeps diff/merge models from colliding with the `file://` URIs the code editor uses.
- `frontend/src/components/editor/EditorHost.tsx` — the mount/`dispose` contract (the host really does unmount in stacked mode; `init` early-returns while an editor exists). Split panes must preserve it.
- `frontend/src/components/editor/blameOverlay.ts` — the existing example of an overlay hooking Monaco decorations through `getEditor()`.
- `frontend/src/store/settings.ts` — `TerminalSettings` is the exact pattern `EditorSettings` should follow (typed interface, `DEFAULTS` entry, `mergeDefaults` in `load()`, `updateX` in `useSettings()`).
- `frontend/src/components/settings/SettingsDialog.tsx` — `TerminalPane` (l.364) as the template for `EditorPane`; the `Section`/`SliderRow`/`ToggleRow`/`SegmentedRow`/`TextRow` helpers (l.510–643); the `Tab` union and `TabButton` list (l.33, l.101).
- `frontend/src/commands/registry.ts` (`Action`, `registerActions`) and `commands/keymap.ts` — the only place key handling lives. Feature components own no key handling; `file.save` (keymap.ts:113) is the reference entry, and the `outside-text-surfaces` scope concept matters for anything that must stand down in a terminal.
- `frontend/src/api/fs.ts` + `src-tauri/src/fs/` — the existing file API and the `ignore`-crate traversal that powers the file tree and `Cmd+P`; find-in-files extends this, it does not reinvent traversal or gitignore handling.
- `src-tauri/src/git/mod.rs:215` `blocking_git!` and `src-tauri/src/lib.rs:837` `generate_handler![…]` — the command wrapper and registration pattern any new Rust command follows.
- `frontend/design-system/MASTER.md` — the visual conventions every new surface follows. Read §7 (motion), §7.5 (liveness), §7.6 (states), §10 (a11y) and §11.5 (brand) before Wave 0.
- `frontend/src/store/theme.ts` (`useTheme().mode()`) — Wave 0's Monaco themes hang off this, not off a second theme source.
- `frontend/src/api/windows.ts` — the broadcast that drives `editorController.reconcile`; split panes and session restore must not break the cross-window tab-list contract.
</reuse>

<design>
Read `frontend/design-system/MASTER.md` §7 (motion), §7.5 (liveness & presence), §7.6 (interaction states), §10 (accessibility) and §11.5 (brand) before Wave 0. The editor is the surface the user sits in all day, which makes it the surface where gratuitous motion costs the most and where honest state reporting pays the most.

**The motion budget is near zero.** Everything the editor does often is keyboard-initiated — tab switch, save, go-to-symbol, find, palette. Per MASTER §7.1 those animate at `0ms`, always. Concretely: no transition on tab activation, no slide on split creation, no fade on file open, no animated breadcrumb. The find-results panel appears instantly. The only motion permitted in this module is (a) the pending spinner in a control's icon slot, (b) `animate-pulse` on a searching region, (c) the context-menu/popover enter at `--dur-short` from its trigger origin. If you find yourself adding a fourth, you are wrong.

**LSP status vocabulary (Wave 5, but specify it in Wave 0's `<StatusLed>`).** Five states, in the status segment, using the §7.5.3 LED:
| State | LED | Segment text | On click |
|---|---|---|---|
| Not installed | none (segment absent) | — | — |
| Starting | `--warning`, pulsing | `rust-analyzer starting` | Show output log |
| Ready | `--success`, solid | `rust-analyzer` | Show output log |
| Degraded (server up, request failing) | `--warning`, solid | `rust-analyzer degraded` | Show output log |
| Crashed | `--destructive`, solid, persists until acknowledged | `rust-analyzer stopped` | Restart |
"Absent binary degrades to today's behavior" means **the segment is absent**, not a permanent grey warning chip — a user who does not want a language server must not be nagged forever. A crash, by contrast, is unexpected and must be reported (§7.5.5 ambient → the segment; do not toast on every crash-restart cycle, but do toast once if it crashes three times in a row).

**Find-in-files states — all six, required.** This is the highest-volume new async surface in the plan.
- *Idle*: the panel shows the query field and nothing else. Not a "no results" message.
- *Searching*: `animate-pulse` on the results region while streaming matches in as they arrive — do not wait for the traversal to finish. Match count updates live. A per-file spinner is wrong; one region-level indication is right (§7.5.2).
- *Results*: file-grouped rows, path in mono at `text-[10px] uppercase`-adjacent weight, match preview in mono with the hit span tinted `bg-primary/15` (never a second highlight colour). Row states per §7.6.
- *No matches*: one line stating the query and the scope searched (`no matches for "foo" in 1,204 files`) plus a control to include gitignored files. Never a bare "No results" (MASTER §9.7).
- *Truncated*: when the match cap is hit, say so with the real number and offer to continue — silent truncation reads as "that's all there is".
- *Error*: inline in the panel, naming the failing path, with Retry.
Cancellation is required: a new query supersedes the in-flight one and the old results never land.

**Save, dirty and autosave must not contradict each other.** The dirty dot is the user's contract that unsaved work exists. With autosave on, the dot's meaning changes and the UI must not lie:
- `autoSave: off` — dirty dot on the tab, `--warning`, until saved.
- `autoSave: afterDelay` — dirty dot appears on first edit and clears on the autosave write. It is never suppressed; the user must be able to see that a write is pending.
- `autoSave: onFocusChange` — same.
- A save that runs format-on-save and takes >80ms puts the *tab's* dot into the pending state (§7.6), not a global indicator.
- A failed save (read-only file, disk full) is a transient toast with Retry and the dot stays dirty (§7.5.6 — never leave an optimistic clean state standing).

**External change detection reads as ambient, not modal.** Wave 3 says "prompt on a dirty one" — a modal per changed file is the wrong pattern and will fire in bursts during a rebase or branch switch.
- Clean buffer: reload silently, and mark the tab with the §7.5.3 *finished* LED so the user can see it happened. No toast.
- Dirty buffer: an inline bar at the top of the editor (not a modal, not a toast) reading `This file changed on disk` with `Keep mine` / `Take theirs` / `Show diff`. It is per-buffer, it stacks with nothing, and it does not steal focus.
- A branch switch that changes 200 files must produce at most one aggregated notice, never 200.

**Editor empty state** (`no file open`): centred, a Lucide icon at `w-5 h-5`, one line naming the state, and the two keyboard paths that fix it rendered as real accelerators (`⌘P` open file, `⌘N` new file) — not prose. Distinct icon and copy from the "no repo open" state, per MASTER §9.7.

**Breadcrumbs and the status segment follow the app, not Monaco.** Breadcrumbs use the row and label patterns from MASTER §4/§9.2 at `text-[10px]`, `--muted-foreground` at rest, `--foreground` on the last segment; they are `<button>`s, not divs, and they do not animate on file change. The status segment reuses `StatusBar.tsx`'s chip idiom. Do not import Monaco's own breadcrumb or minimap chrome styling — MASTER §11.5 names Monaco-drift as the identity risk for this module.

**Vim mode needs a mode indicator or it is unusable**: a status segment showing `NORMAL` / `INSERT` / `VISUAL` in mono uppercase, tinted `--primary` in normal mode. Ship it with the setting or don't ship the setting.

**Nine states, everywhere.** Every new control in the settings pane, tab strip, breadcrumb and find panel satisfies MASTER §7.6, with constant `border-width` and a reserved icon slot. Every icon-only button gets `aria-label`. Every new input gets a real `<label>`.
</design>

<constraints>
- Solid.js 1.9 — `createSignal`/`createStore`/`createEffect(on(…))`/`onMount`/`onCleanup`, props are getters. Not React.
- Monaco 0.55.1, bundled via Vite (not CDN, not `@monaco-editor/loader` for new code). Query context7 (`/microsoft/monaco-editor`) before using any Monaco API you are not already reading in this repo — options schema, `addAction`, provider registration, and the sticky-scroll / bracket-pair option shapes all changed across recent versions.
- Query context7 for `monaco-languageclient` before Wave 5, and for `monaco-vim` before adding Vim mode. Do not write either integration from memory.
- Tauri `=2.11.2` pinned with `unstable` features; `git2 0.19`. New Rust deps need a comment justifying them in `Cargo.toml`, matching the existing style there.
- Separation of concerns: Monaco lifecycle stays in `editorController` / the pane components; settings state stays in the store; process spawning and LSP framing stay in Rust; the frontend LSP client is a transport + provider layer with no process knowledge. No component reads settings from localStorage directly.
- All blocking Rust work (search traversal, process I/O) goes through `blocking_git!`-style `spawn_blocking` or an equivalent — never on the async runtime thread.
- Every Wave-1 setting must apply to a live editor via `updateOptions`; a setting that only takes effect on reload is a bug, not a limitation.
- Wave 5 must degrade cleanly: no language server installed means today's editor, plus a status indicator. A crashed server must not take the editor with it.
- Build exactly these five waves. Make routine judgment calls yourself; check in only where two readings would produce materially different work. If a premise here looks wrong, say so in one sentence and continue as specified rather than quietly widening or narrowing it.
</constraints>

<assumptions>
- Language servers are user-installed binaries discovered on `PATH`, not bundled or auto-downloaded. `rust-analyzer` and `typescript-language-server` first because they cover this repo's own two languages.
- Split panes cap at two groups. An N-way grid is a later question; two covers the diff-beside-source case that motivates it.
- Find-in-files is gitignore-aware by default, with the same `showIgnoredFiles` escape hatch the file tree already has.
- Vim mode is opt-in and off by default.
- Session restore state is per-workspace localStorage, alongside the existing settings/layout stores.
</assumptions>

<out_of_scope>
- Debugging / DAP integration.
- A terminal-side or AI-side change of any kind — the AI commit and agent surfaces stay as they are.
- Git-config settings (a separate prompt covers that).
- Notebook, remote-file, or multi-root workspace support.
- Bundling or auto-installing language servers.
- Extension/plugin API of any kind.
- Rewriting `DiffTabView.tsx` or `MergeEditor.tsx` behavior — they inherit the new options and themes, but their diff/merge logic is untouched.
- The markdown preview pipeline (`marked` + `DOMPurify`).
- More than two editor groups.
</out_of_scope>

<acceptance>
- After each wave: `cd frontend && npx tsc --noEmit` clean, `cd frontend && npx eslint .` clean, `cargo check --manifest-path src-tauri/Cargo.toml` clean.
- Wave 0 — a vitest asserting the Monaco theme object is derived from computed CSS custom properties (swap `data-theme`, re-derive, assert the editor background changes) and that no stock `vs` / `vs-dark` string remains in the codebase. Manual: cycle all eight named themes and both modes, confirm the editor, diff and merge surfaces all follow with no stale colours.
- Wave 1 — a vitest file covering the settings→Monaco option derivation (defaults reproduce today's `SHARED_EDITOR_OPTIONS`; each setting maps to the right Monaco key) plus a `store/settings` test that an old persisted payload without an `editor` key loads with defaults filled in.
- Wave 2 — vitest coverage of the save-transform pipeline (trim trailing whitespace / final newline applied to buffer text in the right order) and of the new action ids being registered exactly once.
- Wave 3 — Rust tests for `fs_search_files` against a temp tree (match line/column correctness, gitignored files excluded by default and included when asked, binary files skipped); vitest for the session-restore serializer.
- Wave 4 — vitest for the tab-strip overflow/reorder logic; visual check by running the app.
- Wave 5 — Rust tests for LSP message framing (Content-Length header parse/serialize, partial-read reassembly); a vitest for the LSP-to-Monaco type conversions (LSP `CompletionItem` → Monaco, LSP `Diagnostic` → marker, LSP position ↔ Monaco position off-by-one).
- Run only the touched suites: `cd frontend && npx vitest run src/components/editor src/store src/commands`, and `cargo test --manifest-path src-tauri/Cargo.toml`.
- Manual, at the end: open a `.rs` and a `.tsx` file, confirm completions and hover from the language servers, split the view, run find-in-files, change a setting and see it apply live without a reload.
- Design acceptance, checked against `frontend/design-system/MASTER.md`:
  - Grep the diff for `transition` on any keyboard-initiated path (tab activation, file open, split creation, find panel mount). Every hit is a bug (MASTER §7.1).
  - Find-in-files: run a query over this repo and confirm results stream in rather than appearing at the end; confirm the no-match state names the query and the file count; confirm a second query cancels the first and the stale results never render.
  - Kill `rust-analyzer` from a terminal while the editor is open: the status segment goes `--destructive` and stays until acknowledged. Uninstall it entirely and reopen: the segment is absent, not a grey warning.
  - Edit a file with `autoSave: afterDelay`: the dirty dot appears immediately and clears on the write. `chmod -w` the file and save: toast with Retry, dot stays dirty.
  - Touch an open clean file from a terminal: it reloads silently and the tab shows the finished LED. Touch a dirty one: an inline bar, not a modal. `git checkout` a branch changing many files: one aggregated notice.
  - Tab through the settings Editor pane and the find panel with no mouse: visible focus ring on every control, nothing drops out of the tab order while pending.
  - `prefers-reduced-motion: reduce`: the searching indication and the LSP LED remain distinguishable from their resting states.
- Update `docs/features/editor-and-preview.md` — in particular the "no language server, no formatter, and no find-in-files" line and the shortcut table.
</acceptance>
