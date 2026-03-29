import { onMount, onCleanup } from "solid-js";
import { FileText, Terminal, GitBranch } from "lucide-solid";

interface NewTabPickerProps {
  onSelect: (type: "notion" | "terminal" | "git") => void;
  onClose: () => void;
}

export function NewTabPicker(props: NewTabPickerProps) {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref && !ref.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", handleClick);
    onCleanup(() => document.removeEventListener("mousedown", handleClick));
  });

  return (
    <div
      ref={ref}
      class="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg overflow-hidden min-w-40"
    >
      <button
        onClick={() => props.onSelect("notion")}
        class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
      >
        <FileText class="w-4 h-4 text-muted-foreground" />
        New Document
      </button>
      <button
        onClick={() => props.onSelect("terminal")}
        class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
      >
        <Terminal class="w-4 h-4 text-muted-foreground" />
        New Terminal
      </button>
      <button
        onClick={() => props.onSelect("git")}
        class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
      >
        <GitBranch class="w-4 h-4 text-muted-foreground" />
        Git Panel
      </button>
    </div>
  );
}
