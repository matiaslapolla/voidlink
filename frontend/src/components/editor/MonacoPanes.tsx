/// Standalone Monaco surfaces that own their models.
///
/// The file tabs share one editor through `editorController`, because they share
/// one model cache and one dirty-tracking story. Diff and merge tabs are the
/// opposite: each shows text that exists nowhere on disk under that identity —
/// the HEAD side of a diff, the "theirs" side of a conflict — so each pane mints
/// throwaway models and disposes them with itself.
///
/// Model URIs therefore have to be unique *and* distinct from the `file://…`
/// URIs the code editor uses: creating a second model for an existing URI is an
/// error in Monaco, and the crash would only show up on the one path where the
/// same file is open as both a tab and a diff.

import { createEffect, on, onCleanup, onMount } from "solid-js";
import type * as Monaco from "monaco-editor";
import { inferLanguage, loadMonaco, SHARED_EDITOR_OPTIONS } from "./monaco";
import { applyVoidlinkTheme, monacoThemeName } from "./monacoTheme";
import { useTheme } from "@/store/theme";

let uriCounter = 0;

/// A scratch model URI nothing else can collide with.
function scratchUri(monaco: typeof Monaco, path: string, role: string): Monaco.Uri {
  uriCounter += 1;
  return monaco.Uri.parse(
    `voidlink-scratch://${role}/${uriCounter}/${encodeURIComponent(path)}`,
  );
}

/// Keep every pane in this window on the VoidLink themes, re-derived whenever
/// the app theme changes.
///
/// Monaco's theme registry and `setTheme` are both global, so this is
/// idempotent across panes — several diff tabs mounted at once all call it and
/// the last one wins with the same answer. Cheaper than a shared subscription,
/// and it keeps each pane's mount self-contained.
function useMonacoThemeSync(getMonaco: () => typeof Monaco | null) {
  const { mode, theme } = useTheme();
  createEffect(
    on(
      // `theme()` and not just `mode()`: switching monokai → dracula rewrites
      // every token without changing mode.
      () => [theme(), mode()] as const,
      ([, m]) => {
        const monaco = getMonaco();
        if (monaco) applyVoidlinkTheme(monaco, m);
      },
      { defer: true },
    ),
  );
}

export interface MonacoPaneProps {
  /// Full text to show. Replacing it rewrites the model in place rather than
  /// recreating the editor, so scroll position and folds survive an edit
  /// arriving from outside (an "accept theirs" click, say).
  text: string;
  /// Path the text belongs to — used only for syntax highlighting and the URI.
  path: string;
  readOnly?: boolean;
  /// Called on every local keystroke. Absent means the pane is display-only.
  onChange?: (text: string) => void;
  class?: string;
}

/// One editable (or read-only) buffer.
export function MonacoPane(props: MonacoPaneProps) {
  const { mode } = useTheme();
  let container!: HTMLDivElement;
  let monacoRef: typeof Monaco | null = null;
  let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  let model: Monaco.editor.ITextModel | null = null;
  /// Set while we push `props.text` into the model, so the resulting change
  /// event isn't mistaken for the user typing and echoed back to the parent.
  let applyingExternal = false;

  useMonacoThemeSync(() => monacoRef);

  onMount(async () => {
    const monaco = await loadMonaco();
    monacoRef = monaco;
    applyVoidlinkTheme(monaco, mode());
    model = monaco.editor.createModel(
      props.text,
      inferLanguage(props.path),
      scratchUri(monaco, props.path, props.readOnly ? "ro" : "rw"),
    );
    editor = monaco.editor.create(container, {
      ...SHARED_EDITOR_OPTIONS,
      model,
      theme: monacoThemeName(mode()),
      readOnly: props.readOnly ?? false,
      lineNumbers: "on",
    });
    const sub = model.onDidChangeContent(() => {
      if (applyingExternal || !model) return;
      props.onChange?.(model.getValue());
    });
    onCleanup(() => {
      sub.dispose();
      editor?.dispose();
      model?.dispose();
      editor = null;
      model = null;
      monacoRef = null;
    });
  });

  // Fold external text changes in without disturbing the viewport. `pushEditOperations`
  // rather than `setValue` so Monaco keeps the undo stack and the cursor.
  createEffect(
    on(
      () => props.text,
      (text) => {
        if (!model || model.getValue() === text) return;
        applyingExternal = true;
        try {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text }],
            () => null,
          );
        } finally {
          applyingExternal = false;
        }
      },
      { defer: true },
    ),
  );

  return <div ref={container} class={`w-full h-full overflow-hidden ${props.class ?? ""}`} />;
}

export interface MonacoDiffPaneProps {
  original: string;
  modified: string;
  path: string;
  /// `true` = two columns, `false` = unified inline. Driven by the store's
  /// `diffMode` so the toggle in the header means the same thing everywhere.
  sideBySide: boolean;
  ignoreWhitespace?: boolean;
  /// Whether the right-hand side accepts edits. Working-tree diffs are
  /// read-only here: editing a file belongs in its file tab, where the save
  /// path and dirty marker live.
  modifiedEditable?: boolean;
  onModifiedChange?: (text: string) => void;
  class?: string;
}

/// A side-by-side (or inline) diff of two texts.
export function MonacoDiffPane(props: MonacoDiffPaneProps) {
  const { mode } = useTheme();
  let container!: HTMLDivElement;
  let monacoRef: typeof Monaco | null = null;
  let editor: Monaco.editor.IStandaloneDiffEditor | null = null;
  let originalModel: Monaco.editor.ITextModel | null = null;
  let modifiedModel: Monaco.editor.ITextModel | null = null;
  let applyingExternal = false;

  useMonacoThemeSync(() => monacoRef);

  onMount(async () => {
    const monaco = await loadMonaco();
    monacoRef = monaco;
    applyVoidlinkTheme(monaco, mode());
    const language = inferLanguage(props.path);
    originalModel = monaco.editor.createModel(
      props.original,
      language,
      scratchUri(monaco, props.path, "original"),
    );
    modifiedModel = monaco.editor.createModel(
      props.modified,
      language,
      scratchUri(monaco, props.path, "modified"),
    );
    editor = monaco.editor.createDiffEditor(container, {
      ...SHARED_EDITOR_OPTIONS,
      theme: monacoThemeName(mode()),
      renderSideBySide: props.sideBySide,
      ignoreTrimWhitespace: props.ignoreWhitespace ?? false,
      readOnly: !props.modifiedEditable,
      originalEditable: false,
      renderOverviewRuler: false,
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });

    const sub = modifiedModel.onDidChangeContent(() => {
      if (applyingExternal || !modifiedModel) return;
      props.onModifiedChange?.(modifiedModel.getValue());
    });

    onCleanup(() => {
      sub.dispose();
      editor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
      editor = null;
      originalModel = null;
      modifiedModel = null;
      monacoRef = null;
    });
  });

  // Text updates replace model contents; the editor and its models persist so
  // the diff doesn't flash on every refetch.
  createEffect(
    on(
      () => [props.original, props.modified] as const,
      ([original, modified]) => {
        applyingExternal = true;
        try {
          if (originalModel && originalModel.getValue() !== original) {
            originalModel.setValue(original);
          }
          if (modifiedModel && modifiedModel.getValue() !== modified) {
            modifiedModel.setValue(modified);
          }
        } finally {
          applyingExternal = false;
        }
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => [props.sideBySide, props.ignoreWhitespace ?? false] as const,
      ([sideBySide, ignoreWhitespace]) => {
        editor?.updateOptions({ renderSideBySide: sideBySide, ignoreTrimWhitespace: ignoreWhitespace });
      },
      { defer: true },
    ),
  );

  return <div ref={container} class={`w-full h-full overflow-hidden ${props.class ?? ""}`} />;
}
