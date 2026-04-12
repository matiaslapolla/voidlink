import { For, Show, createSignal, createEffect, on, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight,
  Folder,
  File,
  FolderOpen,
  FolderInput,
  Copy,
  Scissors,
  Trash2,
  CopyPlus,
  FolderMinus,
  Layers,
  Bot,
  TerminalSquare,
  Pencil,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import type { GitFileStatus } from "@/types/git";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useLayout } from "@/store/LayoutContext";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface FileExplorerProps {
  repoRoot: string | null;
  activeWorkspaceId?: string;
  onAddToContext?: (filePath: string) => void;
  onAddToAgent?: (filePath: string) => void;
  onAddToTerminal?: (filePath: string) => void;
}

// ─── Clipboard state (module-level for cut/copy) ─────────────────────────────

const [clipboardPath, setClipboardPath] = createSignal<string | null>(null);
const [clipboardMode, setClipboardMode] = createSignal<"copy" | "cut" | null>(null);

// ─── Rename dialog state ─────────────────────────────────────────────────────

type GitStatusMap = Map<string, GitFileStatus["status"]>;

function FileNode(props: {
  entry: DirEntry;
  depth: number;
  onOpenFile: (path: string) => void;
  onOpenFilePinned: (path: string) => void;
  onRefresh: () => void;
  explorerProps: FileExplorerProps;
  gitStatusMap: GitStatusMap;
  repoRoot: string | null;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [children, setChildren] = createSignal<DirEntry[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [confirmEmpty, setConfirmEmpty] = createSignal(false);

  const loadChildren = async () => {
    setLoading(true);
    try {
      const entries = await invoke<DirEntry[]>("list_directory", { path: props.entry.path });
      setChildren(entries);
      setLoaded(true);
    } catch {
      // silently fail for unreadable dirs
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    if (!props.entry.is_dir) return;
    const next = !expanded();
    setExpanded(next);
    if (next && !loaded()) {
      await loadChildren();
    }
  };

  const handleClick = () => {
    if (props.entry.is_dir) {
      toggle();
    } else {
      props.onOpenFile(props.entry.path);
    }
  };

  const handleDblClick = () => {
    if (!props.entry.is_dir) {
      props.onOpenFilePinned(props.entry.path);
    }
  };

  const refreshSelf = async () => {
    if (props.entry.is_dir && loaded()) {
      await loadChildren();
    }
  };

  // Git status for this file (relative path lookup)
  const gitStatus = createMemo(() => {
    const root = props.repoRoot;
    if (!root) return null;
    const rel = props.entry.path.startsWith(root + "/")
      ? props.entry.path.slice(root.length + 1)
      : props.entry.path;
    return props.gitStatusMap.get(rel) ?? null;
  });

  const gitBadge = createMemo(() => {
    const s = gitStatus();
    if (!s) return null;
    switch (s) {
      case "modified": return { letter: "M", class: "text-yellow-400" };
      case "untracked": return { letter: "U", class: "text-green-400" };
      case "added": return { letter: "A", class: "text-green-400" };
      case "deleted": return { letter: "D", class: "text-destructive" };
      case "renamed": return { letter: "R", class: "text-blue-400" };
      case "conflicted": return { letter: "C", class: "text-destructive" };
      default: return null;
    }
  });

  // Check if any child in this directory has git status (for folder indicators)
  const dirHasChanges = createMemo(() => {
    if (!props.entry.is_dir || !props.repoRoot) return false;
    const root = props.repoRoot;
    const rel = props.entry.path.startsWith(root + "/")
      ? props.entry.path.slice(root.length + 1)
      : props.entry.path;
    const prefix = rel + "/";
    for (const key of props.gitStatusMap.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  });

  const ext = () => {
    const i = props.entry.name.lastIndexOf(".");
    return i > 0 ? props.entry.name.slice(i + 1).toLowerCase() : "";
  };

  const fileColor = () => {
    const e = ext();
    if (["ts", "tsx"].includes(e)) return "text-blue-400";
    if (["js", "jsx"].includes(e)) return "text-yellow-400";
    if (["rs"].includes(e)) return "text-orange-400";
    if (["css", "scss"].includes(e)) return "text-purple-400";
    if (["json", "toml", "yaml", "yml"].includes(e)) return "text-green-400";
    if (["md", "mdx", "txt"].includes(e)) return "text-muted-foreground";
    return "text-muted-foreground/70";
  };

  // ─── Context menu actions ──────────────────────────────────────────────

  const handleOpen = () => {
    if (props.entry.is_dir) {
      if (!expanded()) toggle();
    } else {
      props.onOpenFile(props.entry.path);
    }
  };

  const handleRename = () => {
    setRenameDraft(props.entry.name);
    setRenaming(true);
  };

  const commitRename = async () => {
    const newName = renameDraft().trim();
    if (!newName || newName === props.entry.name) {
      setRenaming(false);
      return;
    }
    const parent = props.entry.path.substring(0, props.entry.path.lastIndexOf("/"));
    const newPath = `${parent}/${newName}`;
    try {
      await invoke("rename_path", { oldPath: props.entry.path, newPath });
      props.onRefresh();
    } catch (e) {
      console.error("Rename failed:", e);
    }
    setRenaming(false);
  };

  const handleCopy = () => {
    setClipboardPath(props.entry.path);
    setClipboardMode("copy");
  };

  const handleCut = () => {
    setClipboardPath(props.entry.path);
    setClipboardMode("cut");
  };

  const handleDelete = async () => {
    try {
      await invoke("delete_path", { path: props.entry.path });
      props.onRefresh();
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  const handleDuplicate = async () => {
    try {
      await invoke<string>("duplicate_path", { path: props.entry.path });
      props.onRefresh();
    } catch (e) {
      console.error("Duplicate failed:", e);
    }
  };

  const handleEmptyDir = async () => {
    try {
      await invoke("empty_directory", { path: props.entry.path });
      setConfirmEmpty(false);
      await refreshSelf();
    } catch (e) {
      console.error("Empty directory failed:", e);
    }
  };

  const handleAddToContext = () => {
    props.explorerProps.onAddToContext?.(props.entry.path);
  };

  const handleAddToAgent = () => {
    props.explorerProps.onAddToAgent?.(props.entry.path);
  };

  const handleAddToTerminal = () => {
    props.explorerProps.onAddToTerminal?.(props.entry.path);
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
          <Show
            when={!renaming()}
            fallback={
              <div
                class="flex items-center gap-1 px-1.5 py-[3px]"
                style={{ "padding-left": `${props.depth * 14 + 4}px` }}
              >
                <input
                  value={renameDraft()}
                  onInput={(e) => setRenameDraft(e.currentTarget.value)}
                  onBlur={() => commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  class="flex-1 rounded bg-accent/60 px-1.5 py-0.5 text-xs outline-none border border-primary/40"
                  autofocus
                />
              </div>
            }
          >
            <button
              onClick={handleClick}
              onDblClick={handleDblClick}
              class={`w-full flex items-center gap-1 rounded px-1.5 py-[3px] text-xs transition-colors ${
                props.entry.is_dir
                  ? "text-foreground/90 hover:bg-sidebar-accent/50"
                  : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
              }`}
              style={{ "padding-left": `${props.depth * 14 + 4}px` }}
            >
              <Show
                when={props.entry.is_dir}
                fallback={<span class="w-3 shrink-0" />}
              >
                <ChevronRight
                  class={`w-3 h-3 shrink-0 text-muted-foreground/60 ${expanded() ? "rotate-90" : ""}`}
                  style={{ transition: "transform 80ms var(--ease-out-expo)" }}
                />
              </Show>
              <Show
                when={props.entry.is_dir}
                fallback={<File class={`w-3.5 h-3.5 shrink-0 ${fileColor()}`} />}
              >
                <Show
                  when={expanded()}
                  fallback={<Folder class="w-3.5 h-3.5 shrink-0 text-icon-scan" />}
                >
                  <FolderOpen class="w-3.5 h-3.5 shrink-0 text-icon-scan" />
                </Show>
              </Show>
              <span class="truncate">{props.entry.name}</span>
              <Show when={!props.entry.is_dir && gitBadge()}>
                {(_badge) => {
                  const b = gitBadge()!;
                  return (
                    <span class={`ml-auto text-[10px] font-bold shrink-0 ${b.class}`}>
                      {b.letter}
                    </span>
                  );
                }}
              </Show>
              <Show when={props.entry.is_dir && dirHasChanges()}>
                <span class="ml-auto w-1.5 h-1.5 rounded-full bg-yellow-400 shrink-0" />
              </Show>
              <Show when={loading()}>
                <span class="ml-auto text-[10px] text-muted-foreground/50">...</span>
              </Show>
            </button>
          </Show>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem onSelect={handleOpen}>
            <FolderInput class="w-3.5 h-3.5" />
            Open
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleRename}>
            <Pencil class="w-3.5 h-3.5" />
            Rename
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleCopy}>
            <Copy class="w-3.5 h-3.5" />
            Copy
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleCut}>
            <Scissors class="w-3.5 h-3.5" />
            Cut
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleDuplicate}>
            <CopyPlus class="w-3.5 h-3.5" />
            Duplicate
          </ContextMenuItem>
          <ContextMenuSeparator />
          <Show when={props.entry.is_dir}>
            <ContextMenuItem onSelect={() => setConfirmEmpty(true)} destructive>
              <FolderMinus class="w-3.5 h-3.5" />
              Empty Directory
            </ContextMenuItem>
          </Show>
          <ContextMenuItem onSelect={handleDelete} destructive>
            <Trash2 class="w-3.5 h-3.5" />
            Delete
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleAddToContext}>
            <Layers class="w-3.5 h-3.5" />
            Add to Context
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleAddToAgent}>
            <Bot class="w-3.5 h-3.5" />
            Add to AI Agent
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleAddToTerminal}>
            <TerminalSquare class="w-3.5 h-3.5" />
            Add to Terminal
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Empty directory confirmation dialog */}
      <Dialog open={confirmEmpty()} onOpenChange={setConfirmEmpty}>
        <DialogPortal>
          <DialogOverlay />
          <DialogContent>
            <DialogTitle>Empty Directory</DialogTitle>
            <DialogDescription>
              This will permanently delete all contents of <strong>{props.entry.name}</strong>. This action is irreversible.
            </DialogDescription>
            <div class="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmEmpty(false)}
                class="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleEmptyDir}
                class="px-3 py-1.5 text-xs rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Empty Directory
              </button>
            </div>
          </DialogContent>
        </DialogPortal>
      </Dialog>

      <Show when={expanded() && loaded()}>
        <For each={children()}>
          {(child) => (
            <FileNode
              entry={child}
              depth={props.depth + 1}
              onOpenFile={props.onOpenFile}
              onOpenFilePinned={props.onOpenFilePinned}
              onRefresh={props.onRefresh}
              explorerProps={props.explorerProps}
              gitStatusMap={props.gitStatusMap}
              repoRoot={props.repoRoot}
            />
          )}
        </For>
        <Show when={children().length === 0 && !loading()}>
          <div
            class="text-[10px] text-muted-foreground/40 italic px-2 py-0.5"
            style={{ "padding-left": `${(props.depth + 1) * 14 + 4}px` }}
          >
            empty
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function FileExplorer(props: FileExplorerProps) {
  const [entries, setEntries] = createSignal<DirEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [gitStatusMap, setGitStatusMap] = createSignal<GitStatusMap>(new Map());
  const [, actions] = useLayout();

  const loadGitStatus = async (root: string) => {
    try {
      const statuses = await gitApi.fileStatus(root);
      const map: GitStatusMap = new Map();
      for (const s of statuses) {
        map.set(s.path, s.status);
      }
      setGitStatusMap(map);
    } catch {
      setGitStatusMap(new Map());
    }
  };

  const loadEntries = async (root: string) => {
    setLoading(true);
    try {
      const result = await invoke<DirEntry[]>("list_directory", { path: root });
      setEntries(result);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  createEffect(
    on(
      () => props.repoRoot,
      async (root) => {
        if (!root) {
          setEntries([]);
          setGitStatusMap(new Map());
          return;
        }
        await Promise.all([loadEntries(root), loadGitStatus(root)]);
      },
    ),
  );

  const handleRefresh = () => {
    if (props.repoRoot) {
      loadEntries(props.repoRoot);
      loadGitStatus(props.repoRoot);
    }
  };

  const handleOpenFile = (filePath: string) => {
    if (props.activeWorkspaceId) {
      actions.openFile(props.activeWorkspaceId, filePath);
    }
  };

  const handleOpenFilePinned = (filePath: string) => {
    if (props.activeWorkspaceId) {
      actions.openFilePinned(props.activeWorkspaceId, filePath);
    }
  };

  // Handle paste from clipboard
  const handlePaste = async (targetDir: string) => {
    const src = clipboardPath();
    const mode = clipboardMode();
    if (!src || !mode) return;

    const fileName = src.split("/").pop() ?? src;
    const dest = `${targetDir}/${fileName}`;

    try {
      if (mode === "copy") {
        await invoke("copy_path", { src, dest });
      } else {
        await invoke("rename_path", { oldPath: src, newPath: dest });
        setClipboardPath(null);
        setClipboardMode(null);
      }
      handleRefresh();
    } catch (e) {
      console.error("Paste failed:", e);
    }
  };

  // Global keyboard shortcut for paste
  const pasteHandler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "v" && clipboardPath()) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (props.repoRoot) {
        e.preventDefault();
        handlePaste(props.repoRoot);
      }
    }
  };
  window.addEventListener("keydown", pasteHandler);
  onCleanup(() => window.removeEventListener("keydown", pasteHandler));

  return (
    <Show when={props.repoRoot}>
      <div class="border-t border-border flex flex-col flex-1 min-h-0">
        <div class="px-2 py-1.5 flex items-center gap-1.5">
          <span class="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
            Files
          </span>
          <Show when={loading()}>
            <span class="text-[10px] text-muted-foreground/40">loading...</span>
          </Show>
        </div>
        <div class="pb-1 overflow-y-auto flex-1 min-h-0 scrollbar-thin">
          <For each={entries()}>
            {(entry) => (
              <FileNode
                entry={entry}
                depth={0}
                onOpenFile={handleOpenFile}
                onOpenFilePinned={handleOpenFilePinned}
                onRefresh={handleRefresh}
                explorerProps={props}
                gitStatusMap={gitStatusMap()}
                repoRoot={props.repoRoot}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
