/// The breadcrumb row above an editor group: where the file is, and what you
/// are inside of.
///
/// Deliberately not Monaco's breadcrumb widget. MASTER §11.5 names Monaco-drift
/// as this module's identity risk, and the breadcrumb is where it would start —
/// so this uses the app's own row and label idiom (§4, §9.2) at `text-micro`,
/// `--muted-foreground` at rest with `--foreground` on the segment you are
/// actually in.
///
/// Nothing here animates. The row changes on every file open and every cursor
/// move across a symbol boundary, which is hundreds of times a session and all
/// of it keyboard-initiated — MASTER §7.1 budgets that at 0ms, and a breadcrumb
/// that fades on file switch is a fade the user is waiting through.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronRight } from "lucide-solid";
import type * as Monaco from "monaco-editor";
import { editorController } from "./editorController";
import { documentOutline } from "./documentSymbols";
import { symbolChainAt, type OutlineNode } from "./outline";
import type { GroupId } from "./editorGroups";

export interface BreadcrumbsProps {
  groupId: GroupId;
  /// Absolute path of the file this group is showing, or `null`.
  path: () => string | null;
  /// Repository root, so the path renders relative to it rather than from `/`.
  repoRoot: () => string | null;
  /// Open the go-to-symbol picker. What the file segment does.
  onGoToSymbol: () => void;
}

/// Recompute the outline this long after the last keystroke. Long enough that
/// typing a function body does not re-parse per character, short enough that
/// the crumb is right by the time you look at it.
const REPARSE_DELAY_MS = 300;

export function Breadcrumbs(props: BreadcrumbsProps) {
  const [chain, setChain] = createSignal<OutlineNode[]>([]);

  let outline: OutlineNode[] = [];
  let boundEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
  let boundModel: Monaco.editor.ITextModel | null = null;
  let listeners: Monaco.IDisposable[] = [];
  let reparseTimer: ReturnType<typeof setTimeout> | null = null;
  let outlineToken = 0;

  function updateChain() {
    const line = boundEditor?.getPosition()?.lineNumber ?? 1;
    setChain(symbolChainAt(outline, line));
  }

  async function reparse() {
    const monaco = editorController.getMonaco();
    const model = boundModel;
    if (!monaco || !model) {
      outline = [];
      updateChain();
      return;
    }
    // A provider can be async (a language server, once Wave 5 lands), so a
    // slow answer for the file you just left must not overwrite the fast answer
    // for the one you are in.
    const token = ++outlineToken;
    const next = await documentOutline(monaco, model);
    if (token !== outlineToken || model !== boundModel) return;
    outline = next;
    updateChain();
  }

  function scheduleReparse() {
    if (reparseTimer !== null) clearTimeout(reparseTimer);
    reparseTimer = setTimeout(() => {
      reparseTimer = null;
      void reparse();
    }, REPARSE_DELAY_MS);
  }

  function unbind() {
    for (const d of listeners) d.dispose();
    listeners = [];
  }

  /// Re-attach to whatever this group currently holds. Driven by the
  /// controller's change notifications rather than by props alone, because the
  /// editor instance itself appears asynchronously (Monaco is a dynamic import)
  /// and can be replaced when a group is closed and reopened.
  function sync() {
    const editor = editorController.getEditor(props.groupId);
    const model = editor?.getModel() ?? null;
    if (editor === boundEditor && model === boundModel) return;
    unbind();
    boundEditor = editor;
    boundModel = model;
    outline = [];
    setChain([]);
    if (!editor) return;
    listeners.push(editor.onDidChangeCursorPosition(() => updateChain()));
    if (model) listeners.push(model.onDidChangeContent(() => scheduleReparse()));
    void reparse();
  }

  onMount(() => {
    sync();
    const unsub = editorController.subscribe(() => sync());
    onCleanup(() => {
      unsub();
      unbind();
      if (reparseTimer !== null) clearTimeout(reparseTimer);
    });
  });

  /// Path segments, relative to the repo root when the file is inside it.
  const segments = () => {
    const path = props.path();
    if (!path) return [];
    const root = props.repoRoot();
    const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    return rel.split("/").filter(Boolean);
  };

  const dirs = () => segments().slice(0, -1);
  const fileName = () => segments()[segments().length - 1] ?? null;

  return (
    <Show when={props.path()}>
      <nav
        aria-label="Editor breadcrumbs"
        class="shrink-0 flex items-center gap-0.5 h-6 px-2 border-b border-border/60 bg-background text-micro text-muted-foreground overflow-x-auto scrollbar-thin whitespace-nowrap"
      >
        {/* Directory segments are labels, not controls. This window has no
            folder view and no scoped file finder, so a directory has nothing to
            navigate *to* — and a button that does nothing, or a disabled one
            with no stated reason, is the anti-pattern MASTER §7.6 names. They
            become buttons the day there is somewhere for them to go. */}
        <For each={dirs()}>
          {(dir) => (
            <>
              <span class="shrink-0 max-w-[160px] truncate px-1">{dir}</span>
              <Separator />
            </>
          )}
        </For>

        <Show when={fileName()}>
          {(name) => (
            <Crumb
              label={name()}
              mono
              current={chain().length === 0}
              title="Go to symbol in this file"
              onClick={props.onGoToSymbol}
            />
          )}
        </Show>

        <For each={chain()}>
          {(node, i) => (
            <>
              <Separator />
              <Crumb
                label={node.name}
                mono
                current={i() === chain().length - 1}
                title={`Go to ${node.name}`}
                onClick={() => editorController.revealPosition(node.line, node.column)}
              />
            </>
          )}
        </For>
      </nav>
    </Show>
  );
}

function Separator() {
  return <ChevronRight aria-hidden="true" class="w-3 h-3 shrink-0 opacity-40" />;
}

/// One segment. A `<button>` and not a div, per MASTER §10.2 — every segment
/// here has a real target, so none of them is a label pretending to be a
/// control. No transition: see the module note.
function Crumb(props: {
  label: string;
  title: string;
  onClick: () => void;
  mono?: boolean;
  /// The segment the cursor is actually in. `--foreground` against the rest of
  /// the row's `--muted-foreground`.
  current?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      class="shrink-0 max-w-[220px] truncate px-1 rounded hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      classList={{
        "font-mono": props.mono,
        "text-foreground": props.current,
      }}
    >
      {props.label}
    </button>
  );
}
