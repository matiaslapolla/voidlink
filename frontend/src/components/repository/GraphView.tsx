import { createSignal, createEffect, on, Show, lazy } from "solid-js";
import { FolderTree, Globe, ArrowRightLeft, GitFork, Loader2, Box, Layout } from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { Graph2D, type GraphFilters } from "@/components/repository/Graph2D";
import { useLayout } from "@/store/LayoutContext";
import type { GraphNode, RepoGraph } from "@/types/migration";

const Graph3D = lazy(() => import("@/components/repository/Graph3D").then((m) => ({ default: m.Graph3D })));

interface GraphViewProps {
  repoPath: string;
  workspaceId: string;
}

export function GraphView(props: GraphViewProps) {
  const [graph, setGraph] = createSignal<RepoGraph | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [, actions] = useLayout();

  const [mode, setMode] = createSignal<"2d" | "3d">("2d");

  const [filters, setFilters] = createSignal<GraphFilters>({
    showDirectories: false,
    showExternals: false,
    showImportEdges: true,
    showParentEdges: false,
  });

  createEffect(
    on(
      () => props.repoPath,
      async (repoPath) => {
        if (!repoPath) return;
        setLoading(true);
        setError(null);
        try {
          const data = await migrationApi.getRepoGraph(repoPath);
          setGraph(data);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      },
    ),
  );

  function handleNodeClick(node: GraphNode) {
    if (node.nodeType === "file" && node.filePath) {
      actions.openFile(props.workspaceId, node.filePath);
    }
  }

  function toggleFilter(key: keyof GraphFilters) {
    setFilters((f) => ({ ...f, [key]: !f[key] }));
  }

  const stats = () => {
    const g = graph();
    if (!g) return null;
    const files = g.nodes.filter((n) => n.nodeType === "file").length;
    const dirs = g.nodes.filter((n) => n.nodeType === "directory").length;
    const ext = g.nodes.filter((n) => n.nodeType === "external").length;
    const imports = g.edges.filter((e) => e.edgeType === "import").length;
    return { files, dirs, ext, imports };
  };

  return (
    <div class="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div class="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-3 flex-wrap">
        <div class="inline-flex rounded border border-border overflow-hidden">
          <button
            onClick={() => setMode("2d")}
            class={`inline-flex items-center gap-1 px-2 py-0.5 text-xs transition-colors ${
              mode() === "2d" ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <Layout class="w-3 h-3" />
            2D
          </button>
          <button
            onClick={() => setMode("3d")}
            class={`inline-flex items-center gap-1 px-2 py-0.5 text-xs border-l border-border transition-colors ${
              mode() === "3d" ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <Box class="w-3 h-3" />
            3D
          </button>
        </div>

        <div class="w-px h-4 bg-border" />

        <span class="text-xs font-medium text-muted-foreground">Filters:</span>

        <button
          onClick={() => toggleFilter("showDirectories")}
          class={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs transition-colors ${
            filters().showDirectories
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/40"
          }`}
        >
          <FolderTree class="w-3 h-3" />
          Directories
        </button>

        <button
          onClick={() => toggleFilter("showExternals")}
          class={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs transition-colors ${
            filters().showExternals
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/40"
          }`}
        >
          <Globe class="w-3 h-3" />
          Externals
        </button>

        <button
          onClick={() => toggleFilter("showImportEdges")}
          class={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs transition-colors ${
            filters().showImportEdges
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/40"
          }`}
        >
          <ArrowRightLeft class="w-3 h-3" />
          Imports
        </button>

        <button
          onClick={() => toggleFilter("showParentEdges")}
          class={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs transition-colors ${
            filters().showParentEdges
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/40"
          }`}
        >
          <GitFork class="w-3 h-3" />
          Parent Edges
        </button>

        <Show when={stats()}>
          {(s) => (
            <span class="text-[10px] text-muted-foreground ml-auto">
              {s().files} files &middot; {s().dirs} dirs &middot; {s().ext} external &middot; {s().imports} imports
            </span>
          )}
        </Show>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-hidden relative">
        <Show when={loading()}>
          <div class="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
            <span class="ml-2 text-sm text-muted-foreground">Loading graph data...</span>
          </div>
        </Show>

        <Show when={error()}>
          {(err) => (
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive max-w-md">
                {err()}
              </div>
            </div>
          )}
        </Show>

        <Show when={!loading() && graph()}>
          {(g) => (
            <Show
              when={mode() === "3d"}
              fallback={
                <Graph2D
                  nodes={g().nodes}
                  edges={g().edges}
                  filters={filters()}
                  onNodeClick={handleNodeClick}
                />
              }
            >
              <Graph3D
                nodes={g().nodes}
                edges={g().edges}
                filters={filters()}
                onNodeClick={handleNodeClick}
              />
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
