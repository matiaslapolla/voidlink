/// The overlay chrome every fuzzy picker in voidlink wears, and the one
/// highlight treatment they all use.
///
/// `FileFinder.tsx` grew this first — Portal, scrim, a rounded popover with a
/// search row, an ESC hint, a scrolling list and arrow-key navigation. The
/// command palette had its own near-copy, and Wave 3 adds two switchers. Four
/// implementations of the same box is how they drift, so this is that box,
/// once, generic over what a row holds.
///
/// **Nothing here animates.** Every one of these surfaces is opened by a chord
/// and dismissed by one, dozens of times a session — MASTER.md §7.1 puts that
/// at 0ms, and §11 lists "animating a keyboard-initiated transition" as an
/// anti-pattern. The only `transition` in this file is the rows' hover tint,
/// which is pointer-initiated and pinned to `--dur-tint` by `index.css`.
import { For, Show, createEffect, createSignal, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Search } from "lucide-solid";
import type { MatchRange } from "@/commands/fuzzy";

export interface QuickPickProps<T> {
  /// Rows, already filtered and ranked by the caller.
  items: T[];
  /// Stable identity per row. Stamped on the row element as `data-qp-key` — a
  /// picker's rows are otherwise indistinguishable in the DOM, which makes both
  /// a failing test and a bug report harder to read than they need to be.
  itemKey: (item: T) => string;
  renderItem: (item: T, highlighted: () => boolean) => JSX.Element;
  onPick: (item: T) => void;
  onClose: () => void;
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  /// Accessible name for the input — §10.6 asks for a real label, and a
  /// placeholder is not one.
  label: string;
  /// Rendered in place of the list when `items` is empty. §9.7 wants a distinct
  /// icon and sentence per reason, so each caller writes its own.
  empty: JSX.Element;
  /// Shown instead of `empty` while the caller is still fetching.
  loading?: boolean;
  loadingLabel?: string;
  /// Extra control in the search row (the file finder's ignored-files toggle).
  headerTrailing?: JSX.Element;
  /// Fixed footer, for a hint line under the list.
  footer?: JSX.Element;
  /// Popover width. Defaults to the file finder's.
  width?: string;
  /// Keys the caller wants first refusal on, before the list's own handling.
  /// Return `true` to say "handled".
  onKeyDown?: (e: KeyboardEvent) => boolean | void;
}

export function QuickPick<T>(props: QuickPickProps<T>) {
  const [highlight, setHighlight] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;

  onMount(() => queueMicrotask(() => inputRef?.focus()));

  /// A shorter result list must never leave the highlight past the end — the
  /// next Enter would open nothing and read as a dead key.
  createEffect(() => {
    const max = Math.max(0, props.items.length - 1);
    if (highlight() > max) setHighlight(max);
  });

  /// Keep the highlighted row in view during keyboard navigation. `"instant"`,
  /// not smooth: this is a keyboard-initiated movement (§7.1).
  function reveal(index: number) {
    const row = listRef?.querySelector<HTMLElement>(`[data-qp-index="${index}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }

  function move(delta: number) {
    const max = props.items.length - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, highlight() + delta));
    setHighlight(next);
    reveal(next);
  }

  function pick(index: number) {
    const item = props.items[index];
    if (item === undefined) return;
    props.onPick(item);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (props.onKeyDown?.(e) === true) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setHighlight(0);
        reveal(0);
        break;
      case "End":
        e.preventDefault();
        move(props.items.length);
        break;
      case "Enter":
        e.preventDefault();
        pick(highlight());
        break;
      case "Escape":
        e.preventDefault();
        props.onClose();
        break;
    }
  }

  const listId = `quickpick-list-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[var(--z-overlay)] flex items-start justify-center pt-[12vh] bg-black/40"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          class={`${props.width ?? "w-[560px]"} max-w-[92vw] material-structural border border-border rounded-lg shadow-xl flex flex-col overflow-hidden`}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-label={props.label}
              autocomplete="off"
              spellcheck={false}
              value={props.query}
              onInput={(e) => {
                props.onQuery(e.currentTarget.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={props.placeholder}
              class="flex-1 bg-transparent border-0 outline-none text-title placeholder:text-muted-foreground"
            />
            {props.headerTrailing}
            <span class="text-micro text-muted-foreground/70 tracking-wide">ESC</span>
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={props.label}
            class="max-h-[60vh] overflow-y-auto scrollbar-thin py-1"
          >
            <Show when={props.loading}>
              <div class="px-3 py-6 text-center text-body text-muted-foreground">
                {props.loadingLabel ?? "Loading…"}
              </div>
            </Show>
            <Show when={!props.loading && props.items.length === 0}>{props.empty}</Show>
            <For each={props.items}>
              {(item, i) => (
                <div
                  data-qp-index={i()}
                  data-qp-key={props.itemKey(item)}
                  role="option"
                  aria-selected={highlight() === i()}
                  onMouseEnter={() => setHighlight(i())}
                  onClick={() => pick(i())}
                >
                  {props.renderItem(item, () => highlight() === i())}
                </div>
              )}
            </For>
          </div>
          <Show when={props.footer}>
            <div class="px-3 py-1.5 border-t border-border text-micro text-muted-foreground">
              {props.footer}
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

/// One row's shell: the nine states of §7.6 in one place, so a picker row in
/// the palette and one in a switcher cannot disagree about what focused looks
/// like. `border-width`, `padding` and `height` are constant across every state
/// — only the background and text colour move.
export function QuickPickRow(props: {
  highlighted: boolean;
  disabled?: boolean;
  /// Required when `disabled` — §7.6 forbids a disabled control with no stated
  /// reason.
  disabledReason?: string;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-disabled={props.disabled ? "true" : undefined}
      title={props.disabled ? props.disabledReason : undefined}
      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-ui border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
      classList={{
        "bg-accent/70 text-foreground": props.highlighted && !props.disabled,
        "text-muted-foreground": !props.highlighted,
        "opacity-40 cursor-not-allowed": !!props.disabled,
        "hover:bg-accent/40 hover:text-foreground": !props.disabled,
      }}
    >
      {props.children}
    </button>
  );
}

/// `text` with its matched characters tinted. One treatment — `bg-primary/15`,
/// the app's "this one is active" idiom (§11.5) — shared by the palette, the
/// file finder and both switchers.
export function FuzzyText(props: {
  text: string;
  ranges?: MatchRange[];
  class?: string;
}) {
  const parts = () => {
    const ranges = props.ranges ?? [];
    if (ranges.length === 0) return [{ text: props.text, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) out.push({ text: props.text.slice(cursor, start), hit: false });
      out.push({ text: props.text.slice(start, end), hit: true });
      cursor = end;
    }
    if (cursor < props.text.length) out.push({ text: props.text.slice(cursor), hit: false });
    return out;
  };
  return (
    <span class={props.class}>
      <For each={parts()}>
        {(part) => (
          <Show when={part.hit} fallback={part.text}>
            <span class="bg-primary/15 text-primary rounded-[2px]">{part.text}</span>
          </Show>
        )}
      </For>
    </span>
  );
}

/// The §9.7 empty state, as the pickers render it: a Lucide icon at `w-5 h-5`,
/// one line naming *why* it is empty, and — where one exists — the action that
/// fixes it as a real accelerator rather than prose.
export function QuickPickEmpty(props: {
  icon: JSX.Element;
  message: string;
  hint?: string;
}) {
  return (
    <div class="px-3 py-8 flex flex-col items-center gap-2 text-center text-muted-foreground">
      <span class="opacity-60">{props.icon}</span>
      <p class="text-body">{props.message}</p>
      <Show when={props.hint}>
        {(h) => <p class="text-label text-muted-foreground/70">{h()}</p>}
      </Show>
    </div>
  );
}
