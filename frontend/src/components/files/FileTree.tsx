import { For, Show, createSignal, createMemo, createEffect, on, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { createVirtualizer } from "@tanstack/solid-virtual";
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

// One flattened, windowed tree row. `depth` drives indentation exactly as the
// old recursive nodes did: a row's own nesting level for real entries (root's
// children = 1), and the parent dir's depth for the loading/empty placeholders.
type Row =
  | { kind: "dir"; path: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; path: string; name: string; depth: number }
  | { kind: "draft"; depth: number; draftKind: "file" | "folder" }
  | { kind: "loading"; depth: number }
  | { kind: "empty"; depth: number };

export function FileTree(props: { root: string; onOpenFile?: (path: string) => void }) {
  const { state, actions } = useAppStore();
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [edit, setEdit] = createSignal<EditState | null>(null);
  const refresh = () => setRefreshKey(k => k + 1);
  const closeMenu = () => setContextMenu(null);

  // The repo's trunk, used by "Compare with …" — prefer `main`, then `master`,
  // else the first local branch, falling back to "main" if the lookup fails (the
  // compare just errors visibly if wrong). Re-resolved whenever `root` changes:
  // the tree is not remounted on a workspace switch (its `<Show>` parent only
  // swaps the accessor's value), so a mount-only lookup would stay on the
  // previous repo's trunk.
  const [defaultBranch, setDefaultBranch] = createSignal("main");
  createEffect(on(() => props.root, async (root) => {
    setDefaultBranch("main");
    try {
      const branches = await gitApi.listBranches(root, false);
      const names = branches.map((b) => b.name);
      const trunk =
        names.find((n) => n === "main") ??
        names.find((n) => n === "master") ??
        names[0];
      // Ignore a response that lost the race against another switch.
      if (trunk && root === props.root) setDefaultBranch(trunk);
    } catch {
      // keep the "main" default
    }
  }));

  /// Open a compare tab (trunk → HEAD via merge-base) with this file
  /// pre-selected, so "Compare with main" lands straight on the file's diff.
  /// The compare model is repo-wide; we just focus the clicked path.
  function compareWithDefault(absPath: string) {
    closeMenu();
    const wtId = state.activeWorktreeId;
    const rel = absPath.startsWith(props.root + "/")
      ? absPath.slice(props.root.length + 1)
      : absPath;
    const id = actions.openCompareTab(wtId, {
      baseRef: defaultBranch(),
      headRef: "HEAD",
      useMergeBase: true,
    });
    actions.setCompareSelectedFile(wtId, id, rel);
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

  // ── Virtualized tree model ──────────────────────────────────────────────────
  // The tree is windowed with @tanstack/solid-virtual: we flatten the expanded
  // hierarchy into a linear list and mount only on-screen rows so large repos
  // scroll natively instead of rendering every row. The per-dir listing + expand
  // state — previously local to each recursive TreeDir — has to live here so the
  // flattener can walk it.

  // Expanded directory paths (absolute). The root is always expanded; its own
  // row is never rendered, only its contents.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([props.root]));
  // Directory listings, keyed by absolute path. Key present → its entries
  // ([] = listed-and-empty); key absent → not listed yet.
  const [dirCache, setDirCache] = createStore<Record<string, FsEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = createSignal<Set<string>>(new Set());

  const isExpanded = (path: string) => expanded().has(path);
  const toggleDir = (path: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  // List (or re-list) one directory into the cache.
  async function loadDir(path: string) {
    setLoadingDirs(s => new Set(s).add(path));
    try {
      const entries = await fsApi.listDir(path);
      setDirCache(path, entries);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    } finally {
      setLoadingDirs(s => { const n = new Set(s); n.delete(path); return n; });
    }
  }

  // Switching workspaces changes `root` in place — the sidebar's `<Show>` keeps
  // this component mounted and only swaps the accessor's value. Everything keyed
  // by absolute path (expand set, listings, in-flight markers) belongs to the old
  // repo at that point, and the new root is absent from `expanded`, so nothing
  // ever lists it and `walk` renders "Loading…" forever. Rebuild the state around
  // the new root; the lazy-list effect below then picks it up.
  createEffect(on(() => props.root, (root) => {
    setExpanded(new Set([root]));
    setDirCache(reconcile({}));
    setLoadingDirs(new Set<string>());
    setEdit(null);
    setContextMenu(null);
  }, { defer: true }));

  // Lazily list any expanded dir we haven't cached yet (initial mount + expands).
  createEffect(() => {
    for (const path of expanded()) {
      if (dirCache[path] === undefined && !loadingDirs().has(path)) void loadDir(path);
    }
  });
  // A refresh (create/rename/delete, or the external voidlink:refresh-files
  // event) re-lists every currently expanded dir. `defer` skips the mount run,
  // which the effect above already covers.
  createEffect(on(refreshKey, () => {
    for (const path of expanded()) void loadDir(path);
  }, { defer: true }));

  // A new-file/folder draft targeting a dir. Expand that dir so its inline input
  // is visible even when it was collapsed (preserves the old per-dir behavior).
  const draft = () => {
    const e = edit();
    return e && (e.kind === "newFile" || e.kind === "newFolder") ? e : null;
  };
  createEffect(() => {
    const d = draft();
    if (d && !isExpanded(d.parentDir)) setExpanded(prev => new Set(prev).add(d.parentDir));
  });

  // Flatten the expanded hierarchy into the linear list the virtualizer windows.
  // `depth` is the row's own nesting level (root's children = 1), matching the
  // original indentation math; placeholder rows carry the parent's depth.
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const activeDraft = draft();
    const byName = (a: FsEntry, b: FsEntry) => a.name.localeCompare(b.name);
    const draftRow = (depth: number): Row =>
      ({ kind: "draft", depth, draftKind: activeDraft!.kind === "newFolder" ? "folder" : "file" });

    const walk = (dirPath: string, depth: number) => {
      const parentDepth = depth - 1;
      const entries = dirCache[dirPath];
      // Not listed yet: show the loading placeholder (plus any draft input that
      // forced this dir open), then stop — we have nothing to recurse into.
      if (entries === undefined) {
        out.push({ kind: "loading", depth: parentDepth });
        if (activeDraft?.parentDir === dirPath) out.push(draftRow(depth));
        return;
      }
      if (activeDraft?.parentDir === dirPath) out.push(draftRow(depth));
      for (const e of entries.filter(x => x.isDir).sort(byName)) {
        const exp = isExpanded(e.path);
        out.push({ kind: "dir", path: e.path, name: e.name, depth, expanded: exp });
        if (exp) walk(e.path, depth + 1);
      }
      for (const e of entries.filter(x => !x.isDir).sort(byName))
        out.push({ kind: "file", path: e.path, name: e.name, depth });
      // "Empty" only for real subdirs (never the root), matching the old tree.
      if (entries.length === 0 && parentDepth > 0) out.push({ kind: "empty", depth: parentDepth });
    };

    walk(props.root, 1);
    return out;
  });

  // The virtualizer. The outer <div> is the scroll container; rows are compact
  // and near-uniform, so we estimate a fixed height and let measureElement
  // correct any variance (e.g. the slightly taller rename/new-entry input row).
  let scrollRef: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return rows().length; },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 24,
    overscan: 12,
  });

  // Render one flattened row. Kept in-scope so it can reach the tree's handlers
  // directly instead of drilling them through props like the old node components.
  function renderRow(r: Row | undefined) {
    if (!r) return null;
    switch (r.kind) {
      case "loading":
        return (
          <div class="text-xs text-muted-foreground/50 py-0.5" style={{ "padding-left": `calc(24px + ${r.depth * 12}px)` }}>
            Loading…
          </div>
        );
      case "empty":
        return (
          <div class="text-xs text-muted-foreground/50 py-0.5" style={{ "padding-left": `calc(24px + ${r.depth * 12}px)` }}>
            Empty
          </div>
        );
      case "draft":
        return (
          <TreeInput
            depth={r.depth}
            kind={r.draftKind}
            onCommit={commitEdit}
            onCancel={cancelEdit}
          />
        );
      case "dir":
        return (
          <button
            onClick={() => toggleDir(r.path)}
            onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, path: r.path, isDir: true, name: r.name }); }}
            class="w-full flex items-center gap-1 py-0.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
            style={{ "padding-left": `calc(8px + ${r.depth * 12}px)` }}
          >
            <span class="shrink-0 w-3 h-3 text-muted-foreground/60">
              {r.expanded ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
            </span>
            {r.expanded
              ? <FolderOpen class="w-3.5 h-3.5 shrink-0 text-warning/80" />
              : <Folder    class="w-3.5 h-3.5 shrink-0 text-warning/80" />
            }
            <span class="truncate text-[13px]">{r.name}</span>
          </button>
        );
      case "file": {
        const e = edit();
        // A rename in progress replaces the file row with the inline editor.
        if (e && e.kind === "rename" && e.path === r.path) {
          return (
            <TreeInput
              depth={r.depth}
              kind="file"
              initialValue={r.name}
              onCommit={commitEdit}
              onCancel={cancelEdit}
            />
          );
        }
        return (
          <button
            draggable={true}
            onDragStart={(ev) => {
              // Carry the absolute path so a terminal pane can inject it on drop.
              // A custom mime keeps us from colliding with arbitrary text drags;
              // text/plain is the fallback for non-aware drop targets.
              ev.dataTransfer?.setData("application/x-voidlink-path", r.path);
              ev.dataTransfer?.setData("text/plain", r.path);
              if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => props.onOpenFile?.(r.path)}
            onContextMenu={ev => { ev.preventDefault(); setContextMenu({ x: ev.clientX, y: ev.clientY, path: r.path, isDir: false, name: r.name }); }}
            class="w-full flex items-center gap-1.5 py-0.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
            style={{ "padding-left": `calc(20px + ${r.depth * 12}px)` }}
            title={r.path}
          >
            <File class="w-3.5 h-3.5 shrink-0 opacity-60" />
            <span class="truncate text-[13px]">{r.name}</span>
          </button>
        );
      }
    }
  }

  return (
    <div ref={scrollRef} class="flex-1 h-full overflow-y-auto scrollbar-thin py-1">
      {/* Inner spacer sized to the full list so the native scrollbar thumb stays
          proportional; only the windowed rows are absolutely positioned within. */}
      <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(vi) => {
            const row = () => rows()[vi.index];
            return (
              <div
                data-index={vi.index}
                ref={virtualizer.measureElement}
                class="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {renderRow(row())}
              </div>
            );
          }}
        </For>
      </div>

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
