import { createSignal } from "solid-js";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "warning" | "error";
  ttlMs: number;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export function pushToast(
  message: string,
  kind: Toast["kind"] = "info",
  ttlMs = 3500,
) {
  const id = nextId++;
  setToasts((cur) => [...cur, { id, message, kind, ttlMs }]);
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
