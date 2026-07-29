/// Editor settings as *data*.
///
/// The editor pane used to be a hand-written `EditorSettings` interface, a
/// hand-written slice of `parseSettings`, and ~35 hand-placed controls — four
/// edits to add one setting, and no way at all to search them, mark the ones
/// you changed, or validate a pasted configuration. All four of those want the
/// same thing: one table, read by everything.
///
/// This is that table. Each entry carries a dotted VS Code-style id
/// (`editor.fontSize`), the in-memory key it maps to, its type and constraints,
/// its default, a one-line description and the section it renders under. The
/// defaults in `store/settings.ts`, the parse that validates a persisted blob,
/// the settings dialog's controls, the filter box and the JSON view's schema
/// are all derived from it. Adding a setting is one entry here.
///
/// DOM-free and framework-free on purpose: everything in this file is testable
/// in plain node, and `SettingsDialog.tsx` renders what it says rather than
/// deciding anything.
///
/// **Every option name, enum member and default below was checked against
/// monaco-editor 0.55's own `editorOptions.js` and `monaco.d.ts`**, not recall —
/// several were renamed or gained members across versions (`renderWhitespace`
/// gained `trailing`, `wordWrap` gained `wordWrapColumn`, `occurrencesHighlight`
/// went from boolean to `off | singleFile | multiFile`). Where a Monaco default
/// is platform-dependent (`renderFinalNewline`) the value here is the one this
/// app shipped with, and the divergence is noted on the entry.

import type { EditorCoreSettings, EditorSettings } from "./settings";

/// The pane headings, in render order. A section is not a free string: the
/// dialog iterates this list, so a typo in an entry is a compile error rather
/// than a section that silently never draws.
export const SETTING_SECTIONS = [
  "Font",
  "Indentation",
  "Wrapping",
  "Display",
  "Scrolling",
  "Folding",
  "Cursor",
  "Suggestions",
  "Highlighting",
  "Editing",
  "Save",
  "Keybindings",
  "Language servers",
] as const;

export type SettingSection = (typeof SETTING_SECTIONS)[number];

export interface SettingEnumMember {
  value: string;
  label: string;
}

/// Fields every entry has, whatever its type.
interface SettingCommon {
  /// The in-memory key on `EditorSettings`.
  key: keyof EditorCoreSettings;
  /// The dotted form used for display, search and the JSON view. Always
  /// `editor.<key>` — the mapping between the two spellings lives here and
  /// nowhere else.
  id: string;
  section: SettingSection;
  label: string;
  /// One line, sentence case, no trailing period-less fragments. Shown under
  /// the control and searched by the filter box.
  description: string;
}

export type EditorSetting =
  | (SettingCommon & { kind: "boolean"; default: boolean })
  | (SettingCommon & {
      kind: "number";
      default: number;
      min: number;
      max: number;
      step: number;
      /// Rendered after the value in the dialog: `13px`, `1000ms`.
      unit?: string;
    })
  | (SettingCommon & {
      kind: "enum";
      default: string;
      members: readonly SettingEnumMember[];
    })
  | (SettingCommon & { kind: "string"; default: string; placeholder?: string })
  | (SettingCommon & {
      kind: "numberList";
      default: readonly number[];
      min: number;
      max: number;
    })
  | (SettingCommon & { kind: "pathMap"; default: Record<string, string> });

export type SettingKind = EditorSetting["kind"];

/// The exhaustiveness contract, enforced by the compiler.
///
/// `EDITOR_SETTINGS` is declared `satisfies` this mapped type, which requires
/// **every** `EditorCoreSettings` key to have an entry (a new field with no
/// entry fails to compile), forbids entries for keys that do not exist, pins
/// each `id` to `editor.<key>`, and types each `default` — and each enum
/// member's `value` — against the field it feeds. There is no way to add a
/// setting to the interface and forget the table, which is the whole point.
type SettingTable = {
  [K in keyof EditorCoreSettings]: EditorSetting & {
    key: K;
    id: `editor.${K & string}`;
    default: EditorCoreSettings[K];
    members?: readonly { value: EditorCoreSettings[K]; label: string }[];
  };
};

export const EDITOR_SETTINGS = {
  // ── Font ────────────────────────────────────────────────────────────────
  fontFamily: {
    key: "fontFamily",
    id: "editor.fontFamily",
    section: "Font",
    kind: "string",
    default: "'Geist Mono Variable', 'Geist Mono', monospace",
    placeholder: "'Geist Mono Variable', monospace",
    label: "Font family",
    description: "CSS font stack for the editor text.",
  },
  fontSize: {
    key: "fontSize",
    id: "editor.fontSize",
    section: "Font",
    kind: "number",
    default: 13,
    min: 8,
    max: 28,
    step: 1,
    unit: "px",
    label: "Font size",
    description: "Editor font size in pixels.",
  },
  lineHeight: {
    key: "lineHeight",
    id: "editor.lineHeight",
    section: "Font",
    kind: "number",
    // Monaco's own convention, surfaced rather than hidden behind a second
    // toggle: 0 derives the height from the font size, and anything in (0, 8]
    // is a multiplier.
    default: 0,
    min: 0,
    max: 3,
    step: 0.05,
    label: "Line height",
    description: "Line height as a multiplier, or 0 to derive it from the font size.",
  },
  fontLigatures: {
    key: "fontLigatures",
    id: "editor.fontLigatures",
    section: "Font",
    kind: "boolean",
    default: false,
    label: "Ligatures",
    description: "Render =>, !== and friends as single glyphs, if the font has them.",
  },

  // ── Indentation ─────────────────────────────────────────────────────────
  tabSize: {
    key: "tabSize",
    id: "editor.tabSize",
    section: "Indentation",
    kind: "number",
    default: 4,
    min: 1,
    max: 8,
    step: 1,
    unit: " spaces",
    label: "Tab size",
    description: "Number of spaces a tab is rendered as.",
  },
  insertSpaces: {
    key: "insertSpaces",
    id: "editor.insertSpaces",
    section: "Indentation",
    kind: "boolean",
    default: true,
    label: "Insert spaces",
    description: "Insert spaces when pressing Tab.",
  },
  detectIndentation: {
    key: "detectIndentation",
    id: "editor.detectIndentation",
    section: "Indentation",
    kind: "boolean",
    default: true,
    label: "Detect indentation",
    description: "Guess tab size and spaces-vs-tabs from the file's contents when it opens.",
  },
  indentGuides: {
    key: "indentGuides",
    id: "editor.indentGuides",
    section: "Indentation",
    kind: "boolean",
    default: true,
    label: "Indent guides",
    description: "Draw a vertical rule at each indentation level.",
  },
  bracketPairGuides: {
    key: "bracketPairGuides",
    id: "editor.bracketPairGuides",
    section: "Indentation",
    kind: "boolean",
    // Monaco's `guides.bracketPairs` default is false.
    default: false,
    label: "Bracket pair guides",
    description: "Draw a guide connecting each pair of brackets.",
  },
  trimAutoWhitespace: {
    key: "trimAutoWhitespace",
    id: "editor.trimAutoWhitespace",
    section: "Indentation",
    kind: "boolean",
    default: true,
    label: "Trim auto whitespace",
    description: "Remove indentation the editor inserted for you but you never typed into.",
  },

  // ── Wrapping ────────────────────────────────────────────────────────────
  wordWrap: {
    key: "wordWrap",
    id: "editor.wordWrap",
    section: "Wrapping",
    kind: "enum",
    default: "off",
    members: [
      { value: "off", label: "Off" },
      { value: "on", label: "Viewport" },
      { value: "wordWrapColumn", label: "Column" },
      { value: "bounded", label: "Bounded" },
    ],
    label: "Word wrap",
    description:
      "Off, at the viewport edge, at the wrap column, or at whichever of the two is smaller.",
  },
  wordWrapColumn: {
    key: "wordWrapColumn",
    id: "editor.wordWrapColumn",
    section: "Wrapping",
    kind: "number",
    default: 80,
    min: 40,
    max: 200,
    step: 1,
    unit: " cols",
    label: "Wrap column",
    description: "Column used by the Column and Bounded wrap modes.",
  },
  wrappingIndent: {
    key: "wrappingIndent",
    id: "editor.wrappingIndent",
    section: "Wrapping",
    kind: "enum",
    default: "same",
    members: [
      { value: "none", label: "None" },
      { value: "same", label: "Same" },
      { value: "indent", label: "Indent" },
      { value: "deepIndent", label: "Deep" },
    ],
    label: "Wrapping indent",
    description: "How far a wrapped line is indented relative to the line it continues.",
  },

  // ── Display ─────────────────────────────────────────────────────────────
  lineNumbers: {
    key: "lineNumbers",
    id: "editor.lineNumbers",
    section: "Display",
    kind: "enum",
    default: "on",
    members: [
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
      { value: "relative", label: "Relative" },
    ],
    label: "Line numbers",
    description: "Absolute numbers, none, or distance from the cursor.",
  },
  renderWhitespace: {
    key: "renderWhitespace",
    id: "editor.renderWhitespace",
    section: "Display",
    kind: "enum",
    default: "selection",
    members: [
      { value: "none", label: "None" },
      { value: "boundary", label: "Boundary" },
      { value: "selection", label: "Selection" },
      { value: "trailing", label: "Trailing" },
      { value: "all", label: "All" },
    ],
    label: "Whitespace",
    description: "Where space and tab characters are drawn as dots and arrows.",
  },
  renderFinalNewline: {
    key: "renderFinalNewline",
    id: "editor.renderFinalNewline",
    section: "Display",
    kind: "enum",
    // Monaco's own default is platform-dependent — `dimmed` on Linux, `on`
    // everywhere else. A setting whose default changes with the OS is not a
    // default anyone can reason about, so this pins the non-Linux value, which
    // is what this app has always rendered on macOS.
    default: "on",
    members: [
      { value: "on", label: "On" },
      { value: "dimmed", label: "Dimmed" },
      { value: "off", label: "Off" },
    ],
    label: "Final newline",
    description: "Show the trailing newline as an extra empty line.",
  },
  rulers: {
    key: "rulers",
    id: "editor.rulers",
    section: "Display",
    kind: "numberList",
    default: [],
    min: 1,
    max: 400,
    label: "Rulers",
    description: "Vertical rules at these columns. Empty means none.",
  },
  minimap: {
    key: "minimap",
    id: "editor.minimap",
    section: "Display",
    kind: "boolean",
    default: false,
    label: "Minimap",
    description: "Show the scaled-down overview of the file on the right.",
  },
  stickyScroll: {
    key: "stickyScroll",
    id: "editor.stickyScroll",
    section: "Display",
    kind: "boolean",
    default: false,
    label: "Sticky scroll",
    description: "Pin the enclosing scopes to the top of the viewport.",
  },
  bracketPairColorization: {
    key: "bracketPairColorization",
    id: "editor.bracketPairColorization",
    section: "Display",
    kind: "boolean",
    default: false,
    label: "Bracket colors",
    description: "Tint matching brackets by nesting depth.",
  },
  renderLineHighlight: {
    key: "renderLineHighlight",
    id: "editor.renderLineHighlight",
    section: "Display",
    kind: "enum",
    // `line` is what the old hardcoded chrome set, so this default keeps every
    // existing install exactly where it was.
    default: "line",
    members: [
      { value: "none", label: "None" },
      { value: "gutter", label: "Gutter" },
      { value: "line", label: "Line" },
      { value: "all", label: "All" },
    ],
    label: "Current line",
    description: "How the line under the cursor is highlighted.",
  },

  // ── Scrolling ───────────────────────────────────────────────────────────
  scrollBeyondLastLine: {
    key: "scrollBeyondLastLine",
    id: "editor.scrollBeyondLastLine",
    section: "Scrolling",
    kind: "boolean",
    default: false,
    label: "Scroll past end",
    description: "Allow scrolling a screen's worth past the last line.",
  },
  smoothScrolling: {
    key: "smoothScrolling",
    id: "editor.smoothScrolling",
    section: "Scrolling",
    kind: "boolean",
    default: false,
    label: "Smooth scrolling",
    description: "Animate the viewport when it jumps.",
  },
  mouseWheelZoom: {
    key: "mouseWheelZoom",
    id: "editor.mouseWheelZoom",
    section: "Scrolling",
    kind: "boolean",
    default: false,
    label: "Mouse wheel zoom",
    description: "Change the font size with Cmd/Ctrl and the scroll wheel.",
  },
  scrollbarVerticalSize: {
    key: "scrollbarVerticalSize",
    id: "editor.scrollbarVerticalSize",
    section: "Scrolling",
    kind: "number",
    // Monaco's `scrollbar.verticalScrollbarSize` default.
    default: 14,
    min: 2,
    max: 30,
    step: 1,
    unit: "px",
    label: "Vertical scrollbar",
    description: "Width of the vertical scrollbar in pixels.",
  },
  scrollbarHorizontalSize: {
    key: "scrollbarHorizontalSize",
    id: "editor.scrollbarHorizontalSize",
    section: "Scrolling",
    kind: "number",
    // Monaco's `scrollbar.horizontalScrollbarSize` default.
    default: 12,
    min: 2,
    max: 30,
    step: 1,
    unit: "px",
    label: "Horizontal scrollbar",
    description: "Height of the horizontal scrollbar in pixels.",
  },

  // ── Folding ─────────────────────────────────────────────────────────────
  folding: {
    key: "folding",
    id: "editor.folding",
    section: "Folding",
    kind: "boolean",
    default: true,
    label: "Folding",
    description: "Allow collapsing regions of the file.",
  },
  foldingStrategy: {
    key: "foldingStrategy",
    id: "editor.foldingStrategy",
    section: "Folding",
    kind: "enum",
    default: "auto",
    members: [
      { value: "auto", label: "Auto" },
      { value: "indentation", label: "Indentation" },
    ],
    label: "Folding strategy",
    description: "Use the language's own folding ranges, or fall back to indentation.",
  },
  showFoldingControls: {
    key: "showFoldingControls",
    id: "editor.showFoldingControls",
    section: "Folding",
    kind: "enum",
    default: "mouseover",
    members: [
      { value: "mouseover", label: "On hover" },
      { value: "always", label: "Always" },
      { value: "never", label: "Never" },
    ],
    label: "Folding controls",
    description: "When the fold chevrons appear in the gutter.",
  },

  // ── Cursor ──────────────────────────────────────────────────────────────
  cursorStyle: {
    key: "cursorStyle",
    id: "editor.cursorStyle",
    section: "Cursor",
    kind: "enum",
    default: "line",
    members: [
      { value: "line", label: "Line" },
      { value: "block", label: "Block" },
      { value: "underline", label: "Underline" },
    ],
    label: "Cursor style",
    description: "Shape of the caret.",
  },
  cursorBlinking: {
    key: "cursorBlinking",
    id: "editor.cursorBlinking",
    section: "Cursor",
    kind: "enum",
    default: "blink",
    members: [
      { value: "blink", label: "Blink" },
      { value: "smooth", label: "Smooth" },
      { value: "phase", label: "Phase" },
      { value: "expand", label: "Expand" },
      { value: "solid", label: "Solid" },
    ],
    label: "Cursor blinking",
    description: "How the caret animates.",
  },
  cursorSurroundingLines: {
    key: "cursorSurroundingLines",
    id: "editor.cursorSurroundingLines",
    section: "Cursor",
    kind: "number",
    default: 0,
    min: 0,
    max: 30,
    step: 1,
    unit: " lines",
    label: "Scroll off",
    description: "Keep this many lines visible above and below the cursor.",
  },
  multiCursorModifier: {
    key: "multiCursorModifier",
    id: "editor.multiCursorModifier",
    section: "Cursor",
    kind: "enum",
    // Monaco's default is `alt`; the internal value it resolves to is
    // `altKey`, which is not what the option accepts.
    default: "alt",
    members: [
      { value: "alt", label: "Option / Alt" },
      { value: "ctrlCmd", label: "Cmd / Ctrl" },
    ],
    label: "Multi-cursor modifier",
    description: "Which modifier adds a second cursor on click.",
  },

  // ── Suggestions ─────────────────────────────────────────────────────────
  suggestOnTriggerCharacters: {
    key: "suggestOnTriggerCharacters",
    id: "editor.suggestOnTriggerCharacters",
    section: "Suggestions",
    kind: "boolean",
    default: true,
    label: "Trigger characters",
    description: "Open the suggestion widget after a character like a dot.",
  },
  quickSuggestions: {
    key: "quickSuggestions",
    id: "editor.quickSuggestions",
    section: "Suggestions",
    kind: "boolean",
    // Monaco's default object is `{ other: on, comments: off, strings: off }`,
    // which `monaco.ts` reproduces — passing the bare `true` this reads as
    // would also switch it on inside comments and strings, which is *not*
    // today's behaviour.
    default: true,
    label: "Quick suggestions",
    description: "Suggest as you type in code (never inside comments or strings).",
  },
  acceptSuggestionOnEnter: {
    key: "acceptSuggestionOnEnter",
    id: "editor.acceptSuggestionOnEnter",
    section: "Suggestions",
    kind: "enum",
    default: "on",
    members: [
      { value: "on", label: "On" },
      { value: "smart", label: "Smart" },
      { value: "off", label: "Off" },
    ],
    label: "Accept on Enter",
    description: "Whether Enter accepts the highlighted suggestion or inserts a newline.",
  },
  snippetSuggestions: {
    key: "snippetSuggestions",
    id: "editor.snippetSuggestions",
    section: "Suggestions",
    kind: "enum",
    default: "inline",
    members: [
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
      { value: "inline", label: "Inline" },
      { value: "none", label: "None" },
    ],
    label: "Snippets",
    description: "Where snippets sort among the other suggestions.",
  },
  inlayHints: {
    key: "inlayHints",
    id: "editor.inlayHints",
    section: "Suggestions",
    kind: "boolean",
    default: true,
    label: "Inlay hints",
    description: "Show inferred types and parameter names inline, when a server provides them.",
  },
  parameterHints: {
    key: "parameterHints",
    id: "editor.parameterHints",
    section: "Suggestions",
    kind: "boolean",
    default: true,
    label: "Parameter hints",
    description: "Show the signature popup while typing arguments.",
  },

  // ── Highlighting ────────────────────────────────────────────────────────
  occurrencesHighlight: {
    key: "occurrencesHighlight",
    id: "editor.occurrencesHighlight",
    section: "Highlighting",
    kind: "enum",
    default: "singleFile",
    members: [
      { value: "off", label: "Off" },
      { value: "singleFile", label: "This file" },
      { value: "multiFile", label: "All files" },
    ],
    label: "Occurrences",
    description: "Highlight other occurrences of the symbol under the cursor.",
  },
  selectionHighlight: {
    key: "selectionHighlight",
    id: "editor.selectionHighlight",
    section: "Highlighting",
    kind: "boolean",
    default: true,
    label: "Selection matches",
    description: "Highlight text matching the current selection.",
  },
  unicodeHighlight: {
    key: "unicodeHighlight",
    id: "editor.unicodeHighlight",
    section: "Highlighting",
    kind: "boolean",
    default: true,
    label: "Unicode highlight",
    description: "Flag invisible and ASCII-lookalike characters.",
  },

  // ── Editing ─────────────────────────────────────────────────────────────
  autoClosingBrackets: {
    key: "autoClosingBrackets",
    id: "editor.autoClosingBrackets",
    section: "Editing",
    kind: "enum",
    default: "languageDefined",
    members: [
      { value: "always", label: "Always" },
      { value: "languageDefined", label: "Language" },
      { value: "beforeWhitespace", label: "Before space" },
      { value: "never", label: "Never" },
    ],
    label: "Auto-close brackets",
    description: "When typing an opening bracket also inserts the closing one.",
  },
  autoSurround: {
    key: "autoSurround",
    id: "editor.autoSurround",
    section: "Editing",
    kind: "enum",
    default: "languageDefined",
    members: [
      { value: "languageDefined", label: "Language" },
      { value: "quotes", label: "Quotes" },
      { value: "brackets", label: "Brackets" },
      { value: "never", label: "Never" },
    ],
    label: "Auto-surround",
    description: "Wrap a selection when you type a quote or bracket over it.",
  },
  linkedEditing: {
    key: "linkedEditing",
    id: "editor.linkedEditing",
    section: "Editing",
    kind: "boolean",
    default: false,
    label: "Linked editing",
    description: "Edit a matching tag or symbol at the same time, where the language supports it.",
  },

  // ── Save ────────────────────────────────────────────────────────────────
  formatOnSave: {
    key: "formatOnSave",
    id: "editor.formatOnSave",
    section: "Save",
    kind: "boolean",
    default: false,
    label: "Format on save",
    description: "Uses whatever formatter the language provides. No provider means no change.",
  },
  trimTrailingWhitespaceOnSave: {
    key: "trimTrailingWhitespaceOnSave",
    id: "editor.trimTrailingWhitespaceOnSave",
    section: "Save",
    kind: "boolean",
    default: false,
    label: "Trim whitespace",
    description: "Strip trailing spaces from every line on save.",
  },
  insertFinalNewlineOnSave: {
    key: "insertFinalNewlineOnSave",
    id: "editor.insertFinalNewlineOnSave",
    section: "Save",
    kind: "boolean",
    default: false,
    label: "Final newline",
    description: "Ensure the file ends with exactly one newline on save.",
  },
  autoSave: {
    key: "autoSave",
    id: "editor.autoSave",
    section: "Save",
    kind: "enum",
    default: "off",
    members: [
      { value: "off", label: "Off" },
      { value: "afterDelay", label: "After delay" },
      { value: "onFocusChange", label: "On blur" },
    ],
    label: "Auto save",
    description: "Write the buffer back without an explicit save.",
  },
  autoSaveDelayMs: {
    key: "autoSaveDelayMs",
    id: "editor.autoSaveDelayMs",
    section: "Save",
    kind: "number",
    default: 1000,
    min: 200,
    max: 10000,
    step: 100,
    unit: "ms",
    label: "Auto save delay",
    description: "Idle time before an After-delay auto save fires.",
  },

  // ── Keybindings ─────────────────────────────────────────────────────────
  vimMode: {
    key: "vimMode",
    id: "editor.vimMode",
    section: "Keybindings",
    kind: "boolean",
    default: false,
    label: "Vim mode",
    description: "Loads monaco-vim on demand. A mode indicator appears in the title bar.",
  },

  // ── Language servers ────────────────────────────────────────────────────
  lspEnabled: {
    key: "lspEnabled",
    id: "editor.lspEnabled",
    section: "Language servers",
    kind: "boolean",
    default: true,
    label: "Language servers",
    description: "Completions, hover, diagnostics and formatting from servers you already have.",
  },
  lspServerPaths: {
    key: "lspServerPaths",
    id: "editor.lspServerPaths",
    section: "Language servers",
    kind: "pathMap",
    default: {},
    label: "Server paths",
    description: "Override where a server's binary lives. Blank means find it on PATH.",
  },
} satisfies SettingTable;

/// Every entry, in declaration order — which is the order the dialog renders
/// within each section.
export const EDITOR_SETTING_LIST: readonly EditorSetting[] = Object.values(EDITOR_SETTINGS);

const BY_ID = new Map(EDITOR_SETTING_LIST.map((s) => [s.id, s]));
const BY_KEY = new Map(EDITOR_SETTING_LIST.map((s) => [s.key as string, s]));

/// Look a setting up by its dotted id (`editor.fontSize`).
export function settingById(id: string): EditorSetting | undefined {
  return BY_ID.get(id);
}

/// Look a setting up by its in-memory key (`fontSize`).
export function settingByKey(key: string): EditorSetting | undefined {
  return BY_KEY.get(key);
}

/// The sections that actually have entries, in `SETTING_SECTIONS` order, each
/// with its settings. What the dialog iterates.
export function settingsBySection(): { section: SettingSection; settings: EditorSetting[] }[] {
  return SETTING_SECTIONS.map((section) => ({
    section,
    settings: EDITOR_SETTING_LIST.filter((s) => s.section === section),
  })).filter((g) => g.settings.length > 0);
}

export type NumberSetting = Extract<EditorSetting, { kind: "number" }>;
export type EnumSetting = Extract<EditorSetting, { kind: "enum" }>;
export type StringSetting = Extract<EditorSetting, { kind: "string" }>;

/// Narrowers for JSX. Solid's `<Match when={…}>` passes its `when` value to the
/// child as an accessor, so a *predicate* narrows nothing — the branch needs
/// the narrowed entry itself, which is what these return.
export function asNumberSetting(s: EditorSetting): NumberSetting | null {
  return s.kind === "number" ? s : null;
}

export function asEnumSetting(s: EditorSetting): EnumSetting | null {
  return s.kind === "enum" ? s : null;
}

export function asStringSetting(s: EditorSetting): StringSetting | null {
  return s.kind === "string" ? s : null;
}

/// A fresh copy of one entry's default. Arrays and records are cloned so a
/// mutation of the live store can never reach back into the table.
export function defaultFor(setting: EditorSetting): EditorCoreSettings[keyof EditorCoreSettings] {
  if (setting.kind === "numberList") return [...setting.default];
  if (setting.kind === "pathMap") return { ...setting.default };
  return setting.default;
}

/// The default editor settings, derived from the table rather than written out
/// beside it. `store/settings.ts` exports this as `DEFAULT_SETTINGS.editor`.
export function defaultEditorSettings(): EditorSettings {
  const out: Record<string, unknown> = {};
  for (const s of EDITOR_SETTING_LIST) out[s.key] = defaultFor(s);
  out.languageOverrides = {};
  // Built key by key from the table, which the `satisfies SettingTable` above
  // proves covers every field — but TypeScript cannot follow a loop into a
  // shape, so the assertion is where that proof is cashed in.
  return out as unknown as EditorSettings;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/// Coerce one persisted value against its entry.
///
/// Returns `undefined` when the value is unusable — wrong type, or an enum
/// member that no longer exists — so the caller can fall back to the default.
/// Numbers out of range are *clamped* rather than rejected: a font size of 400
/// is a typo, not a reason to silently reset the whole font section.
export function coerceSettingValue(setting: EditorSetting, value: unknown): unknown | undefined {
  switch (setting.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? clamp(value, setting.min, setting.max)
        : undefined;
    case "enum":
      return typeof value === "string" && setting.members.some((m) => m.value === value)
        ? value
        : undefined;
    case "string":
      return typeof value === "string" ? value : undefined;
    case "numberList": {
      if (!Array.isArray(value)) return undefined;
      const nums = value
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .map((v) => clamp(Math.round(v), setting.min, setting.max));
      return [...new Set(nums)].sort((a, b) => a - b);
    }
    case "pathMap": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  }
}

/// Whether a value differs from its entry's default. Drives the modified dot,
/// the per-setting reset and the "modified only" filter.
export function isModified(setting: EditorSetting, value: unknown): boolean {
  if (setting.kind === "numberList") {
    const d = setting.default;
    return (
      !Array.isArray(value) || value.length !== d.length || value.some((v, i) => v !== d[i])
    );
  }
  if (setting.kind === "pathMap") {
    // The default is `{}`, so any entry with a non-empty value counts. A key
    // present but blank is the resting state of every LSP row and must not
    // light the dot up.
    if (typeof value !== "object" || value === null) return true;
    return Object.values(value as Record<string, unknown>).some((v) => v !== "");
  }
  return value !== setting.default;
}

/// Coerce a persisted `editor` payload into a complete `EditorSettings`.
///
/// Three rules, all of them load-bearing:
///
/// 1. A key the payload does not have takes the table's default — this is what
///    makes a blob written before a setting existed still load.
/// 2. A key whose value no longer validates takes the default too, rather than
///    poisoning the editor with a member Monaco will reject.
/// 3. **Keys the table does not know survive untouched.** A user on a newer
///    build whose config is opened by an older one must not lose fields, so the
///    unknown half of the payload is carried through to the next write.
export function parseEditorSettings(raw: unknown): EditorSettings {
  const source = isPlainObject(raw) ? raw : {};
  const known = new Set<string>(EDITOR_SETTING_LIST.map((s) => s.key as string));
  known.add("languageOverrides");

  const out: Record<string, unknown> = {};
  // Unknown keys first, so a validated value always wins over a stale one.
  for (const [k, v] of Object.entries(source)) {
    if (!known.has(k)) out[k] = v;
  }
  for (const s of EDITOR_SETTING_LIST) {
    const coerced =
      s.key in source ? coerceSettingValue(s, (source as Record<string, unknown>)[s.key]) : undefined;
    out[s.key] = coerced === undefined ? defaultFor(s) : coerced;
  }
  out.languageOverrides = parseLanguageOverrides(source.languageOverrides);
  // Built key by key from the table, which the `satisfies SettingTable` above
  // proves covers every field — but TypeScript cannot follow a loop into a
  // shape, so the assertion is where that proof is cashed in.
  return out as unknown as EditorSettings;
}

/// Per-language overrides, keyed by Monaco language id. Same three rules as
/// above, minus the defaults: an override only holds the fields it overrides,
/// so an absent key means "inherit", not "reset".
function parseLanguageOverrides(raw: unknown): Record<string, Partial<EditorCoreSettings>> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, Partial<EditorCoreSettings>> = {};
  for (const [language, patch] of Object.entries(raw)) {
    if (!isPlainObject(patch)) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const setting = BY_KEY.get(k);
      if (!setting) {
        // Unknown here too — a newer build's override key must round-trip.
        clean[k] = v;
        continue;
      }
      const coerced = coerceSettingValue(setting, v);
      if (coerced !== undefined) clean[k] = coerced;
    }
    if (Object.keys(clean).length > 0) out[language] = clean as Partial<EditorCoreSettings>;
  }
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/// The globals with `languageId`'s overrides folded on top, per field.
///
/// Pure and DOM-free — this is the whole per-language contract in one function,
/// and it is the only place an override is resolved. `editorController` and
/// `useEditorOptionsSync` both call it, which is what keeps "there is no second
/// path by which a setting reaches Monaco" true with overrides in play.
///
/// An unknown language, or one with no entry, returns the globals unchanged.
export function effectiveEditorSettings(
  settings: EditorSettings,
  languageId: string | null | undefined,
): EditorSettings {
  if (!languageId) return settings;
  const patch = settings.languageOverrides[languageId];
  if (!patch || Object.keys(patch).length === 0) return settings;
  // `languageOverrides` is deliberately not spread from the patch: an override
  // cannot itself carry overrides, and letting one through would make
  // resolution recursive for no gain.
  return { ...settings, ...patch, languageOverrides: settings.languageOverrides };
}
