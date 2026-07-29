<context>
VoidLink's editor settings are a hand-built GUI: ~30 fields in `EditorSettings`
rendered as ~35 controls in a 1972-line `SettingsDialog.tsx`. Every field applies to a
live editor — that part is right and must stay right. What is missing is everything
that makes VS Code's settings usable at scale: you cannot search them, you cannot tell
which ones you changed, you cannot express "4-space tabs in Rust, 2 in TypeScript", and
you cannot read or paste the whole configuration as text.

The GUI does not scale by adding rows to it. This slice adds the three surfaces that do:
a searchable settings index with modified state, per-language overrides, and a raw JSON
view backed by the same store — so the config can grow to VS Code's breadth without the
dialog growing to VS Code's size.

<task>
Bring editor configuration to VS Code-level availability, in three waves.

**Wave 1 — the settings schema (riskiest, do first).**
Today `EditorSettings` is a TypeScript interface plus a hand-written `parseSettings`
and ~35 hand-placed controls. Search, modified badges, per-setting reset and JSON
validation each need the same thing: settings as *data*. Introduce a schema in a new
`frontend/src/store/settingsSchema.ts` — one entry per setting with a dotted id
(`editor.fontSize`), type and constraints (enum members, min/max, step), default,
one-line description, and the section it belongs to.

The schema must be the single source of truth for the defaults, the parse and the
rendering, so a new setting is one schema entry rather than four edits. Derive
`DEFAULT_SETTINGS` from it and make `parseSettings` schema-driven, preserving the
existing forward-compatibility rule (a payload saved before a section existed still
loads, unknown keys survive a round-trip). `AppSettings`'s shape and `useSettings()`'s
returned surface do **not** change — ~40 consumers read them, and keeping them
identical is this wave's proof, exactly as `layout.test.ts` passing unmodified was the
proof for the `layout.ts` decomposition.

Expand coverage in the same pass with the Monaco options the editor still has no
control for — at minimum: `rulers`, `folding` / `foldingStrategy` /
`showFoldingControls`, `guides.bracketPairs`, `renderWhitespace` gaining Monaco's
`trailing` member, `renderFinalNewline`, `wrappingIndent`, `wordWrap` gaining Monaco's
`wordWrapColumn` member, `suggestOnTriggerCharacters`, `quickSuggestions`,
`acceptSuggestionOnEnter`, `snippetSuggestions`, `inlayHints.enabled`,
`parameterHints.enabled`, `occurrencesHighlight`, `selectionHighlight`,
`renderLineHighlight`, `cursorSurroundingLines`, `scrollbar` sizes, `mouseWheelZoom`,
`multiCursorModifier`, `linkedEditing`, `autoClosingBrackets`, `autoSurround`,
`detectIndentation`, `trimAutoWhitespace`, `unicodeHighlight`. Query context7 for
`monaco-editor` 0.55's option names, members and defaults rather than trusting recall —
several of these were renamed or gained members across versions, and the module comment
on `EditorSettings` requires each field be applicable through `updateOptions` or
`model.updateOptions`. A field Monaco can only consume at construction time does not
belong there without a stated reason.

**Wave 2 — searchable settings UI with modified state.**
Render the settings panes from the schema. Add a filter box matching id, label,
description and enum members using the existing `commands/fuzzy.ts` scorer with its
match-position highlighting. Each control gains a modified indicator when its value
differs from the schema default, plus a per-setting reset, plus a "modified only"
filter. Add a palette action that deep-links to a named setting. Keep the current
sections and control primitives — this is a rendering change, not a redesign.

**Wave 3 — per-language overrides and the JSON view.**
Add `languageOverrides: Record<string, Partial<EditorSettings>>` keyed by Monaco
language id, resolved by an `effectiveEditorSettings(settings, languageId)` — pure,
DOM-free, tested. Wire it through `editorController.applyEditorSettings` and
`useEditorOptionsSync`, which are already the only two paths by which options reach
Monaco; keep it that way, because that is what makes "a setting that only takes effect
on reload is a bug" enforceable. A model whose language changes must re-resolve.

Then a JSON view: a Monaco instance editing the serialised settings, VS Code's dotted
form (`"editor.fontSize": 13`, `"[rust]": { "editor.tabSize": 4 }`), with a JSON schema
generated from Wave 1's table registered through `monaco.languages.json.jsonDefaults`
for completion and inline validation. GUI and JSON are two views over one store: an
edit in either is visible in the other, and invalid JSON blocks the write and says why
inline rather than silently discarding it. Add a per-language section to the GUI too,
so overrides are not JSON-only.

Update `docs/features/settings.md` and `docs/features/editor-and-preview.md`.
</task>

<reuse>
- `frontend/src/store/settings.ts` — `EditorSettings`, `parseSettings`,
  `DEFAULT_SETTINGS`, `useSettings()`, `STORAGE_KEY = "voidlink-settings"`, the
  forward-compatibility rule. Refactor behind an unchanged public surface.
- `frontend/src/store/settings.test.ts` — must pass unmodified after Wave 1.
- `frontend/src/components/settings/SettingsDialog.tsx` — `EditorPane` and the
  `TabButton` / slider / toggle / segmented primitives. Reuse the primitives, replace
  the hand-placed rows.
- `frontend/src/components/editor/editorOptions.ts` + `editorOptions.test.ts` — the
  pure `editorOptions(settings)` / `modelOptions(settings)` derivation. Language
  resolution belongs here or beside it, and it stays pure.
- `frontend/src/components/editor/editorController.ts` —
  `applyEditorSettings`, the shared editor and the model cache.
- `frontend/src/components/editor/MonacoPanes.tsx` — `useEditorOptionsSync` for the
  diff and merge panes.
- `frontend/src/components/editor/monaco.ts` — how Monaco is loaded and configured.
  The JSON view uses this instance; do not add a second loader.
- `frontend/src/components/editor/monacoTheme.ts` — themes derived from VoidLink's own
  tokens. The JSON editor gets the same theme, not `vs-dark`.
- `frontend/src/commands/fuzzy.ts` — the shared scorer returning matched character
  positions. Do not write a second one.
- `frontend/src/commands/registry.ts` + `actionIds.ts` — palette actions.
- `frontend/src/components/editor/lspServers.ts` — existing per-server id keying;
  `lspServerPaths` is already a `Record` keyed that way and shows the house idiom for a
  keyed override map.
- `frontend/design-system/MASTER.md` — §4/§9.2 typography, §7.6 (no dead affordance),
  §11.5 (do not import VS Code's own chrome; this app owns its widgets).
</reuse>

<constraints>
- One store, two views. There must be no path by which a setting reaches Monaco other
  than `applyEditorSettings` / `useEditorOptionsSync`, and no second copy of the values
  behind the JSON editor.
- Defaults must reproduce today's behaviour exactly. An existing install sees no visual
  or behavioural change on upgrade — only new controls.
- Query context7 (`resolve-library-id` → `query-docs`) for `monaco-editor` before using
  any option name, enum member, `jsonDefaults` API or `IStandaloneEditorConstructionOptions`
  field. Pinned: `monaco-editor` ^0.55.1, `@monaco-editor/loader` ^1.7.0, `solid-js`
  ^1.9.7, TypeScript ~5.9.3 under `erasableSyntaxOnly` — no enums, no constructor
  parameter properties.
- Separation of concerns: schema and resolution are DOM-free and testable in plain node;
  the dialog renders and does not parse; persistence stays behind `settings.ts`.
- Verify with `npm run build` from `frontend/` (it runs `tsc -b`). Plain
  `npx tsc --noEmit` at the frontend root compiles nothing — the root tsconfig is
  `"files": []` plus project references.
- A settings blob written by the current build must still load, and unknown keys must
  survive a round-trip — a user on a newer build's config opened by an older one must
  not lose fields.
- Build exactly these three waves. Routine calls are yours; check in only where two
  readings mean materially different work. If a premise looks wrong, say so in one
  sentence and continue as asked.
</constraints>

<assumptions>
- Settings stay in localStorage under `voidlink-settings`. The JSON view edits that
  blob; it is not a file on disk, and no Rust change is needed. A real
  `~/.voidlink/settings.json` is a separate decision with its own migration.
- The schema covers editor settings first. Terminal, UI, AI, brain and git sections may
  migrate to it opportunistically, but only the editor section is required.
- Keys are dotted VS Code style for display and JSON; the in-memory shape stays nested,
  and the schema owns the mapping between them.
- Override keys are Monaco language ids (`typescript`, `rust`), not file extensions.
</assumptions>

<out_of_scope>
- A user-editable keymap. `commands/keymap.ts` notes the shape is already serialisable
  for this; building the editor is a separate slice.
- Workspace- or folder-scoped settings. Global only.
- Settings sync, import/export, or profiles.
- A settings file on disk, and any Rust/Tauri change.
- Extending the LSP surface (`lspServers.ts`, `lspBridge.ts`) beyond exposing existing
  `lspServerPaths` through the schema.
- Terminal settings breadth — the xterm option set stays as it is.
- Theme authoring or `monacoTheme.ts` changes.
- Redesigning the settings dialog's navigation or visual language.
</out_of_scope>

<acceptance>
- `store/settings.test.ts` passes **unmodified** after Wave 1 — the refactor's proof.
- `store/settingsSchema.test.ts`: every schema entry's default matches
  `DEFAULT_SETTINGS`; every `EditorSettings` field has an entry and vice versa (a
  compile-time-exhaustive check, so adding a field without a schema entry fails here);
  enum members validate; out-of-range numbers clamp; unknown keys survive a
  parse → serialise round-trip.
- `editorOptions.test.ts` extended: `effectiveEditorSettings` with no override returns
  globals unchanged; an override wins per field only; an unknown language falls back;
  overrides compose with `modelOptions` correctly.
- A JSON-view test: valid dotted JSON parses into the same shape the GUI writes;
  invalid JSON is rejected with a message and leaves the store untouched.
- Filter test over the schema: matching by id, label and enum member; "modified only"
  returns exactly the non-default entries.
- `npm run build` and `npx eslint .` clean from `frontend/`; `npm test` green.
- Launch the app and confirm by hand: change a setting in JSON → GUI updates and the
  open editor changes live; set `[rust] editor.tabSize` → a Rust buffer picks it up and
  a TypeScript one does not; reset a modified setting. State explicitly in the summary
  whether this was done.
</acceptance>
