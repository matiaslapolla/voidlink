import { For, Show, createMemo, createSignal } from "solid-js";
import { ChevronRight, FolderTree, List, Search } from "lucide-solid";
import type { FileDiff } from "@/types/git";
import type { CompareTreeMode } from "@/store/layout";

// Tree panel for the Compare tab. Mirrors the VSCode "git-tree-compare"
// experience: hierarchical view of changed files with status icons,
// per-folder rollups, compact-folder collapsing, and a fuzzy filter.
//
// Tree shape:
//   - Internal nodes are folders; their key is the joined relative path.
//   - Leaves are files; their key is `newPath ?? oldPath`.
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
      let next = cursor.children!.find((c) => c.path === segPath && c.children);
      if (!next) {
        next = {
          path: segPath,
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

function statusIcon(status: FileDiff["status"]) {
  switch (status) {
    case "added":
      return { ch: "A", color: "text-success" };
    case "deleted":
      return { ch: "D", color: "text-destructive" };
    case "renamed":
      return { ch: "R", color: "text-info" };
    case "copied":
      return { ch: "C", color: "text-info" };
    default:
      return { ch: "M", color: "text-warning" };
  }
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
                isRoot
              />
            </Show>
          </Show>
        </Show>
      </div>

      {/* Footer summary */}
      <Show when={props.files.length > 0}>
        <div class="px-3 py-1 border-t border-border text-[10px] text-muted-foreground tabular-nums shrink-0 flex items-center justify-between">
          <span>
            {props.files.length} file{props.files.length === 1 ? "" : "s"}
          </span>
          <span>
            <span class="text-success">
              +{props.files.reduce((s, f) => s + f.additions, 0)}
            </span>{" "}
            <span class="text-destructive">
              −{props.files.reduce((s, f) => s + f.deletions, 0)}
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
}) {
  const [open, setOpen] = createSignal(true);
  // When filter is active, force-open so matches are revealed.
  const isOpen = () => open() || props.filter.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
  const file = props.node.file!;
  const sel = () => props.selectedPath === props.node.path;
  const ic = () => statusIcon(file.status);

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
      <span class={`w-3 text-[10px] font-bold shrink-0 ${ic().color}`}>{ic().ch}</span>
      <span class="flex-1 truncate">{props.node.label}</span>
      <span class="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
        <span class="text-success">+{file.additions}</span>{" "}
        <span class="text-destructive">−{file.deletions}</span>
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
          const ic = () => statusIcon(file.status);
          return (
            <button
              type="button"
              onClick={() => props.onSelect(path)}
              class={`flex items-center w-full text-left gap-1.5 px-3 py-0.5 transition-colors ${
                sel() ? "bg-primary/15 text-primary" : "hover:bg-accent/30 text-foreground/85"
              }`}
              title={path}
            >
              <span class={`w-3 text-[10px] font-bold shrink-0 ${ic().color}`}>{ic().ch}</span>
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
