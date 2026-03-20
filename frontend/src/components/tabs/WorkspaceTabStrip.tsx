import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { X, Plus, FileText, Terminal, Columns2 } from "lucide-solid";
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
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{ tabId: string; x: number; y: number } | null>(null);
  let stripRef: HTMLDivElement | undefined;
  let editInputRef: HTMLInputElement | undefined;
  let contextMenuRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (editingId()) {
      editInputRef?.focus();
      editInputRef?.select();
    }
  });

  // Close context menu on outside click
  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (contextMenu() && contextMenuRef && !contextMenuRef.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  const handleWheel = (e: WheelEvent) => {
    if (stripRef) {
      stripRef.scrollLeft += e.deltaY;
    }
  };

  const startEdit = (tab: Tab) => {
    setEditingId(tab.id);
    setEditValue(tab.title);
  };

  const confirmEdit = () => {
    if (!editingId()) return;
    const title =
      editValue().trim() ||
      tabs.find((t) => t.id === editingId())?.title ||
      "Tab";
    onRenameTab(editingId()!, title);
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

  const canSplit = () => tabs.length > 1;

  return (
    <div class="flex items-stretch border-b border-border bg-background/40 shrink-0">
      <div
        ref={stripRef}
        onWheel={handleWheel}
        class="flex items-center gap-1 px-2 py-1 overflow-x-auto overflow-y-hidden scrollbar-tab-strip"
      >
        <For each={tabs}>
          {(tab) => {
            const isActive = () => tab.id === activeTabId;
            const isSplit = () => tab.id === splitTabId;
            const isFocused = () => (isActive() && focusedPane === "left") || (isSplit() && focusedPane === "right");

            return (
              <div
                onClick={() => onSelectTab(tab.id)}
                onDblClick={(e) => {
                  e.preventDefault();
                  startEdit(tab);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                }}
                class={`group flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${getTabStyle(tab.id)}`}
              >
                {/* Focus indicator dot */}
                <Show when={isFocused() && splitTabId}>
                  <span class="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                </Show>
                <Show
                  when={tab.type === "notion"}
                  fallback={<Terminal class="w-3.5 h-3.5 flex-shrink-0" />}
                >
                  <FileText class="w-3.5 h-3.5 flex-shrink-0" />
                </Show>
                <Show
                  when={editingId() === tab.id}
                  fallback={<span class="max-w-32 truncate">{tab.title}</span>}
                >
                  <input
                    ref={editInputRef}
                    value={editValue()}
                    onInput={(e) => setEditValue(e.currentTarget.value)}
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
                    class="px-1 py-0 text-xs bg-background rounded outline-none w-24 max-w-32"
                  />
                </Show>
                <Show when={editingId() !== tab.id}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    class="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/20 hover:text-destructive"
                    title="Close tab"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <div class="relative flex-shrink-0 px-1 flex items-center gap-0.5">
        {/* Split toggle button */}
        <button
          onClick={() => {
            if (splitTabId) {
              onCloseSplit();
            } else if (canSplit() && activeTabId) {
              onSplitTab(activeTabId);
            }
          }}
          disabled={!splitTabId && !canSplit()}
          class={`p-1 rounded transition-colors ${
            splitTabId
              ? "text-primary hover:bg-accent/40"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
          } disabled:opacity-30 disabled:cursor-not-allowed`}
          title={splitTabId ? "Close split view (⌘\\)" : "Split view (⌘\\)"}
        >
          <Columns2 class="w-4 h-4" />
        </button>

        <button
          onClick={() => setPickerOpen((p) => !p)}
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="New tab (⌘T)"
        >
          <Plus class="w-4 h-4" />
        </button>
        <Show when={pickerOpen()}>
          <NewTabPicker
            onSelect={(type) => {
              onAddTab(type);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        </Show>
      </div>

      {/* Context menu */}
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            ref={contextMenuRef}
            class="fixed z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[180px]"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
          >
            <Show when={!splitTabId && canSplit()}>
              <button
                class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={() => {
                  onSplitTab(menu().tabId);
                  setContextMenu(null);
                }}
              >
                Open in Split View
              </button>
            </Show>
            <Show when={splitTabId && menu().tabId !== activeTabId && menu().tabId !== splitTabId}>
              <button
                class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={() => {
                  onSplitTab(menu().tabId);
                  setContextMenu(null);
                }}
              >
                Open in Split View
              </button>
            </Show>
            <Show when={splitTabId}>
              <button
                class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={() => {
                  onCloseSplit();
                  setContextMenu(null);
                }}
              >
                Close Split View
              </button>
            </Show>
            <button
              class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => {
                onCloseTab(menu().tabId);
                setContextMenu(null);
              }}
            >
              Close Tab
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
