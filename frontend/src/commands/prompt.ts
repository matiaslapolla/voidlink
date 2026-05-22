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
let nextId = 1;

function openPrompt(opts: {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  toggles?: PromptToggle[];
}): Promise<PromptResult | null> {
  // Only one prompt at a time; if one is already open, cancel it first.
  const existing = request();
  if (existing) existing.resolve(null);
  return new Promise((resolve) => {
    setRequest({
      id: nextId++,
      title: opts.title,
      label: opts.label,
      placeholder: opts.placeholder,
      initialValue: opts.initialValue ?? "",
      confirmLabel: opts.confirmLabel ?? "OK",
      toggles: opts.toggles ?? [],
      resolve,
    });
  });
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
  setRequest(null);
  const trimmed = value?.trim();
  if (!trimmed) {
    r.resolve(null);
    return;
  }
  r.resolve({ value: trimmed, toggles: toggles ?? {} });
}
