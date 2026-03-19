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
