import { Show, createSignal } from "solid-js";
import { FolderOpen, RefreshCcw, RotateCw, Search, BarChart3, Brain, GitFork } from "lucide-solid";
import { RepositoryHeader } from "@/components/repository/RepositoryHeader";
import { SearchTab } from "@/components/repository/SearchTab";
import { GraphView } from "@/components/repository/GraphView";
import { EntityView } from "@/components/repository/EntityView";
import { DataFlowView } from "@/components/repository/DataFlowView";
import { useLayout } from "@/store/LayoutContext";
import type { WorkspaceState } from "@/types/workspace";
import type { SearchResult } from "@/types/migration";

export type RepoSubTab = "search" | "graph" | "entities" | "dataflows";

interface RepositoryViewProps {
  workspace: WorkspaceState;
  onSearch: () => void;
  onQueryChange: (v: string) => void;
  onAddContext: (result: SearchResult) => void;
  onChooseRepo: () => void;
  onScan: (full: boolean) => void;
}

function ActionCard(props: {
  icon: typeof FolderOpen;
  label: string;
  description: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      class="flex flex-col items-center gap-2 rounded-md border border-border p-5 bg-card/40 hover:bg-accent/30 cursor-pointer transition-colors text-center"
    >
      <Icon class="w-6 h-6 text-muted-foreground" />
      <span class="text-sm font-medium">{props.label}</span>
      <span class="text-xs text-muted-foreground">{props.description}</span>
    </button>
  );
}

const SUB_TABS: { id: RepoSubTab; label: string; icon: typeof Search }[] = [
  { id: "search", label: "Search", icon: Search },
  { id: "graph", label: "Graph", icon: BarChart3 },
  { id: "entities", label: "Entities", icon: Brain },
  { id: "dataflows", label: "Data Flows", icon: GitFork },
];

export function RepositoryView(props: RepositoryViewProps) {
  const [subTab, setSubTab] = createSignal<RepoSubTab>("search");
  const [, actions] = useLayout();

  const ws = () => props.workspace;
  const hasRepo = () => !!ws().repoRoot;
  const hasScanned = () => !!ws().scanStatus;

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* State A: No repo selected */}
      <Show when={!hasRepo()}>
        <div class="h-full flex items-center justify-center p-8">
          <div class="rounded-md border border-border p-8 bg-card/40 text-center max-w-md space-y-4">
            <FolderOpen class="w-12 h-12 mx-auto text-muted-foreground" />
            <h2 class="text-lg font-semibold">No Repository Selected</h2>
            <p class="text-sm text-muted-foreground">
              Choose a repository folder to start exploring your codebase.
            </p>
            <button
              onClick={props.onChooseRepo}
              class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <FolderOpen class="w-4 h-4" />
              Choose Repository
            </button>
          </div>
        </div>
      </Show>

      {/* State B: Repo selected, not yet scanned */}
      <Show when={hasRepo() && !hasScanned()}>
        <div class="h-full overflow-auto p-4 space-y-4">
          <div class="rounded-md border border-border p-3 bg-card/40 flex items-center gap-3">
            <FolderOpen class="w-5 h-5 shrink-0 text-muted-foreground" />
            <span class="text-sm font-medium truncate flex-1">{ws().repoRoot}</span>
            <button
              onClick={props.onChooseRepo}
              class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent/60 transition-colors"
            >
              Change
            </button>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <ActionCard
              icon={RefreshCcw}
              label="Scan"
              description="Index files incrementally"
              onClick={() => props.onScan(false)}
            />
            <ActionCard
              icon={RotateCw}
              label="Full Rescan"
              description="Rebuild all indexes from scratch"
              onClick={() => props.onScan(true)}
            />
          </div>
        </div>
      </Show>

      {/* State C: Scanned */}
      <Show when={hasRepo() && hasScanned()}>
        <RepositoryHeader scanStatus={ws().scanStatus} lastError={ws().lastError} />

        {/* Compact toolbar */}
        <div class="border-b border-border px-3 py-1.5 flex items-center gap-2">
          <FolderOpen class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span class="text-xs text-muted-foreground truncate flex-1">{ws().repoRoot}</span>
          <button
            onClick={props.onChooseRepo}
            class="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 transition-colors"
          >
            Change
          </button>
          <button
            onClick={() => props.onScan(false)}
            class="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 transition-colors"
          >
            <RefreshCcw class="w-3 h-3" />
            Scan
          </button>
          <button
            onClick={() => props.onScan(true)}
            class="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 transition-colors"
          >
            <RotateCw class="w-3 h-3" />
            Full Rescan
          </button>
        </div>

        {/* Sub-tab bar */}
        <div class="border-b border-border px-3 flex gap-0">
          {SUB_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                onClick={() => setSubTab(tab.id)}
                class={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  subTab() === tab.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                <Icon class="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Sub-tab content */}
        <div class="flex-1 overflow-hidden relative">
          <Show when={subTab() === "search"}>
            <SearchTab
              searchQuery={ws().searchQuery}
              searchResults={ws().searchResults}
              searching={ws().searching}
              repoRoot={ws().repoRoot}
              onQueryChange={props.onQueryChange}
              onSearch={props.onSearch}
              onAddContext={props.onAddContext}
              onOpenFile={(filePath, line) => {
                if (line != null) {
                  actions.openFileAtLine(ws().id, filePath, line);
                } else {
                  actions.openFile(ws().id, filePath);
                }
              }}
            />
          </Show>
          <Show when={subTab() === "graph"}>
            <GraphView repoPath={ws().repoRoot!} workspaceId={ws().id} />
          </Show>
          <Show when={subTab() === "entities"}>
            <EntityView repoPath={ws().repoRoot!} workspaceId={ws().id} />
          </Show>
          <Show when={subTab() === "dataflows"}>
            <DataFlowView repoPath={ws().repoRoot!} workspaceId={ws().id} />
          </Show>
        </div>
      </Show>
    </div>
  );
}
