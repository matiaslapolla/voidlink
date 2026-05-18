import { Show, For, createResource, createSignal, createEffect, type JSX } from "solid-js";
import { Layers, X } from "lucide-solid";
import {
  useSettings,
  type CursorStyle,
  type UiDensity,
  type UiTextSize,
} from "@/store/settings";
import { useAppStore } from "@/store/LayoutContext";
import { stackApi } from "@/api/stack";
import { pushToast } from "@/commands/toast";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "ui" | "terminal" | "ai" | "stack";

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
            <TabButton active={tab() === "terminal"} onClick={() => setTab("terminal")}>Terminal</TabButton>
            <TabButton active={tab() === "ai"} onClick={() => setTab("ai")}>AI</TabButton>
            <TabButton active={tab() === "stack"} onClick={() => setTab("stack")}>Stack</TabButton>
          </div>

          <div class="flex-1 overflow-y-auto scrollbar-thin p-4 text-xs">
            <Show when={tab() === "ui"}><UiPane /></Show>
            <Show when={tab() === "terminal"}><TerminalPane /></Show>
            <Show when={tab() === "ai"}><AiPane /></Show>
            <Show when={tab() === "stack"}><StackPane /></Show>
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
    </div>
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

// ─── Reusable rows ───────────────────────────────────────────────────────────

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section>
      <h3 class="ui-section-label mb-2">{props.title}</h3>
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
        commit-message draft. No keys are stored here — your CLI handles auth.
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
    </div>
  );
}

// ─── Stack Pane ─────────────────────────────────────────────────────────────

const DEFAULT_TRUNK_HINT = "main, master, develop, trunk";

function StackPane() {
  const { activeWorkspace } = useAppStore();
  const repoPath = () => activeWorkspace()?.repoRoot ?? null;

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
