import { createEffect, on, onCleanup, createMemo } from "solid-js";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  lintKeymap,
  setDiagnostics,
  type Diagnostic as CmDiagnostic,
} from "@codemirror/lint";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { php } from "@codemirror/lang-php";
import { yaml } from "@codemirror/lang-yaml";

import { useTheme } from "@/store/theme";
import { useEditorSettings } from "@/store/editor-settings";
import {
  getDiagnosticsForFile,
  notifyFileOpened,
  detectLspServers,
  initialized as lspInitialized,
} from "@/store/lsp-state";
import { gitApi } from "@/api/git";

// ─── Language detection ─────────────────────────────────────────────────────

function langExtension(filePath: string): Extension {
  const name = filePath.split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return [];
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  switch (ext) {
    case "ts": case "mts": case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js": case "mjs": case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "rs": return rust();
    case "py": return python();
    case "json": case "jsonc": return json();
    case "html": case "htm": case "svelte": case "vue": return html();
    case "css": case "scss": case "less": return css();
    case "md": case "mdx": return markdown();
    case "xml": case "svg": return xml();
    case "sql": return sql();
    case "java": case "kt": case "kts": return java();
    case "c": case "cpp": case "cc": case "cxx": case "h": case "hpp": case "hxx": return cpp();
    case "go": return go();
    case "php": return php();
    case "yaml": case "yml": return yaml();
    default: return [];
  }
}

// ─── Git diff gutter marker ─────────────────────────────────────────────────

class DiffMarker extends GutterMarker {
  constructor(readonly changeType: string) { super(); }
  toDOM() {
    const el = document.createElement("div");
    el.style.width = "3px";
    el.style.height = "100%";
    el.style.marginLeft = "2px";
    el.style.borderRadius = "1px";
    if (this.changeType === "added") el.style.background = "#2ea043";
    else if (this.changeType === "modified") el.style.background = "#0078d4";
    else el.style.background = "#f85149";
    return el;
  }
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface CodeMirrorEditorProps {
  filePath: string;
  editBuffer: string;
  onEdit: (text: string) => void;
  onSave?: () => void;
  repoPath?: string | null;
  workspaceId?: string;
  scrollToLine?: number;
  readOnly?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CodeMirrorEditor(props: CodeMirrorEditorProps) {
  let view: EditorView | undefined;
  let suppressUpdate = false;

  const { mode } = useTheme();
  const editorSettings = useEditorSettings();

  // Compartments for dynamic reconfiguration
  const themeComp = new Compartment();
  const settingsComp = new Compartment();

  // Git diff data (read by gutter extension via closure)
  let diffMap = new Map<number, string>();

  const gitDiffGutter = gutter({
    class: "cm-git-diff-gutter",
    lineMarker: (v, line) => {
      const lineNo = v.state.doc.lineAt(line.from).number;
      const changeType = diffMap.get(lineNo);
      return changeType ? new DiffMarker(changeType) : null;
    },
    initialSpacer: () => {
      const el = document.createElement("div");
      el.style.width = "3px";
      return el;
    },
  });

  // Build theme: CSS-variable chrome + syntax highlighting
  const buildTheme = (): Extension => {
    const isDark = mode() === "dark";
    return [
      // Editor chrome — reads the app's CSS variables so every theme "just works"
      EditorView.theme(
        {
          "&": {
            backgroundColor: "var(--editor-bg)",
            color: "var(--foreground)",
          },
          "&.cm-focused": { outline: "none" },
          ".cm-content": { caretColor: "var(--foreground)" },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
          "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
            { backgroundColor: "var(--accent)" },
          ".cm-activeLine": {
            backgroundColor: "color-mix(in oklch, var(--accent) 50%, transparent)",
          },
          ".cm-selectionMatch": {
            backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)",
          },
          ".cm-matchingBracket, .cm-nonmatchingBracket": {
            backgroundColor: "color-mix(in oklch, var(--primary) 30%, transparent)",
            outline: "1px solid var(--border)",
          },
          ".cm-gutters": {
            backgroundColor: "var(--editor-gutter-bg)",
            color: "var(--editor-line-number)",
            borderRight: "1px solid var(--editor-border)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "transparent",
            color: "var(--editor-line-number-active)",
          },
          ".cm-foldPlaceholder": {
            backgroundColor: "var(--muted)",
            border: "none",
            color: "var(--muted-foreground)",
          },
          ".cm-tooltip": {
            backgroundColor: "var(--popover)",
            color: "var(--popover-foreground)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            boxShadow: "0 4px 12px oklch(0 0 0 / 0.3)",
          },
          ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
            backgroundColor: "var(--accent)",
            color: "var(--accent-foreground)",
          },
          ".cm-panels": {
            backgroundColor: "var(--popover)",
            color: "var(--popover-foreground)",
          },
          ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
          ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
          ".cm-search label": { fontSize: "inherit" },
          ".cm-textfield": {
            backgroundColor: "var(--input)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
          },
          ".cm-button": {
            backgroundImage: "none",
            backgroundColor: "var(--secondary)",
            color: "var(--secondary-foreground)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
          },
        },
        { dark: isDark },
      ),
      // Syntax highlighting
      isDark
        ? syntaxHighlighting(oneDarkHighlightStyle)
        : syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ];
  };

  const buildSettings = (): Extension => {
    const es = editorSettings();
    return EditorView.theme({
      "&": { height: "100%", fontSize: `${es.fontSize}px` },
      ".cm-content": {
        fontFamily: es.fontFamily,
        lineHeight: String(es.lineHeight),
        padding: "8px 0",
      },
      ".cm-gutters": {
        fontFamily: es.fontFamily,
        fontSize: `${es.fontSize}px`,
      },
      ".cm-scroller": { overflow: "auto" },
      ".cm-git-diff-gutter": { width: "7px" },
      ".cm-git-diff-gutter .cm-gutterElement": {
        padding: "0",
        minWidth: "7px",
      },
    });
  };

  // Create the editor via ref callback
  const initEditor = (el: HTMLDivElement) => {
    const state = EditorState.create({
      doc: props.editBuffer,
      extensions: [
        // Core
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        autocompletion(),

        // Gutters
        lineNumbers(),
        foldGutter(),
        gitDiffGutter,

        // Keymaps
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
          { key: "Mod-s", run: () => { props.onSave?.(); return true; } },
        ]),

        // Language
        langExtension(props.filePath),

        // Dynamic compartments
        themeComp.of(buildTheme()),
        settingsComp.of(buildSettings()),

        // Read-only
        EditorState.readOnly.of(props.readOnly ?? false),

        // Relay changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressUpdate) {
            props.onEdit(update.state.doc.toString());
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: el });

    // Initial scroll
    if (props.scrollToLine && props.scrollToLine > 0) {
      const lineNum = Math.min(props.scrollToLine, view.state.doc.lines);
      const pos = view.state.doc.line(lineNum).from;
      view.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }

    // Notify LSP
    if (props.repoPath) {
      if (!lspInitialized()) detectLspServers();
      notifyFileOpened(props.filePath, props.editBuffer, props.repoPath);
    }
  };

  onCleanup(() => view?.destroy());

  // ── External content sync (file reload / after save) ──────────────────

  createEffect(
    on(
      () => props.editBuffer,
      (buf) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current !== buf) {
          suppressUpdate = true;
          view.dispatch({
            changes: { from: 0, to: current.length, insert: buf },
          });
          suppressUpdate = false;
        }
      },
    ),
  );

  // ── Scroll to line ────────────────────────────────────────────────────

  createEffect(
    on(
      () => props.scrollToLine,
      (line) => {
        if (!view || !line || line <= 0) return;
        const lineNum = Math.min(line, view.state.doc.lines);
        const pos = view.state.doc.line(lineNum).from;
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
      },
    ),
  );

  // ── Theme sync ────────────────────────────────────────────────────────

  createEffect(
    on(mode, () => {
      view?.dispatch({ effects: themeComp.reconfigure(buildTheme()) });
    }),
  );

  // ── Editor settings sync ──────────────────────────────────────────────

  createEffect(
    on(editorSettings, () => {
      view?.dispatch({ effects: settingsComp.reconfigure(buildSettings()) });
    }),
  );

  // ── Git diff decorations ──────────────────────────────────────────────

  createEffect(
    on(
      () => [props.filePath, props.repoPath] as const,
      async ([filePath, repoPath]) => {
        if (!repoPath || !filePath) {
          diffMap = new Map();
          return;
        }
        try {
          const changes = await gitApi.diffFileLines(repoPath, filePath);
          diffMap = new Map(changes.map((c) => [c.line, c.changeType]));
          // Force gutter re-render by requesting a measure
          if (view) view.requestMeasure();
        } catch {
          diffMap = new Map();
        }
      },
    ),
  );

  // ── LSP diagnostics ──────────────────────────────────────────────────

  const diagnostics = createMemo(() => getDiagnosticsForFile(props.filePath));

  createEffect(
    on(diagnostics, (diags) => {
      if (!view) return;
      const cmDiags: CmDiagnostic[] = diags.map((d) => {
        const from = safePos(view!, d.range_start_line, d.range_start_char);
        const to = safePos(view!, d.range_end_line, d.range_end_char);
        return {
          from,
          to: Math.max(from, to),
          severity:
            d.severity === 1
              ? "error"
              : d.severity === 2
                ? "warning"
                : "info",
          message: d.message,
          source: d.source ?? undefined,
        };
      });
      view.dispatch(setDiagnostics(view.state, cmDiags));
    }),
  );

  return <div ref={initEditor} class="w-full h-full min-h-0 overflow-hidden" />;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safePos(view: EditorView, line: number, char: number): number {
  const lineCount = view.state.doc.lines;
  const ln = Math.min(Math.max(line + 1, 1), lineCount);
  const lineObj = view.state.doc.line(ln);
  return Math.min(lineObj.from + char, lineObj.to);
}
