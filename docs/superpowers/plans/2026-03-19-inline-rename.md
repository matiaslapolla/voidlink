# Inline Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to double-click workspace names and tab titles to rename them inline, with Enter/blur to confirm and Escape to cancel.

**Architecture:** Add `renameWorkspace` to `App.tsx` and pass it to `WorkspaceSidebar` and `WorkspaceTopBar`. Add `onRenameTab` to `WorkspaceTabStrip` (wrapping the existing `updateTab`). Each component manages local `editingId` + `editValue` state to control the inline input. No new files needed.

**Tech Stack:** React 18, TypeScript, Tailwind CSS

---

### Task 1: Add `renameWorkspace` to App.tsx and thread it to both workspace components

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/workspaces/WorkspaceSidebar.tsx`
- Modify: `frontend/src/components/workspaces/WorkspaceTopBar.tsx`

- [ ] **Step 1: Add `renameWorkspace` callback in `App.tsx`**

In `App.tsx`, after the `selectWorkspace` callback (~line 122), add:

```ts
const renameWorkspace = useCallback(
  (id: string, name: string) => {
    updateWsState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((w) =>
        w.id === id ? { ...w, name } : w,
      ),
    }));
  },
  [updateWsState],
);
```

- [ ] **Step 2: Pass `onRenameWorkspace` to `WorkspaceSidebar` and `WorkspaceTopBar` in the JSX**

In the render section of `App.tsx`:

```tsx
<WorkspaceSidebar
  workspaces={workspaces}
  activeWorkspaceId={activeWorkspaceId}
  onSelectWorkspace={selectWorkspace}
  onAddWorkspace={addWorkspace}
  onOpenSettings={() => setSettingsOpen(true)}
  onRenameWorkspace={renameWorkspace}
/>
```

```tsx
<WorkspaceTopBar
  workspaces={workspaces}
  activeWorkspaceId={activeWorkspaceId}
  onSelectWorkspace={selectWorkspace}
  onAddWorkspace={addWorkspace}
  onRemoveWorkspace={removeWorkspace}
  onRenameWorkspace={renameWorkspace}
/>
```

- [ ] **Step 3: Add inline rename to `WorkspaceSidebar`**

Replace the full `WorkspaceSidebar` component with this updated version:

```tsx
import { useState, useRef, useEffect } from "react";
import { Plus, Settings } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { Workspace } from "@/types/tabs";

interface WorkspaceSidebarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: (name: string) => void;
  onOpenSettings: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
}

export function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onOpenSettings,
  onRenameWorkspace,
}: WorkspaceSidebarProps) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) addInputRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const confirmAdd = () => {
    const name = newName.trim() || "Workspace";
    onAddWorkspace(name);
    setNewName("");
    setAdding(false);
  };

  const startEdit = (ws: Workspace) => {
    setEditingId(ws.id);
    setEditValue(ws.name);
  };

  const confirmEdit = () => {
    if (!editingId) return;
    const name = editValue.trim() || workspaces.find((w) => w.id === editingId)?.name || "Workspace";
    onRenameWorkspace(editingId, name);
    setEditingId(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const getInitials = (name: string) =>
    name
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("");

  return (
    <div className="w-60 border-r border-border flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="flex-1 overflow-y-auto p-2 pt-3 flex flex-col gap-0.5">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            onClick={() => onSelectWorkspace(ws.id)}
            onDoubleClick={(e) => {
              e.preventDefault();
              startEdit(ws);
            }}
            className={`w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left transition-colors ${
              ws.id === activeWorkspaceId
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "hover:bg-sidebar-accent/50 text-sidebar-foreground"
            }`}
          >
            <span className="w-7 h-7 rounded-md bg-accent flex items-center justify-center text-xs font-bold flex-shrink-0">
              {getInitials(ws.name) || "W"}
            </span>
            {editingId === ws.id ? (
              <input
                ref={editInputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.stopPropagation(); confirmEdit(); }
                  if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
                }}
                onBlur={confirmEdit}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 px-1 py-0 text-sm bg-accent rounded outline-none min-w-0"
              />
            ) : (
              <span className="truncate">{ws.name}</span>
            )}
            {ws.id === activeWorkspaceId && editingId !== ws.id && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
            )}
          </button>
        ))}

        {adding && (
          <div className="px-2 py-1">
            <input
              ref={addInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmAdd();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewName("");
                }
              }}
              onBlur={confirmAdd}
              placeholder="Workspace name…"
              className="w-full px-2 py-1 text-sm bg-accent rounded outline-none"
            />
          </div>
        )}
      </div>

      <Separator />
      <div className="p-2 flex gap-1">
        <button
          onClick={() => setAdding(true)}
          className="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm hover:bg-sidebar-accent/50 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Workspace
        </button>
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-md hover:bg-sidebar-accent/50 transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add inline rename to `WorkspaceTopBar`**

Replace the full `WorkspaceTopBar` component with this updated version:

```tsx
import { useState, useRef, useEffect } from "react";
import { X, Plus } from "lucide-react";
import type { Workspace } from "@/types/tabs";

interface WorkspaceTopBarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: (name: string) => void;
  onRemoveWorkspace: (id: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
}

export function WorkspaceTopBar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
}: WorkspaceTopBarProps) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) addInputRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const confirmAdd = () => {
    const name = newName.trim() || "Workspace";
    onAddWorkspace(name);
    setNewName("");
    setAdding(false);
  };

  const startEdit = (ws: Workspace) => {
    setEditingId(ws.id);
    setEditValue(ws.name);
  };

  const confirmEdit = () => {
    if (!editingId) return;
    const name = editValue.trim() || workspaces.find((w) => w.id === editingId)?.name || "Workspace";
    onRenameWorkspace(editingId, name);
    setEditingId(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  return (
    <div className="flex items-center gap-1 px-2 h-9 border-b border-border bg-background/60 overflow-x-auto scrollbar-none flex-shrink-0">
      {workspaces.map((ws) => (
        <div
          key={ws.id}
          className={`group flex items-center gap-1 px-2 py-1 rounded text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
            ws.id === activeWorkspaceId
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          onClick={() => onSelectWorkspace(ws.id)}
          onDoubleClick={(e) => {
            e.preventDefault();
            startEdit(ws);
          }}
        >
          {ws.id === activeWorkspaceId && editingId !== ws.id && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
          )}
          {editingId === ws.id ? (
            <input
              ref={editInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.stopPropagation(); confirmEdit(); }
                if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
              }}
              onBlur={confirmEdit}
              onClick={(e) => e.stopPropagation()}
              className="px-1 py-0 text-xs bg-background rounded outline-none w-24"
            />
          ) : (
            <span>{ws.name}</span>
          )}
          {workspaces.length > 1 && editingId !== ws.id && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveWorkspace(ws.id);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/20 hover:text-destructive"
              title="Close workspace"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}

      {adding ? (
        <input
          ref={addInputRef}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmAdd();
            if (e.key === "Escape") {
              setAdding(false);
              setNewName("");
            }
          }}
          onBlur={confirmAdd}
          placeholder="Workspace name…"
          className="px-2 py-0.5 text-xs bg-accent rounded outline-none w-32"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="New workspace"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/workspaces/WorkspaceSidebar.tsx frontend/src/components/workspaces/WorkspaceTopBar.tsx
git commit -m "feat: add inline rename for workspaces in sidebar and top bar"
```

---

### Task 2: Add inline rename to `WorkspaceTabStrip`

**Files:**
- Modify: `frontend/src/components/tabs/WorkspaceTabStrip.tsx`
- Modify: `frontend/src/App.tsx` (add `onRenameTab` prop pass-through)

- [ ] **Step 1: Add `onRenameTab` prop to `WorkspaceTabStrip` and wire inline rename**

Replace the full `WorkspaceTabStrip` component:

```tsx
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
    const title = editValue.trim() || tabs.find((t) => t.id === editingId)?.title || "Tab";
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
                  if (e.key === "Enter") { e.stopPropagation(); confirmEdit(); }
                  if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
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
```

- [ ] **Step 2: Pass `onRenameTab` from `App.tsx` to `WorkspaceTabStrip`**

In `App.tsx`, find the `WorkspaceTabStrip` JSX block (~line 455) and add the `onRenameTab` prop:

```tsx
{activeWorkspace && (
  <WorkspaceTabStrip
    tabs={activeWorkspace.tabs}
    activeTabId={activeWorkspace.activeTabId}
    onSelectTab={(tabId) => selectTab(activeWorkspaceId!, tabId)}
    onCloseTab={(tabId) => removeTab(activeWorkspaceId!, tabId)}
    onAddTab={(type) => addTab(activeWorkspaceId!, type)}
    onRenameTab={(tabId, title) =>
      updateTab(activeWorkspaceId!, tabId, { title } as Partial<Tab>)
    }
  />
)}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/tabs/WorkspaceTabStrip.tsx frontend/src/App.tsx
git commit -m "feat: add inline rename for notion and terminal tabs"
```
