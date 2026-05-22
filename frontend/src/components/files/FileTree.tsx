import { For, Show, createSignal, createResource, createEffect, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, FilePlus, FolderPlus, Pencil, Trash2, GitCompare } from "lucide-solid";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { fsApi, type FsEntry } from "@/api/fs";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  name: string;
}

// An in-progress create/rename rendered inline in the tree. We avoid the
// native `window.prompt`/`confirm` here: macOS WKWebView (which Tauri uses)
// silently returns null from `prompt()`, so the old flow created nothing.
type EditState =
  | { kind: "newFile"; parentDir: string }
  | { kind: "newFolder"; parentDir: string }
  | { kind: "rename"; path: string; initialName: string };

export function FileTree(props: { root: string; onOpenFile?: (path: string) => void }) {
  const { state, actions } = useAppStore();
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [edit, setEdit] = createSignal<EditState | null>(null);
  const refresh = () => setRefreshKey(k => k + 1);
  const closeMenu = () => setContextMenu(null);

  // The repo's trunk, used by "Compare with …". Resolved once on mount —
  // prefer `main`, then `master`, else the first local branch. Falls back to
  // "main" if the lookup fails (the compare just errors visibly if wrong).
  const [defaultBranch, setDefaultBranch] = createSignal("main");
  onMount(async () => {
    try {
      const branches = await gitApi.listBranches(props.root, false);
      const names = branches.map((b) => b.name);
      const trunk =
        names.find((n) => n === "main") ??
        names.find((n) => n === "master") ??
        names[0];
      if (trunk) setDefaultBranch(trunk);
    } catch {
      // keep the "main" default
    }
  });

  /// Open a compare tab (trunk → HEAD via merge-base) with this file
  /// pre-selected, so "Compare with main" lands straight on the file's diff.
  /// The compare model is repo-wide; we just focus the clicked path.
  function compareWithDefault(absPath: string) {
    closeMenu();
    const wsId = state.activeWorkspaceId;
    const rel = absPath.startsWith(props.root + "/")
      ? absPath.slice(props.root.length + 1)
      : absPath;
    const id = actions.openCompareTab(wsId, {
      baseRef: defaultBranch(),
      headRef: "HEAD",
      useMergeBase: true,
    });
    actions.setCompareSelectedFile(wsId, id, rel);
  }

  // External writers (the New Tab menu, future flows) dispatch this to ask
  // the tree to re-list its dirs without re-mounting.
  onMount(() => {
    const handler = () => refresh();
    window.addEventListener("voidlink:refresh-files", handler);
    onCleanup(() => window.removeEventListener("voidlink:refresh-files", handler));
  });

  // Start an inline edit. The actual filesystem write happens in commitEdit
  // once the user confirms a name, so the tree input is the single entry point.
  const startNewFile = (parentDir: string) => { closeMenu(); setEdit({ kind: "newFile", parentDir }); };
  const startNewFolder = (parentDir: string) => { closeMenu(); setEdit({ kind: "newFolder", parentDir }); };
  const startRename = (path: string, name: string) => { closeMenu(); setEdit({ kind: "rename", path, initialName: name }); };
  const cancelEdit = () => setEdit(null);

  async function commitEdit(value: string) {
    const e = edit();
    if (!e) return;
    const name = value.trim();
    if (!name) { cancelEdit(); return; }
    try {
      if (e.kind === "newFile") {
        const path = `${e.parentDir}/${name}`;
        await fsApi.createFile(path);
        setEdit(null);
        refresh();
        props.onOpenFile?.(path);
      } else if (e.kind === "newFolder") {
        await fsApi.createDir(`${e.parentDir}/${name}`);
        setEdit(null);
        refresh();
      } else {
        if (name === e.initialName) { cancelEdit(); return; }
        const parent = e.path.split("/").slice(0, -1).join("/");
        await fsApi.rename(e.path, `${parent}/${name}`);
        setEdit(null);
        refresh();
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "error", 6000);
      // Leave the input open so the user can correct the name and retry.
    }
  }

  async function handleDelete(path: string, name: string) {
    closeMenu();
    // Native OS dialog via the Tauri plugin — unlike WKWebView's `confirm()`,
    // this actually shows on macOS.
    const ok = await dialogConfirm(`Delete "${name}"? This cannot be undone.`, {
      title: "Delete",
      kind: "warning",
    });
    if (!ok) return;
    try { await fsApi.delete(path); refresh(); }
    catch (e) { pushToast(e instanceof Error ? e.message : String(e), "error", 6000); }
  }

  return (
    <div class="flex-1 h-full overflow-y-auto scrollbar-thin py-1">
      <TreeDir
        path={props.root}
        depth={0}
        defaultExpanded
        refreshKey={refreshKey()}
        edit={edit}
        onCommitEdit={commitEdit}
        onCancelEdit={cancelEdit}
        onOpenFile={props.onOpenFile}
        onContextMenu={setContextMenu}
      />

      <Show when={contextMenu()}>
        {(m) => (
          <ContextMenuPopup
            state={m()}
            defaultBranch={defaultBranch()}
            onClose={closeMenu}
            onCompareWithDefault={() => compareWithDefault(m().path)}
            onNewFile={() => startNewFile(m().isDir ? m().path : m().path.split("/").slice(0, -1).join("/"))}
            onNewFolder={() => startNewFolder(m().isDir ? m().path : m().path.split("/").slice(0, -1).join("/"))}
            onRename={() => startRename(m().path, m().name)}
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
  defaultBranch: string;
  onClose: () => void;
  onCompareWithDefault: () => void;
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
        <Show when={!props.state.isDir}>
          <MenuBtn icon={GitCompare} onClick={props.onCompareWithDefault}>
            Compare with {props.defaultBranch}
          </MenuBtn>
          <div class="my-1 h-px bg-border mx-2" />
        </Show>
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
  edit: () => EditState | null;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
  onOpenFile?: (path: string) => void;
  onContextMenu: (state: ContextMenuState) => void;
}) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false);

  const [entries] = createResource(
    () => expanded() ? `${props.path}::${props.refreshKey}` : null,
    (key) => fsApi.listDir(key.split("::")[0]),
  );

  // A new-file/folder draft targeting this dir.
  const draft = () => {
    const e = props.edit();
    return e && (e.kind === "newFile" || e.kind === "newFolder") && e.parentDir === props.path ? e : null;
  };
  // Expand so the draft input is visible when creating into a collapsed dir.
  createEffect(() => { if (draft()) setExpanded(true); });

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
        <Show when={draft()}>
          {(d) => (
            <TreeInput
              depth={props.depth + 1}
              kind={d().kind === "newFolder" ? "folder" : "file"}
              onCommit={props.onCommitEdit}
              onCancel={props.onCancelEdit}
            />
          )}
        </Show>
        <For each={dirs()}>
          {(entry) => (
            <TreeDir
              path={entry.path}
              depth={props.depth + 1}
              label={entry.name}
              refreshKey={props.refreshKey}
              edit={props.edit}
              onCommitEdit={props.onCommitEdit}
              onCancelEdit={props.onCancelEdit}
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
              edit={props.edit}
              onCommitEdit={props.onCommitEdit}
              onCancelEdit={props.onCancelEdit}
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
  edit: () => EditState | null;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
  onOpenFile?: (path: string) => void;
  onContextMenu: (state: ContextMenuState) => void;
}) {
  const indent = () => `${props.depth * 12}px`;
  const renaming = () => {
    const e = props.edit();
    return e && e.kind === "rename" && e.path === props.entry.path;
  };
  return (
    <Show
      when={!renaming()}
      fallback={
        <TreeInput
          depth={props.depth}
          kind="file"
          initialValue={props.entry.name}
          onCommit={props.onCommitEdit}
          onCancel={props.onCancelEdit}
        />
      }
    >
    <button
      draggable={true}
      onDragStart={(e) => {
        // Carry the absolute path so a terminal pane can inject it on drop.
        // A custom mime keeps us from colliding with arbitrary text drags;
        // text/plain is the fallback for non-aware drop targets.
        e.dataTransfer?.setData("application/x-voidlink-path", props.entry.path);
        e.dataTransfer?.setData("text/plain", props.entry.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => props.onOpenFile?.(props.entry.path)}
      onContextMenu={e => { e.preventDefault(); props.onContextMenu({ x: e.clientX, y: e.clientY, path: props.entry.path, isDir: false, name: props.entry.name }); }}
      class="w-full flex items-center gap-1.5 py-0.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      style={{ "padding-left": `calc(20px + ${indent()})` }}
      title={props.entry.path}
    >
      <File class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <span class="truncate text-[13px]">{props.entry.name}</span>
    </button>
    </Show>
  );
}

/// Inline name editor used for new file/folder and rename. Mounts focused,
/// commits on Enter or blur, cancels on Escape. Indented to line up with the
/// tree row it stands in for. Replaces the old `window.prompt` flow, which
/// silently no-ops in macOS WKWebView.
function TreeInput(props: {
  depth: number;
  kind: "file" | "folder";
  initialValue?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const indent = () => `${props.depth * 12}px`;
  let inputRef: HTMLInputElement | undefined;
  // Guard so blur-after-commit (Enter moves focus away) doesn't fire twice.
  let done = false;
  const commit = () => { if (done) return; done = true; props.onCommit(inputRef?.value ?? ""); };
  const cancel = () => { if (done) return; done = true; props.onCancel(); };

  onMount(() => {
    queueMicrotask(() => {
      inputRef?.focus();
      // For rename, preselect the basename (sans extension) like editors do.
      const v = inputRef?.value ?? "";
      const dot = v.lastIndexOf(".");
      if (props.initialValue && dot > 0) inputRef?.setSelectionRange(0, dot);
      else inputRef?.select();
    });
  });

  const Icon = props.kind === "folder" ? Folder : File;
  return (
    <div
      class="w-full flex items-center gap-1.5 py-0.5"
      style={{ "padding-left": `calc(20px + ${indent()})` }}
    >
      <Icon class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <input
        ref={inputRef}
        value={props.initialValue ?? ""}
        spellcheck={false}
        autocapitalize="off"
        autocorrect="off"
        class="flex-1 min-w-0 bg-input/60 border border-primary/60 rounded px-1 py-0 text-[13px] text-foreground outline-none focus:border-primary"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        }}
        onBlur={commit}
      />
    </div>
  );
}
