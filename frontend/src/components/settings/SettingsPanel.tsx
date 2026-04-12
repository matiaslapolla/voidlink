import { createSignal, createEffect, For, Show } from "solid-js";
import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X, Check, ChevronDown, Lock, Palette, Type, SquareTerminal, Cpu } from "lucide-solid";
import { settingsApi } from "@/api/settings";
import { useTheme, THEMES } from "@/store/theme";
import { useEditorSettings, updateEditorSettings } from "@/store/editor-settings";

// ─── Terminal settings (persisted in localStorage) ─────────────────────────

const TERMINAL_SETTINGS_KEY = "voidlink-terminal-settings";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  lineHeight: number;
}

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", monospace',
  fontSize: 16,
  scrollback: 5000,
  cursorStyle: "block",
  cursorBlink: true,
  lineHeight: 1.0,
};

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(TERMINAL_SETTINGS_KEY);
    if (raw) return { ...DEFAULT_TERMINAL_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_TERMINAL_SETTINGS };
}

function saveTerminalSettings(settings: TerminalSettings) {
  localStorage.setItem(TERMINAL_SETTINGS_KEY, JSON.stringify(settings));
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ProviderDef {
  id: string;
  label: string;
  needsKey: boolean;
  models: string[];
}

type Section = "appearance" | "editor" | "terminal" | "ai";

const SECTIONS: { id: Section; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "editor", label: "Editor", icon: Type },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "ai", label: "AI Provider", icon: Cpu },
];

// Model names shortened for display but full ID used for API calls
const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    models: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o4-mini",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    needsKey: true,
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    needsKey: true,
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    needsKey: true,
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "moonshotai/kimi-k2-instruct",
      "qwen/qwen3-32b",
      "qwen-2.5-32b",
      "qwen-2.5-coder-32b",
      "gemma2-9b-it",
      "mixtral-8x7b-32768",
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks",
    needsKey: true,
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/llama-v3p1-405b-instruct",
      "accounts/fireworks/models/qwen3-235b-a22b",
      "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
      "accounts/fireworks/models/qwen-qwq-32b-preview",
      "accounts/fireworks/models/qwen2p5-72b-instruct",
      "accounts/fireworks/models/mixtral-8x7b-instruct",
      "accounts/fireworks/models/deepseek-r1",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    needsKey: true,
    models: [
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "meta-llama/llama-3.3-70b-instruct",
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2-instruct",
      "moonshotai/moonlight-16b-a3b-instruct",
      "minimax/minimax-m2.7",
      "minimax/minimax-m2.5",
      "minimax/minimax-01",
      "qwen/qwen3-235b-a22b-instruct-2507",
      "qwen/qwen3-coder-480b-a35b-instruct",
      "qwen/qwen3-next-80b-a3b-instruct",
      "qwen/qwq-32b",
      "deepseek/deepseek-r1",
    ],
  },
  {
    id: "ollama",
    label: "Ollama",
    needsKey: false,
    models: [
      "llama3.2",
      "llama3.1",
      "mistral",
      "codellama",
      "qwen2.5",
      "qwen2.5-coder",
      "qwen3",
      "deepseek-r1",
      "phi4",
    ],
  },
  {
    id: "kimi",
    label: "Kimi",
    needsKey: true,
    models: [
      "kimi-k2.5",
      "kimi-k2",
      "kimi-k2-turbo-preview",
      "moonlight-16b-a3b-instruct",
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    needsKey: true,
    models: [
      "MiniMax-M2",
      "MiniMax-M2-Stable",
      "minimax-m2.1",
      "minimax-01",
    ],
  },
];

function modelDisplayName(model: string): string {
  if (model.startsWith("accounts/fireworks/models/")) {
    return model.replace("accounts/fireworks/models/", "");
  }
  return model;
}

// ─── Settings label helper ──────────────────────────────────────────────────

function SettingLabel(props: { children: any }) {
  return (
    <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
      {props.children}
    </label>
  );
}

function SectionTitle(props: { children: any; description?: string }) {
  return (
    <div class="mb-5">
      <h3 class="text-base font-semibold text-foreground">{props.children}</h3>
      <Show when={props.description}>
        <p class="text-xs text-muted-foreground mt-0.5">{props.description}</p>
      </Show>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function SettingsPanel(props: SettingsPanelProps) {
  const [section, setSection] = createSignal<Section>("appearance");
  const { theme: currentTheme, setTheme: applyTheme } = useTheme();
  const editorSettings = useEditorSettings();

  // ─── Terminal settings state ─────────────────────────────────────────────
  const [termSettings, setTermSettings] = createSignal<TerminalSettings>(loadTerminalSettings());
  const [termSaved, setTermSaved] = createSignal(false);

  function handleTermSave() {
    saveTerminalSettings(termSettings());
    setTermSaved(true);
    setTimeout(() => setTermSaved(false), 2000);
  }

  function updateTermSetting<K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) {
    setTermSettings((prev) => ({ ...prev, [key]: value }));
  }

  // ─── AI Provider state ──────────────────────────────────────────────────
  const [selectedProvider, setSelectedProvider] = createSignal<string>(PROVIDERS[0].id);
  const [selectedModel, setSelectedModel] = createSignal<string>(PROVIDERS[0].models[0]);
  const [apiKey, setApiKey] = createSignal("");
  const [keyStored, setKeyStored] = createSignal(false);
  const [activeProvider, setActiveProvider] = createSignal("");
  const [activeModel, setActiveModel] = createSignal("");

  const [saving, setSaving] = createSignal(false);
  const [saveSuccess, setSaveSuccess] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");

  function providerDef(id: string): ProviderDef {
    return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  }

  function selectProvider(id: string) {
    const def = providerDef(id);
    setSelectedProvider(id);
    setSelectedModel(def.models[0]);
    setApiKey("");
    setSaveSuccess(false);
    setSaveError("");
    if (def.needsKey) {
      settingsApi.loadApiKey(id).then((k) => setKeyStored(!!k)).catch(() => setKeyStored(false));
    } else {
      setKeyStored(false);
    }
  }

  // Load persisted settings when the panel opens
  createEffect(() => {
    if (!props.open) return;
    settingsApi
      .loadProviderSettings()
      .then((settings) => {
        const ap = settings.activeProvider ?? "";
        const am = settings.models?.[ap] ?? "";
        setActiveProvider(ap);
        setActiveModel(am);
        if (ap && PROVIDERS.some((p) => p.id === ap)) {
          const def = providerDef(ap);
          setSelectedProvider(ap);
          setSelectedModel(am || def.models[0]);
          if (def.needsKey) {
            settingsApi
              .loadApiKey(ap)
              .then((k) => setKeyStored(!!k))
              .catch(() => setKeyStored(false));
          }
        }
      })
      .catch(() => {});
  });

  async function handleSave() {
    const pid = selectedProvider();
    const model = selectedModel();
    const key = apiKey().trim();
    const def = providerDef(pid);

    setSaving(true);
    setSaveSuccess(false);
    setSaveError("");

    try {
      if (def.needsKey && key !== "") {
        await settingsApi.saveApiKey(pid, key);
        setKeyStored(true);
        setApiKey("");
      }
      await settingsApi.saveProviderSettings({
        activeProvider: pid,
        models: { [pid]: model },
      });
      await settingsApi.reloadProvider();
      setActiveProvider(pid);
      setActiveModel(model);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearKey() {
    const pid = selectedProvider();
    try {
      await settingsApi.saveApiKey(pid, "");
      setKeyStored(false);
    } catch {
      // best-effort
    }
  }

  const currentDef = () => providerDef(selectedProvider());

  const inputClass = "w-full rounded-md bg-muted/50 border border-border/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors";
  const selectClass = "w-full appearance-none rounded-md bg-muted/50 border border-border/60 px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring cursor-pointer transition-colors";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup class="max-w-[680px] w-full p-0 overflow-hidden">
          <div class="flex min-h-[460px] max-h-[70vh]">
            {/* ── Sidebar ─────────────────────────────────────────────── */}
            <div class="w-[180px] shrink-0 border-r border-border/40 bg-muted/20 flex flex-col">
              <div class="flex items-center justify-between px-4 pt-4 pb-4">
                <DialogTitle class="text-sm font-semibold tracking-wide text-foreground">
                  Settings
                </DialogTitle>
              </div>
              <nav class="flex-1 px-2 space-y-0.5">
                <For each={SECTIONS}>
                  {(s) => (
                    <button
                      onClick={() => setSection(s.id)}
                      class={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
                        section() === s.id
                          ? "bg-accent text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                      }`}
                    >
                      <s.icon class={`w-4 h-4 ${section() === s.id ? "text-primary" : ""}`} />
                      {s.label}
                    </button>
                  )}
                </For>
              </nav>
              <DialogClose class="mx-2 mb-3 p-2 rounded-md text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors flex items-center gap-2 text-xs">
                <X class="w-3.5 h-3.5" />
                Close
              </DialogClose>
            </div>

            {/* ── Content ─────────────────────────────────────────────── */}
            <div class="flex-1 overflow-auto p-6">

              {/* ── Appearance ─────────────────────────────────────────── */}
              <Show when={section() === "appearance"}>
                <SectionTitle description="Choose a color theme for the interface and editor">
                  Appearance
                </SectionTitle>
                <div class="grid grid-cols-2 gap-2.5">
                  <For each={THEMES}>
                    {(t) => {
                      const isActive = () => currentTheme() === t.id;
                      return (
                        <button
                          onClick={() => applyTheme(t.id)}
                          class={`relative flex flex-col gap-2.5 p-3 rounded-lg border text-left transition-colors ${
                            isActive()
                              ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                              : "border-border/50 hover:border-muted-foreground/30 hover:bg-accent/30"
                          }`}
                        >
                          {/* Color preview bar */}
                          <div class="flex gap-1.5">
                            <span
                              class="w-5 h-5 rounded-md border border-white/10"
                              style={{ background: t.preview[0] }}
                            />
                            <span
                              class="w-5 h-5 rounded-md border border-white/10"
                              style={{ background: t.preview[2] }}
                            />
                            <span
                              class="w-5 h-5 rounded-md border border-white/10"
                              style={{ background: t.preview[1] }}
                            />
                            <span
                              class="w-5 h-5 rounded-md border border-white/10"
                              style={{ background: t.preview[3] }}
                            />
                          </div>
                          <div class="flex items-center justify-between">
                            <span class="text-[13px] font-medium">{t.label}</span>
                            <span class="text-[10px] uppercase tracking-wider text-muted-foreground">
                              {t.mode}
                            </span>
                          </div>
                          <Show when={isActive()}>
                            <div class="absolute top-2 right-2">
                              <Check class="w-3.5 h-3.5 text-primary" />
                            </div>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>

              {/* ── Editor ─────────────────────────────────────────────── */}
              <Show when={section() === "editor"}>
                <SectionTitle description="Font and display settings for the code editor">
                  Editor
                </SectionTitle>
                <div class="space-y-4">
                  <div>
                    <SettingLabel>Font Family</SettingLabel>
                    <input
                      type="text"
                      value={editorSettings().fontFamily}
                      onInput={(e) => updateEditorSettings({ fontFamily: e.currentTarget.value })}
                      class={`${inputClass} font-mono`}
                    />
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <SettingLabel>Font Size</SettingLabel>
                      <input
                        type="number"
                        min="8"
                        max="32"
                        value={editorSettings().fontSize}
                        onInput={(e) => updateEditorSettings({ fontSize: parseInt(e.currentTarget.value) || 12 })}
                        class={inputClass}
                      />
                    </div>
                    <div>
                      <SettingLabel>Line Height</SettingLabel>
                      <input
                        type="number"
                        min="1"
                        max="3"
                        step="0.1"
                        value={editorSettings().lineHeight}
                        onInput={(e) => updateEditorSettings({ lineHeight: parseFloat(e.currentTarget.value) || 1.6 })}
                        class={inputClass}
                      />
                    </div>
                  </div>

                  {/* Live preview */}
                  <div class="mt-5">
                    <SettingLabel>Preview</SettingLabel>
                    <div class="rounded-lg border border-border/50 bg-muted/30 p-4 overflow-hidden">
                      <pre
                        class="m-0"
                        style={{
                          "font-family": editorSettings().fontFamily,
                          "font-size": `${editorSettings().fontSize}px`,
                          "line-height": editorSettings().lineHeight,
                        }}
                      >
                        <code class="text-foreground">
                          <span class="text-primary">function</span>{" "}
                          <span class="text-info">greet</span>
                          {"(name: "}
                          <span class="text-warning">string</span>
                          {") {\n"}
                          {"  "}
                          <span class="text-primary">return</span>
                          {" `Hello, ${name}!`;\n"}
                          {"}"}
                        </code>
                      </pre>
                    </div>
                  </div>

                  <p class="text-[11px] text-muted-foreground/70">
                    Changes apply immediately to open editors.
                  </p>
                </div>
              </Show>

              {/* ── Terminal ───────────────────────────────────────────── */}
              <Show when={section() === "terminal"}>
                <SectionTitle description="Configure the integrated terminal emulator">
                  Terminal
                </SectionTitle>
                <div class="space-y-4">
                  <div>
                    <SettingLabel>Font Family</SettingLabel>
                    <input
                      type="text"
                      value={termSettings().fontFamily}
                      onInput={(e) => updateTermSetting("fontFamily", e.currentTarget.value)}
                      class={`${inputClass} font-mono`}
                    />
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <SettingLabel>Font Size</SettingLabel>
                      <input
                        type="number"
                        min="8"
                        max="32"
                        value={termSettings().fontSize}
                        onInput={(e) => updateTermSetting("fontSize", parseInt(e.currentTarget.value) || 13)}
                        class={inputClass}
                      />
                    </div>
                    <div>
                      <SettingLabel>Line Height</SettingLabel>
                      <input
                        type="number"
                        min="1"
                        max="2.5"
                        step="0.1"
                        value={termSettings().lineHeight}
                        onInput={(e) => updateTermSetting("lineHeight", parseFloat(e.currentTarget.value) || 1.4)}
                        class={inputClass}
                      />
                    </div>
                  </div>

                  <div>
                    <SettingLabel>Scrollback Lines</SettingLabel>
                    <input
                      type="number"
                      min="500"
                      max="100000"
                      step="500"
                      value={termSettings().scrollback}
                      onInput={(e) => updateTermSetting("scrollback", parseInt(e.currentTarget.value) || 5000)}
                      class={inputClass}
                    />
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <SettingLabel>Cursor Style</SettingLabel>
                      <div class="relative">
                        <select
                          value={termSettings().cursorStyle}
                          onChange={(e) => updateTermSetting("cursorStyle", e.currentTarget.value as "block" | "underline" | "bar")}
                          class={selectClass}
                        >
                          <option value="block">Block</option>
                          <option value="underline">Underline</option>
                          <option value="bar">Bar</option>
                        </select>
                        <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                      </div>
                    </div>
                    <div>
                      <SettingLabel>Cursor Blink</SettingLabel>
                      <button
                        onClick={() => updateTermSetting("cursorBlink", !termSettings().cursorBlink)}
                        class={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
                          termSettings().cursorBlink
                            ? "bg-primary/10 border-primary/50 text-primary"
                            : "bg-muted/50 border-border/60 text-muted-foreground"
                        }`}
                      >
                        {termSettings().cursorBlink ? "On" : "Off"}
                      </button>
                    </div>
                  </div>

                  <div class="pt-2 flex items-center justify-between">
                    <p class="text-[11px] text-muted-foreground/70">
                      Terminal settings apply on next terminal launch.
                    </p>
                    <div class="flex items-center gap-2">
                      <Show when={termSaved()}>
                        <span class="text-xs text-success flex items-center gap-1">
                          <Check class="w-3.5 h-3.5" /> Saved
                        </span>
                      </Show>
                      <Button size="sm" onClick={handleTermSave} class="h-8 text-sm">
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              </Show>

              {/* ── AI Provider ────────────────────────────────────────── */}
              <Show when={section() === "ai"}>
                <SectionTitle description="Configure your AI model provider and API credentials">
                  AI Provider
                </SectionTitle>
                <div class="space-y-5">
                  {/* Provider */}
                  <div>
                    <SettingLabel>Provider</SettingLabel>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={PROVIDERS}>
                        {(p) => (
                          <button
                            onClick={() => selectProvider(p.id)}
                            class={`px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                              selectedProvider() === p.id
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted/50 hover:bg-accent text-foreground border border-border/40"
                            }`}
                          >
                            {p.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>

                  {/* Model */}
                  <div>
                    <SettingLabel>Model</SettingLabel>
                    <div class="relative">
                      <select
                        value={selectedModel()}
                        onChange={(e) => setSelectedModel(e.currentTarget.value)}
                        class={selectClass}
                      >
                        <For each={currentDef().models}>
                          {(model) => (
                            <option value={model}>{modelDisplayName(model)}</option>
                          )}
                        </For>
                      </select>
                      <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>

                  {/* API Key */}
                  <Show when={currentDef().needsKey}>
                    <div>
                      <SettingLabel>API Key</SettingLabel>
                      <input
                        type="password"
                        autocomplete="off"
                        spellcheck={false}
                        placeholder={keyStored() ? "Key saved — enter new key to replace" : "Paste your API key"}
                        value={apiKey()}
                        onInput={(e) => setApiKey(e.currentTarget.value)}
                        class={`${inputClass} font-mono`}
                      />
                      <div class="flex items-center justify-between mt-1.5">
                        <span class="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Lock class="w-3 h-3" />
                          Encrypted in OS keychain
                        </span>
                        <Show when={keyStored()}>
                          <button
                            onClick={() => void handleClearKey()}
                            class="text-[11px] text-destructive hover:underline"
                          >
                            Clear key
                          </button>
                        </Show>
                      </div>
                    </div>
                  </Show>

                  <Show when={!currentDef().needsKey}>
                    <div>
                      <SettingLabel>API Key</SettingLabel>
                      <p class="text-sm text-muted-foreground">
                        No API key required — Ollama runs locally.
                      </p>
                    </div>
                  </Show>

                  {/* Actions */}
                  <div class="pt-2 flex items-center justify-between border-t border-border/30">
                    <Show
                      when={activeProvider()}
                      fallback={<span class="text-xs text-muted-foreground">No provider active</span>}
                    >
                      <span class="text-xs text-muted-foreground">
                        Active:{" "}
                        <span class="text-foreground font-medium">
                          {providerDef(activeProvider()).label}
                        </span>
                        <Show when={activeModel()}>
                          {" "}
                          <span class="opacity-60">— {modelDisplayName(activeModel())}</span>
                        </Show>
                      </span>
                    </Show>

                    <div class="flex items-center gap-2">
                      <Show when={saveError()}>
                        <span class="text-xs text-destructive">{saveError()}</span>
                      </Show>
                      <Button
                        size="sm"
                        disabled={saving()}
                        onClick={() => void handleSave()}
                        class="h-8 text-sm"
                      >
                        <Show
                          when={saveSuccess()}
                          fallback={saving() ? "Saving..." : "Save & Apply"}
                        >
                          <Check class="w-3.5 h-3.5 mr-1" /> Applied
                        </Show>
                      </Button>
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
