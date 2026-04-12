import { createEffect, on, onCleanup, onMount } from "solid-js";
import type { GraphNode, GraphEdge } from "@/types/migration";
import type { GraphFilters } from "@/components/repository/Graph2D";

interface Graph3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  filters: GraphFilters;
  onNodeClick: (node: GraphNode) => void;
}

const LANG_COLORS: Record<string, string> = {
  typescript: "#3178c6",
  javascript: "#f7df1e",
  rust: "#dea584",
  python: "#3572a5",
  go: "#00add8",
  java: "#b07219",
  css: "#563d7c",
  html: "#e34c26",
};

function nodeColor(node: GraphNode): string {
  if (node.nodeType === "directory") return "#6b7280";
  if (node.nodeType === "external") return "#4b5563";
  return LANG_COLORS[node.language ?? ""] ?? "#9ca3af";
}

function nodeRadius(node: GraphNode): number {
  if (node.nodeType === "directory") return 1.2;
  if (node.nodeType === "external") return 0.8;
  const bytes = node.sizeBytes ?? 500;
  return Math.max(0.5, Math.min(2.5, Math.sqrt(bytes / 500)));
}

function filterNodes(nodes: GraphNode[], filters: GraphFilters): GraphNode[] {
  return nodes.filter((n) => {
    if (n.nodeType === "directory" && !filters.showDirectories) return false;
    if (n.nodeType === "external" && !filters.showExternals) return false;
    return true;
  });
}

function filterEdges(edges: GraphEdge[], filters: GraphFilters, nodeIds: Set<string>): GraphEdge[] {
  return edges.filter((e) => {
    if (e.edgeType === "import" && !filters.showImportEdges) return false;
    if (e.edgeType === "path_parent" && !filters.showParentEdges) return false;
    return nodeIds.has(e.source) && nodeIds.has(e.target);
  });
}

function buildGraphData(nodes: GraphNode[], edges: GraphEdge[], filters: GraphFilters) {
  const filteredNodes = filterNodes(nodes, filters);
  const nodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = filterEdges(edges, filters, nodeIds);

  return {
    nodes: filteredNodes.map((n) => ({ ...n })),
    links: filteredEdges.map((e) => ({
      source: e.source,
      target: e.target,
      edgeType: e.edgeType,
    })),
  };
}

export function Graph3D(props: Graph3DProps) {
  let containerRef: HTMLDivElement | undefined;
  let graph: any = null;

  async function init() {
    if (!containerRef) return;

    const ForceGraph3D = (await import("3d-force-graph")).default;

    graph = ForceGraph3D()(containerRef)
      .backgroundColor("#0a0a0f")
      .nodeId("id")
      .nodeLabel((node: any) => (node as GraphNode).filePath ?? (node as GraphNode).label)
      .nodeColor((node: any) => nodeColor(node as GraphNode))
      .nodeRelSize(1)
      .nodeVal((node: any) => {
        const r = nodeRadius(node as GraphNode);
        return r * r * r;
      })
      .nodeOpacity(0.9)
      .linkColor((link: any) =>
        link.edgeType === "import" ? "rgba(96, 165, 250, 0.3)" : "rgba(107, 114, 128, 0.15)",
      )
      .linkWidth(0.3)
      .linkOpacity(0.6)
      .onNodeClick((node: any) => props.onNodeClick(node as GraphNode))
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .warmupTicks(50)
      .cooldownTicks(200)
      .graphData(buildGraphData(props.nodes, props.edges, props.filters));
  }

  onMount(() => {
    init().catch(console.error);
  });

  createEffect(
    on(
      () => [props.nodes, props.edges, props.filters] as const,
      () => {
        if (graph) {
          graph.graphData(buildGraphData(props.nodes, props.edges, props.filters));
        }
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    if (graph) {
      graph.pauseAnimation?.();
      (graph as any)._destructor?.();
      graph = null;
    }
  });

  return <div ref={containerRef} class="absolute inset-0" />;
}
