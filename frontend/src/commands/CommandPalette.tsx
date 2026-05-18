import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Search } from "lucide-solid";
import {
  type Action,
  closePalette,
  getActions,
  isPaletteOpen,
} from "@/commands/registry";

function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  // Direct substring: strong score, prefer earlier match.
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;
  // Character-in-order fallback (subsequence). Score by gaps.
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score -= found - ti;
    ti = found + 1;
  }
  return 100 + score;
}

export function CommandPalette() {
  return (
    <Show when={isPaletteOpen()}>
      <PaletteContent />
    </Show>
  );
}

function PaletteContent() {
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    queueMicrotask(() => inputRef?.focus());
  });

  const filtered = createMemo<Array<Action & { score: number }>>(() => {
    const q = query();
    const list = getActions();
    if (!q.trim()) {
      return list.map((a) => ({ ...a, score: 0 }));
    }
    return list
      .map((a) => {
        const labelScore = fuzzyScore(a.label, q);
        const groupScore = a.group ? fuzzyScore(a.group, q) : -1;
        return { ...a, score: Math.max(labelScore, groupScore) };
      })
      .filter((a) => a.score >= 0)
      .sort((a, b) => b.score - a.score);
  });

  function runAt(index: number) {
    const list = filtered();
    const action = list[index];
    if (!action) return;
    if (action.enabled && !action.enabled()) return;
    closePalette();
    void action.run();
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(list.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(highlight());
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  }

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[80] flex items-start justify-center pt-[12vh] bg-black/40"
        onClick={closePalette}
      >
        <div
          class="w-[520px] max-w-[92vw] bg-popover border border-border rounded-lg shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search actions…"
              class="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
            />
            <span class="text-[10px] text-muted-foreground/70 tracking-wide">ESC</span>
          </div>
          <div class="max-h-[60vh] overflow-y-auto scrollbar-thin py-1">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-3 py-6 text-center text-xs text-muted-foreground">
                  No matching actions
                </div>
              }
            >
              <For each={filtered()}>
                {(action, i) => (
                  <PaletteRow
                    action={action}
                    highlighted={highlight() === i()}
                    onClick={() => runAt(i())}
                    onMouseEnter={() => setHighlight(i())}
                  />
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function PaletteRow(props: {
  action: Action;
  highlighted: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const disabled = () => props.action.enabled && !props.action.enabled();
  return (
    <button
      onClick={props.onClick}
      onMouseEnter={props.onMouseEnter}
      disabled={disabled()}
      class={`w-full flex items-center gap-3 px-3 py-1.5 text-left text-[13px] transition-colors ${
        props.highlighted ? "bg-accent/70 text-foreground" : "text-muted-foreground"
      } ${disabled() ? "opacity-40" : "hover:bg-accent/40 hover:text-foreground"}`}
    >
      <Show when={props.action.group}>
        {(g) => (
          <span class="text-[10px] uppercase tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
            {g()}
          </span>
        )}
      </Show>
      <span class="flex-1 truncate">
        {props.action.label}
        <Show when={props.action.description}>
          {(d) => (
            <span class="ml-2 text-[11px] text-muted-foreground/80">· {d()}</span>
          )}
        </Show>
      </span>
      <Show when={props.action.shortcutLabel}>
        {(s) => (
          <span class="text-[10px] text-muted-foreground/70 font-mono tracking-wide">
            {s()}
          </span>
        )}
      </Show>
    </button>
  );
}
