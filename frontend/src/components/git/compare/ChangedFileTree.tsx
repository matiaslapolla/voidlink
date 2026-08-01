import { For, Show, createMemo, createSignal } from "solid-js";
import { ChevronRight, FolderTree, List, Search } from "lucide-solid";
import type { FileDiff } from "@/types/git";
import type { CompareTreeMode } from "@/store/layout";
import { StatusBadge } from "@/components/git/shared/StatusBadge";

// Tree panel for the Compare tab. Mirrors the VSCode "git-tree-compare"
// experience: hierarchical view of changed files with status icons,
// per-folder rollups, compact-folder collapsing, and a fuzzy filter.
//
// Tree shape:
//   - Internal nodes are folders; their path is the joined relative path and
//     their key is that plus a trailing slash.
//   - Leaves are files; their path and key are both `newPath ?? oldPath`.
// Compact-mode collapses chains of single-child folders into one segment.

type Props = {
  files: FileDiff[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  mode: CompareTreeMode;
  filter: string;
  onModeChange: (mode: CompareTreeMode) => void;
  onFilterChange: (filter: string) => void;
};

interface TreeNode {
  // Path relative to the repo root, joined with "/".
  path: string;
  /// The node's identity, distinct from its path.
  ///
  /// A path does not identify a row, because a commit can turn a file into a
  /// directory (or the reverse) and then both exist in one diff: `swap`
  /// deleted as a file, `swap/inner.ts` added under a directory of the same
  /// name. Both nodes carried `path: "swap"`, so anything keyed on the path —
  /// the collapse set, and any future selection or scroll-to — could not tell
  /// which of the two rows it meant. Folders get a trailing slash, which is
  /// exactly the character git itself uses to tell the two apart and which no
  /// path component may contain.
  key: string;
  // The display segment(s) used for this row. With compact folders enabled,
  // a chain `a/b/c` whose only descendant lives below collapses into a single
  // node displayed as `a/b/c`.
  label: string;
  // null for files; populated for folders.
  children: TreeNode[] | null;
  // Aggregate counts (for folders) or per-file counts (for files).
  additions: number;
  deletions: number;
  fileCount: number;
  // For files only.
  file?: FileDiff;
}

function pathOf(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? "";
}

function buildTree(files: FileDiff[]): TreeNode {
  const root: TreeNode = {
    path: "",
    key: "",
    label: "",
    children: [],
    additions: 0,
    deletions: 0,
    fileCount: 0,
  };

  for (const file of files) {
    const fullPath = pathOf(file);
    if (!fullPath) continue;
    const parts = fullPath.split("/");

    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const segPath = parts.slice(0, i + 1).join("/");
      let next = cursor.children!.find((c) => c.key === `${segPath}/`);
      if (!next) {
        next = {
          path: segPath,
          key: `${segPath}/`,
          label: seg,
          children: [],
          additions: 0,
          deletions: 0,
          fileCount: 0,
        };
        cursor.children!.push(next);
      }
      cursor = next;
    }

    cursor.children!.push({
      path: fullPath,
      key: fullPath,
      label: parts[parts.length - 1],
      children: null,
      additions: file.additions,
      deletions: file.deletions,
      fileCount: 1,
      file,
    });
  }

  // Roll up counts. Sort folders first, then files; both alphabetically.
  function aggregate(node: TreeNode) {
    if (!node.children) return;
    for (const child of node.children) aggregate(child);
    node.children.sort((a, b) => {
      const aDir = a.children !== null;
      const bDir = b.children !== null;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    node.additions = node.children.reduce((s, c) => s + c.additions, 0);
    node.deletions = node.children.reduce((s, c) => s + c.deletions, 0);
    node.fileCount = node.children.reduce((s, c) => s + c.fileCount, 0);
  }
  aggregate(root);

  // Compact: a folder with exactly one folder-child collapses into a chain.
  function compact(node: TreeNode): TreeNode {
    if (!node.children) return node;
    const collapsed = node.children.map(compact);
    if (
      node !== root &&
      collapsed.length === 1 &&
      collapsed[0].children !== null
    ) {
      const only = collapsed[0];
      return {
        path: only.path,
        key: only.key,
        label: `${node.label}/${only.label}`,
        children: only.children,
        additions: only.additions,
        deletions: only.deletions,
        fileCount: only.fileCount,
      };
    }
    return { ...node, children: collapsed };
  }
  return compact(root);
}

function fuzzyMatches(filter: string, path: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  const p = path.toLowerCase();
  // Plain substring is enough for this v1 — matches git-tree-compare's behavior.
  return p.includes(f);
}

export function ChangedFileTree(props: Props) {
  const tree = createMemo(() => buildTree(props.files));

  /// Which folders the user collapsed, by node key.
  ///
  /// Owned here rather than by each `FolderRow`, because the rows do not
  /// survive a refetch: `buildTree` allocates all-new nodes, `<For>` keys by
  /// object identity, and every row is therefore disposed and recreated —
  /// taking a `createSignal(true)` inside it with them. So every folder sprang
  /// back open on every git pulse, which with the filesystem watcher running is
  /// often. Keys outlive the nodes; the state is keyed on those instead — and
  /// on the node *key* rather than its path, because a file and a directory of
  /// the same name can both be in one diff and share a path.
  ///
  /// Collapsed-set rather than open-set so a folder that appears for the first
  /// time defaults to open, which is what the previous `createSignal(true)`
  /// meant.
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const isOpen = (key: string) => !collapsed().has(key);
  const toggleOpen = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const filteredFiles = createMemo(() => {
    if (!props.filter) return props.files;
    return props.files.filter((f) => fuzzyMatches(props.filter, pathOf(f)));
  });

  return (
    <div class="flex flex-col h-full bg-sidebar/40">
      {/* Toolbar */}
      <div class="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <div class="flex items-center flex-1 gap-1.5 px-2 py-0.5 rounded-md border border-border bg-background/60 focus-within:border-primary/50 transition-colors">
          <Search class="w-3 h-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={props.filter}
            onInput={(e) => props.onFilterChange(e.currentTarget.value)}
            placeholder="Filter files…"
            class="flex-1 min-w-0 bg-transparent outline-none text-[11px] placeholder:text-muted-foreground/60"
            aria-label="Filter changed files"
          />
        </div>
        <div
          role="group"
          aria-label="File tree mode"
          class="flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          <button
            onClick={() => props.onModeChange("tree")}
            aria-label="Tree view"
            aria-pressed={props.mode === "tree"}
            class={`p-0.5 rounded transition-colors ${
              props.mode === "tree"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Tree"
          >
            <FolderTree class="w-3 h-3" />
          </button>
          <button
            onClick={() => props.onModeChange("flat")}
            aria-label="Flat list view"
            aria-pressed={props.mode === "flat"}
            class={`p-0.5 rounded transition-colors ${
              props.mode === "flat"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Flat list"
          >
            <List class="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div class="flex-1 overflow-auto scrollbar-thin py-1 text-[12px]">
        <Show
          when={props.files.length > 0}
          fallback={
            <div class="h-full flex items-center justify-center text-muted-foreground text-[11px] italic">
              No differences.
            </div>
          }
        >
          <Show
            when={props.mode === "tree"}
            fallback={
              <FlatList
                files={filteredFiles()}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
              />
            }
          >
            <Show
              when={filteredFiles().length > 0}
              fallback={
                <div class="px-3 py-2 text-[11px] text-muted-foreground italic">
                  No matches for “{props.filter}”.
                </div>
              }
            >
              <TreeBranch
                node={tree()}
                depth={0}
                filter={props.filter}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
                isOpen={isOpen}
                onToggle={toggleOpen}
                isRoot
              />
            </Show>
          </Show>
        </Show>
      </div>

      {/* Footer summary.
          Counts the files actually listed. It used to reduce over the
          unfiltered `props.files` while the body above showed the filtered
          set, so typing into the filter left a footer describing a different
          list — and "of N" is spelled out rather than implied, so a filtered
          view never looks like the whole diff. */}
      <Show when={props.files.length > 0}>
        <div class="px-3 py-1 border-t border-border text-[10px] text-muted-foreground tabular-nums shrink-0 flex items-center justify-between">
          <span>
            {filteredFiles().length} file{filteredFiles().length === 1 ? "" : "s"}
            <Show when={filteredFiles().length !== props.files.length}>
              <span class="opacity-70"> of {props.files.length}</span>
            </Show>
          </span>
          <span>
            <span class="text-success">
              +{filteredFiles().reduce((s, f) => s + f.additions, 0)}
            </span>{" "}
            <span class="text-destructive">
              −{filteredFiles().reduce((s, f) => s + f.deletions, 0)}
            </span>
          </span>
        </div>
      </Show>
    </div>
  );
}

function TreeBranch(props: {
  node: TreeNode;
  depth: number;
  filter: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  isRoot?: boolean;
}) {
  // Hide branches that don't contain any matching file when filter is active.
  const visible = createMemo(() => {
    if (!props.filter) return props.node;
    function prune(n: TreeNode): TreeNode | null {
      if (!n.children) {
        return fuzzyMatches(props.filter, n.path) ? n : null;
      }
      const kept = n.children.map(prune).filter((c): c is TreeNode => c !== null);
      if (kept.length === 0) return null;
      const additions = kept.reduce((s, c) => s + c.additions, 0);
      const deletions = kept.reduce((s, c) => s + c.deletions, 0);
      const fileCount = kept.reduce((s, c) => s + c.fileCount, 0);
      return { ...n, children: kept, additions, deletions, fileCount };
    }
    return prune(props.node);
  });

  return (
    <Show when={visible()}>
      {(node) => (
        <Show when={!props.isRoot} fallback={<RootChildren node={node()} props={props} />}>
          <FolderRow
            node={node()}
            depth={props.depth}
            filter={props.filter}
            selectedPath={props.selectedPath}
            onSelect={props.onSelect}
            isOpen={props.isOpen}
            onToggle={props.onToggle}
          />
        </Show>
      )}
    </Show>
  );
}

function RootChildren(props: { node: TreeNode; props: Parameters<typeof TreeBranch>[0] }) {
  return (
    <For each={props.node.children ?? []}>
      {(child) => (
        <Show
          when={child.children !== null}
          fallback={
            <FileRow
              node={child}
              depth={0}
              selectedPath={props.props.selectedPath}
              onSelect={props.props.onSelect}
            />
          }
        >
          <TreeBranch
            node={child}
            depth={0}
            filter={props.props.filter}
            selectedPath={props.props.selectedPath}
            onSelect={props.props.onSelect}
            isOpen={props.props.isOpen}
            onToggle={props.props.onToggle}
          />
        </Show>
      )}
    </For>
  );
}

function FolderRow(props: {
  node: TreeNode;
  depth: number;
  filter: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  // When filter is active, force-open so matches are revealed.
  const isOpen = () => props.isOpen(props.node.key) || props.filter.length > 0;
  const setOpen = () => props.onToggle(props.node.key);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen()}
        class="flex items-center w-full text-left gap-1 pr-2 py-0.5 hover:bg-accent/30 transition-colors"
        style={{ "padding-left": `${props.depth * 12 + 6}px` }}
        aria-expanded={isOpen()}
      >
        <ChevronRight
          class={`w-3 h-3 shrink-0 text-muted-foreground transition-transform ${
            isOpen() ? "rotate-90" : ""
          }`}
        />
        <span class="flex-1 truncate text-foreground/85">{props.node.label}/</span>
        <span class="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
          <span class="text-success">+{props.node.additions}</span>{" "}
          <span class="text-destructive">−{props.node.deletions}</span>
        </span>
        <span class="text-[10px] tabular-nums text-muted-foreground/50 shrink-0 w-10 text-right">
          {props.node.fileCount}
        </span>
      </button>
      <Show when={isOpen()}>
        <For each={props.node.children ?? []}>
          {(child) => (
            <Show
              when={child.children !== null}
              fallback={
                <FileRow
                  node={child}
                  depth={props.depth + 1}
                  selectedPath={props.selectedPath}
                  onSelect={props.onSelect}
                />
              }
            >
              <FolderRow
                node={child}
                depth={props.depth + 1}
                filter={props.filter}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
                isOpen={props.isOpen}
                onToggle={props.onToggle}
              />
            </Show>
          )}
        </For>
      </Show>
    </div>
  );
}

function FileRow(props: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  // Reactive. It used to be read once at creation, which was safe only because
  // every row was rebuilt on every refetch — the very thing fixed above. Fixing
  // one without the other would have turned a cosmetic annoyance into a row
  // showing another file's status.
  const file = () => props.node.file!;
  const sel = () => props.selectedPath === props.node.path;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.node.path)}
      class={`flex items-center w-full text-left gap-1.5 pr-2 py-0.5 transition-colors ${
        sel() ? "bg-primary/15 text-primary" : "hover:bg-accent/30 text-foreground/85"
      }`}
      style={{ "padding-left": `${props.depth * 12 + 18}px` }}
      title={props.node.path}
    >
      <StatusBadge status={file().status} />
      <span class="flex-1 truncate">{props.node.label}</span>
      <span class="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
        <span class="text-success">+{file().additions}</span>{" "}
        <span class="text-destructive">−{file().deletions}</span>
      </span>
    </button>
  );
}

function FlatList(props: {
  files: FileDiff[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const sorted = createMemo(() =>
    [...props.files].sort((a, b) => pathOf(a).localeCompare(pathOf(b))),
  );

  return (
    <Show
      when={sorted().length > 0}
      fallback={
        <div class="px-3 py-2 text-[11px] text-muted-foreground italic">
          No matches.
        </div>
      }
    >
      <For each={sorted()}>
        {(file) => {
          const path = pathOf(file);
          const sel = () => props.selectedPath === path;
          return (
            <button
              type="button"
              onClick={() => props.onSelect(path)}
              class={`flex items-center w-full text-left gap-1.5 px-3 py-0.5 transition-colors ${
                sel() ? "bg-primary/15 text-primary" : "hover:bg-accent/30 text-foreground/85"
              }`}
              title={path}
            >
              <StatusBadge status={file.status} />
              <span class="flex-1 truncate">{path}</span>
              <span class="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
                <span class="text-success">+{file.additions}</span>{" "}
                <span class="text-destructive">−{file.deletions}</span>
              </span>
            </button>
          );
        }}
      </For>
    </Show>
  );
}
