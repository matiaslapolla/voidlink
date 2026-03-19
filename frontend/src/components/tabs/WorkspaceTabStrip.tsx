import { useState, useRef, useEffect } from "react";
import { X, Plus, FileText, Terminal, Columns2 } from "lucide-react";
import type { Tab } from "@/types/tabs";
import { NewTabPicker } from "./NewTabPicker";

interface WorkspaceTabStripProps {
  tabs: Tab[];
  activeTabId: string | null;
  splitTabId: string | null;
  focusedPane: "left" | "right";
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: (type: "notion" | "terminal") => void;
  onRenameTab: (id: string, title: string) => void;
  onSplitTab: (tabId: string) => void;
  onCloseSplit: () => void;
}

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  splitTabId,
  focusedPane,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onRenameTab,
  onSplitTab,
  onCloseSplit,
}: WorkspaceTabStripProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

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

  const getTabStyle = (tabId: string) => {
    const isActive = tabId === activeTabId;
    const isSplit = tabId === splitTabId;
    const inSplitMode = splitTabId !== null;

    if (isActive) {
      return inSplitMode
        ? "bg-accent text-accent-foreground ring-1 ring-primary/40"
        : "bg-accent text-accent-foreground";
    }
    if (isSplit) {
      return "bg-accent/50 text-accent-foreground ring-1 ring-primary/40";
    }
    return "text-muted-foreground hover:text-foreground hover:bg-accent/40 opacity-60 hover:opacity-80";
  };

  const canSplit = tabs.length > 1;

  return (
    <div className="flex items-stretch border-b border-border bg-background/40 shrink-0">
      <div
        ref={stripRef}
        onWheel={handleWheel}
        className="flex items-center gap-1 px-2 py-1 overflow-x-auto overflow-y-hidden scrollbar-tab-strip"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isSplit = tab.id === splitTabId;
          const isFocused = (isActive && focusedPane === "left") || (isSplit && focusedPane === "right");

          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                startEdit(tab);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              className={`group flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${getTabStyle(tab.id)}`}
            >
              {/* Focus indicator dot */}
              {isFocused && splitTabId && (
                <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
              )}
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
          );
        })}
      </div>

      <div className="relative flex-shrink-0 px-1 flex items-center gap-0.5">
        {/* Split toggle button */}
        <button
          onClick={() => {
            if (splitTabId) {
              onCloseSplit();
            } else if (canSplit && activeTabId) {
              onSplitTab(activeTabId);
            }
          }}
          disabled={!splitTabId && !canSplit}
          className={`p-1 rounded transition-colors ${
            splitTabId
              ? "text-primary hover:bg-accent/40"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
          } disabled:opacity-30 disabled:cursor-not-allowed`}
          title={splitTabId ? "Close split view (⌘\\)" : "Split view (⌘\\)"}
        >
          <Columns2 className="w-4 h-4" />
        </button>

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

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {!splitTabId && canSplit && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => {
                onSplitTab(contextMenu.tabId);
                setContextMenu(null);
              }}
            >
              Open in Split View
            </button>
          )}
          {splitTabId && contextMenu.tabId !== activeTabId && contextMenu.tabId !== splitTabId && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => {
                onSplitTab(contextMenu.tabId);
                setContextMenu(null);
              }}
            >
              Open in Split View
            </button>
          )}
          {splitTabId && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => {
                onCloseSplit();
                setContextMenu(null);
              }}
            >
              Close Split View
            </button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
            onClick={() => {
              onCloseTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            Close Tab
          </button>
        </div>
      )}
    </div>
  );
}
