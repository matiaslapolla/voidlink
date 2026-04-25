import { For, Show, createSignal, createResource, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-solid";
import { fsApi, type FsEntry } from "@/api/fs";

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  name: string;
}

export function FileTree(props: { root: string; onOpenFile?: (path: string) => void }) {
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const refresh = () => setRefreshKey(k => k + 1);
  const closeMenu = () => setContextMenu(null);

  async function handleNewFile(parentDir: string) {
    closeMenu();
    const name = prompt("New file name:");
    if (!name?.trim()) return;
    try { await fsApi.createFile(`${parentDir}/${name.trim()}`); refresh(); }
    catch (e) { alert(String(e)); }
  }

  async function handleNewFolder(parentDir: string) {
    closeMenu();
    const name = prompt("New folder name:");
    if (!name?.trim()) return;
    try { await fsApi.createDir(`${parentDir}/${name.trim()}`); refresh(); }
    catch (e) { alert(String(e)); }
  }

  async function handleRename(path: string, oldName: string) {
    closeMenu();
    const newName = prompt("Rename to:", oldName);
    if (!newName?.trim() || newName.trim() === oldName) return;
    const parent = path.split("/").slice(0, -1).join("/");
    try { await fsApi.rename(path, `${parent}/${newName.trim()}`); refresh(); }
    catch (e) { alert(String(e)); }
  }

  async function handleDelete(path: string, name: string) {
    closeMenu();
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try { await fsApi.delete(path); refresh(); }
    catch (e) { alert(String(e)); }
  }

  return (
    <div class="flex-1 h-full overflow-y-auto scrollbar-thin py-1">
      <TreeDir
        path={props.root}
        depth={0}
        defaultExpanded
        refreshKey={refreshKey()}
        onOpenFile={props.onOpenFile}
        onContextMenu={setContextMenu}
      />

      <Show when={contextMenu()}>
        {(m) => (
          <ContextMenuPopup
            state={m()}
            onClose={closeMenu}
            onNewFile={() => void handleNewFile(m().isDir ? m().path : m().path.split("/").slice(0, -1).join("/"))}
            onNewFolder={() => void handleNewFolder(m().isDir ? m().path : m().path.split("/").slice(0, -1).join("/"))}
            onRename={() => void handleRename(m().path, m().name)}
            onDelete={() => void handleDelete(m().path, m().name)}
          />
        )}
      </Show>
    </div>
  );
}

// ── Context menu — own component so onMount/onCleanup work correctly ──────────

function ContextMenuPopup(props: {
  state: ContextMenuState;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  onMount(() => {
    // Delay by one tick so the right-click event that opened the menu doesn't
    // immediately close it via the document listener.
    const close = () => props.onClose();
    const timer = setTimeout(() => {
      document.addEventListener("click", close, { once: true });
      document.addEventListener("contextmenu", close, { once: true });
    }, 0);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    });
  });

  return (
    <Portal>
      <div
        class="fixed z-50 min-w-[164px] bg-popover border border-border rounded-md shadow-xl py-1 text-[13px]"
        style={{ left: `${props.state.x}px`, top: `${props.state.y}px` }}
        onClick={e => e.stopPropagation()}
        onContextMenu={e => e.stopPropagation()}
      >
        <MenuBtn icon={FilePlus} onClick={props.onNewFile}>New File</MenuBtn>
        <MenuBtn icon={FolderPlus} onClick={props.onNewFolder}>New Folder</MenuBtn>
        <div class="my-1 h-px bg-border mx-2" />
        <MenuBtn icon={Pencil} onClick={props.onRename}>Rename</MenuBtn>
        <MenuBtn icon={Trash2} onClick={props.onDelete} danger>Delete</MenuBtn>
      </div>
    </Portal>
  );
}

function MenuBtn(props: { icon: any; onClick: () => void; danger?: boolean; children: any }) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      class={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        props.danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-accent/60"
      }`}
    >
      <Icon class="w-3.5 h-3.5 shrink-0 opacity-70" />
      {props.children}
    </button>
  );
}

// ── Tree nodes ────────────────────────────────────────────────────────────────

function TreeDir(props: {
  path: string;
  depth: number;
  defaultExpanded?: boolean;
  label?: string;
  refreshKey: number;
  onOpenFile?: (path: string) => void;
  onContextMenu: (state: ContextMenuState) => void;
}) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false);

  const [entries] = createResource(
    () => expanded() ? `${props.path}::${props.refreshKey}` : null,
    (key) => fsApi.listDir(key.split("::")[0]),
  );

  const name = () => props.label ?? props.path.split("/").pop() ?? props.path;
  const dirs  = () => (entries() ?? []).filter(e =>  e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = () => (entries() ?? []).filter(e => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const indent = () => `${props.depth * 12}px`;

  return (
    <>
      <Show when={props.depth > 0}>
        <button
          onClick={() => setExpanded(v => !v)}
          onContextMenu={e => { e.preventDefault(); props.onContextMenu({ x: e.clientX, y: e.clientY, path: props.path, isDir: true, name: name() }); }}
          class="w-full flex items-center gap-1 py-0.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
          style={{ "padding-left": `calc(8px + ${indent()})` }}
        >
          <span class="shrink-0 w-3 h-3 text-muted-foreground/60">
            {expanded() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
          </span>
          {expanded()
            ? <FolderOpen class="w-3.5 h-3.5 shrink-0 text-warning/80" />
            : <Folder    class="w-3.5 h-3.5 shrink-0 text-warning/80" />
          }
          <span class="truncate text-[13px]">{name()}</span>
        </button>
      </Show>

      <Show when={expanded() || props.depth === 0}>
        <Show when={entries.loading}>
          <div class="text-xs text-muted-foreground/50 py-0.5" style={{ "padding-left": `calc(24px + ${indent()})` }}>
            Loading…
          </div>
        </Show>
        <For each={dirs()}>
          {(entry) => (
            <TreeDir
              path={entry.path}
              depth={props.depth + 1}
              label={entry.name}
              refreshKey={props.refreshKey}
              onOpenFile={props.onOpenFile}
              onContextMenu={props.onContextMenu}
            />
          )}
        </For>
        <For each={files()}>
          {(entry) => (
            <TreeFile
              entry={entry}
              depth={props.depth + 1}
              onOpenFile={props.onOpenFile}
              onContextMenu={props.onContextMenu}
            />
          )}
        </For>
        <Show when={!entries.loading && (entries() ?? []).length === 0 && props.depth > 0}>
          <div class="text-xs text-muted-foreground/50 py-0.5" style={{ "padding-left": `calc(24px + ${indent()})` }}>
            Empty
          </div>
        </Show>
      </Show>
    </>
  );
}

function TreeFile(props: {
  entry: FsEntry;
  depth: number;
  onOpenFile?: (path: string) => void;
  onContextMenu: (state: ContextMenuState) => void;
}) {
  const indent = () => `${props.depth * 12}px`;
  return (
    <button
      onClick={() => props.onOpenFile?.(props.entry.path)}
      onContextMenu={e => { e.preventDefault(); props.onContextMenu({ x: e.clientX, y: e.clientY, path: props.entry.path, isDir: false, name: props.entry.name }); }}
      class="w-full flex items-center gap-1.5 py-0.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      style={{ "padding-left": `calc(20px + ${indent()})` }}
      title={props.entry.path}
    >
      <File class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <span class="truncate text-[13px]">{props.entry.name}</span>
    </button>
  );
}
