/// The settings, as text.
///
/// A Monaco instance over the same store the controls write to — not a copy of
/// it. Typing here calls the same `updateEditor` a toggle does, and a change
/// made by a toggle rewrites the buffer under the cursor. That is the whole
/// design: **one store, two views.**
///
/// Uses `loadMonaco()` like every other surface in the app — there is exactly
/// one loader and one `MonacoEnvironment`, and adding a second is how the
/// language workers stop resolving under Vite. It gets VoidLink's own theme
/// (`monacoTheme.ts`), not stock `vs-dark`; MASTER §11.5 is about not importing
/// VS Code's chrome, and a differently-themed pane inside our own dialog is
/// exactly that.
///
/// Validation and completion come from a JSON Schema generated from the
/// settings table, registered through `monaco.languages.json.jsonDefaults`.
/// Nothing about it is hand-written, so it cannot drift from the GUI.

import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import type * as Monaco from "monaco-editor";
import { loadMonaco } from "@/components/editor/monaco";
import { applyVoidlinkTheme, monacoThemeName } from "@/components/editor/monacoTheme";
import { useTheme } from "@/store/theme";
import { useSettings } from "@/store/settings";
import {
  SETTINGS_JSON_MODEL_URI,
  SETTINGS_JSON_SCHEMA_URI,
  parseSettingsJson,
  settingsJsonSchema,
  toSettingsJson,
} from "@/store/settingsJson";

/// Register the generated schema against the settings buffer's uri.
///
/// **`monaco.json.jsonDefaults`, not `monaco.languages.json.jsonDefaults`** —
/// the latter is deprecated in 0.55 and typed as `{ deprecated: true }`, so it
/// does not even compile. The language services moved to top-level namespaces.
///
/// `jsonDefaults` is global and last-write-wins, so this is idempotent across
/// mounts — opening the pane twice registers the same schema twice with the
/// same answer. Every other schema already registered is kept: replacing the
/// whole list would silently disarm validation for any other JSON buffer.
function registerSettingsSchema(monaco: typeof Monaco) {
  const defaults = monaco.json.jsonDefaults;
  const existing = defaults.diagnosticsOptions.schemas ?? [];
  defaults.setDiagnosticsOptions({
    ...defaults.diagnosticsOptions,
    validate: true,
    schemas: [
      ...existing.filter((s) => s.uri !== SETTINGS_JSON_SCHEMA_URI),
      {
        uri: SETTINGS_JSON_SCHEMA_URI,
        fileMatch: [SETTINGS_JSON_MODEL_URI],
        schema: settingsJsonSchema(),
      },
    ],
  });
}

export function SettingsJsonPane() {
  const { mode, theme } = useTheme();
  const { settings, updateEditor } = useSettings();
  const [error, setError] = createSignal<string | null>(null);
  let container!: HTMLDivElement;
  let monacoRef: typeof Monaco | null = null;
  let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  let model: Monaco.editor.ITextModel | null = null;
  /// Set while the *store* is being pushed into the buffer, so the resulting
  /// change event is not mistaken for the user typing and written straight back
  /// out — which would fight the cursor on every keystroke.
  let applyingExternal = false;
  /// Set while the *buffer* is being written into the store, so the store
  /// effect below knows the text is already correct and leaves it alone.
  let applyingLocal = false;

  onMount(async () => {
    const monaco = await loadMonaco();
    monacoRef = monaco;
    applyVoidlinkTheme(monaco, mode());
    registerSettingsSchema(monaco);

    const uri = monaco.Uri.parse(SETTINGS_JSON_MODEL_URI);
    // The pane can be opened, closed and reopened; a model for this uri may
    // still be around from last time, and creating a second one for the same
    // uri throws.
    model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(toSettingsJson(settings.editor), "json", uri);
    if (model.getValue() !== toSettingsJson(settings.editor)) {
      model.setValue(toSettingsJson(settings.editor));
    }

    editor = monaco.editor.create(container, {
      model,
      theme: monacoThemeName(mode()),
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: "on",
      folding: true,
      fontSize: settings.editor.fontSize,
      fontFamily: settings.editor.fontFamily,
      padding: { top: 8, bottom: 8 },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      tabSize: 2,
    });

    const sub = model.onDidChangeContent(() => {
      if (applyingExternal || !model) return;
      const result = parseSettingsJson(model.getValue());
      if (!result.ok) {
        // Refused, out loud, and the store is untouched — a text pane that
        // silently drops what you typed is worse than one that says no.
        setError(result.error);
        return;
      }
      setError(null);
      applyingLocal = true;
      try {
        updateEditor(result.editor);
      } finally {
        applyingLocal = false;
      }
    });

    onCleanup(() => {
      sub.dispose();
      editor?.dispose();
      // The model outlives the pane deliberately: it is keyed by a fixed uri,
      // and disposing it here would race a reopen in the same tick.
      editor = null;
      monacoRef = null;
    });
  });

  // The other direction: a change made with a control rewrites the buffer.
  // `pushEditOperations` rather than `setValue` so the undo stack and the
  // cursor survive somebody dragging a slider with the JSON pane open.
  createEffect(
    on(
      () => toSettingsJson(settings.editor),
      (text) => {
        if (applyingLocal || !model || model.getValue() === text) return;
        applyingExternal = true;
        try {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text }],
            () => null,
          );
          setError(null);
        } finally {
          applyingExternal = false;
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      // `theme()` as well as `mode()`, matching `EditorHost` and `MonacoPanes`:
      // the eight named themes rewrite every token without changing mode, so
      // tracking the mode alone left this pane on monokai's hexes after a
      // switch to dracula.
      () => [theme(), mode()] as const,
      ([, m]) => {
        if (monacoRef) applyVoidlinkTheme(monacoRef, m);
        editor?.updateOptions({ theme: monacoThemeName(m) });
      },
      { defer: true },
    ),
  );

  return (
    <div class="space-y-2">
      <p class="text-label text-muted-foreground leading-relaxed">
        The same settings, in VS Code's dotted form. Edits apply as you type;
        a <code>"[rust]"</code> section overrides those keys for Rust buffers
        only. Completion and validation come from the same table the controls
        are drawn from.
      </p>
      <div
        ref={container}
        class="h-[420px] w-full overflow-hidden rounded border border-border"
      />
      <Show when={error()}>
        {(message) => (
          <div
            role="alert"
            class="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-label text-destructive"
          >
            <AlertTriangle class="mt-px h-3 w-3 shrink-0" />
            <span>
              {message()} — nothing was saved. The settings are unchanged until
              this parses.
            </span>
          </div>
        )}
      </Show>
    </div>
  );
}
