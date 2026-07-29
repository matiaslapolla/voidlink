import { createSignal } from "solid-js";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "warning" | "error";
  ttlMs: number;
  /// Optional affordance rendered inside the toast — Retry on a failure, Undo
  /// on a reversible action (MASTER §7.5.5: "Undo beats confirm", and a
  /// failure toast with no way to act on it is just an obituary). Running it
  /// dismisses the toast.
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run: () => void;
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
