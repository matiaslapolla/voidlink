import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Keyboard } from "lucide-solid";
import { closeCheatSheet, getAction, isCheatSheetOpen } from "@/commands/registry";
import {
  KEYMAP,
  KEYMAP_GROUPS,
  type BindingScope,
  type KeymapEntry,
  type KeymapGroup,
} from "@/commands/keymap";
import { shortcutLabels } from "@/commands/shortcuts";

/// The shortcuts cheat sheet.
///
/// Reads `KEYMAP` and nothing else, so it cannot go stale: adding a binding
/// adds a row here for free, and there is no second list to forget. Labels and
/// descriptions come from the live action registry, which is also where the
/// palette gets them.
export function ShortcutsCheatSheet() {
  return (
    <Show when={isCheatSheetOpen()}>
      <CheatSheetContent />
    </Show>
  );
}

interface Row {
  actionId: string;
  label: string;
  description?: string;
  scopeHint?: string;
  chords: string[];
  group: KeymapGroup;
}

/// Why a scoped binding sometimes doesn't fire. Worth surfacing here — "⌘S
/// didn't save while I was in the terminal" is otherwise a mystery.
const SCOPE_HINTS: Partial<Record<BindingScope, string>> = {
  "outside-terminal": "not while a terminal has focus",
  "outside-text-surfaces": "not while the editor or a terminal has focus",
};

function rowFor(entry: KeymapEntry): Row {
  const action = getAction(entry.actionId);
  return {
    actionId: entry.actionId,
    // An entry with no registered action is a bug the dev assertion shouts
    // about; here we degrade to the raw id rather than dropping the row, so
    // the problem is visible instead of invisible.
    label: action?.label ?? entry.actionId,
    description: action?.description,
    scopeHint: SCOPE_HINTS[entry.binding.scope ?? "global"],
    chords: shortcutLabels(entry.actionId),
    group: entry.group,
  };
}

function CheatSheetContent() {
  const [query, setQuery] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    queueMicrotask(() => inputRef?.focus());
  });

  const rows = createMemo<Row[]>(() => KEYMAP.map(rowFor));

  const filtered = createMemo<Row[]>(() => {
    const q = query().trim().toLowerCase();
    if (!q) return rows();
    return rows().filter((r) =>
      [r.label, r.group, r.description ?? "", r.scopeHint ?? "", ...r.chords]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  });

  const groups = createMemo(() =>
    KEYMAP_GROUPS.map((group) => ({
      group,
      rows: filtered().filter((r) => r.group === group),
    })).filter((g) => g.rows.length > 0),
  );

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCheatSheet();
    }
  }

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[var(--z-overlay)] flex items-start justify-center pt-[10vh] bg-black/40"
        onClick={closeCheatSheet}
        onKeyDown={onKeyDown}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cheat-sheet-title"
          class="w-[640px] max-w-[92vw] max-h-[80vh] material-structural border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Keyboard class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <h2 id="cheat-sheet-title" class="text-title font-semibold shrink-0">
              Keyboard shortcuts
            </h2>
            <input
              ref={inputRef}
              type="text"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Filter shortcuts…"
              aria-label="Filter shortcuts"
              class="flex-1 min-w-0 bg-transparent border-0 outline-none text-title placeholder:text-muted-foreground"
            />
            <span class="text-micro text-muted-foreground/70 shrink-0">Esc to close</span>
          </div>

          <div class="flex-1 overflow-y-auto scrollbar-thin px-3 py-2">
            <Show
              when={groups().length > 0}
              fallback={
                <div class="px-3 py-6 text-center text-body text-muted-foreground">
                  No matching shortcuts
                </div>
              }
            >
              <For each={groups()}>
                {(g) => (
                  <section class="mb-3 last:mb-0">
                    <h3 class="text-label font-medium text-muted-foreground/80 py-1">
                      {g.group}
                    </h3>
                    <div class="rounded border border-border/60 divide-y divide-border/40">
                      <For each={g.rows}>{(row) => <CheatRow row={row} />}</For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>

          <div class="px-3 py-2 border-t border-border text-label text-muted-foreground leading-snug">
            The platform modifier is ⌘ on macOS and Ctrl elsewhere; voidlink
            accepts either. A few bindings stand down while the editor or a
            terminal has focus, so they never swallow a key those need — those
            say so under the action name.
          </div>
        </div>
      </div>
    </Portal>
  );
}

function CheatRow(props: { row: Row }) {
  return (
    <div class="flex items-center gap-3 px-2.5 py-1.5 text-ui">
      <span class="flex-1 min-w-0 text-foreground/90">
        <span class="block truncate">
          {props.row.label}
          <Show when={props.row.description}>
            {(d) => (
              <span class="ml-2 text-label text-muted-foreground/80">· {d()}</span>
            )}
          </Show>
        </span>
        <Show when={props.row.scopeHint}>
          {(hint) => (
            <span class="block text-micro text-muted-foreground/70 leading-tight">
              {hint()}
            </span>
          )}
        </Show>
      </span>
      <span class="flex items-center gap-1.5 shrink-0">
        <For each={props.row.chords}>
          {(chord) => (
            <kbd class="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-label font-mono text-foreground/80">
              {chord}
            </kbd>
          )}
        </For>
      </span>
    </div>
  );
}
