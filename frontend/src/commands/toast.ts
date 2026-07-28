import { createSignal } from "solid-js";

/// An affordance rendered inside the toast. MASTER.md §7.5.5: a transient
/// notice for a failure carries Retry, and one for a reversible effect carries
/// Undo — a toast that only says what went wrong makes the user go and find the
/// control again. Invoking it dismisses the toast.
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "warning" | "error";
  ttlMs: number;
  action?: ToastAction;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export function pushToast(
  message: string,
  kind: Toast["kind"] = "info",
  ttlMs = 3500,
  action?: ToastAction,
) {
  const id = nextId++;
  setToasts((cur) => [...cur, { id, message, kind, ttlMs, action }]);
  window.setTimeout(() => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, ttlMs);
  return id;
}

export function dismissToast(id: number) {
  setToasts((cur) => cur.filter((t) => t.id !== id));
}

export function useToasts() {
  return { toasts };
}
