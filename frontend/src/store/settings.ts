import { createStore } from "solid-js/store";
import { createEffect } from "solid-js";
import type { CommitIdentity } from "@/types/git";
import { defaultEditorSettings, parseEditorSettings } from "./settingsSchema";

export type CursorStyle = "block" | "underline" | "bar";
export type UiTextSize = "sm" | "base" | "xl";
export type UiDensity = "compact" | "normal" | "comfortable";

/// Whether the git client and the code editor get their own OS windows
/// ("detached", the default) or live inside the main window as switchable views
/// ("stacked"). See `commands/environment.ts` for how the choice is routed.
export type EnvironmentMode = "stacked" | "detached";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontWeightBold: number;
  letterSpacing: number;
  ligatures: boolean;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  cursorWidth: number;
  scrollback: number;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  macOptionIsMeta: boolean;
  rightClickSelectsWord: boolean;
  scrollSensitivity: number;
  scrollOnUserInput: boolean;
}

/// Word wrap. `wordWrapColumn` wraps at `wordWrapColumn` regardless of the
/// viewport; `bounded` wraps at the smaller of the two, which is the only mode
/// that behaves the same in a split pane as in a full-width one.
export type EditorWordWrap = "off" | "on" | "wordWrapColumn" | "bounded";
export type EditorRenderWhitespace = "none" | "selection" | "boundary" | "trailing" | "all";
export type EditorLineNumbers = "on" | "off" | "relative";
export type EditorWrappingIndent = "none" | "same" | "indent" | "deepIndent";
export type EditorRenderFinalNewline = "on" | "off" | "dimmed";
export type EditorFoldingStrategy = "auto" | "indentation";
export type EditorShowFoldingControls = "always" | "never" | "mouseover";
export type EditorRenderLineHighlight = "none" | "gutter" | "line" | "all";
export type EditorMultiCursorModifier = "ctrlCmd" | "alt";
export type EditorAcceptSuggestionOnEnter = "on" | "smart" | "off";
export type EditorSnippetSuggestions = "top" | "bottom" | "inline" | "none";
export type EditorOccurrencesHighlight = "off" | "singleFile" | "multiFile";
export type EditorAutoClosingBrackets =
  | "always"
  | "languageDefined"
  | "beforeWhitespace"
  | "never";
export type EditorAutoSurround = "languageDefined" | "quotes" | "brackets" | "never";
/// Monaco's cursor vocabulary, not xterm's — `line` where the terminal says
/// `bar`. Kept separate from `CursorStyle` rather than mapped, because the two
/// surfaces genuinely have different option sets and a shared type would have
/// to lie about one of them.
export type EditorCursorStyle = "line" | "block" | "underline";
export type EditorCursorBlinking = "blink" | "smooth" | "phase" | "expand" | "solid";
/// When a buffer is written back without an explicit ⌘S. `afterDelay` writes
/// `autoSaveDelayMs` after the last keystroke; `onFocusChange` on blur.
///
/// The dirty dot is *never* suppressed by any of these (MASTER §7.5.3): it
/// appears on the first edit and clears on the write, so a pending autosave is
/// always visible rather than being quietly implied.
export type EditorAutoSave = "off" | "afterDelay" | "onFocusChange";

/// Everything the code editor reads. Every field here must be applicable to a
/// live editor through `updateOptions` / `model.updateOptions` — a setting that
/// only takes effect after a reload is a bug, not a limitation, so a new field
/// that Monaco can only consume at construction time does not belong in this
/// interface without a note saying why.
///
/// **Every field here needs an entry in `settingsSchema.ts`,** and the compiler
/// enforces it: the schema is declared `satisfies` a mapped type over these
/// keys, so adding a field without a schema entry fails to build. The entry is
/// where the default, the constraints and the description live — this interface
/// is only the shape.
///
/// `EditorCoreSettings` is the per-setting half; `EditorSettings` adds the
/// override map, which is not itself a setting. Splitting them is what keeps
/// `Partial<EditorCoreSettings>` from being recursive.
export interface EditorCoreSettings {
  fontFamily: string;
  fontSize: number;
  /// Monaco's own convention: `0` computes the height from the font size, and
  /// anything in `(0, 8]` is a multiplier. Larger values are raw pixels.
  lineHeight: number;
  fontLigatures: boolean;
  tabSize: number;
  insertSpaces: boolean;
  /// Guess `tabSize` / `insertSpaces` from the file's contents. Applied live by
  /// calling `model.detectIndentation`, not only at model creation — see
  /// `applyModelSettings` in `monaco.ts`.
  detectIndentation: boolean;
  trimAutoWhitespace: boolean;
  wordWrap: EditorWordWrap;
  wordWrapColumn: number;
  wrappingIndent: EditorWrappingIndent;
  minimap: boolean;
  stickyScroll: boolean;
  bracketPairColorization: boolean;
  renderWhitespace: EditorRenderWhitespace;
  renderFinalNewline: EditorRenderFinalNewline;
  /// Columns to draw a vertical rule at. Empty means none.
  rulers: number[];
  indentGuides: boolean;
  bracketPairGuides: boolean;
  lineNumbers: EditorLineNumbers;
  renderLineHighlight: EditorRenderLineHighlight;
  folding: boolean;
  foldingStrategy: EditorFoldingStrategy;
  showFoldingControls: EditorShowFoldingControls;
  cursorStyle: EditorCursorStyle;
  cursorBlinking: EditorCursorBlinking;
  cursorSurroundingLines: number;
  multiCursorModifier: EditorMultiCursorModifier;
  smoothScrolling: boolean;
  scrollBeyondLastLine: boolean;
  mouseWheelZoom: boolean;
  scrollbarVerticalSize: number;
  scrollbarHorizontalSize: number;
  suggestOnTriggerCharacters: boolean;
  /// Suggest as you type. Maps to Monaco's `{ other, comments, strings }`
  /// object with comments and strings left off, which is its default.
  quickSuggestions: boolean;
  acceptSuggestionOnEnter: EditorAcceptSuggestionOnEnter;
  snippetSuggestions: EditorSnippetSuggestions;
  inlayHints: boolean;
  parameterHints: boolean;
  occurrencesHighlight: EditorOccurrencesHighlight;
  selectionHighlight: boolean;
  unicodeHighlight: boolean;
  autoClosingBrackets: EditorAutoClosingBrackets;
  autoSurround: EditorAutoSurround;
  linkedEditing: boolean;
  formatOnSave: boolean;
  trimTrailingWhitespaceOnSave: boolean;
  insertFinalNewlineOnSave: boolean;
  autoSave: EditorAutoSave;
  autoSaveDelayMs: number;
  /// Vim keybindings. Off by default, and `monaco-vim` is only imported when
  /// this is on, so declining it costs nothing. Ships with a mode indicator —
  /// a Vim mode whose current mode is invisible is unusable.
  vimMode: boolean;
  /// Start language servers for files that have one. On by default: a server
  /// is only ever started when its binary is already installed, so the setting
  /// costs nothing for the users who have none, and the ones who installed
  /// rust-analyzer did so in order to use it.
  ///
  /// Like `formatOnSave`, `autoSave` and `vimMode`, this is not a Monaco option
  /// — the "must apply through `updateOptions`" rule above is about the fields
  /// that *are*. Turning it off stops the running servers immediately; it does
  /// not need a reload either.
  lspEnabled: boolean;
  /// Override where a server's binary lives, keyed by server id (see
  /// `components/editor/lspServers.ts`). An empty or absent value means "find
  /// it on `PATH`", which is the case for everyone who installed it normally.
  lspServerPaths: Record<string, string>;
}

/// The editor settings plus the per-language override map.
///
/// Overrides are keyed by **Monaco language id** (`typescript`, `rust`), not by
/// file extension — the same idiom `lspServerPaths` uses for server ids, and
/// the only key a model can actually be asked for. A patch holds just the
/// fields it overrides; everything absent inherits. `effectiveEditorSettings`
/// in `settingsSchema.ts` is the one place they are resolved.
export type EditorSettings = EditorCoreSettings & {
  languageOverrides: Record<string, Partial<EditorCoreSettings>>;
};

export interface UiSettings {
  textSize: UiTextSize;
  density: UiDensity;
  environmentMode: EnvironmentMode;
  /// Surface gitignored files in the file tree and Cmd+P. Off by default —
  /// the point of the ignore list is that build output stays out of the way —
  /// but a repo's `.env` is gitignored and still needs editing, which is the
  /// case this exists for.
  showIgnoredFiles: boolean;
}

/// Non-secret identity of a provider key. `id` is the OS-keychain account the
/// value is filed under; `envVar` is the environment variable it is exported
/// as when voidlink spawns the user's AI CLI. **This object never carries the
/// value** — secrets live in the keychain only, reachable from Rust and never
/// returned to the frontend, so persisting bindings to localStorage is safe.
export interface AiKeyBinding {
  id: string;
  envVar: string;
  label: string;
}

/// Keys voidlink offers out of the box. These are always listed in Settings →
/// AI (as "Not set" until you add one) so the common case needs no typing.
/// Custom bindings live in `AiSettings.customKeys`.
export const AI_KEY_PRESETS: readonly AiKeyBinding[] = [
  { id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  { id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
  { id: "gemini", envVar: "GEMINI_API_KEY", label: "Google Gemini" },
  { id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
];

/// One named agent in the workspace roster. `commandTemplate` is a shell
/// command the grounded prompt is piped to on stdin — same BYO-CLI contract
/// as `commitCommand`.
///
/// The name exists so two entries pointing at differently-configured CLIs are
/// distinguishable in a tab title. Anonymity was the whole limitation of the
/// single-command agent: there was exactly one, so it never needed a label.
export interface AgentRosterEntry {
  id: string;
  name: string;
  commandTemplate: string;
}

/// The id the silent migration gives the entry built from `ai.agentCommand`.
///
/// A stable literal rather than a fresh uuid so the migration is idempotent:
/// a payload that has already been through it is recognisable, and anything
/// that persisted a binding to the pre-roster agent still resolves.
export const DEFAULT_AGENT_ID = "default";

/// AI is BYO-CLI: voidlink shells out to whatever generative-text command the
/// user already has installed. `commitCommand` is the shell template; the
/// staged diff is piped to stdin and stdout becomes the suggested message.
///
/// `agents` is the per-workspace roster: each entry is a named agent an agent
/// tab can be bound to, so two differently-configured CLIs can run side by
/// side. It is never empty — `parseSettings` synthesizes a one-entry roster
/// from `agentCommand` rather than allowing a state in which every bound tab
/// points at nothing.
///
/// `agentCommand` survives the roster as the shared fallback, and is the
/// reason the fallback chain has three links: an entry's own
/// `commandTemplate`, else `agentCommand`, else `commitCommand`. Deleting it
/// would have been tidier and would have silently unconfigured everyone whose
/// roster entry leaves its template blank. `resolveAgentCommand` is the one
/// place the chain is walked.
///
/// `customKeys` extends `AI_KEY_PRESETS` with user-defined provider keys. Like
/// the presets it holds only the id → env-var mapping; values are in the OS
/// keychain.
export interface AiSettings {
  commitCommand: string;
  agentCommand: string;
  agents: AgentRosterEntry[];
  customKeys: AiKeyBinding[];
}

/// Commit identity overrides, keyed by repository root.
///
/// Per-repo rather than global because the whole point is having a different
/// identity in a work repo than a personal one. An absent entry means "use
/// whatever git config says", which is the default for every repository —
/// voidlink only stores the exceptions.
///
/// This never writes to the repository's git config. It is a voidlink-side
/// override applied at commit time, so it cannot surprise you the next time
/// you commit from the command line.
///
/// That is a statement about *this* store, not about voidlink: Settings → Git
/// does write real git config (`gitApi.configSet`), and the two sit adjacent in
/// the same pane. If you are looking for `user.name` in git config, it is not
/// here and never will be — `identityByRepo` is deliberately a separate layer.
export interface GitSettings {
  identityByRepo: Record<string, CommitIdentity>;
}

export interface AppSettings {
  ui: UiSettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  ai: AiSettings;
  git: GitSettings;
}

const STORAGE_KEY = "voidlink-settings";

const DEFAULTS: AppSettings = {
  ui: {
    textSize: "base",
    density: "normal",
    // Detached is what shipped, so an existing install sees no change until it
    // opts in. `mergeDefaults` fills the key in for settings saved before it
    // existed.
    environmentMode: "detached",
    showIgnoredFiles: false,
  },
  terminal: {
    // Prefer a nerd-font stack so Starship/powerline glyphs render, with plain
    // system fallbacks if no nerd font is installed.
    //
    // The *Mono* variants come first deliberately. Nerd Fonts ships each icon
    // twice: at a double-cell advance in the plain family, and squeezed into
    // one cell in the "Mono"/"NFM" family. xterm assigns the private-use
    // codepoints those icons live at a width of 1 under every Unicode table it
    // has, so the plain family draws each prompt icon a cell wider than the
    // grid reserved — a starship prompt with a handful of icons then sits
    // several columns right of where the terminal thinks it does, and the
    // input line redraws over itself. The Mono family is the one meant for
    // terminals.
    fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrainsMono Nerd Font", "JetBrainsMono NF", "FiraCode Nerd Font Mono", "FiraCode NFM", "Cascadia Code", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    fontWeight: 400,
    fontWeightBold: 700,
    letterSpacing: 0,
    ligatures: false,
    cursorStyle: "block",
    cursorBlink: true,
    cursorWidth: 1,
    scrollback: 5000,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    macOptionIsMeta: false,
    rightClickSelectsWord: false,
    scrollSensitivity: 1,
    scrollOnUserInput: true,
  },
  /// Derived from `settingsSchema.ts` rather than written out here, so the
  /// defaults, the parse and the dialog cannot drift apart.
  ///
  /// The schema's values were chosen to reproduce exactly what the editor did
  /// before it was configurable: the old hardcoded `SHARED_EDITOR_OPTIONS` for
  /// the keys it set, and Monaco's own defaults for the keys it left alone. An
  /// existing install therefore sees no visual change on upgrade — only new
  /// controls.
  editor: defaultEditorSettings(),
  ai: {
    commitCommand: "",
    agentCommand: "",
    // Not `[]`. A fresh install and a migrated one land on the same shape, so
    // no caller anywhere has to handle an empty roster.
    agents: [{ id: DEFAULT_AGENT_ID, name: "Repo agent", commandTemplate: "" }],
    customKeys: [],
  },
  git: {
    identityByRepo: {},
  },
};

function mergeDefaults<T extends object>(defaults: T, partial: Partial<T> | undefined): T {
  if (!partial) return { ...defaults };
  return { ...defaults, ...partial };
}

/// Validate a persisted roster row by row, and synthesize the one-entry roster
/// when nothing usable survives.
///
/// Malformed rows are **dropped, not thrown on**. This is user-editable JSON on
/// disk (Settings → JSON writes the same file), so a hand-edited entry with a
/// numeric name is a realistic input, and the per-row policy the rest of this
/// codebase applies — one bad row costs one row — is the only one that doesn't
/// turn a typo into a settings reset.
///
/// Ids are deduped keeping the first occurrence: a later duplicate is
/// unreachable anyway, because every lookup goes through `agentById`, which
/// returns the first match.
function parseAgentRoster(raw: unknown, agentCommand: string): AgentRosterEntry[] {
  const entries: AgentRosterEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const { id, name, commandTemplate } = row as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string") continue;
      if (typeof commandTemplate !== "string") continue;
      if (!id.trim() || seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, name, commandTemplate });
    }
  }
  if (entries.length > 0) return entries;
  // The silent migration: an install whose only agent config is the old single
  // `agentCommand` boots into a roster of exactly that command, under the name
  // the slide-over header already showed, so nothing about its behaviour or
  // vocabulary changes.
  return [{ id: DEFAULT_AGENT_ID, name: "Repo agent", commandTemplate: agentCommand.trim() }];
}

function parseAiSettings(partial: Partial<AiSettings> | undefined): AiSettings {
  const ai = mergeDefaults(DEFAULTS.ai, partial);
  return { ...ai, agents: parseAgentRoster(partial?.agents, ai.agentCommand) };
}

/// Fold a persisted payload into a complete settings object.
///
/// Split out of `load` and exported so the forward-compatibility rule — a
/// payload saved before a section existed loads with that section's defaults
/// filled in — is testable without a browser. Every new top-level section needs
/// a line here or it silently stays `undefined` for every existing install.
///
/// The editor section is the one that does not use `mergeDefaults`: it goes
/// through `parseEditorSettings`, which fills from the schema *and* validates,
/// so a stale enum member or an out-of-range number cannot reach Monaco. Keys
/// the schema has never heard of still survive the round-trip, which is what
/// stops an older build from eating a newer one's config.
export function parseSettings(raw: string | null): AppSettings {
  try {
    if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ui: mergeDefaults(DEFAULTS.ui, parsed.ui),
      terminal: mergeDefaults(DEFAULTS.terminal, parsed.terminal),
      // Absent in every payload saved before the editor became configurable,
      // which is every payload on disk today.
      editor: parseEditorSettings(parsed.editor),
      // The one section besides `editor` that validates rather than merging:
      // the agent roster has to be non-empty for every caller downstream, and
      // has to absorb a payload saved before it existed. See
      // `parseAgentRoster`.
      ai: parseAiSettings(parsed.ai),
      git: mergeDefaults(DEFAULTS.git, parsed.git),
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function load(): AppSettings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

const [settings, setSettings] = createStore<AppSettings>(load());

createEffect(() => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
});

// ── UI effects: apply textSize + density to <html> so CSS rules can react.
const TEXT_SIZE_PX: Record<UiTextSize, number> = { sm: 14, base: 16, xl: 18 };

createEffect(() => {
  const html = document.documentElement;
  html.style.fontSize = `${TEXT_SIZE_PX[settings.ui.textSize]}px`;
  html.setAttribute("data-density", settings.ui.density);
});

export function useSettings() {
  return {
    settings,
    updateTerminal(patch: Partial<TerminalSettings>) {
      setSettings("terminal", patch);
    },
    updateEditor(patch: Partial<EditorSettings>) {
      setSettings("editor", patch);
    },
    updateUi(patch: Partial<UiSettings>) {
      setSettings("ui", patch);
    },
    updateAi(patch: Partial<AiSettings>) {
      setSettings("ai", patch);
    },
    /// Append a roster entry and return its id, so the caller can bind a tab to
    /// the agent it just created without re-reading the roster to find it.
    addAgent(name: string, commandTemplate: string): string {
      const id = crypto.randomUUID();
      setSettings("ai", "agents", (agents) => [...agents, { id, name, commandTemplate }]);
      return id;
    },
    updateAgent(id: string, patch: Partial<Omit<AgentRosterEntry, "id">>) {
      setSettings("ai", "agents", (agents) =>
        agents.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      );
    },
    /// Remove an entry. Refuses to remove the last one — a roster of zero would
    /// leave every agent tab bound to nothing, and there is no UI state that
    /// recovers from that except re-adding an agent, which the user would have
    /// to guess at.
    removeAgent(id: string) {
      if (settings.ai.agents.length <= 1) return;
      setSettings("ai", "agents", (agents) => agents.filter((entry) => entry.id !== id));
    },
    /// Save a per-repo identity override. Trims both fields; passing a blank
    /// name or email clears the override instead of storing an unusable one.
    setRepoIdentity(repoRoot: string, identity: CommitIdentity | null) {
      const name = identity?.name.trim() ?? "";
      const email = identity?.email.trim() ?? "";
      if (!name || !email) {
        setSettings("git", "identityByRepo", (byRepo) => {
          const next = { ...byRepo };
          delete next[repoRoot];
          return next;
        });
        return;
      }
      setSettings("git", "identityByRepo", (byRepo) => ({
        ...byRepo,
        [repoRoot]: { name, email },
      }));
    },
    /// Append a custom provider key binding. Rejects a duplicate id so a
    /// binding can never shadow a preset or another custom row.
    addAiKey(binding: AiKeyBinding) {
      if (aiKeyBindings().some((b) => b.id === binding.id)) return false;
      setSettings("ai", "customKeys", (keys) => [...keys, binding]);
      return true;
    },
    /// Drop a custom binding. The keychain entry is deleted separately via
    /// `secretsApi.delete` — this only forgets the mapping.
    removeAiKey(id: string) {
      setSettings("ai", "customKeys", (keys) => keys.filter((k) => k.id !== id));
    },
    reset() {
      setSettings(JSON.parse(JSON.stringify(DEFAULTS)));
    },
  };
}

/// Every provider-key binding voidlink knows about: bundled presets first,
/// then the user's custom rows. Non-reactive snapshot — safe to call from the
/// command layer outside a tracking scope.
export function aiKeyBindings(): AiKeyBinding[] {
  return [...AI_KEY_PRESETS, ...settings.ai.customKeys];
}

/// The shape `git_ai_generate_commit` / `git_agent_query` accept. Only the
/// id → env-var mapping crosses to Rust; Rust resolves the values from the OS
/// keychain at spawn time, so no secret ever passes through here.
export function aiSecretBindings(): { id: string; envVar: string }[] {
  return aiKeyBindings().map(({ id, envVar }) => ({ id, envVar }));
}

/// The workspace's agent roster. Non-reactive snapshot — safe to call from the
/// command layer outside a tracking scope, like `aiKeyBindings()`.
///
/// Copied rather than returned as-is: the store's array is what Solid tracks,
/// and handing it to a caller that might sort it in place is a mutation of
/// persisted state that no `setSettings` call would explain.
export function agentRoster(): AgentRosterEntry[] {
  return [...settings.ai.agents];
}

/// One entry by id, or `null` when the id is stale — a tab bound to an agent
/// the user has since removed. Callers render that as an unconfigured agent
/// rather than crashing. Non-reactive.
export function agentById(id: string): AgentRosterEntry | null {
  return settings.ai.agents.find((entry) => entry.id === id) ?? null;
}

/// The roster entry a new agent tab binds to when the caller has no preference:
/// the first entry. `parseSettings` guarantees there is one; the `??` is for the
/// type, not for a state that can occur.
export function defaultAgentId(): string {
  return settings.ai.agents[0]?.id ?? DEFAULT_AGENT_ID;
}

/// The shell template to actually run for `entry`: its own template, else the
/// shared `ai.agentCommand`, else `ai.commitCommand` — the same two fallbacks
/// the single-command agent already had, with the per-entry template layered on
/// top. Returns `""` when nothing is configured, which callers render as the
/// "no AI command configured" notice rather than spawning an empty shell.
export function resolveAgentCommand(entry: AgentRosterEntry | null): string {
  const own = entry?.commandTemplate.trim() ?? "";
  if (own) return own;
  const shared = settings.ai.agentCommand.trim();
  if (shared) return shared;
  return settings.ai.commitCommand.trim();
}

/// The saved identity override for `repoRoot`, or `null` when that repo has
/// none and git config should win. Non-reactive snapshot.
export function repoIdentity(repoRoot: string): CommitIdentity | null {
  return settings.git.identityByRepo[repoRoot] ?? null;
}

export const DEFAULT_SETTINGS = DEFAULTS;
