import { createStore } from "solid-js/store";
import { createEffect, createSignal } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { onUiVisualChange, publishUiVisualChange } from "@/api/windows";
import type { CommitIdentity } from "@/types/git";
import { defaultEditorSettings, parseEditorSettings } from "./settingsSchema";
import {
  composeClaudeCommand,
  parseClaudeSpec,
  type ClaudeAgentSpec,
} from "./claudeAgent";
// Imported from the leaf module rather than from `store/layout`, which reaches
// back into this file — the palette is a five-string constant and nothing here
// wants the store that happens to be exported beside it.
import {
  DEFAULT_TAB_GROUP_COLOR,
  TAB_GROUP_COLORS,
  type TabGroupColor,
} from "./layout/tabGroups";

export type CursorStyle = "block" | "underline" | "bar";
export type UiTextSize = "sm" | "base" | "xl";
export type UiDensity = "compact" | "normal" | "comfortable";

/// Whether the git client and the code editor get their own OS windows
/// ("detached", the default) or live inside the main window as switchable views
/// ("stacked"). See `commands/environment.ts` for how the choice is routed.
export type EnvironmentMode = "stacked" | "detached";

/// Which way a pane's tab strip runs. `horizontal` is the row above the pane
/// body that shipped; `vertical` is a column down its left edge.
///
/// It is a genuine layout mode, not a skin: a vertical strip gives a tab room
/// for a full path instead of 140px of truncation, but it also puts a third
/// navigation column at the left edge of the window, beside the rail and the
/// file tree. `App.tsx` is where that second consequence is dealt with — see
/// the note on the file explorer's placement there.
export type TabOrientation = "horizontal" | "vertical";

/// How the background image is scaled and positioned against the window.
/// `cover` is the sensible default — fills the window, cropping rather than
/// letterboxing, which is what every other "pick a wallpaper" surface does.
export type BackgroundFit = "cover" | "contain" | "tile";

export const BACKGROUND_FITS: readonly BackgroundFit[] = ["cover", "contain", "tile"];

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
  /// Whether the terminal may use the WebGL renderer.
  ///
  /// `auto` feature-detects and falls back to xterm's DOM renderer when WebGL2
  /// is unavailable or the addon fails to construct, which is right almost
  /// everywhere. The escape hatch exists for Linux: WebKitGTK hands back a
  /// *successful* WebGL2 context even when it is backed by a software
  /// rasterizer, and it masks the renderer string, so nothing we can query
  /// distinguishes a real GPU from llvmpipe. On such a machine the accelerated
  /// path is the slower one and there is no way to detect it — only to let the
  /// user say so.
  gpuAcceleration: TerminalGpuAcceleration;
}

/// `auto` — use WebGL when it is available. `off` — always use xterm's DOM
/// renderer.
export type TerminalGpuAcceleration = "auto" | "off";

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
  /// Which way every pane's tab strip runs. Applies to the workbench and to
  /// the detached editor window alike — the strip is one component and a
  /// preference that held in one window and not the other would read as a bug.
  tabOrientation: TabOrientation;
  /// Width of the vertical tab column, in px. Ignored while the strip is
  /// horizontal. Persisted here rather than in the layout store because it is
  /// a property of the *preference* — resetting the layout must not silently
  /// take the column back to its default width.
  verticalTabWidth: number;
  /// Surface gitignored files in the file tree and Cmd+P. Off by default —
  /// the point of the ignore list is that build output stays out of the way —
  /// but a repo's `.env` is gitignored and still needs editing, which is the
  /// case this exists for.
  showIgnoredFiles: boolean;
  /// Absolute path to a user-picked background image, or `null` for the
  /// plain themed background. A *path*, not a copy of the file — resolved
  /// through the Tauri asset protocol (`convertFileSrc`) at paint time, never
  /// read into a data URI. Shared by all three windows (see
  /// `bridgeUiVisualAcrossWindows` in this file).
  backgroundImage: string | null;
  /// How opaque the island surfaces are over the background image, 0-100.
  /// 100 (the default) is today's fully opaque chrome — an install that never
  /// touches this setting sees no visual change. Ignored while
  /// `backgroundImage` is unset, and overridden to fully opaque under
  /// `prefers-reduced-transparency: reduce` regardless of its value (`index.css`).
  surfaceOpacity: number;
  /// Blur radius, in px, applied *behind* every translucent surface — the
  /// difference between "the photo shows through the chrome" and "the chrome
  /// is frosted glass sitting on the photo". Only the second one stays
  /// readable over a busy image, which is why this defaults to on rather than
  /// to 0: an install that turns on a background image should get the
  /// legible version of it without a second trip to settings.
  ///
  /// Same two conditions as `surfaceOpacity`: ignored while `backgroundImage`
  /// is unset, and dropped entirely under `prefers-reduced-transparency:
  /// reduce` (`index.css`). 0 is a real value and removes the compositing
  /// pass altogether — see `data-surface-blur` in the effect below.
  surfaceBlur: number;
  /// How strongly the image itself comes through, 0-100 — the *other* half of
  /// the transparency feature, and a different question from `surfaceOpacity`.
  /// That slider says how translucent the islands are; this one says how much
  /// photo is behind them to see. They are separate because the scrim between
  /// the image and the shell is what protects text contrast, so turning the
  /// islands down while the scrim stays put reveals nothing but the scrim —
  /// which is exactly how this feature read as inert.
  ///
  /// Drives `--ui-bg-scrim` (the scrim's own opacity) in the effect below:
  /// 0 → a 95%-opaque scrim, the near-invisible image this shipped with;
  /// 100 → 25%, the photo plainly present. Linear in between; `index.css`'s
  /// scrim comment has the measured contrast at both ends and names where AA
  /// stops holding.
  ///
  /// Same two conditions as the two above: ignored while `backgroundImage` is
  /// unset, and irrelevant under `prefers-reduced-transparency: reduce`, where
  /// the image is dropped altogether.
  backgroundStrength: number;
  /// How the background image is scaled and positioned. See `BackgroundFit`.
  backgroundFit: BackgroundFit;
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
  // A `claude setup-token` token, which is how a Claude *subscription* is used
  // non-interactively. It is exactly the shape the presets already handle — an
  // id and an env var, value in the keychain — and its absence was why a user
  // on a paid plan opened this pane, saw only "Anthropic: not set", and
  // concluded VoidLink wanted an API key they'd have to buy separately.
  //
  // Ordered directly after `ANTHROPIC_API_KEY` because that adjacency is the
  // point: the two are alternatives, and the API key silently wins when both
  // are present. See the note in `ProviderKeysSection`.
  {
    id: "claude-code-oauth",
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude subscription",
  },
  { id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
  { id: "gemini", envVar: "GEMINI_API_KEY", label: "Google Gemini" },
  { id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
];

/// One named agent in the workspace roster.
///
/// The name exists so two entries pointing at differently-configured CLIs are
/// distinguishable in a tab title. Anonymity was the whole limitation of the
/// single-command agent: there was exactly one, so it never needed a label.
///
/// **An entry is one of two things, and `claude` is which.** With no spec it is
/// the original BYO-CLI contract: `commandTemplate` is a shell command a
/// grounded prompt is piped to on stdin, and it can point at anything the user
/// has installed. With a spec it is a *composed* `claude` invocation — the
/// fields are the form in Settings → AI and the command is derived from them by
/// `composeClaudeCommand`.
///
/// The two are not a union type, because the migration between them has to be
/// lossless in both directions: switching a composed agent back to a
/// hand-written command must not throw the spec away, or the switch is a
/// one-way door the user finds out about afterwards. So both fields are always
/// present and `claude` being set is the whole of the discriminator.
export interface AgentRosterEntry {
  id: string;
  name: string;
  commandTemplate: string;
  /// The chip colour in the roster and on the terminal this agent launches.
  ///
  /// The five chart tokens, reused from tab groups rather than a new palette —
  /// the app already has one set of "distinguishable hues every theme defines"
  /// and a second would drift from it.
  color: TabGroupColor;
  /// Set when this agent is built from the form rather than typed as a command.
  claude?: ClaudeAgentSpec;
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

/// What runs when nothing is configured: the user's own `claude`, in print
/// mode, authenticated however that CLI is already authenticated on this
/// machine.
///
/// **This is the shipped answer now, not a suggestion.** Settings → AI no
/// longer offers a command box — see `AiPane` for why — so these two constants
/// are what a fresh install actually spawns. Both are one-shot filters: the
/// grounded text is piped to stdin and stdout is the answer, which is the
/// contract `run_cli` implements and the reason `-p` is not optional here.
///
/// Exactly two flags, and the shortness is the design. Every optional extra is
/// a way for these to fail on a `claude` older than the one they were written
/// against — which is not hypothetical, it is what the Test button found the
/// day it shipped. `--print` and `--tools` are both long-standing; anything
/// newer belongs in a user's own command, not in the default.
///   • `-p` — one-shot. These are filters, not sessions.
///   • `--tools ''` — an empty built-in tool set. Neither of these paths wants
///     a model that can edit the repository; they want prose back. It also
///     makes them dramatically cheaper and faster than a tool-enabled turn.
///
/// The stored `commitCommand` / `agentCommand` still win when non-empty. They
/// are unreachable from the dialog and remain editable from Settings → JSON, so
/// an install that had `ollama run llama3.2` in there keeps it rather than being
/// silently switched to a different vendor on upgrade.
export const DEFAULT_COMMIT_COMMAND =
  `claude -p --tools '' ` +
  `'Write a concise, imperative-mood git commit message (50-character title, optional body) ` +
  `for the staged diff above. Output ONLY the message.'`;

export const DEFAULT_AGENT_COMMAND =
  `claude -p --tools '' ` +
  `'Answer the question above about this repository, using only the context given.'`;

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

/// Features that are on trial. Everything here defaults to **off**, and a
/// surface behind one of these flags must be genuinely absent when it is off —
/// not rendered and hidden, not polling in the background. `display: none` is
/// not an experiment, it is a feature you shipped and then apologised for.
///
/// A flag graduates by having its key deleted and its surface made
/// unconditional, which is why nothing else in the app is allowed to read
/// `settings.experimental` except the surface it gates.
export interface ExperimentalSettings {
  /// The agent kanban across every worktree in the active workspace: which
  /// agent needs you, which is working, which is done. Adds a sidebar entry
  /// and, with it, the board.
  agentDashboard: boolean;
  /// Show the Idle column — agents that have been quiet for
  /// `AGENT_IDLE_MS` without reporting completion.
  ///
  /// No effect at all while `agentDashboard` is off, and deliberately not
  /// coupled to it in the data: a nested flag that silently rewrites its
  /// parent's value is worse than one that is simply inert, because the JSON
  /// view would then show a value the GUI never set.
  showIdleAgents: boolean;
}

export interface AppSettings {
  ui: UiSettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  ai: AiSettings;
  git: GitSettings;
  experimental: ExperimentalSettings;
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
    // Horizontal is what shipped, so an existing install sees no change until
    // it opts in — the same rule `environmentMode` follows.
    tabOrientation: "horizontal",
    verticalTabWidth: 200,
    showIgnoredFiles: false,
    backgroundImage: null,
    surfaceOpacity: 100,
    surfaceBlur: 18,
    // Not 0: an install that picks an image is asking to see one, and 0 is
    // exactly the near-invisible image this setting exists to fix. 45 puts the
    // scrim at 63.5%, the highest round value at which both shipped default
    // themes still clear AA at the opacity floor — see the measured table in
    // `index.css` and `aaStrengthCeilingFor` below.
    backgroundStrength: 45,
    backgroundFit: "cover",
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
    gpuAcceleration: "auto",
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
    agents: [
      {
        id: DEFAULT_AGENT_ID,
        name: "Repo agent",
        commandTemplate: "",
        color: DEFAULT_TAB_GROUP_COLOR,
      },
    ],
    customKeys: [],
  },
  git: {
    identityByRepo: {},
  },
  /// Both off. An experiment that is on by default is not an experiment, and
  /// an upgrade must never add a sidebar entry the user did not ask for.
  experimental: {
    agentDashboard: false,
    showIdleAgents: false,
  },
};

function mergeDefaults<T extends object>(defaults: T, partial: Partial<T> | undefined): T {
  if (!partial) return { ...defaults };
  return { ...defaults, ...partial };
}

/// Floor of the `surfaceOpacity` slider. 0 is allowed: at 0% the island's own
/// tint is gone and an island *is* the canvas — which is a coherent thing to
/// ask for, because the canvas is not bare. `index.css`'s scrim comment
/// (search that file for "Background image + island translucency") has the
/// measured worst-case contrast: a `--canvas` scrim under everything keeps
/// foreground text ≥ AA against the two extremes a photo can present, and its
/// canvas-side numbers are exactly the 0% case. That scrim is no longer fixed
/// — `backgroundStrength` sets it — so the numbers there are a table over both
/// sliders rather than a single guarantee.
export const SURFACE_OPACITY_MIN = 0;
export const SURFACE_OPACITY_MAX = 100;

function clampSurfaceOpacity(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULTS.ui.surfaceOpacity;
  return Math.max(SURFACE_OPACITY_MIN, Math.min(SURFACE_OPACITY_MAX, Math.round(v)));
}

/// Bounds of the `surfaceBlur` slider. 0 is allowed — unlike the opacity
/// floor, "no blur" is a coherent thing to ask for (it is what shipped before
/// this setting existed) and it is also the only value that costs nothing to
/// render. The ceiling is where more radius stops being visible: past ~40px a
/// photograph is already an even wash of colour, so the slider would be
/// spending GPU on a difference nobody can see.
export const SURFACE_BLUR_MIN = 0;
export const SURFACE_BLUR_MAX = 40;

function clampSurfaceBlur(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULTS.ui.surfaceBlur;
  return Math.max(SURFACE_BLUR_MIN, Math.min(SURFACE_BLUR_MAX, Math.round(v)));
}

/// Bounds of the `backgroundStrength` slider. Both ends are real settings
/// rather than guard rails: 0 is the fully-dampened image this feature
/// shipped with, and 100 is a photo at the strongest the scrim math still
/// leaves room for.
export const BACKGROUND_STRENGTH_MIN = 0;
export const BACKGROUND_STRENGTH_MAX = 100;

/// The scrim's opacity at each end of the slider, in percent. Not a straight
/// inversion of the slider: the scrim is a *contrast floor*, so its useful
/// range is the narrow band between "the photo may as well not be there"
/// (95%, where the ten themes were originally measured) and "the photo is
/// present and the darkest theme is at the edge of AA" (25%). Mapping the
/// slider onto that band rather than onto 100→0 is what keeps every position
/// on it a position someone would actually choose.
const SCRIM_AT_STRENGTH_MIN = 95;
const SCRIM_AT_STRENGTH_MAX = 25;

/// Scrim opacity, in percent, for a strength value. Exported for the settings
/// row, which marks where AA is lost, and for the tests.
export function scrimOpacityFor(strength: number): number {
  const t = (strength - BACKGROUND_STRENGTH_MIN) / (BACKGROUND_STRENGTH_MAX - BACKGROUND_STRENGTH_MIN);
  return SCRIM_AT_STRENGTH_MIN + t * (SCRIM_AT_STRENGTH_MAX - SCRIM_AT_STRENGTH_MIN);
}

/// Lowest whole-percent scrim at which each theme's `--foreground` still
/// clears AA (4.5:1) over a worst-case pure-white or pure-black photo, with
/// the island at `SURFACE_OPACITY_MIN` — the title bar's case at any opacity,
/// since it paints `bg-canvas` and `bg-canvas` is `transparent` under an
/// image. Measured, not derived: `index.css`'s scrim comment states the
/// method, and a theme whose `--foreground` or `--background` is retuned needs
/// its number recomputed. `null` is a theme no scrim value saves.
const AA_SCRIM_FLOOR: Record<string, number | null> = {
  dark: 62,
  light: 52,
  "github-dark": 60,
  "github-light": 53,
  monokai: 61,
  "solarized-dark": 94,
  "solarized-light": null,
  nord: 66,
  dracula: 61,
  "one-dark": 82,
};

/// Highest `backgroundStrength` at which `themeId` still clears AA, or `null`
/// if it never does (`solarized-light`, and any theme absent from the table —
/// an unknown id is not a licence to promise a guarantee that was never
/// measured). The settings row marks this position rather than clamping to
/// it: a user reading code on an opaque island is not harmed by a title bar
/// at 4.2:1, and past this point it is their call.
export function aaStrengthCeilingFor(themeId: string): number | null {
  const floor = AA_SCRIM_FLOOR[themeId];
  if (floor == null) return null;
  const t = (SCRIM_AT_STRENGTH_MIN - floor) / (SCRIM_AT_STRENGTH_MIN - SCRIM_AT_STRENGTH_MAX);
  const strength = Math.floor(BACKGROUND_STRENGTH_MIN + t * (BACKGROUND_STRENGTH_MAX - BACKGROUND_STRENGTH_MIN));
  return Math.max(BACKGROUND_STRENGTH_MIN, Math.min(BACKGROUND_STRENGTH_MAX, strength));
}

function clampBackgroundStrength(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULTS.ui.backgroundStrength;
  return Math.max(BACKGROUND_STRENGTH_MIN, Math.min(BACKGROUND_STRENGTH_MAX, Math.round(v)));
}

/// Validate the five background/translucency keys field by field, same
/// policy as `parseExperimentalSettings`: a hand-edited or stale value falls
/// back to its default rather than reaching Monaco-adjacent code with a shape
/// nothing here has a branch for.
function parseUiSettings(partial: Partial<UiSettings> | undefined): UiSettings {
  const merged = mergeDefaults(DEFAULTS.ui, partial);
  return {
    ...merged,
    backgroundImage:
      typeof partial?.backgroundImage === "string" && partial.backgroundImage.trim()
        ? partial.backgroundImage
        : null,
    surfaceOpacity: clampSurfaceOpacity(partial?.surfaceOpacity),
    surfaceBlur: clampSurfaceBlur(partial?.surfaceBlur),
    backgroundStrength: clampBackgroundStrength(partial?.backgroundStrength),
    backgroundFit: BACKGROUND_FITS.includes(partial?.backgroundFit as BackgroundFit)
      ? (partial!.backgroundFit as BackgroundFit)
      : DEFAULTS.ui.backgroundFit,
  };
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
      const { id, name, commandTemplate, color, claude } = row as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string") continue;
      if (typeof commandTemplate !== "string") continue;
      if (!id.trim() || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        name,
        commandTemplate,
        // Absent in every roster written before agents had a colour, which is
        // every roster on disk today — and an unknown token would render as no
        // colour at all rather than as a wrong one, so it is repaired here.
        color: (TAB_GROUP_COLORS as readonly string[]).includes(color as string)
          ? (color as TabGroupColor)
          : DEFAULT_TAB_GROUP_COLOR,
        // `undefined` rather than a default spec: an entry with no spec is a
        // hand-written command, and filling one in would silently convert every
        // existing agent into a `claude` invocation.
        ...(parseClaudeSpec(claude) ? { claude: parseClaudeSpec(claude) } : {}),
      });
    }
  }
  if (entries.length > 0) return entries;
  // The silent migration: an install whose only agent config is the old single
  // `agentCommand` boots into a roster of exactly that command, under the name
  // the slide-over header already showed, so nothing about its behaviour or
  // vocabulary changes.
  return [
    {
      id: DEFAULT_AGENT_ID,
      name: "Repo agent",
      commandTemplate: agentCommand.trim(),
      color: DEFAULT_TAB_GROUP_COLOR,
    },
  ];
}

function parseAiSettings(partial: Partial<AiSettings> | undefined): AiSettings {
  const ai = mergeDefaults(DEFAULTS.ai, partial);
  return { ...ai, agents: parseAgentRoster(partial?.agents, ai.agentCommand) };
}

/// Validate the experimental flags. Anything that is not literally `true` is
/// `false`: an absent key (every payload on disk today), a key from a build
/// that has since graduated its flag, or a hand-edited non-boolean.
function parseExperimentalSettings(
  partial: Partial<ExperimentalSettings> | undefined,
): ExperimentalSettings {
  return {
    agentDashboard: partial?.agentDashboard === true,
    showIdleAgents: partial?.showIdleAgents === true,
  };
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
      // Validated rather than merged: `backgroundImage`, `surfaceOpacity` and
      // `backgroundFit` all need field-by-field checks (`parseUiSettings`),
      // the same reason `ai` and `experimental` don't use a plain merge.
      ui: parseUiSettings(parsed.ui),
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
      // Validated rather than merged, because these are flags and a flag has to
      // be a boolean. A hand-edited `"agentDashboard": "yes"` from the JSON
      // view is truthy, so a plain merge would turn a typo into an enabled
      // experiment — the one direction a default-off flag must never fall.
      experimental: parseExperimentalSettings(parsed.experimental),
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

/// What `base` means, and therefore what the named type scale in `index.css`
/// was authored against: `--text-body` is 12px *at this root size*.
const TEXT_SIZE_BASE_PX = TEXT_SIZE_PX.base;

createEffect(() => {
  const html = document.documentElement;
  const px = TEXT_SIZE_PX[settings.ui.textSize];
  html.style.fontSize = `${px}px`;
  // `font-size` alone only moves the rem-based sizes, which after the type
  // scale landed is a small minority of the app's text. `--text-scale` is what
  // moves the named scale (`text-micro` … `text-title`) with it, so the
  // preference reaches the ~470 chrome sites that were authored as fixed px
  // and had been ignoring it. See the `--text-scale` comment in `index.css`.
  html.style.setProperty("--text-scale", String(px / TEXT_SIZE_BASE_PX));
  html.setAttribute("data-density", settings.ui.density);
});

/// The one place the background image and the island-opacity mix are applied
/// to the document — `index.css`'s `html[data-bg-image]` rule is the other
/// half, and together they are the whole feature (see that rule for the
/// mixing math). No component paints the image itself; this is the "geometry
/// lives in one place" rule `AppShell.tsx` states for the island inset,
/// applied to the background layer.
///
/// The path is resolved through the Tauri asset protocol (`convertFileSrc`),
/// never read into a data URI, and probed with a throwaway `Image()` before
/// it is trusted: a path that no longer resolves (the file moved, an install
/// synced settings without the file) must fall back to the plain themed
/// background silently, not paint a broken-image icon into the shell.
///
/// The blur half is `--ui-surface-blur` plus a `data-surface-blur` attribute.
/// The attribute exists so that `surfaceBlur: 0` produces *no rule at all*
/// rather than `blur(0px)`: a zero-radius `backdrop-filter` still promotes
/// every surface carrying it to its own compositing layer and still costs a
/// readback per frame, which is the whole expense with none of the effect.
///
/// The image-strength half is `--ui-bg-scrim`, the opacity of the scrim the
/// `#root` rule paints over the photo. It is a property rather than an
/// attribute because unlike the blur it has no free value: every position on
/// the slider costs the same one gradient.

/// Whether an image is actually *painted*, as opposed to merely configured —
/// the JS mirror of the `data-bg-image` attribute the effect below toggles.
/// The two differ for the whole span of the `Image()` probe, and permanently
/// for a path that no longer resolves, which is exactly the case a component
/// reading `settings.ui.backgroundImage` directly would get wrong. Declared
/// above the effect that writes it: module-scope effects run on creation, so
/// a `const` below would be in its temporal dead zone on the first pass.
const [bgImageActive, setBgImageActive] = createSignal(false);

/// `prefers-reduced-transparency: reduce`, reactively. `index.css` answers
/// this preference for everything it paints; anything painted from TS (the
/// terminal grid, which is a canvas and not a CSS surface) has to ask.
const [reducedTransparency, setReducedTransparency] = createSignal(
  typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches === true,
);
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-reduced-transparency: reduce)");
  // No teardown: this is module scope, one listener per window for the life
  // of the process, same as the effects around it.
  mq.addEventListener("change", (e) => setReducedTransparency(e.matches));
}

createEffect(() => {
  const html = document.documentElement;
  const path = settings.ui.backgroundImage;
  html.style.setProperty("--ui-surface-opacity", `${settings.ui.surfaceOpacity}%`);
  html.style.setProperty("--ui-surface-blur", `${settings.ui.surfaceBlur}px`);
  html.style.setProperty("--ui-bg-scrim", `${scrimOpacityFor(settings.ui.backgroundStrength)}%`);
  html.toggleAttribute("data-surface-blur", settings.ui.surfaceBlur > 0);
  html.setAttribute("data-bg-fit", settings.ui.backgroundFit);

  if (!path) {
    html.style.removeProperty("--ui-bg-image");
    html.removeAttribute("data-bg-image");
    setBgImageActive(false);
    return;
  }
  const src = convertFileSrc(path);
  const probe = new Image();
  probe.onload = () => {
    // The setting may have moved on while the probe was in flight (the user
    // picked a different image, or cleared it) — only apply if it's still
    // the path this load was for.
    if (settings.ui.backgroundImage !== path) return;
    html.style.setProperty("--ui-bg-image", `url("${src}")`);
    html.setAttribute("data-bg-image", "");
    setBgImageActive(true);
  };
  probe.onerror = () => {
    if (settings.ui.backgroundImage !== path) return;
    html.style.removeProperty("--ui-bg-image");
    html.removeAttribute("data-bg-image");
    setBgImageActive(false);
  };
  probe.src = src;
});

/// Whether surfaces that are painted from TS rather than CSS should let the
/// background image through right now. One accessor rather than three reads at
/// each call site, because the *policy* — an image is actually up, the user
/// asked for translucency, and the OS is not overriding it — is the thing that
/// has to stay in step with `index.css`, and a component re-deriving it is how
/// the two fall apart.
///
/// Reactive: reads a store field and two signals, so a caller inside an effect
/// or a JSX expression re-runs when any of them moves.
export function surfacesAreTranslucent(): boolean {
  if (!bgImageActive()) return false;
  if (reducedTransparency()) return false;
  // At full opacity there is nothing to see through, and the cheapest way to
  // paint that is the opaque path every install without an image is on.
  return settings.ui.surfaceOpacity < SURFACE_OPACITY_MAX;
}

/// Tell the other windows the background/opacity/fit changed, and mirror
/// changes they broadcast. Same symmetric shape as `bridgeThemeAcrossWindows`
/// in `store/theme.ts` (any window may write, every window follows) and for
/// the same reason: each window is a separate JS context that hydrates this
/// store once at module eval, so a change made in the workbench would
/// otherwise never reach an already-open editor or git window.
///
/// Call once per window root, from `main.tsx` alongside
/// `bridgeThemeAcrossWindows`.
export function bridgeUiVisualAcrossWindows(): () => void {
  let applyingRemote = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  // The effect below fires immediately on its first run — that is us catching
  // up to whatever this window's own module-eval hydration already loaded,
  // not a change anyone else needs to hear. Broadcasting it would have a
  // freshly-opened satellite shout its (possibly stale) local read at a
  // workbench that already has the current value. Same reasoning as
  // `applyTheme`'s `broadcast = false` on its own initial call.
  let first = true;

  // Publish on every local change to the three keys — except the first
  // (above) and except while we are in the middle of *applying* a remote one,
  // which would otherwise ping the change straight back out (the `source`
  // guard in `onUiVisualChange` only drops our own echo, not a second,
  // locally-triggered lap).
  createEffect(() => {
    const value = {
      backgroundImage: settings.ui.backgroundImage,
      surfaceOpacity: settings.ui.surfaceOpacity,
      surfaceBlur: settings.ui.surfaceBlur,
      backgroundStrength: settings.ui.backgroundStrength,
      backgroundFit: settings.ui.backgroundFit,
    };
    if (first) {
      first = false;
      return;
    }
    if (applyingRemote) return;
    void publishUiVisualChange(value);
  });

  void onUiVisualChange((value) => {
    applyingRemote = true;
    setSettings("ui", {
      backgroundImage: value.backgroundImage,
      surfaceOpacity: clampSurfaceOpacity(value.surfaceOpacity),
      // Clamped, so a payload from a window running an older build — one with
      // no `surfaceBlur` in it at all — lands on the default rather than on
      // `undefined`, which the store would happily write through.
      surfaceBlur: clampSurfaceBlur(value.surfaceBlur),
      backgroundStrength: clampBackgroundStrength(value.backgroundStrength),
      backgroundFit: BACKGROUND_FITS.includes(value.backgroundFit)
        ? value.backgroundFit
        : DEFAULTS.ui.backgroundFit,
    });
    applyingRemote = false;
  }).then((fn) => {
    if (disposed) void fn();
    else unlisten = fn;
  });

  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
}

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
    /// Ask the OS for an image and set it as the background, or leave the
    /// current one untouched if the user cancels. Resolves once the picker
    /// closes so the settings row can show it is busy (`SettingsDialog.tsx`).
    ///
    /// Stores the path only — never a copy of the file, never a data URI. The
    /// effect above resolves it through the asset protocol at paint time.
    async pickBackgroundImage(): Promise<void> {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setSettings("ui", "backgroundImage", selected);
    },
    clearBackgroundImage() {
      setSettings("ui", "backgroundImage", null);
    },
    updateAi(patch: Partial<AiSettings>) {
      setSettings("ai", patch);
    },
    updateExperimental(patch: Partial<ExperimentalSettings>) {
      setSettings("experimental", patch);
    },
    /// Append a roster entry and return its id, so the caller can bind a tab to
    /// the agent it just created without re-reading the roster to find it.
    /// Append an agent. `claude` present means it is built from the form;
    /// absent means it is a hand-written command, and the two entry points in
    /// the UI say which rather than leaving it to be inferred.
    ///
    /// The colour rotates through the palette by position rather than being
    /// picked, so three agents added in a row are three distinguishable chips
    /// with nothing for the user to decide.
    addAgent(name: string, commandTemplate: string, claude?: ClaudeAgentSpec): string {
      const id = crypto.randomUUID();
      setSettings("ai", "agents", (agents) => [
        ...agents,
        {
          id,
          name,
          commandTemplate,
          color: TAB_GROUP_COLORS[agents.length % TAB_GROUP_COLORS.length] ?? DEFAULT_TAB_GROUP_COLOR,
          ...(claude ? { claude } : {}),
        },
      ]);
      return id;
    },
    /// Patch one field of a composed agent's spec.
    ///
    /// Separate from `updateAgent` because the spec is nested: a caller
    /// spreading a partial spec into `updateAgent` would replace the whole
    /// object and blank every field it did not mention, which is exactly what
    /// a per-keystroke settings form does on every keystroke.
    ///
    /// A no-op on a hand-written entry. Turning one into a composed agent is
    /// `setAgentClaudeSpec`, and it is a deliberate act with a control of its
    /// own — not something a stray patch should accomplish by accident.
    updateAgentClaude(id: string, patch: Partial<ClaudeAgentSpec>) {
      const index = settings.ai.agents.findIndex((entry) => entry.id === id);
      if (index === -1 || !settings.ai.agents[index]?.claude) return;
      setSettings("ai", "agents", index, "claude", patch);
    },
    /// Switch an entry between composed and hand-written.
    ///
    /// Passing `null` drops the spec and the entry falls back to its
    /// `commandTemplate` — which is why nothing here touches that field: a
    /// composed agent keeps whatever command it had before, so switching away
    /// lands on that rather than on a blank input.
    ///
    /// Dropping the spec **discards the form**, and there is no undo. That is a
    /// deliberate simplification over keeping a shadow copy nothing reads, and
    /// it is only defensible because the control that calls it says so on its
    /// face (§7.6) rather than in a tooltip nobody opens.
    setAgentClaudeSpec(id: string, spec: ClaudeAgentSpec | null) {
      const index = settings.ai.agents.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      // `undefined` rather than deleting the key. It reads as absent everywhere
      // that matters — `entry.claude` is falsy, and `JSON.stringify` omits the
      // key entirely, so the reload agrees with the live store instead of
      // disagreeing with it.
      setSettings("ai", "agents", index, "claude", spec ?? undefined);
    },
    /// Patch one entry, by path rather than by rebuilding the array.
    ///
    /// `agents.map(...)` would be equivalent as *data* and is not equivalent as
    /// *reactivity*: it hands `setSettings` a new array of new objects, so every
    /// row's identity changes on every keystroke. `<For>` is keyed by reference,
    /// so every row in the roster unmounts and remounts — which in a pane made
    /// of text inputs means the input you are typing into is destroyed after the
    /// first character and the rest of the word goes nowhere. Solid's path
    /// syntax touches only the leaf.
    updateAgent(id: string, patch: Partial<Omit<AgentRosterEntry, "id">>) {
      const index = settings.ai.agents.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      setSettings("ai", "agents", index, patch);
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

/// The shell command that launches `entry` in a terminal.
///
/// Only defined for a composed agent. A hand-written entry has no launch
/// command by design: its `commandTemplate` is a *filter* — a grounded prompt
/// goes in on stdin and an answer comes out — and running one in a PTY with no
/// stdin would hang on an empty pipe rather than start a session.
///
/// The agent's name is passed through to `--name`, so the session labels itself
/// in its own prompt box and in the terminal title. That is the difference
/// between four panes of `claude` and four panes of *named* agents, and it is
/// why the name is not merely decoration in the roster.
export function agentLaunchCommand(entry: AgentRosterEntry | null): string | null {
  if (!entry?.claude) return null;
  return composeClaudeCommand(entry.claude, entry.name);
}

/// The shell template the commit-message drafter pipes the staged diff to.
///
/// Never blank. It used to be — the pane shipped an empty box and every AI
/// action in the app was a no-op with a "configure a command" toast until the
/// user filled it in. With BYO-CLI off the dialog there is nothing to fill in,
/// so the built-in `claude -p` is the answer and a stored command is the
/// override rather than the other way round.
export function resolveCommitCommand(): string {
  return settings.ai.commitCommand.trim() || DEFAULT_COMMIT_COMMAND;
}

/// The shell template to pipe a grounded prompt to for `entry`: its own
/// template, else the shared `ai.agentCommand`, else `ai.commitCommand`, else
/// the built-in `claude -p` — the same fallbacks the single-command agent
/// already had, with the per-entry template on top and a working default
/// underneath instead of `""`.
///
/// **Deliberately blind to `entry.claude`.** A composed agent describes an
/// *interactive session* — no `-p`, a real PTY, a permission prompt it can
/// actually answer — and this is the other contract entirely: one prompt in on
/// stdin, one answer out on stdout, no session and nothing to answer with.
/// Running a composed command here would be running the right binary under the
/// wrong assumption. The two live side by side because they are two products of
/// the same roster entry, not two spellings of one; `agentLaunchCommand` is the
/// other.
export function resolveAgentCommand(entry: AgentRosterEntry | null): string {
  const own = entry?.commandTemplate.trim() ?? "";
  if (own) return own;
  const shared = settings.ai.agentCommand.trim();
  if (shared) return shared;
  const commit = settings.ai.commitCommand.trim();
  if (commit) return commit;
  return DEFAULT_AGENT_COMMAND;
}

/// The saved identity override for `repoRoot`, or `null` when that repo has
/// none and git config should win. Non-reactive snapshot.
export function repoIdentity(repoRoot: string): CommitIdentity | null {
  return settings.git.identityByRepo[repoRoot] ?? null;
}

export const DEFAULT_SETTINGS = DEFAULTS;
