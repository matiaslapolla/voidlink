import { For } from "solid-js";
import { Portal } from "solid-js/web";
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-solid";
import { dismissToast, useToasts, type Toast } from "@/commands/toast";

export function ToastViewport() {
  const { toasts } = useToasts();
  return (
    <Portal>
      <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        <For each={toasts()}>
          {(t) => <ToastRow toast={t} />}
        </For>
      </div>
    </Portal>
  );
}

function ToastRow(props: { toast: Toast }) {
  const Icon = () => {
    switch (props.toast.kind) {
      case "success":
        return <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" />;
      case "warning":
        return <AlertTriangle class="w-3.5 h-3.5 text-warning shrink-0" />;
      case "error":
        return <XCircle class="w-3.5 h-3.5 text-destructive shrink-0" />;
      default:
        return <Info class="w-3.5 h-3.5 text-info shrink-0" />;
    }
  };
  return (
    <div class="pointer-events-auto min-w-[240px] max-w-[420px] bg-popover border border-border rounded-md shadow-lg px-3 py-2 flex items-start gap-2 text-xs">
      <Icon />
      <span class="flex-1 leading-snug">{props.toast.message}</span>
      <button
        onClick={() => dismissToast(props.toast.id)}
        aria-label="Dismiss"
        class="p-0.5 rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <X class="w-3 h-3" />
      </button>
    </div>
  );
}
