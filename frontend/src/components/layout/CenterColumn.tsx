import { Show, For, createMemo } from "solid-js";
import { MountOnce } from "@/components/layout/MountOnce";
import { RepositoryView } from "@/components/repository/RepositoryView";
import { ContextBuilderTab } from "@/components/context/ContextBuilderTab";
import { WorkflowTab } from "@/components/workflow/WorkflowTab";
import { AgentChatView } from "@/components/agent/AgentChatView";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { FileEditor } from "@/components/editor/FileEditor";
import { SplitDiffView } from "@/components/editor/SplitDiffView";
import { PromptStudioView } from "@/components/prompt-studio/PromptStudioView";
import { BreadcrumbBar } from "@/components/layout/BreadcrumbBar";
import { CenterTabBar } from "@/components/layout/CenterTabBar";
import { useLayout } from "@/store/LayoutContext";
import type { WorkspaceState } from "@/types/workspace";
import type { SearchResult } from "@/types/migration";
import type { TabInstance } from "@/store/layout";

interface CenterColumnProps {
  workspace: WorkspaceState;
  contextTokenEstimate: number;
  onSearch: () => void;
  onQueryChange: (v: string) => void;
  onAddContext: (result: SearchResult) => void;
  onRemoveContext: (id: string) => void;
  onAddFreetext: (label: string, content: string) => void;
  onObjectiveChange: (v: string) => void;
  onConstraintsChange: (v: string) => void;
  onGenerate: () => void;
  onRun: () => void;
  onChooseRepo: () => void;
  onScan: (full: boolean) => void;
}

const SINGLETON_TYPES = new Set(["repository", "contextBuilder", "workflow", "aiAgent", "promptStudio"]);

export function CenterColumn(props: CenterColumnProps) {
  const [layout] = useLayout();

  const tabState = createMemo(() => {
    return layout.centerTabsByWorkspace[props.workspace.id] ?? { tabs: [], activeTabId: "" };
  });

  const activeTab = createMemo((): TabInstance | undefined => {
    const state = tabState();
    return state.tabs.find((t) => t.id === state.activeTabId);
  });

  const activeType = createMemo(() => activeTab()?.type ?? "repository");

  const dynamicTabs = createMemo(() => {
    return tabState().tabs.filter((t) => !SINGLETON_TYPES.has(t.type));
  });

  const ws = () => props.workspace;

  return (
    <>
      <CenterTabBar workspaceId={props.workspace.id} />
      <BreadcrumbBar workspaceId={props.workspace.id} />

      <section class="flex-1 overflow-hidden relative">
        {/* Singleton: Repository */}
        <div
          class="absolute inset-0 h-full"
          style={{ display: activeType() === "repository" ? "block" : "none" }}
        >
          <RepositoryView
            workspace={ws()}
            onSearch={props.onSearch}
            onQueryChange={props.onQueryChange}
            onAddContext={props.onAddContext}
            onChooseRepo={props.onChooseRepo}
            onScan={props.onScan}
          />
        </div>

        {/* Singleton: Context Builder */}
        <div
          class="absolute inset-0 h-full"
          style={{ display: activeType() === "contextBuilder" ? "block" : "none" }}
        >
          <ContextBuilderTab
            contextItems={ws().contextItems}
            tokenEstimate={props.contextTokenEstimate}
            onRemoveItem={props.onRemoveContext}
            onAddFreetext={props.onAddFreetext}
          />
        </div>

        {/* Singleton: Workflow */}
        <div
          class="absolute inset-0 h-full"
          style={{ display: activeType() === "workflow" ? "block" : "none" }}
        >
          <WorkflowTab
            objective={ws().objective}
            constraintsText={ws().constraintsText}
            contextItems={ws().contextItems}
            contextTokenEstimate={props.contextTokenEstimate}
            workflow={ws().workflow}
            runState={ws().runState}
            generatingWorkflow={ws().generatingWorkflow}
            runningWorkflow={ws().runningWorkflow}
            onObjectiveChange={props.onObjectiveChange}
            onConstraintsChange={props.onConstraintsChange}
            onGenerate={props.onGenerate}
            onRun={props.onRun}
          />
        </div>

        {/* Singleton: Prompt Studio */}
        <div
          class="absolute inset-0 h-full overflow-hidden"
          style={{ display: activeType() === "promptStudio" ? "block" : "none" }}
        >
          <PromptStudioView />
        </div>

        {/* Singleton: AI Agent */}
        <MountOnce when={ws().repoRoot}>
          {(repoRoot) => (
            <div
              class="absolute inset-0 h-full overflow-hidden"
              style={{ display: activeType() === "aiAgent" ? "block" : "none" }}
            >
              <AgentChatView repoPath={repoRoot()} />
            </div>
          )}
        </MountOnce>

        {/* Dynamic tabs: file, image, svg, terminal */}
        <For each={dynamicTabs()}>
          {(tab) => (
            <div
              class="absolute inset-0 h-full overflow-hidden"
              style={{ display: activeTab()?.id === tab.id ? "block" : "none" }}
            >
              <Show when={tab.type === "file" || tab.type === "image" || tab.type === "svg"}>
                <FileEditor
                  filePath={tab.meta.filePath ?? null}
                  tabId={tab.id}
                  workspaceId={props.workspace.id}
                  repoPath={ws().repoRoot}
                />
              </Show>
              <Show when={tab.type === "diff" && tab.meta.filePath}>
                <SplitDiffView
                  filePath={tab.meta.filePath!}
                  repoPath={ws().repoRoot ?? ""}
                />
              </Show>
              <Show when={tab.type === "terminal" && tab.meta.ptyId}>
                <TerminalPane ptyId={tab.meta.ptyId!} class="w-full h-full" />
              </Show>
            </div>
          )}
        </For>
      </section>
    </>
  );
}
