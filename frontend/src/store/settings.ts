import { createStore } from "solid-js/store";
import { createEffect } from "solid-js";
import type { CommitIdentity } from "@/types/git";

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

/// Word wrap. `bounded` wraps at the smaller of the viewport and
/// `wordWrapColumn`, which is the only mode that behaves the same in a split
/// pane as in a full-width one.
export type EditorWordWrap = "off" | "on" | "bounded";
export type EditorRenderWhitespace = "none" | "selection" | "boundary" | "all";
export type EditorLineNumbers = "on" | "off" | "relative";
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
export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  /// Monaco's own convention: `0` computes the height from the font size, and
  /// anything in `(0, 8]` is a multiplier. Larger values are raw pixels.
  lineHeight: number;
  fontLigatures: boolean;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: EditorWordWrap;
  wordWrapColumn: number;
  minimap: boolean;
  stickyScroll: boolean;
  bracketPairColorization: boolean;
  renderWhitespace: EditorRenderWhitespace;
  indentGuides: boolean;
  lineNumbers: EditorLineNumbers;
  cursorStyle: EditorCursorStyle;
  cursorBlinking: EditorCursorBlinking;
  smoothScrolling: boolean;
  scrollBeyondLastLine: boolean;
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

/// AI is BYO-CLI: voidlink shells out to whatever generative-text command the
/// user already has installed. `commitCommand` is the shell template; the
/// staged diff is piped to stdin and stdout becomes the suggested message.
/// `agentCommand` is the (optional) template for the repo agent — a grounded
/// prompt is piped to stdin. When empty, the agent falls back to
/// `commitCommand` so a single configured CLI powers both.
///
/// `customKeys` extends `AI_KEY_PRESETS` with user-defined provider keys. Like
/// the presets it holds only the id → env-var mapping; values are in the OS
/// keychain.
export interface AiSettings {
  commitCommand: string;
  agentCommand: string;
  customKeys: AiKeyBinding[];
}

/// The local path to the brain-kb vault (a git-cloned second-brain content
/// repo). Independent of the `brain` CLI's own `~/.config/brain/config.json`
/// vaultPath — the two must be pointed at the same directory by hand.
export interface BrainSettings {
  vaultPath: string;
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
export interface GitSettings {
  identityByRepo: Record<string, CommitIdentity>;
}

export interface AppSettings {
  ui: UiSettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  ai: AiSettings;
  brain: BrainSettings;
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
  /// Chosen to reproduce exactly what the editor did before it was
  /// configurable: the old hardcoded `SHARED_EDITOR_OPTIONS` for the keys it
  /// set, and Monaco's own defaults for the keys it left alone. An existing
  /// install therefore sees no visual change on upgrade — the pane starts
  /// where the editor already was.
  editor: {
    fontFamily: "'Geist Mono Variable', 'Geist Mono', monospace",
    fontSize: 13,
    lineHeight: 0, // 0 = derive from font size, which is what Monaco was doing
    fontLigatures: false,
    tabSize: 4,
    insertSpaces: true,
    wordWrap: "off",
    wordWrapColumn: 80,
    minimap: false,
    stickyScroll: false,
    bracketPairColorization: false,
    renderWhitespace: "selection",
    indentGuides: true,
    lineNumbers: "on",
    cursorStyle: "line",
    cursorBlinking: "blink",
    smoothScrolling: false,
    scrollBeyondLastLine: false,
    formatOnSave: false,
    trimTrailingWhitespaceOnSave: false,
    insertFinalNewlineOnSave: false,
    autoSave: "off",
    autoSaveDelayMs: 1000,
    vimMode: false,
    lspEnabled: true,
    lspServerPaths: {},
  },
  ai: {
    commitCommand: "",
    agentCommand: "",
    customKeys: [],
  },
  brain: {
    vaultPath: "",
  },
  git: {
    identityByRepo: {},
  },
};

function mergeDefaults<T extends object>(defaults: T, partial: Partial<T> | undefined): T {
  if (!partial) return { ...defaults };
  return { ...defaults, ...partial };
}

/// Fold a persisted payload into a complete settings object.
///
/// Split out of `load` and exported so the forward-compatibility rule — a
/// payload saved before a section existed loads with that section's defaults
/// filled in — is testable without a browser. Every new top-level section needs
/// a line here or it silently stays `undefined` for every existing install.
export function parseSettings(raw: string | null): AppSettings {
  try {
    if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ui: mergeDefaults(DEFAULTS.ui, parsed.ui),
      terminal: mergeDefaults(DEFAULTS.terminal, parsed.terminal),
      // Absent in every payload saved before the editor became configurable,
      // which is every payload on disk today.
      editor: mergeDefaults(DEFAULTS.editor, parsed.editor),
      ai: mergeDefaults(DEFAULTS.ai, parsed.ai),
      brain: mergeDefaults(DEFAULTS.brain, parsed.brain),
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
    updateBrain(patch: Partial<BrainSettings>) {
      setSettings("brain", patch);
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

/// The saved identity override for `repoRoot`, or `null` when that repo has
/// none and git config should win. Non-reactive snapshot.
export function repoIdentity(repoRoot: string): CommitIdentity | null {
  return settings.git.identityByRepo[repoRoot] ?? null;
}

export const DEFAULT_SETTINGS = DEFAULTS;
