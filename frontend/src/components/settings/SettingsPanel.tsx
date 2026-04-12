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
import { X, Check, ChevronDown, Lock } from "lucide-solid";
import { settingsApi } from "@/api/settings";
import { useTheme, THEMES } from "@/store/theme";

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
      // OpenAI
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      // Anthropic
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      // Google
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      // Meta
      "meta-llama/llama-3.3-70b-instruct",
      // Kimi (Moonshot)
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2-instruct",
      "moonshotai/moonlight-16b-a3b-instruct",
      // MiniMax
      "minimax/minimax-m2.7",
      "minimax/minimax-m2.5",
      "minimax/minimax-01",
      // Qwen
      "qwen/qwen3-235b-a22b-instruct-2507",
      "qwen/qwen3-coder-480b-a35b-instruct",
      "qwen/qwen3-next-80b-a3b-instruct",
      "qwen/qwq-32b",
      // DeepSeek
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
  // Shorten long model IDs for display while keeping the full ID as value
  if (model.startsWith("accounts/fireworks/models/")) {
    return model.replace("accounts/fireworks/models/", "");
  }
  return model;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = createSignal<"ai" | "terminal" | "theme">("ai");
  const { theme: currentTheme, setTheme: applyTheme } = useTheme();

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

  // Which provider the user is currently editing
  const [selectedProvider, setSelectedProvider] = createSignal<string>(PROVIDERS[0].id);
  // Selected model per provider (editing state, not yet saved)
  const [selectedModel, setSelectedModel] = createSignal<string>(PROVIDERS[0].models[0]);
  // API key the user is typing
  const [apiKey, setApiKey] = createSignal("");
  // Whether a key is already stored in keychain for the selected provider
  const [keyStored, setKeyStored] = createSignal(false);
  // The currently active provider+model (persisted state)
  const [activeProvider, setActiveProvider] = createSignal("");
  const [activeModel, setActiveModel] = createSignal("");

  const [saving, setSaving] = createSignal(false);
  const [saveSuccess, setSaveSuccess] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");

  function providerDef(id: string): ProviderDef {
    return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  }

  // When provider changes: reset model to provider's first, check keychain
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

        // Pre-select the active provider in the editor if set
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
      // 1. Save API key to OS keychain (only if user typed one)
      if (def.needsKey && key !== "") {
        await settingsApi.saveApiKey(pid, key);
        setKeyStored(true);
        setApiKey("");
      }

      // 2. Persist provider + model selection
      await settingsApi.saveProviderSettings({
        activeProvider: pid,
        models: { [pid]: model },
      });

      // 3. Reload backend provider
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

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup class="max-w-md w-full">
          {/* Header */}
          <div class="flex items-center justify-between mb-4">
            <DialogTitle class="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
              Settings
            </DialogTitle>
            <DialogClose class="p-1 rounded hover:bg-accent transition-colors">
              <X class="w-4 h-4" />
            </DialogClose>
          </div>

          {/* Tab switcher */}
          <div class="flex gap-1 mb-5 border-b border-border pb-2">
            <button
              onClick={() => setSettingsTab("ai")}
              class={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                settingsTab() === "ai"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
              }`}
            >
              AI Provider
            </button>
            <button
              onClick={() => setSettingsTab("terminal")}
              class={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                settingsTab() === "terminal"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
              }`}
            >
              Terminal
            </button>
            <button
              onClick={() => setSettingsTab("theme")}
              class={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                settingsTab() === "theme"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
              }`}
            >
              Theme
            </button>
          </div>

          {/* ── Terminal settings tab ─────────────────────────────────── */}
          <Show when={settingsTab() === "terminal"}>
            <div class="space-y-4">
              <div>
                <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                  Font Family
                </label>
                <input
                  type="text"
                  value={termSettings().fontFamily}
                  onInput={(e) => updateTermSetting("fontFamily", e.currentTarget.value)}
                  class="w-full rounded-md bg-background border border-input px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                    Font Size
                  </label>
                  <input
                    type="number"
                    min="8"
                    max="32"
                    value={termSettings().fontSize}
                    onInput={(e) => updateTermSetting("fontSize", parseInt(e.currentTarget.value) || 13)}
                    class="w-full rounded-md bg-background border border-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div>
                  <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                    Line Height
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="2.5"
                    step="0.1"
                    value={termSettings().lineHeight}
                    onInput={(e) => updateTermSetting("lineHeight", parseFloat(e.currentTarget.value) || 1.4)}
                    class="w-full rounded-md bg-background border border-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                  Scrollback Lines
                </label>
                <input
                  type="number"
                  min="500"
                  max="100000"
                  step="500"
                  value={termSettings().scrollback}
                  onInput={(e) => updateTermSetting("scrollback", parseInt(e.currentTarget.value) || 5000)}
                  class="w-full rounded-md bg-background border border-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                    Cursor Style
                  </label>
                  <div class="relative">
                    <select
                      value={termSettings().cursorStyle}
                      onChange={(e) => updateTermSetting("cursorStyle", e.currentTarget.value as "block" | "underline" | "bar")}
                      class="w-full appearance-none rounded-md bg-background border border-input px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                    >
                      <option value="block">Block</option>
                      <option value="underline">Underline</option>
                      <option value="bar">Bar</option>
                    </select>
                    <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                    Cursor Blink
                  </label>
                  <button
                    onClick={() => updateTermSetting("cursorBlink", !termSettings().cursorBlink)}
                    class={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
                      termSettings().cursorBlink
                        ? "bg-primary/10 border-primary text-primary"
                        : "bg-background border-input text-muted-foreground"
                    }`}
                  >
                    {termSettings().cursorBlink ? "On" : "Off"}
                  </button>
                </div>
              </div>

              <div class="mt-4 flex items-center justify-end gap-2">
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
          </Show>

          {/* ── Theme settings tab ─────────────────────────────────────── */}
          <Show when={settingsTab() === "theme"}>
            <div class="space-y-4">
              <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Choose a theme
              </p>
              <div class="grid grid-cols-2 gap-2">
                <For each={THEMES}>
                  {(t) => {
                    const isActive = () => currentTheme() === t.id;
                    return (
                      <button
                        onClick={() => applyTheme(t.id)}
                        class={`relative flex flex-col gap-2 p-3 rounded-lg border text-left transition-colors ${
                          isActive()
                            ? "border-primary bg-primary/8 ring-1 ring-primary/40"
                            : "border-border hover:border-muted-foreground/30 hover:bg-accent/40"
                        }`}
                      >
                        {/* Color preview dots */}
                        <div class="flex gap-1.5">
                          <span
                            class="w-4 h-4 rounded-full border border-white/10"
                            style={{ background: t.preview[0] }}
                          />
                          <span
                            class="w-4 h-4 rounded-full border border-white/10"
                            style={{ background: t.preview[2] }}
                          />
                          <span
                            class="w-4 h-4 rounded-full border border-white/10"
                            style={{ background: t.preview[1] }}
                          />
                          <span
                            class="w-4 h-4 rounded-full border border-white/10"
                            style={{ background: t.preview[3] }}
                          />
                        </div>
                        <div class="flex items-center justify-between">
                          <span class="text-sm font-medium">{t.label}</span>
                          <span class="text-[10px] uppercase tracking-wide text-muted-foreground">
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
            </div>
          </Show>

          {/* ── AI Provider settings tab ──────────────────────────────── */}
          <Show when={settingsTab() === "ai"}>
          <div class="space-y-5">
            {/* Step 1 — Provider */}
            <div>
              <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                1 · Provider
              </p>
              <div class="flex flex-wrap gap-1.5">
                <For each={PROVIDERS}>
                  {(p) => (
                    <button
                      onClick={() => selectProvider(p.id)}
                      class={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        selectedProvider() === p.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent/60 hover:bg-accent text-foreground"
                      }`}
                    >
                      {p.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            {/* Step 2 — Model */}
            <div>
              <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                2 · Model
              </p>
              <div class="relative">
                <select
                  value={selectedModel()}
                  onChange={(e) => setSelectedModel(e.currentTarget.value)}
                  class="w-full appearance-none rounded-md bg-background border border-input px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
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

            {/* Step 3 — API Key */}
            <Show when={currentDef().needsKey}>
              <div>
                <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  3 · API Key
                </p>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={keyStored() ? "Key saved — enter new key to replace" : "Paste your API key"}
                  value={apiKey()}
                  onInput={(e) => setApiKey(e.currentTarget.value)}
                  class="w-full rounded-md bg-background border border-input px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <div class="flex items-center justify-between mt-1.5">
                  <span class="flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock class="w-3 h-3" />
                    Encrypted in OS keychain
                  </span>
                  <Show when={keyStored()}>
                    <button
                      onClick={() => void handleClearKey()}
                      class="text-xs text-destructive hover:underline"
                    >
                      Clear key
                    </button>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={!currentDef().needsKey}>
              <div>
                <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  3 · API Key
                </p>
                <p class="text-sm text-muted-foreground">
                  No API key required — Ollama runs locally.
                </p>
              </div>
            </Show>
          </div>

          {/* Actions */}
          <div class="mt-6 flex items-center justify-between">
            {/* Active status */}
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
                  fallback={saving() ? "Saving…" : "Save & Apply"}
                >
                  <Check class="w-3.5 h-3.5 mr-1" /> Applied
                </Show>
              </Button>
            </div>
          </div>
          </Show>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
