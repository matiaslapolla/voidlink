import {
  Show,
  For,
  Match,
  Switch,
  createResource,
  createSignal,
  createEffect,
  type JSX,
} from "solid-js";
import { Check, Layers, Loader2, RefreshCw, Trash2, X } from "lucide-solid";
import { open } from "@tauri-apps/plugin-dialog";
import { gitApi } from "@/api/git";
import type { ConfigEntry, ConfigScope, ConfigSnapshot } from "@/types/git";
import {
  CONFIG_GROUPS,
  displayValue,
  fieldsInGroup,
  parseGitBool,
  resolveProvenance,
  type ConfigField,
} from "./gitConfig";
import {
  AI_KEY_PRESETS,
  aiKeyBindings,
  useSettings,
  type AiKeyBinding,
  type CursorStyle,
  type EditorAutoSave,
  type EditorCursorBlinking,
  type EditorCursorStyle,
  type EditorLineNumbers,
  type EditorRenderWhitespace,
  type EditorWordWrap,
  type EnvironmentMode,
  type UiDensity,
  type UiTextSize,
} from "@/store/settings";
import { LSP_SERVERS } from "@/components/editor/lspServers";
import { useTheme } from "@/store/theme";
import { useAppStore } from "@/store/LayoutContext";
import { resetLayoutStorage } from "@/store/layout";
import { stackApi } from "@/api/stack";
import { secretsApi, type SecretStatus } from "@/api/secrets";
import { pushToast } from "@/commands/toast";
import { getAction } from "@/commands/registry";
import { shortcutLabel, shortcutLabels } from "@/commands/shortcuts";
import {
  KEYMAP,
  KEYMAP_GROUPS,
  type BindingScope,
  type KeymapEntry,
} from "@/commands/keymap";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "ui" | "theme" | "editor" | "terminal" | "keyboard" | "ai" | "git" | "stack" | "brain";

export function SettingsDialog(props: SettingsDialogProps) {
  const [tab, setTab] = createSignal<Tab>("ui");
  const { reset } = useSettings();
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.open) {
      queueMicrotask(() => {
        const focusable = dialogRef?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        focusable?.[0]?.focus();
      });
    }
  });

  const trapFocus = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = [
      ...(dialogRef?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
        onClick={props.onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); props.onClose(); }
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
          class="w-[560px] max-w-[92vw] max-h-[86vh] flex flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-xl"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={trapFocus}
        >
          <div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <h2 id="settings-dialog-title" class="text-sm font-semibold">Settings</h2>
            <button
              onClick={props.onClose}
              aria-label="Close settings"
              class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              title="Close"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          <div class="flex items-center gap-1 border-b border-border px-2 py-1 text-xs">
            <TabButton active={tab() === "ui"} onClick={() => setTab("ui")}>UI</TabButton>
            <TabButton active={tab() === "theme"} onClick={() => setTab("theme")}>Theme</TabButton>
            <TabButton active={tab() === "editor"} onClick={() => setTab("editor")}>Editor</TabButton>
            <TabButton active={tab() === "terminal"} onClick={() => setTab("terminal")}>Terminal</TabButton>
            <TabButton active={tab() === "keyboard"} onClick={() => setTab("keyboard")}>Keyboard</TabButton>
            <TabButton active={tab() === "ai"} onClick={() => setTab("ai")}>AI</TabButton>
            <TabButton active={tab() === "git"} onClick={() => setTab("git")}>Git</TabButton>
            <TabButton active={tab() === "stack"} onClick={() => setTab("stack")}>Stack</TabButton>
            <TabButton active={tab() === "brain"} onClick={() => setTab("brain")}>Brain</TabButton>
          </div>

          <div class="flex-1 overflow-y-auto scrollbar-thin p-4 text-xs">
            <Show when={tab() === "ui"}><UiPane /></Show>
            <Show when={tab() === "theme"}><ThemePane /></Show>
            <Show when={tab() === "editor"}><EditorPane /></Show>
            <Show when={tab() === "terminal"}><TerminalPane /></Show>
            <Show when={tab() === "keyboard"}><KeyboardPane /></Show>
            <Show when={tab() === "ai"}><AiPane /></Show>
            <Show when={tab() === "git"}><GitPane /></Show>
            <Show when={tab() === "stack"}><StackPane /></Show>
            <Show when={tab() === "brain"}><BrainPane /></Show>
          </div>

          <div class="flex items-center justify-between px-4 py-2.5 border-t border-border">
            <button
              onClick={reset}
              class="px-3 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            >
              Reset to defaults
            </button>
            <button
              onClick={props.onClose}
              class="px-3 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 active:scale-[0.96] transition-[background-color,color,transform]"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      onClick={props.onClick}
      class={`px-3 py-1 rounded transition-colors ${
        props.active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {props.children}
    </button>
  );
}

// ─── UI Pane ─────────────────────────────────────────────────────────────────

const TEXT_SIZES: { id: UiTextSize; label: string }[] = [
  { id: "sm", label: "Small" },
  { id: "base", label: "Base" },
  { id: "xl", label: "XL" },
];
const ENVIRONMENT_MODES: { id: EnvironmentMode; label: string }[] = [
  { id: "detached", label: "Detached" },
  { id: "stacked", label: "Stacked" },
];
const DENSITIES: { id: UiDensity; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "normal", label: "Normal" },
  { id: "comfortable", label: "Comfortable" },
];

function UiPane() {
  const { settings, updateUi } = useSettings();
  return (
    <div class="space-y-4">
      <SegmentedRow
        label="Text size"
        value={settings.ui.textSize}
        options={TEXT_SIZES}
        onChange={(v) => updateUi({ textSize: v })}
      />
      <SegmentedRow
        label="Spacing"
        value={settings.ui.density}
        options={DENSITIES}
        onChange={(v) => updateUi({ density: v })}
      />
      <div>
        <SegmentedRow
          label="Ignored files"
          value={settings.ui.showIgnoredFiles ? "show" : "hide"}
          options={[
            { id: "hide", label: "Hide" },
            { id: "show", label: "Show" },
          ]}
          onChange={(v) => updateUi({ showIgnoredFiles: v === "show" })}
        />
        <p class="mt-1 ml-[7.75rem] text-[11px] text-muted-foreground/80">
          Show lists gitignored files in the file tree and Cmd+P, dimmed — the
          way to edit a repo's <code>.env</code>. Build output directories
          (node_modules, dist, target…) stay out of Cmd+P either way.
        </p>
      </div>
      <div>
        <SegmentedRow
          label="Environment mode"
          value={settings.ui.environmentMode}
          options={ENVIRONMENT_MODES}
          onChange={(v) => updateUi({ environmentMode: v })}
        />
        <p class="mt-1 ml-[7.75rem] text-[11px] text-muted-foreground/80">
          Detached gives the git client and the editor their own windows.
          Stacked keeps all three in this window, switched from the title bar —
          switching to it closes any satellite window already open.
        </p>
      </div>
      <ResetLayoutRow />
    </div>
  );
}

/// The `--reset-layout` escape hatch: clear every layout key and reload.
///
/// Layout state is the one thing in this app that can render the shell
/// unusable — a pane tree that claims tabs that do not exist, a panel dragged
/// to zero, a blob half-written by a crash. `resetLayoutStorage()` clears
/// exactly the layout keys: settings, provider keys, themes and *saved
/// snapshots* are all untouched, which is why this can sit next to the
/// ordinary UI preferences instead of behind a support ticket.
function ResetLayoutRow() {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <div class="flex items-center gap-3">
      <div class="w-28 shrink-0">
        <div class="text-muted-foreground">Layout</div>
        <div class="text-[10px] text-muted-foreground/70 leading-tight">
          Tabs, panes, panel widths
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          onClick={() => {
            if (!confirming()) {
              setConfirming(true);
              return;
            }
            resetLayoutStorage();
            window.location.reload();
          }}
          aria-label={
            confirming()
              ? "Confirm resetting the layout and reload"
              : "Reset the layout to defaults"
          }
          title={
            confirming()
              ? "Click again to clear tabs, panes and panel widths, then reload"
              : "Clears tabs, panes and panel widths. Settings, provider keys and saved snapshots are kept."
          }
          class={`px-3 py-1 rounded border text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
            confirming()
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
        >
          {confirming() ? "Confirm reset & reload" : "Reset layout"}
        </button>
        <Show when={confirming()}>
          <button
            onClick={() => setConfirming(false)}
            aria-label="Cancel the layout reset"
            class="px-2 py-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
        </Show>
      </div>
    </div>
  );
}

// ─── Theme Pane ──────────────────────────────────────────────────────────────

function ThemePane() {
  const { theme, setTheme, THEMES } = useTheme();
  let gridRef: HTMLDivElement | undefined;

  // Roving arrow-key navigation across the theme grid. The cards are native
  // <button>s, so Tab focus and Enter/Space activation come for free; this only
  // layers grid-style arrow movement on top (2-column layout).
  const COLS = 2;
  const onGridKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const btns = [
      ...(gridRef?.querySelectorAll<HTMLButtonElement>("button[data-theme-option]") ?? []),
    ];
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1) return;
    e.preventDefault();
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % btns.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + btns.length) % btns.length;
    else if (e.key === "ArrowDown") next = Math.min(idx + COLS, btns.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(idx - COLS, 0);
    btns[next]?.focus();
  };

  return (
    <div class="space-y-4">
      <p class="text-[11px] text-muted-foreground leading-relaxed">
        Pick a color theme. Applied instantly across the whole app and remembered
        across restarts. Each swatch previews that palette's background,
        foreground, primary, and border.
      </p>
      <div
        ref={gridRef}
        role="radiogroup"
        aria-label="Color theme"
        onKeyDown={onGridKeyDown}
        class="grid grid-cols-2 gap-2"
      >
        <For each={THEMES}>
          {(t) => {
            const selected = () => theme() === t.id;
            return (
              <button
                data-theme-option
                role="radio"
                aria-checked={selected()}
                onClick={() => setTheme(t.id)}
                title={t.label}
                class={`group flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected()
                    ? "border-primary/60 bg-primary/10"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <ThemeSwatch preview={t.preview} />
                <span
                  class={`flex-1 truncate text-[11px] ${
                    selected() ? "text-primary" : "text-foreground/90"
                  }`}
                >
                  {t.label}
                </span>
                <Show when={selected()}>
                  <Check class="w-3.5 h-3.5 shrink-0 text-primary" />
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function ThemeSwatch(props: { preview: [string, string, string, string] }) {
  // The four reference colors come straight from the theme's own definition in
  // the store — deliberately NOT from CSS tokens. Semantic tokens (--background
  // etc.) only resolve to a theme's values under the matching [data-theme] on
  // <html>, so a token-driven swatch would paint every card in the *currently
  // active* theme. Rendering the literal palette values inline is the only way
  // each card can preview its own palette regardless of what's active. (The raw
  // values live in the store, not this component — MASTER §4's "no raw hex in
  // components" is about semantic UI color, which the ring/check below honor.)
  const [bg, fg, primary, border] = props.preview;
  return (
    <span
      aria-hidden="true"
      class="flex h-9 w-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded border"
      style={{ "background-color": bg, "border-color": border }}
    >
      <span class="text-[11px] font-semibold leading-none" style={{ color: fg }}>
        Aa
      </span>
      <span class="h-1 w-4 rounded-full" style={{ "background-color": primary }} />
    </span>
  );
}

// ─── Terminal Pane ───────────────────────────────────────────────────────────

const CURSOR_STYLES: { id: CursorStyle; label: string }[] = [
  { id: "block", label: "Block" },
  { id: "underline", label: "Underline" },
  { id: "bar", label: "Bar" },
];

// Each preset is labelled by its primary family (for the chip text) and
// declares the full stack applied when selected. Names match typical
// Nerd-Font package spellings (JetBrainsMono NF, FiraCode NF, etc.) because
// the plain "JetBrains Mono" name is usually not what's installed.
const FONT_PRESETS: { label: string; stack: string }[] = [
  {
    label: "System Mono",
    stack: 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  },
  {
    label: "JetBrainsMono NF",
    stack: '"JetBrainsMono Nerd Font", "JetBrainsMono NF", "JetBrains Mono", ui-monospace, monospace',
  },
  {
    label: "JetBrainsMono NFM",
    stack: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrains Mono", ui-monospace, monospace',
  },
  {
    label: "FiraCode NF",
    stack: '"FiraCode Nerd Font", "FiraCode NF", "Fira Code", ui-monospace, monospace',
  },
  {
    label: "Hack NF",
    stack: '"Hack Nerd Font", "Hack NF", Hack, ui-monospace, monospace',
  },
  {
    label: "Cascadia Code",
    stack: '"CaskaydiaCove Nerd Font", "Cascadia Code", "Cascadia Mono", ui-monospace, monospace',
  },
  {
    label: "DejaVu Sans Mono",
    stack: '"DejaVu Sans Mono", monospace',
  },
];

// ─── Editor Pane ─────────────────────────────────────────────────────────────

const EDITOR_WORD_WRAP: { id: EditorWordWrap; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "on", label: "Viewport" },
  { id: "bounded", label: "Column" },
];

const EDITOR_WHITESPACE: { id: EditorRenderWhitespace; label: string }[] = [
  { id: "none", label: "None" },
  { id: "selection", label: "Selection" },
  { id: "boundary", label: "Boundary" },
  { id: "all", label: "All" },
];

const EDITOR_LINE_NUMBERS: { id: EditorLineNumbers; label: string }[] = [
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
  { id: "relative", label: "Relative" },
];

const EDITOR_CURSOR_STYLES: { id: EditorCursorStyle; label: string }[] = [
  { id: "line", label: "Line" },
  { id: "block", label: "Block" },
  { id: "underline", label: "Underline" },
];

const EDITOR_CURSOR_BLINKING: { id: EditorCursorBlinking; label: string }[] = [
  { id: "blink", label: "Blink" },
  { id: "smooth", label: "Smooth" },
  { id: "phase", label: "Phase" },
  { id: "expand", label: "Expand" },
  { id: "solid", label: "Solid" },
];

const EDITOR_AUTO_SAVE: { id: EditorAutoSave; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "afterDelay", label: "After delay" },
  { id: "onFocusChange", label: "On blur" },
];

/// Every setting here applies to the running editor through `updateOptions` —
/// there is no "restart to apply" row, by design (see `monaco.ts`).
function EditorPane() {
  const { settings, updateEditor } = useSettings();
  return (
    <div class="space-y-6">
      <Section title="Font">
        <TextRow
          label="Font family"
          value={settings.editor.fontFamily}
          placeholder="'Geist Mono Variable', monospace"
          onInput={(v) => updateEditor({ fontFamily: v })}
        />
        <div class="flex flex-wrap gap-1 pl-28">
          <For each={FONT_PRESETS}>
            {(p) => (
              <button
                onClick={() => updateEditor({ fontFamily: p.stack })}
                class="px-2 py-0.5 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={p.stack}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
        <SliderRow label="Font size" value={settings.editor.fontSize} min={8} max={28} step={1}
          format={(v) => `${v}px`} onInput={(v) => updateEditor({ fontSize: v })} />
        {/* Monaco's own convention: 0 derives the height from the font size,
            and anything up to 8 is a multiplier. Surfacing that as "Auto"
            rather than hiding it behind a second toggle. */}
        <SliderRow label="Line height" value={settings.editor.lineHeight} min={0} max={3} step={0.05}
          format={(v) => (v === 0 ? "Auto" : `${v.toFixed(2)}×`)}
          onInput={(v) => updateEditor({ lineHeight: v })} />
        <ToggleRow
          label="Ligatures"
          hint="Render =>, !== and friends as single glyphs, if the font has them."
          value={settings.editor.fontLigatures}
          onChange={(v) => updateEditor({ fontLigatures: v })}
        />
      </Section>

      <Section title="Indentation">
        <SliderRow label="Tab size" value={settings.editor.tabSize} min={1} max={8} step={1}
          format={(v) => `${v} spaces`} onInput={(v) => updateEditor({ tabSize: v })} />
        <ToggleRow label="Insert spaces" value={settings.editor.insertSpaces}
          onChange={(v) => updateEditor({ insertSpaces: v })} />
        <ToggleRow label="Indent guides" value={settings.editor.indentGuides}
          onChange={(v) => updateEditor({ indentGuides: v })} />
      </Section>

      <Section title="Wrapping">
        <SegmentedRow label="Word wrap" value={settings.editor.wordWrap} options={EDITOR_WORD_WRAP}
          onChange={(v) => updateEditor({ wordWrap: v })} />
        <Show when={settings.editor.wordWrap === "bounded"}>
          <SliderRow label="Wrap column" value={settings.editor.wordWrapColumn} min={40} max={200} step={1}
            format={(v) => `${v} cols`} onInput={(v) => updateEditor({ wordWrapColumn: v })} />
        </Show>
      </Section>

      <Section title="Display">
        <SegmentedRow label="Line numbers" value={settings.editor.lineNumbers} options={EDITOR_LINE_NUMBERS}
          onChange={(v) => updateEditor({ lineNumbers: v })} />
        <SegmentedRow label="Whitespace" value={settings.editor.renderWhitespace} options={EDITOR_WHITESPACE}
          onChange={(v) => updateEditor({ renderWhitespace: v })} />
        <ToggleRow label="Minimap" value={settings.editor.minimap}
          onChange={(v) => updateEditor({ minimap: v })} />
        <ToggleRow
          label="Sticky scroll"
          hint="Pin the enclosing scopes to the top of the viewport."
          value={settings.editor.stickyScroll}
          onChange={(v) => updateEditor({ stickyScroll: v })}
        />
        <ToggleRow label="Bracket colors" value={settings.editor.bracketPairColorization}
          onChange={(v) => updateEditor({ bracketPairColorization: v })} />
        <ToggleRow label="Scroll past end" value={settings.editor.scrollBeyondLastLine}
          onChange={(v) => updateEditor({ scrollBeyondLastLine: v })} />
        <ToggleRow label="Smooth scrolling" value={settings.editor.smoothScrolling}
          onChange={(v) => updateEditor({ smoothScrolling: v })} />
      </Section>

      <Section title="Keybindings">
        <ToggleRow
          label="Vim mode"
          hint="Loads monaco-vim on demand. A mode indicator appears in the title bar."
          value={settings.editor.vimMode}
          onChange={(v) => updateEditor({ vimMode: v })}
        />
      </Section>

      <Section title="Cursor">
        <SegmentedRow label="Style" value={settings.editor.cursorStyle} options={EDITOR_CURSOR_STYLES}
          onChange={(v) => updateEditor({ cursorStyle: v })} />
        <SegmentedRow label="Blinking" value={settings.editor.cursorBlinking} options={EDITOR_CURSOR_BLINKING}
          onChange={(v) => updateEditor({ cursorBlinking: v })} />
      </Section>

      <Section title="Save">
        <ToggleRow
          label="Format on save"
          hint="Uses whatever formatter the language provides. No provider means no change."
          value={settings.editor.formatOnSave}
          onChange={(v) => updateEditor({ formatOnSave: v })}
        />
        <ToggleRow label="Trim whitespace" value={settings.editor.trimTrailingWhitespaceOnSave}
          onChange={(v) => updateEditor({ trimTrailingWhitespaceOnSave: v })} />
        <ToggleRow label="Final newline" value={settings.editor.insertFinalNewlineOnSave}
          onChange={(v) => updateEditor({ insertFinalNewlineOnSave: v })} />
        <SegmentedRow label="Auto save" value={settings.editor.autoSave} options={EDITOR_AUTO_SAVE}
          onChange={(v) => updateEditor({ autoSave: v })} />
        <Show when={settings.editor.autoSave === "afterDelay"}>
          <SliderRow label="Delay" value={settings.editor.autoSaveDelayMs} min={200} max={10000} step={100}
            format={(v) => `${(v / 1000).toFixed(1)}s`}
            onInput={(v) => updateEditor({ autoSaveDelayMs: v })} />
        </Show>
        <p class="text-[10px] text-muted-foreground/70 leading-relaxed">
          Auto save never hides the dirty dot — it appears on the first edit and
          clears on the write, so a pending save is always visible.
        </p>
      </Section>

      {/* Language servers. The paths are blank by default and stay blank for
          almost everyone: a server installed normally is found on PATH, and an
          empty field reads as "nothing to do here" rather than as a setting
          somebody forgot to fill in. */}
      <Section title="Language servers">
        <ToggleRow
          label="Enabled"
          hint="Completions, hover, diagnostics and formatting from a server you already have installed. Nothing is downloaded."
          value={settings.editor.lspEnabled}
          onChange={(v) => updateEditor({ lspEnabled: v })}
        />
        <Show when={settings.editor.lspEnabled}>
          <For each={LSP_SERVERS}>
            {(spec) => (
              <TextRow
                label={spec.id}
                value={settings.editor.lspServerPaths[spec.id] ?? ""}
                placeholder={`found on PATH (${spec.monacoLanguages.join(", ")})`}
                onInput={(v) =>
                  updateEditor({
                    lspServerPaths: { ...settings.editor.lspServerPaths, [spec.id]: v },
                  })
                }
              />
            )}
          </For>
          <p class="text-[10px] text-muted-foreground/70 leading-relaxed">
            Leave a path blank to search PATH. A server that is not installed is
            not an error — the editor works exactly as it does now and the
            status bar shows nothing at all.
          </p>
        </Show>
      </Section>
    </div>
  );
}

function TerminalPane() {
  const { settings, updateTerminal } = useSettings();
  return (
    <div class="space-y-6">
      <Section title="Font">
        <TextRow
          label="Font family"
          value={settings.terminal.fontFamily}
          placeholder='"JetBrains Mono", monospace'
          onInput={(v) => updateTerminal({ fontFamily: v })}
        />
        <div class="flex flex-wrap gap-1 pl-28">
          <For each={FONT_PRESETS}>
            {(p) => (
              <button
                onClick={() => updateTerminal({ fontFamily: p.stack })}
                class="px-2 py-0.5 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                title={p.stack}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
        <SliderRow label="Font size" value={settings.terminal.fontSize} min={8} max={28} step={1}
          format={(v) => `${v}px`} onInput={(v) => updateTerminal({ fontSize: v })} />
        <SliderRow label="Line height" value={settings.terminal.lineHeight} min={0.9} max={2} step={0.05}
          format={(v) => v.toFixed(2)} onInput={(v) => updateTerminal({ lineHeight: v })} />
        <SliderRow label="Letter spacing" value={settings.terminal.letterSpacing} min={-2} max={4} step={0.5}
          format={(v) => `${v}px`} onInput={(v) => updateTerminal({ letterSpacing: v })} />
        <SliderRow label="Font weight" value={settings.terminal.fontWeight} min={100} max={900} step={100}
          format={(v) => String(v)} onInput={(v) => updateTerminal({ fontWeight: v })} />
        <SliderRow label="Bold weight" value={settings.terminal.fontWeightBold} min={300} max={900} step={100}
          format={(v) => String(v)} onInput={(v) => updateTerminal({ fontWeightBold: v })} />
        <ToggleRow
          label="Ligatures"
          hint="Load ligatures addon. May reduce rendering perf on heavy output."
          value={settings.terminal.ligatures}
          onChange={(v) => updateTerminal({ ligatures: v })}
        />
      </Section>

      <Section title="Cursor">
        <SegmentedRow label="Style" value={settings.terminal.cursorStyle} options={CURSOR_STYLES}
          onChange={(v) => updateTerminal({ cursorStyle: v })} />
        <ToggleRow label="Blink" value={settings.terminal.cursorBlink}
          onChange={(v) => updateTerminal({ cursorBlink: v })} />
        <SliderRow label="Width" value={settings.terminal.cursorWidth} min={1} max={5} step={1}
          format={(v) => `${v}px`} onInput={(v) => updateTerminal({ cursorWidth: v })} />
      </Section>

      <Section title="Behavior">
        <SliderRow label="Min contrast" value={settings.terminal.minimumContrastRatio} min={1} max={21} step={0.5}
          format={(v) => v.toFixed(1)} onInput={(v) => updateTerminal({ minimumContrastRatio: v })} />
        <ToggleRow label="Bold is bright" value={settings.terminal.drawBoldTextInBrightColors}
          onChange={(v) => updateTerminal({ drawBoldTextInBrightColors: v })} />
        <ToggleRow label="macOS Option = Meta" value={settings.terminal.macOptionIsMeta}
          onChange={(v) => updateTerminal({ macOptionIsMeta: v })} />
        <ToggleRow label="Right-click selects word" value={settings.terminal.rightClickSelectsWord}
          onChange={(v) => updateTerminal({ rightClickSelectsWord: v })} />
      </Section>

      <Section title="Scroll">
        <SliderRow label="Scrollback" value={settings.terminal.scrollback} min={500} max={50000} step={500}
          format={(v) => `${v.toLocaleString()} lines`} onInput={(v) => updateTerminal({ scrollback: v })} />
        <SliderRow label="Sensitivity" value={settings.terminal.scrollSensitivity} min={0.5} max={5} step={0.25}
          format={(v) => `${v}×`} onInput={(v) => updateTerminal({ scrollSensitivity: v })} />
        <ToggleRow label="Scroll on input" value={settings.terminal.scrollOnUserInput}
          onChange={(v) => updateTerminal({ scrollOnUserInput: v })} />
      </Section>
    </div>
  );
}

// ─── Keyboard Pane ───────────────────────────────────────────────────────────

const SCOPE_HINTS: Record<BindingScope, string | null> = {
  global: null,
  "outside-terminal": "not while a terminal has focus",
  "outside-text-surfaces": "not while the editor or a terminal has focus",
};

/// Read-only listing of every global shortcut, straight from `keymap.ts`.
/// Rebinding is not offered yet — the keymap is structured to allow it, but
/// the editor UI is a separate piece of work.
function KeyboardPane() {
  const groups = KEYMAP_GROUPS.map((group) => ({
    group,
    entries: KEYMAP.filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0);

  return (
    <div class="space-y-6">
      <p class="text-[11px] text-muted-foreground leading-relaxed">
        Every global shortcut, derived from the same table that fires them —
        this list cannot go out of date. On macOS the platform modifier is ⌘;
        elsewhere it is Ctrl, and voidlink accepts either. Press{" "}
        <span class="font-mono">{shortcutLabel("help.shortcuts")}</span> anywhere
        for the same list as a filterable overlay.
      </p>
      <For each={groups}>
        {(g) => (
          <Section title={g.group}>
            <For each={g.entries}>
              {(entry) => <ShortcutRow entry={entry} />}
            </For>
          </Section>
        )}
      </For>
    </div>
  );
}

function ShortcutRow(props: { entry: KeymapEntry }) {
  const action = () => getAction(props.entry.actionId);
  const chords = () => shortcutLabels(props.entry.actionId);
  const scopeHint = () => SCOPE_HINTS[props.entry.binding.scope ?? "global"];
  return (
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-foreground/90 truncate">
          {action()?.label ?? props.entry.actionId}
        </div>
        <Show when={scopeHint()}>
          {(hint) => (
            <div class="text-[10px] text-muted-foreground/70 leading-tight">
              {hint()}
            </div>
          )}
        </Show>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <For each={chords()}>
          {(chord) => (
            <kbd class="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-mono text-foreground/80">
              {chord}
            </kbd>
          )}
        </For>
      </div>
    </div>
  );
}

// ─── Reusable rows ───────────────────────────────────────────────────────────

/// `tone="warning"` is used by the Git pane only: with the config scope set to
/// Global, every header recolours to say that edits land outside the repo. The
/// colour transition is the pane's whole motion budget — at 0ms a
/// simultaneous recolour of five headers reads as a repaint glitch rather than
/// a change of mode.
function Section(props: { title: string; tone?: "warning"; children: JSX.Element }) {
  return (
    <section>
      <h3
        class={`ui-section-label mb-2 ${props.tone === "warning" ? "text-warning" : ""}`}
        style={{ transition: "color var(--dur-short) var(--ease-in-out)" }}
      >
        {props.title}
      </h3>
      <div class="space-y-3">{props.children}</div>
    </section>
  );
}

function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      <span class="w-28 text-muted-foreground shrink-0">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
        class="flex-1 accent-primary"
      />
      <span class="w-24 text-right tabular-nums text-foreground/80 shrink-0">
        {props.format(props.value)}
      </span>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  value: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      <div class="w-28 shrink-0">
        <div class="text-muted-foreground">{props.label}</div>
        <Show when={props.hint}>
          <div class="text-[10px] text-muted-foreground/70 leading-tight">{props.hint}</div>
        </Show>
      </div>
      <button
        onClick={() => props.onChange(!props.value)}
        class={`px-3 py-1 rounded-full border text-[11px] transition-colors ${
          props.value
            ? "bg-primary/15 border-primary/40 text-primary"
            : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
        }`}
      >
        {props.value ? "On" : "Off"}
      </button>
    </div>
  );
}

function TextRow(props: {
  label: string;
  value: string;
  placeholder?: string;
  onInput: (v: string) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      <span class="w-28 text-muted-foreground shrink-0">{props.label}</span>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

function SegmentedRow<T extends string>(props: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      <span class="w-28 text-muted-foreground shrink-0">{props.label}</span>
      <div class="flex-1 flex gap-1">
        <For each={props.options}>
          {(opt) => (
            <button
              onClick={() => props.onChange(opt.id)}
              class={`flex-1 px-2 py-1 rounded border text-[11px] transition-colors ${
                props.value === opt.id
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
              }`}
            >
              {opt.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

// ─── AI Pane ────────────────────────────────────────────────────────────────

const AI_COMMAND_PRESETS: { label: string; command: string }[] = [
  {
    label: "Claude CLI",
    command:
      'claude --no-tools -p "You are a senior engineer. Write a concise, imperative-mood git commit message (50-char title, optional body) for the following staged diff. Output ONLY the message."',
  },
  {
    label: "Ollama (llama3.2)",
    command:
      'ollama run llama3.2 "Write a concise imperative-mood git commit message for this diff. Output ONLY the message:"',
  },
  {
    label: "OpenAI Codex CLI",
    command:
      'codex exec -m gpt-5 "Write a concise imperative-mood git commit message (50-char title, optional body) for this staged diff. Output ONLY the message."',
  },
];

function AiPane() {
  const { settings, updateAi } = useSettings();
  return (
    <div class="space-y-4">
      <p class="text-[11px] text-muted-foreground leading-relaxed">
        VoidLink doesn't ship an LLM. Configure any local CLI you already have
        installed; the staged diff is piped to its stdin and stdout becomes the
        commit-message draft. If that CLI needs an API key, store it under
        Provider keys below — it goes to your OS keychain, never to voidlink's
        settings.
      </p>
      <Section title="Commit messages">
        <TextRow
          label="Command"
          value={settings.ai.commitCommand}
          placeholder={'e.g. claude --no-tools -p "Write a git commit message:"'}
          onInput={(v) => updateAi({ commitCommand: v })}
        />
        <div class="flex flex-wrap gap-1 pl-28">
          <For each={AI_COMMAND_PRESETS}>
            {(p) => (
              <button
                onClick={() => updateAi({ commitCommand: p.command })}
                class="px-2 py-0.5 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                title={p.command}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
      </Section>
      <Section title="Repo agent">
        <TextRow
          label="Command"
          value={settings.ai.agentCommand}
          placeholder={'optional — defaults to the commit command'}
          onInput={(v) => updateAi({ agentCommand: v })}
        />
        <p class="text-[11px] text-muted-foreground leading-relaxed pl-28">
          Used by the repo agent ({shortcutLabel("agent.toggle")}). A prompt
          grounded in your live workspace state — branch, status, recent log,
          staged diff, open files — is piped to stdin; stdout is the answer.
          Leave blank to reuse the commit command.
        </p>
      </Section>
      <ProviderKeysSection />
    </div>
  );
}

// ─── Provider keys ──────────────────────────────────────────────────────────

/// Manage AI provider keys held in the OS credential store.
///
/// The value is write-only from here: it is sent to Rust once, stored in the
/// keychain, and never comes back. All this pane can learn is presence plus a
/// four-character tail, which is exactly what `secret_status` returns. Presence
/// is always re-read from the keychain rather than tracked locally, so the UI
/// can't show "saved" for something that isn't there.
function ProviderKeysSection() {
  const { removeAiKey } = useSettings();
  const [keychainError, setKeychainError] = createSignal<string | null>(null);

  const [statuses, { refetch }] = createResource(
    () => aiKeyBindings().map((b) => b.id),
    async (ids): Promise<SecretStatus[]> => {
      // Caught here rather than left to reject: reading a resource accessor
      // in a failed state rethrows into render, and there is no ErrorBoundary
      // inside the dialog. A locked or denied keychain has to be *reported* —
      // never flattened into an empty list that would read as "no keys set".
      try {
        const result = await secretsApi.status(ids);
        setKeychainError(null);
        return result;
      } catch (e) {
        setKeychainError(String(e));
        return [];
      }
    },
  );

  createEffect(() => {
    const err = keychainError();
    if (err) pushToast(`Couldn't read the OS keychain: ${err}`, "error", 7000);
  });

  const statusFor = (id: string) => statuses()?.find((s) => s.id === id);

  const forget = async (binding: AiKeyBinding) => {
    try {
      // Delete the stored value before dropping the mapping, otherwise the
      // credential is orphaned in the keychain with nothing pointing at it.
      await secretsApi.delete(binding.id);
      removeAiKey(binding.id);
      pushToast(`Removed ${binding.envVar}`, "success");
      void refetch();
    } catch (e) {
      pushToast(`Couldn't remove ${binding.envVar}: ${String(e)}`, "error", 7000);
    }
  };

  return (
    <Section title="Provider keys">
      <p class="text-[11px] text-muted-foreground leading-relaxed">
        Optional. Keys go to your OS credential store (macOS Keychain, Windows
        Credential Manager, Linux secret-service) — never to voidlink's settings
        or localStorage — and are exported into the environment of the commands
        above. VoidLink itself never sends them anywhere. Injection is additive:
        if your shell already exports the same variable, yours wins.
      </p>
      <Show when={keychainError()}>
        {(err) => (
          <p class="text-[11px] text-destructive leading-relaxed" title={err()}>
            Can't reach the OS credential store, so which keys are stored is
            unknown. Saving will report the same error.
          </p>
        )}
      </Show>
      <For each={aiKeyBindings()}>
        {(binding) => (
          <KeyRow
            binding={binding}
            status={statusFor(binding.id)}
            loading={statuses.loading}
            unknown={keychainError() !== null}
            onChanged={() => void refetch()}
            removable={!AI_KEY_PRESETS.some((p) => p.id === binding.id)}
            onForget={() => void forget(binding)}
          />
        )}
      </For>
      <AddCustomKey onAdded={() => void refetch()} />
    </Section>
  );
}

function KeyRow(props: {
  binding: AiKeyBinding;
  status: SecretStatus | undefined;
  loading: boolean;
  /// The keychain couldn't be read at all — presence is genuinely unknown,
  /// which is not the same thing as "not set".
  unknown: boolean;
  onChanged: () => void;
  removable: boolean;
  onForget: () => void;
}) {
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const present = () => props.status?.present ?? false;

  const statusText = () => {
    if (props.unknown) return "Unknown";
    if (props.loading && !props.status) return "Checking…";
    if (!present()) return "Not set";
    const hint = props.status?.hint ?? "";
    return hint ? `Set · ••••${hint}` : "Set";
  };

  const save = async () => {
    const v = value().trim();
    if (!v) {
      pushToast("Paste a key value first.", "warning");
      return;
    }
    setBusy(true);
    try {
      await secretsApi.set(props.binding.id, props.binding.envVar, v);
      pushToast(`${props.binding.label} key saved to the OS keychain`, "success");
      props.onChanged();
    } catch (e) {
      pushToast(`Couldn't save the ${props.binding.label} key: ${String(e)}`, "error", 7000);
    } finally {
      // Never leave a secret sitting in a DOM input, success or failure.
      setValue("");
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await secretsApi.delete(props.binding.id);
      pushToast(`${props.binding.label} key deleted from the OS keychain`, "success");
      props.onChanged();
    } catch (e) {
      pushToast(`Couldn't delete the ${props.binding.label} key: ${String(e)}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex items-start gap-2">
      <div class="w-28 shrink-0 pt-1">
        <div class="truncate text-foreground/90" title={props.binding.label}>
          {props.binding.label}
        </div>
        <div
          class="truncate font-mono text-[10px] text-muted-foreground/70"
          title={props.binding.envVar}
        >
          {props.binding.envVar}
        </div>
      </div>
      <div class="flex-1 min-w-0 space-y-1">
        <div class="flex items-center gap-1.5">
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            value={value()}
            disabled={busy()}
            placeholder={present() ? "Replace key…" : "Paste key…"}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            class="flex-1 min-w-0 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <button
            onClick={() => void save()}
            disabled={busy()}
            class="px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-50 transition-colors"
          >
            Save
          </button>
          <Show when={present()}>
            <button
              onClick={() => void remove()}
              disabled={busy()}
              title={`Delete the stored ${props.binding.label} key`}
              aria-label={`Delete the stored ${props.binding.label} key`}
              class="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
          </Show>
          <Show when={props.removable}>
            <button
              onClick={props.onForget}
              disabled={busy()}
              title={`Remove ${props.binding.envVar} from this list`}
              aria-label={`Remove ${props.binding.envVar} from this list`}
              class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-50 transition-colors"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </Show>
        </div>
        <div
          class={`text-[10px] ${present() ? "text-primary/80" : "text-muted-foreground/70"}`}
        >
          {statusText()}
        </div>
      </div>
    </div>
  );
}

function AddCustomKey(props: { onAdded: () => void }) {
  const { addAiKey } = useSettings();
  const [envVar, setEnvVar] = createSignal("");
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const add = async () => {
    const name = envVar().trim();
    const v = value().trim();
    if (!name) {
      pushToast("Enter the environment variable name your CLI expects.", "warning");
      return;
    }
    if (!v) {
      pushToast("Paste a key value first.", "warning");
      return;
    }
    const id = `custom.${name}`;
    setBusy(true);
    try {
      // Store first: Rust owns the one implementation of the env-var name
      // rule, so a rejected name never leaves a dangling binding behind.
      await secretsApi.set(id, name, v);
      const added = addAiKey({ id, envVar: name, label: name });
      pushToast(
        added ? `${name} saved to the OS keychain` : `${name} was already listed — value updated`,
        "success",
      );
      setEnvVar("");
      props.onAdded();
    } catch (e) {
      pushToast(`Couldn't save ${name}: ${String(e)}`, "error", 7000);
    } finally {
      setValue("");
      setBusy(false);
    }
  };

  return (
    <div class="flex items-center gap-1.5 pt-1 border-t border-border/50">
      <input
        type="text"
        value={envVar()}
        disabled={busy()}
        placeholder="MY_PROVIDER_API_KEY"
        onInput={(e) => setEnvVar(e.currentTarget.value)}
        aria-label="Custom environment variable name"
        class="w-28 shrink-0 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
      <input
        type="password"
        autocomplete="off"
        spellcheck={false}
        value={value()}
        disabled={busy()}
        placeholder="Paste key…"
        aria-label="Custom key value"
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
        class="flex-1 min-w-0 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
      <button
        onClick={() => void add()}
        disabled={busy()}
        class="px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-50 transition-colors"
      >
        Add
      </button>
    </div>
  );
}

// ─── Brain Pane ─────────────────────────────────────────────────────────────

// ─── Git Pane ───────────────────────────────────────────────────────────────

/// Settings → Git: real git config on top, voidlink's own identity overrides
/// underneath.
///
/// This is the only pane that writes a file git owns, and the only one that
/// can write outside the repository. Three consequences shape it:
///
///   1. **The scope is stated continuously, never confirmed per write.** The
///      segmented control plus a permanent line naming the resolved file means
///      a write is never a surprise (§7.5.1 Anticipation) without a modal in
///      front of every edit.
///   2. **No optimistic updates** (§7.5.6). A config write is a filesystem
///      write outside our control, so every row renders the value that came
///      back from the re-read, never the value that was typed.
///   3. **No success toast** (§7.5.5). A write lands in single-digit
///      milliseconds and the user is looking straight at the row; the new
///      value and its new provenance mark *are* the feedback.
function GitPane() {
  const { activeRepoPath } = useAppStore();
  const [scope, setScope] = createSignal<ConfigScope>(activeRepoPath() ? "local" : "global");
  const [readError, setReadError] = createSignal<string | null>(null);
  const [readAt, setReadAt] = createSignal<Date | null>(null);

  const [snapshot, { refetch }] = createResource(
    () => activeRepoPath() ?? "",
    async (repoPath): Promise<ConfigSnapshot | null> => {
      // Caught rather than left to reject: reading a resource in a failed
      // state rethrows into render and there is no ErrorBoundary in the
      // dialog. A cascade that could not be read has to be *reported* — an
      // empty list would read as "nothing is configured", which is a lie.
      try {
        const result = await gitApi.configList(repoPath);
        setReadError(null);
        setReadAt(new Date());
        return result;
      } catch (e) {
        setReadError(String(e));
        return null;
      }
    },
  );

  // Losing the repo while Local is selected would leave writes aimed at a
  // file that no longer resolves.
  createEffect(() => {
    if (!activeRepoPath() && scope() === "local") setScope("global");
  });

  const entries = () => snapshot()?.entries ?? [];
  const targetPath = () =>
    scope() === "local" ? (snapshot()?.scopes.local ?? null) : (snapshot()?.scopes.global ?? null);
  const loading = () => snapshot.loading && !snapshot();

  /// One write, then a re-read. The re-read is not an optimisation to skip:
  /// it is the only thing that makes the rendered value true.
  const applyWrite = async (key: string, value: string | null) => {
    const repoPath = activeRepoPath() ?? "";
    const sc = scope();
    try {
      if (value === null) await gitApi.configUnset(repoPath, key, sc);
      else await gitApi.configSet(repoPath, key, value, sc);
      await refetch();
    } catch (e) {
      // Rust already names the resolved file in write errors; append it only
      // when the failure happened before it got that far.
      const raw = String(e);
      const path = targetPath();
      const named = path && !raw.includes(path) ? `${raw} (${path})` : raw;
      pushToast(`Couldn't write ${key} — ${named}`, "error", 8000, {
        label: "Retry",
        run: () => void applyWrite(key, value),
      });
    }
  };

  const freshness = () => {
    const at = readAt();
    if (!at) return "Not read yet";
    // §7.5.4: this pane has no watcher on .git/config, so it must not imply
    // liveness it does not have. Saying when it last read is the honest form.
    return `Last read ${at.toLocaleTimeString()} — voidlink does not watch this file, so an edit made elsewhere shows up only after a refresh`;
  };

  return (
    <div class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <p class="text-[11px] text-muted-foreground leading-relaxed">
          Reads your whole config cascade and writes the keys below to the
          scope you pick. Everything else in git config is left alone — edit it
          with <code>git config</code>.
        </p>
        <button
          onClick={() => void refetch()}
          aria-label="Re-read git config"
          title={freshness()}
          class="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <RefreshCw
            class={`w-3 h-3 ${snapshot.loading ? "animate-spin motion-loop" : ""}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      <ScopePicker
        scope={scope()}
        onChange={setScope}
        repoOpen={activeRepoPath() !== null}
        targetPath={targetPath()}
        loading={loading()}
      />

      <Show when={readError()}>
        {(err) => (
          // Inline, not a toast: a toast for a pane with no content leaves the
          // user staring at nothing after it fades.
          <div
            class="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 space-y-1.5"
            role="alert"
          >
            <p class="text-[11px] text-destructive leading-relaxed">
              Couldn't read git config. Nothing below is being shown because
              nothing could be read.
            </p>
            <p class="text-[10px] font-mono text-muted-foreground break-all">{err()}</p>
            <button
              onClick={() => void refetch()}
              class="px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Retry
            </button>
          </div>
        )}
      </Show>

      <Show when={!readError()}>
        <For each={CONFIG_GROUPS}>
          {(group) => (
            <Section title={group} tone={scope() === "global" ? "warning" : undefined}>
              <For each={fieldsInGroup(group)}>
                {(field) => (
                  <ConfigFieldRow
                    field={field}
                    entries={entries()}
                    scope={scope()}
                    loading={loading()}
                    onWrite={(value) => applyWrite(field.key, value)}
                  />
                )}
              </For>
            </Section>
          )}
        </For>
      </Show>

      <RepoIdentityOverrides />
    </div>
  );
}

/// The one control in this pane that must not be misread. A segmented toggle
/// alone looks exactly like the harmless diff-mode toggle, so the resolved
/// target file is named directly underneath it, permanently — no hover, no
/// disclosure, no per-write confirmation.
function ScopePicker(props: {
  scope: ConfigScope;
  onChange: (scope: ConfigScope) => void;
  repoOpen: boolean;
  targetPath: string | null;
  loading: boolean;
}) {
  const noRepoReason = "No repository is open in this workspace, so there is no .git/config to write";

  return (
    <div class="space-y-1.5">
      <div class="flex items-center gap-3">
        <span id="git-config-scope-label" class="w-28 text-muted-foreground shrink-0">
          Write scope
        </span>
        <div class="flex-1 flex gap-1" role="group" aria-labelledby="git-config-scope-label">
          <button
            // Not `disabled`: a disabled button leaves the tab order, and a
            // keyboard user would never reach the explanation for why it is
            // off (§7.6 — a disabled control with no stated reason).
            aria-disabled={!props.repoOpen}
            aria-pressed={props.scope === "local"}
            title={props.repoOpen ? "Writes go to this repository's .git/config" : noRepoReason}
            onClick={() => props.repoOpen && props.onChange("local")}
            class={`flex-1 px-2 py-1 rounded border text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
              !props.repoOpen
                ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                : props.scope === "local"
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            Local
          </button>
          <button
            aria-pressed={props.scope === "global"}
            title="Writes go to your user-wide git config, outside this repository"
            onClick={() => props.onChange("global")}
            class={`flex-1 px-2 py-1 rounded border text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
              props.scope === "global"
                ? "bg-warning/15 border-warning/40 text-warning"
                : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            Global
          </button>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <span class="w-28 shrink-0" aria-hidden="true" />
        <p class="flex-1 text-[10px] leading-tight text-muted-foreground">
          <Show
            when={!props.loading}
            fallback={<span class="inline-block h-3 w-52 rounded bg-muted animate-pulse motion-loop align-middle" />}
          >
            <Show
              when={props.targetPath}
              fallback={<span>Nothing to write to — pick a scope with a resolvable file.</span>}
            >
              {(path) => (
                <>
                  Edits write to <span class="font-mono break-all text-foreground/80">{path()}</span>
                </>
              )}
            </Show>
          </Show>
        </p>
      </div>

      <Show when={!props.repoOpen}>
        <div class="flex items-start gap-3">
          <span class="w-28 shrink-0" aria-hidden="true" />
          <p class="flex-1 text-[10px] leading-tight text-muted-foreground/80">
            {noRepoReason}. The global cascade below still reads normally.
          </p>
        </div>
      </Show>
    </div>
  );
}

/// One config key: label, the right control for its type, and exactly one
/// provenance mark in a slot reserved at rest.
///
/// This is not built on `TextRow` / `ToggleRow` / `SegmentedRow` — it borrows
/// their class vocabulary instead. Those helpers have no room for the
/// provenance slot or the Clear action, and they label their inputs with a
/// `<span>`, which §10.6 does not allow for a field a user types an email
/// address into.
function ConfigFieldRow(props: {
  field: ConfigField;
  entries: ConfigEntry[];
  scope: ConfigScope;
  loading: boolean;
  onWrite: (value: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = createSignal(false);
  // Held only while the field has focus. Cleared on commit so the row falls
  // back to the re-read value — never the typed one (§7.5.6).
  const [draft, setDraft] = createSignal<string | null>(null);

  const inputId = `git-config-${props.field.key.replace(/\./g, "-")}`;
  const labelId = `${inputId}-label`;
  const prov = () => resolveProvenance(props.entries, props.field.key, props.scope);
  const shown = () => displayValue(prov(), props.field);

  /// A config write completes well inside the 80ms band, so the pending state
  /// only appears if this particular one did not (§7.5.2). The control stays
  /// focusable and in the tab order throughout (§10.11).
  const commit = async (value: string | null) => {
    const timer = window.setTimeout(() => setBusy(true), 80);
    try {
      await props.onWrite(value);
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
      setDraft(null);
    }
  };

  const commitText = () => {
    const typed = draft();
    if (typed === null) return;
    const trimmed = typed.trim();
    if (trimmed === (prov().atScope ?? "")) {
      setDraft(null);
      return;
    }
    void commit(trimmed === "" ? null : trimmed);
  };

  return (
    <div class="density-row flex items-start gap-3">
      <div class="w-28 shrink-0">
        {/* A segmented control is a group of buttons, not one labelable
            element, so it gets `aria-labelledby` and the label is a span.
            A `<label for>` pointing at nothing is worse than no label. */}
        <Show
          when={props.field.kind !== "enum"}
          fallback={
            <span id={labelId} class="text-muted-foreground block leading-tight">
              {props.field.label}
            </span>
          }
        >
          <label for={inputId} id={labelId} class="text-muted-foreground block leading-tight">
            {props.field.label}
          </label>
        </Show>
        <span class="block text-[10px] font-mono text-muted-foreground/60 leading-tight break-all">
          {props.field.key}
        </span>
      </div>

      <div class="flex-1 min-w-0 space-y-1">
        <div
          class={`flex items-center gap-1.5 ${prov().kind === "inherited" ? "opacity-80" : ""}`}
        >
          <Show
            when={!props.loading}
            fallback={
              // The scaffold renders with the real labels and a pulsing value
              // slot: never a blank pane, never a centred spinner (§7.5.2).
              <span
                class="h-5 flex-1 rounded bg-muted animate-pulse motion-loop"
                aria-busy="true"
                aria-label={`Reading ${props.field.key}`}
              />
            }
          >
            <Switch>
              <Match when={props.field.kind === "boolean"}>
                <button
                  id={inputId}
                  aria-pressed={parseGitBool(shown(), parseGitBool(props.field.fallback))}
                  onClick={() =>
                    void commit(
                      parseGitBool(shown(), parseGitBool(props.field.fallback)) ? "false" : "true",
                    )
                  }
                  class={`px-3 py-1 rounded-full border text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                    parseGitBool(shown(), parseGitBool(props.field.fallback))
                      ? "bg-primary/15 border-primary/40 text-primary"
                      : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                  }`}
                >
                  {parseGitBool(shown(), parseGitBool(props.field.fallback)) ? "On" : "Off"}
                </button>
              </Match>

              <Match when={props.field.kind === "enum"}>
                <div class="flex flex-wrap gap-1" role="group" aria-labelledby={labelId}>
                  <For each={props.field.options ?? []}>
                    {(opt) => (
                      <button
                        aria-pressed={shown() === opt}
                        onClick={() => void commit(opt)}
                        class={`px-2 py-1 rounded border text-[11px] font-mono transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                          shown() === opt
                            ? "bg-primary/15 border-primary/40 text-primary"
                            : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                        }`}
                      >
                        {opt}
                      </button>
                    )}
                  </For>
                </div>
              </Match>

              <Match when={props.field.kind === "text"}>
                <input
                  id={inputId}
                  type="text"
                  value={draft() ?? (prov().value ?? "")}
                  placeholder={props.field.placeholder}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onBlur={commitText}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitText();
                    } else if (e.key === "Escape") {
                      // Abandon the draft rather than write it. Escape does
                      // not bubble to close the dialog here on purpose.
                      e.stopPropagation();
                      setDraft(null);
                    }
                  }}
                  class="flex-1 min-w-0 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono outline-2 outline-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Match>
            </Switch>
          </Show>

          {/* Icon slot reserved at rest so a spinner arriving causes no
              reflow (§7.5.2). */}
          <span class="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
            <Show when={busy()}>
              <Loader2 class="w-3 h-3 animate-spin motion-loop text-muted-foreground" aria-hidden="true" />
              <span class="sr-only">Writing…</span>
            </Show>
          </span>
        </div>

        <Show when={props.field.hint}>
          <p class="text-[10px] leading-tight text-muted-foreground/70">{props.field.hint}</p>
        </Show>

        <Show when={prov().kind === "unset" && !props.loading}>
          <p class="text-[10px] leading-tight text-muted-foreground/60">
            git's default here is <span class="font-mono">{props.field.fallback}</span>.
          </p>
        </Show>

        <Show when={prov().shadowed}>
          {(shadow) => (
            <p class="text-[10px] leading-tight text-muted-foreground/60 break-all">
              {shadow().level}: <span class="font-mono">{shadow().value}</span>
            </p>
          )}
        </Show>
      </div>

      {/* Provenance slot — reserved at rest, one mark, always carried by
          text and not by colour (§10.12). */}
      <div class="w-36 shrink-0 flex items-start justify-end gap-1.5 pt-1">
        <Show
          when={!props.loading}
          fallback={<span class="h-3 w-16 rounded bg-muted animate-pulse motion-loop" />}
        >
          <span class="text-[10px] uppercase tracking-wider text-muted-foreground text-right leading-tight">
            {prov().label}
          </span>
        </Show>
        <span class="w-8 shrink-0">
          <Show when={prov().atScope !== null && !props.loading}>
            <button
              onClick={() => void commit(null)}
              title={`Remove ${props.field.key} from ${props.scope} config`}
              aria-label={`Clear ${props.field.key} at ${props.scope} scope`}
              class="px-1 py-0.5 rounded border border-border text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Clear
            </button>
          </Show>
        </span>
      </div>
    </div>
  );
}

/// Git identity overrides, one row per repository that has one.
///
/// Rows are only created from the commit box ("Save for this repo") — there is
/// no "add" here on purpose, because an identity for a repository you have not
/// opened is not something you can meaningfully type a path for. This pane is
/// where you review and remove them.
///
/// It sits directly under the git-config identity rows and *will* be confused
/// with them, so the label and the first line of copy exist to separate the
/// two: this list never reaches git config.
function RepoIdentityOverrides() {
  const { settings, setRepoIdentity } = useSettings();
  const { activeRepoPath } = useAppStore();

  const entries = () =>
    Object.entries(settings.git.identityByRepo).sort(([a], [b]) => a.localeCompare(b));

  const repoName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

  return (
    <div class="space-y-4">
      <Section title="voidlink identity overrides">
        <p class="text-[11px] text-muted-foreground leading-relaxed">
          Separate from the <code>user.name</code> and <code>user.email</code>{" "}
          rows above: these are applied by voidlink at commit time and are
          stored in voidlink's own settings, so they never touch git config and
          committing from the command line in the same repository is
          unaffected. Set one from the commit box in the git panel.
        </p>
        <Show
          when={entries().length > 0}
          fallback={
            <p class="text-[11px] text-muted-foreground/70 italic">
              No overrides. Every repository commits with its git config identity.
            </p>
          }
        >
          <div class="space-y-1">
            <For each={entries()}>
              {([repoPath, identity]) => (
                <div class="flex items-center gap-2 rounded border border-border bg-muted/20 px-2 py-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span class="text-[12px] font-medium truncate">
                        {repoName(repoPath)}
                      </span>
                      <Show when={activeRepoPath() === repoPath}>
                        <span class="text-[10px] text-primary/80">active</span>
                      </Show>
                    </div>
                    <p class="text-[10px] text-muted-foreground font-mono truncate" title={repoPath}>
                      {repoPath}
                    </p>
                    <p class="text-[11px] text-muted-foreground truncate">
                      {identity.name} &lt;{identity.email}&gt;
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setRepoIdentity(repoPath, null);
                      pushToast(`${repoName(repoPath)} reverted to git config`, "info", 2500);
                    }}
                    aria-label={`Remove the identity override for ${repoName(repoPath)}`}
                    title="Remove — this repository goes back to git config"
                    class="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent/40 transition-colors"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Section>
    </div>
  );
}

function BrainPane() {
  const { settings, updateBrain } = useSettings();

  const pickVaultPath = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select the brain-kb vault folder",
    });
    if (!selected || Array.isArray(selected)) return;
    updateBrain({ vaultPath: selected });
  };

  return (
    <div class="space-y-4">
      <p class="text-[11px] text-muted-foreground leading-relaxed">
        A local git clone of your brain-kb vault (typed entries + notes). This
        must be the same directory the <code>brain</code> CLI writes to — its
        own path lives separately in <code>~/.config/brain/config.json</code>,
        so the two have to be pointed at each other by hand.
      </p>
      <Section title="Vault">
        <div class="flex items-center gap-3">
          <span class="w-28 text-muted-foreground shrink-0">Path</span>
          <input
            type="text"
            value={settings.brain.vaultPath}
            placeholder="/path/to/brain-kb"
            onInput={(e) => updateBrain({ vaultPath: e.currentTarget.value })}
            class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={pickVaultPath}
            class="px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            Browse…
          </button>
        </div>
      </Section>
    </div>
  );
}

// ─── Stack Pane ─────────────────────────────────────────────────────────────

const DEFAULT_TRUNK_HINT = "main, master, develop, trunk";

function StackPane() {
  const { activeRepoPath } = useAppStore();
  const repoPath = () => activeRepoPath() ?? null;

  // Load the per-repo trunk override list when a repo is active. The key
  // resets across workspace switches so the input always reflects the
  // active repo's `.git/config`.
  const [trunks, { refetch }] = createResource(
    () => repoPath(),
    async (p): Promise<string[] | null> => (p ? await stackApi.getTrunks(p) : null),
  );

  const [draft, setDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  // Mirror the loaded list into the editable input whenever the resource
  // resolves for a new repo.
  createEffect(() => {
    const t = trunks();
    if (Array.isArray(t)) setDraft(t.join(", "));
  });

  async function onSave() {
    const path = repoPath();
    if (!path) return;
    setSaving(true);
    try {
      const list = draft()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await stackApi.setTrunks(path, list);
      pushToast(
        list.length === 0
          ? "Trunk override cleared — defaults restored"
          : `Saved ${list.length} trunk override${list.length === 1 ? "" : "s"}`,
        "success",
      );
      // Discovery in the sidebar reads trunks fresh; broadcast so STACK
      // section adopts the new rule immediately.
      window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
      refetch();
    } catch (e) {
      pushToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Show
      when={repoPath()}
      fallback={
        <div class="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
          <Layers class="w-5 h-5 opacity-60" />
          <p>Select a workspace with a repo to configure its stack settings.</p>
        </div>
      }
    >
      <div class="space-y-6">
        <Section title="Trunk branches">
          <p class="text-muted-foreground leading-snug pb-1">
            Comma-separated branch names that voidlink treats as trunks for the
            active repo. Trunks anchor a stack — they never have a parent and
            are never restacked. The built-in defaults ({DEFAULT_TRUNK_HINT})
            and <span class="font-mono">origin/HEAD</span> always apply on top
            of whatever you set here.
          </p>
          <Show
            when={!trunks.loading}
            fallback={<div class="text-muted-foreground">Loading…</div>}
          >
            <div class="flex items-center gap-3">
              <span class="w-28 text-muted-foreground shrink-0">Overrides</span>
              <input
                type="text"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                placeholder="release/v2, staging"
                class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div class="flex items-center justify-end gap-2 pl-28">
              <Show when={(trunks() ?? []).length > 0}>
                <button
                  onClick={() => {
                    setDraft("");
                    void onSave();
                  }}
                  disabled={saving()}
                  class="px-3 py-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-50"
                >
                  Clear
                </button>
              </Show>
              <button
                onClick={() => void onSave()}
                disabled={saving()}
                class="px-3 py-1 rounded bg-primary text-primary-foreground text-[11px] hover:bg-primary/90 disabled:opacity-50"
              >
                {saving() ? "Saving…" : "Save"}
              </button>
            </div>
          </Show>
        </Section>
      </div>
    </Show>
  );
}
