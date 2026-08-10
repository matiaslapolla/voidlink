/// The settings dialog's row primitives.
///
/// Extracted from `SettingsDialog.tsx` when the agent roster grew a form of its
/// own and moved to its own file: two panes needed the same label column, the
/// same indent and the same four row shapes, and the alternative was either a
/// duplicate set that would drift or an import cycle between the dialog and a
/// pane it renders.
import { For, Show, type JSX } from "solid-js";

/// The label column, and the indent that has to line up with it.
///
/// Every row in this dialog is `flex gap-3` with a fixed-width label cell, and
/// two places in the AI pane annotate a row by indenting a sibling to match.
/// Those were hand-written as `pl-28` against a `w-28` label — which is short
/// by exactly the `gap-3` between them, so the commit-preset buttons and the
/// fallback-command hint sat 12px to the left of the input they belong to.
/// Deriving the indent from the column is what stops the two drifting again.
///
/// `break-words` rather than `truncate`: the label is the only thing telling a
/// user what a control does, and silently clipping it at the `xl` text size is
/// worse than a row that grows a line. `shrink-0` is what keeps a long label
/// from taking width from the control instead.
export const LABEL_COL = "w-28 shrink-0 break-words";
/// `w-28` + `gap-3`, as a value rather than as a number to remember.
export const LABEL_INDENT = "pl-[calc(7rem+0.75rem)]";

export function Section(props: { title: string; tone?: "warning"; children: JSX.Element }) {
  return (
    <section>
      <h3
        class={`ui-section-label mb-2 ${props.tone === "warning" ? "text-warning" : ""}`}
        style={{ transition: "color var(--dur-short) var(--ease-in-out)" }}
      >
        {props.title}
      </h3>
      <div class="space-y-3">{props.children}</div>
    </section>
  );
}

/// `labelCell` replaces the whole label column rather than its text.
///
/// The schema-driven editor pane needs a modified dot, a highlighted match and
/// a per-setting reset in that column; every other pane passes a plain string
/// and gets exactly what it always got. One set of controls, two callers.
export function SliderRow(props: {
  label: string;
  labelCell?: JSX.Element;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      {props.labelCell ?? <span class={`${LABEL_COL} text-muted-foreground`} title={props.label}>{props.label}</span>}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
        class="flex-1 accent-primary"
      />
      <span class="w-24 text-right tabular-nums text-foreground/80 shrink-0">
        {props.format(props.value)}
      </span>
    </div>
  );
}

export function ToggleRow(props: {
  label: string;
  labelCell?: JSX.Element;
  value: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      {props.labelCell ?? (
        <div class={LABEL_COL} title={props.label}>
          <div class="text-muted-foreground">{props.label}</div>
          <Show when={props.hint}>
            <div class="text-micro text-muted-foreground/70 leading-tight">{props.hint}</div>
          </Show>
        </div>
      )}
      <button
        onClick={() => props.onChange(!props.value)}
        class={`px-3 py-1 rounded-full border text-label transition-colors ${
          props.value
            ? "bg-primary/15 border-primary/40 text-primary"
            : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
        }`}
      >
        {props.value ? "On" : "Off"}
      </button>
    </div>
  );
}

export function TextRow(props: {
  label: string;
  labelCell?: JSX.Element;
  value: string;
  placeholder?: string;
  onInput: (v: string) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      {props.labelCell ?? <span class={`${LABEL_COL} text-muted-foreground`} title={props.label}>{props.label}</span>}
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        // The label beside it is a `<span>`, not a `<label>` — the rows predate
        // the `labelCell` escape hatch and a real `for`/`id` pair would need an
        // id per row. Naming the control directly is the same promise to a
        // screen reader with none of that bookkeeping (§10.6).
        aria-label={props.label}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
    </div>
  );
}

export function SegmentedRow<T extends string>(props: {
  label: string;
  labelCell?: JSX.Element;
  value: T;
  hint?: string;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      {props.labelCell ?? (
        <div class={LABEL_COL} title={props.label}>
          <div class="text-muted-foreground">{props.label}</div>
          <Show when={props.hint}>
            <div class="text-micro text-muted-foreground/70 leading-tight">{props.hint}</div>
          </Show>
        </div>
      )}
      <div class="flex-1 flex gap-1">
        <For each={props.options}>
          {(opt) => (
            <button
              onClick={() => props.onChange(opt.id)}
              class={`flex-1 px-2 py-1 rounded border text-label transition-colors ${
                props.value === opt.id
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
              }`}
            >
              {opt.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

