import { createSignal } from "solid-js";

// In-app text prompt. macOS WKWebView silently returns null from
// `window.prompt()`, so anything that needs a typed value (branch name,
// snapshot name, …) routes through here instead. Mirrors the toast pattern:
// a module-level signal drives a single host mounted at the app root.

export interface PromptToggle {
  key: string;
  label: string;
  default?: boolean;
}

export interface PromptResult {
  value: string;
  toggles: Record<string, boolean>;
}

export interface PromptRequest {
  id: number;
  title: string;
  label?: string;
  placeholder?: string;
  initialValue: string;
  confirmLabel: string;
  toggles: PromptToggle[];
  resolve: (result: PromptResult | null) => void;
}

const [request, setRequest] = createSignal<PromptRequest | null>(null);
/// Requests waiting for the host, oldest first.
const queue: PromptRequest[] = [];
let nextId = 1;

/// Ask for a value, queueing behind any prompt already on screen.
///
/// This used to *cancel* the open prompt and replace it. One prompt at a time is
/// right — two dialogs over one host is not a thing — but cancelling the existing
/// one silently aborted whatever multi-step flow it belonged to: "Add remote"
/// asks for a name and then a URL, an annotated tag asks for a name and then a
/// message, and any prompt raised from another pane in between killed the flow
/// mid-way with no error and no explanation. Queueing keeps every caller's
/// promise honest; the user answers them in order.
function openPrompt(opts: {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  toggles?: PromptToggle[];
}): Promise<PromptResult | null> {
  return new Promise((resolve) => {
    const entry: PromptRequest = {
      id: nextId++,
      title: opts.title,
      label: opts.label,
      placeholder: opts.placeholder,
      initialValue: opts.initialValue ?? "",
      confirmLabel: opts.confirmLabel ?? "OK",
      toggles: opts.toggles ?? [],
      resolve,
    };
    if (request()) queue.push(entry);
    else setRequest(entry);
  });
}

/// Show the next queued prompt, if any.
function advance() {
  setRequest(queue.shift() ?? null);
}

/// Ask the user for a string. Resolves with the trimmed value, or `null` if
/// they cancel (Escape / backdrop / cancel button) or submit it empty.
export function textPrompt(opts: {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return openPrompt(opts).then((r) => (r ? r.value : null));
}

/// Like `textPrompt`, but also surfaces a set of boolean toggles (checkboxes)
/// alongside the input. Resolves with `{ value, toggles }` or `null`.
export function promptWithToggles(opts: {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  toggles: PromptToggle[];
}): Promise<PromptResult | null> {
  return openPrompt(opts);
}

export function usePrompt() {
  return { request };
}

/// Settle the active prompt. `value` is the raw input on confirm, or `null`
/// on cancel; empty/whitespace strings resolve as `null`. `toggles` carries
/// the final checkbox states.
export function resolvePrompt(value: string | null, toggles?: Record<string, boolean>) {
  const r = request();
  if (!r) return;
  advance();
  const trimmed = value?.trim();
  if (!trimmed) {
    r.resolve(null);
    return;
  }
  r.resolve({ value: trimmed, toggles: toggles ?? {} });
}

/// Cancel everything, including anything queued. For a window teardown — a
/// pending promise whose host is gone would never settle.
export function cancelAllPrompts() {
  const active = request();
  setRequest(null);
  const pending = queue.splice(0, queue.length);
  active?.resolve(null);
  for (const p of pending) p.resolve(null);
}
