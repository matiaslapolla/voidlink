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
import { loadTerminalSettings, saveTerminalSettings } from "@/lib/terminalSettings";
import type { TerminalSettings } from "@/lib/terminalSettings";
import { PROVIDERS } from "@/lib/providers";
import type { ProviderDef } from "@/lib/providers";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function modelDisplayName(model: string): string {
  // Shorten long model IDs for display while keeping the full ID as value
  if (model.startsWith("accounts/fireworks/models/")) {
    return model.replace("accounts/fireworks/models/", "");
  }
  return model;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = createSignal<"ai" | "terminal">("ai");

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
                  <span class="text-xs text-green-500 flex items-center gap-1">
                    <Check class="w-3.5 h-3.5" /> Saved
                  </span>
                </Show>
                <Button size="sm" onClick={handleTermSave} class="h-8 text-sm">
                  Save
                </Button>
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
