/// Go to symbol in the active file (⇧⌘O).
///
/// Modelled on `commands/FileFinder.tsx` down to the geometry, ranking and key
/// handling, because a second quick-open that behaves differently from the
/// first is a worse feature than not having it. The two share `fuzzy.ts`; what
/// differs is only where the rows come from.
///
/// Not Monaco's `editor.action.quickOutline`: that widget brings Monaco's own
/// list chrome, which is exactly the drift MASTER §11.5 warns about for this
/// module. The symbols underneath are the same ones — see `documentSymbols.ts`.
///
/// No motion. It opens on a chord and closes on a chord (MASTER §7.1).

import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  Braces,
  Box,
  Hash,
  Package,
  Search,
  SquareFunction,
  Type,
  Variable,
  type LucideProps,
} from "lucide-solid";
import type { Component } from "solid-js";
import { fuzzyScore } from "@/commands/fuzzy";
import { editorController } from "./editorController";
import { documentOutline } from "./documentSymbols";
import { flattenOutline, type OutlineKind, type OutlineNode } from "./outline";

/// One row: the symbol, how deep it sits, and the containers above it.
type Row = { node: OutlineNode; depth: number; container: string[] };

const KIND_ICONS: Record<OutlineKind, Component<LucideProps>> = {
  class: Box,
  struct: Box,
  interface: Type,
  enum: Braces,
  function: SquareFunction,
  method: SquareFunction,
  module: Package,
  constant: Variable,
  variable: Variable,
  section: Hash,
};

export function GoToSymbol(props: { open: () => boolean; onClose: () => void }) {
  return (
    <Show when={props.open()}>
      <SymbolPicker onClose={props.onClose} />
    </Show>
  );
}

function SymbolPicker(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  // Read once per open. The buffer cannot change underneath a modal the user is
  // typing into, and re-parsing on every keystroke would be work with no
  // possible different answer.
  const [symbols] = createResource<Row[]>(async () => {
    const monaco = editorController.getMonaco();
    const model = editorController.getEditor()?.getModel() ?? null;
    if (!monaco || !model) return [];
    return flattenOutline(await documentOutline(monaco, model));
  });

  onMount(() => queueMicrotask(() => inputRef?.focus()));

  const ranked = createMemo<Row[]>(() => {
    const list = symbols() ?? [];
    const q = query().trim();
    if (!q) return list;
    return list
      .map((row) => ({ row, score: fuzzyScore(`${row.container.join(".")}.${row.node.name}`, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.row);
  });

  function go(index: number) {
    const row = ranked()[index];
    if (!row) return;
    props.onClose();
    editorController.revealPosition(row.node.line, row.node.column);
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = ranked();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(list.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(highlight());
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  /// The scope line under the empty state. Names the file and says *why* there
  /// is nothing, rather than a bare "No results" (MASTER §9.7).
  const emptyReason = () => {
    const path = editorController.getActivePath();
    if (!path) return "No file is open.";
    const name = path.split("/").pop() ?? path;
    if (query().trim()) return `No symbol matching “${query().trim()}” in ${name}.`;
    return `No symbols found in ${name}. VoidLink outlines TypeScript, JavaScript, Rust, Go, Python and Markdown until a language server is configured.`;
  };

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[80] flex items-start justify-center pt-[12vh] bg-black/40"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-label="Go to symbol"
          class="w-[560px] max-w-[92vw] bg-popover border border-border rounded-lg shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <label for="goto-symbol-query" class="sr-only">
              Go to symbol in the active file
            </label>
            <input
              id="goto-symbol-query"
              ref={inputRef}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Go to symbol…"
              class="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
            />
            <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {ranked().length}
            </span>
          </div>

          <div class="max-h-[50vh] overflow-y-auto scrollbar-thin py-1">
            <Show
              when={ranked().length > 0}
              fallback={
                <p class="px-3 py-3 text-[11px] text-muted-foreground">{emptyReason()}</p>
              }
            >
              <For each={ranked()}>
                {(row, i) => {
                  const Icon = KIND_ICONS[row.node.kind];
                  return (
                    <button
                      type="button"
                      onClick={() => go(i())}
                      onMouseEnter={() => setHighlight(i())}
                      class="w-full flex items-center gap-2 px-3 py-1 text-left text-[12px]"
                      classList={{
                        "bg-primary/15 text-primary": i() === highlight(),
                        "text-foreground": i() !== highlight(),
                      }}
                    >
                      <Icon class="w-3 h-3 shrink-0 opacity-70" />
                      <span
                        class="font-mono truncate"
                        style={{ "padding-left": `${row.depth * 10}px` }}
                      >
                        {row.node.name}
                      </span>
                      <Show when={row.node.detail}>
                        <span class="font-mono text-[10px] text-muted-foreground truncate">
                          {row.node.detail}
                        </span>
                      </Show>
                      <span class="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {row.node.line}
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
