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
    const name =
      editValue.trim() ||
      workspaces.find((w) => w.id === editingId)?.name ||
      "Workspace";
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
