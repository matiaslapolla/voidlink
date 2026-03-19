import { useState, useRef, useEffect } from "react";
import { X, Plus, FileText, Terminal } from "lucide-react";
import type { Tab } from "@/types/tabs";
import { NewTabPicker } from "./NewTabPicker";

interface WorkspaceTabStripProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: (type: "notion" | "terminal") => void;
  onRenameTab: (id: string, title: string) => void;
}

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onRenameTab,
}: WorkspaceTabStripProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const handleWheel = (e: React.WheelEvent) => {
    if (stripRef.current) {
      stripRef.current.scrollLeft += e.deltaY;
    }
  };

  const startEdit = (tab: Tab) => {
    setEditingId(tab.id);
    setEditValue(tab.title);
  };

  const confirmEdit = () => {
    if (!editingId) return;
    const title =
      editValue.trim() ||
      tabs.find((t) => t.id === editingId)?.title ||
      "Tab";
    onRenameTab(editingId, title);
    setEditingId(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  return (
    <div className="flex items-stretch border-b border-border bg-background/40 flex-shrink-0">
      <div
        ref={stripRef}
        onWheel={handleWheel}
        className="flex items-center gap-1 px-2 py-1 overflow-x-hidden scrollbar-none flex-1"
        style={{ scrollBehavior: "smooth", scrollSnapType: "x mandatory" }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={(e) => {
              e.preventDefault();
              startEdit(tab);
            }}
            className={`group flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
              tab.id === activeTabId
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40 opacity-60 hover:opacity-80"
            }`}
            style={{ scrollSnapAlign: "start" }}
          >
            {tab.type === "notion" ? (
              <FileText className="w-3.5 h-3.5 flex-shrink-0" />
            ) : (
              <Terminal className="w-3.5 h-3.5 flex-shrink-0" />
            )}
            {editingId === tab.id ? (
              <input
                ref={editInputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    confirmEdit();
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    cancelEdit();
                  }
                }}
                onBlur={confirmEdit}
                onClick={(e) => e.stopPropagation()}
                className="px-1 py-0 text-xs bg-background rounded outline-none w-24 max-w-32"
              />
            ) : (
              <span className="max-w-32 truncate">{tab.title}</span>
            )}
            {editingId !== tab.id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/20 hover:text-destructive"
                title="Close tab"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="relative flex-shrink-0 px-1 flex items-center">
        <button
          onClick={() => setPickerOpen((p) => !p)}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="New tab (⌘T)"
        >
          <Plus className="w-4 h-4" />
        </button>
        {pickerOpen && (
          <NewTabPicker
            onSelect={(type) => {
              onAddTab(type);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
