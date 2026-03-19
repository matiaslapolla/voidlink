import { useEffect, useRef } from "react";
import { FileText, Terminal } from "lucide-react";

interface NewTabPickerProps {
  onSelect: (type: "notion" | "terminal") => void;
  onClose: () => void;
}

export function NewTabPicker({ onSelect, onClose }: NewTabPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg overflow-hidden min-w-40"
    >
      <button
        onClick={() => onSelect("notion")}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
      >
        <FileText className="w-4 h-4 text-muted-foreground" />
        New Document
      </button>
      <button
        onClick={() => onSelect("terminal")}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
      >
        <Terminal className="w-4 h-4 text-muted-foreground" />
        New Terminal
      </button>
    </div>
  );
}
