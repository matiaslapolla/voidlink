import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import {
  PanelRightClose,
  PanelRightOpen,
  ChevronRight,
  Layers,
  GitBranch,
  Circle,
  X,
  FileText,
  GitCommit,
  Search,
  MessageSquare,
  Activity,
  Coins,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { useLayout } from "@/store/LayoutContext";
import type { WorkspaceState } from "@/types/workspace";
import type { ContextItem, ContextItemKind } from "@/types/context";
import type { GitRepoInfo } from "@/types/git";

interface RightSidebarProps {
  workspace: WorkspaceState | null;
  contextTokenEstimate: number;
  onRemoveContextItem: (id: string) => void;
  onOpenContextTab: () => void;
  repoPath: string | null;
}

const SECTIONS_KEY = "voidlink-right-sidebar-sections";

const KIND_ICON: Record<ContextItemKind, any> = {
  "search-result": Search,
  file: FileText,
  "diff-hunk": GitCommit,
  freetext: MessageSquare,
};

function loadSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { context: true, gitStatus: true, tokenUsage: true, activity: false };
}

function SectionHeader(props: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  badge?: string | number;
}) {
  return (
    <button
      onClick={props.onToggle}
      class="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
    >
      <ChevronRight
        class={`w-3 h-3 shrink-0 ${props.expanded ? "rotate-90" : ""}`}
        style={{ transition: "transform 80ms var(--ease-out-expo)" }}
      />
      <span class="flex-1 text-left">{props.title}</span>
      <Show when={props.badge}>
        <span class="text-xs bg-primary/15 text-primary rounded px-1.5 py-0.5 font-medium normal-case">
          {props.badge}
        </span>
      </Show>
    </button>
  );
}

export function RightSidebar(props: RightSidebarProps) {
  const [layout, actions] = useLayout();
  const collapsed = () => layout.rightCollapsed;

  const [sections, setSections] = createSignal(loadSections());
  const [gitInfo, setGitInfo] = createSignal<GitRepoInfo | null>(null);

  // Persist section state
  createEffect(() => {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections()));
  });

  // Fetch git info
  createEffect(() => {
    const repo = props.repoPath;
    if (!repo) {
      setGitInfo(null);
      return;
    }
    gitApi.repoInfo(repo).then(setGitInfo).catch(() => setGitInfo(null));
  });

  // Keyboard shortcut: Ctrl+Shift+B
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "B" && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        actions.toggleRight();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  const toggleSection = (key: string) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const contextItems = () => props.workspace?.contextItems ?? [];

  return (
    <Show
      when={!collapsed()}
      fallback={
        <aside class="w-8 bg-sidebar flex flex-col items-center py-2 flex-shrink-0">
          <button
            onClick={() => actions.toggleRight()}
            class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Expand panel (Ctrl+Shift+B)"
          >
            <PanelRightOpen class="w-4 h-4" />
          </button>
        </aside>
      }
    >
      <aside
        class="bg-sidebar flex flex-col flex-shrink-0 overflow-hidden"
        style={{ width: `${layout.rightWidth}px` }}
      >
        {/* Header */}
        <div class="px-3 py-2.5 border-b border-border flex items-center gap-2">
          <span class="flex-1 text-xs uppercase tracking-wider font-semibold text-muted-foreground">
            Info
          </span>
          <button
            onClick={() => actions.toggleRight()}
            class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse panel (Ctrl+Shift+B)"
          >
            <PanelRightClose class="w-3.5 h-3.5" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          {/* ── Context Section ─────────────────────────────────────── */}
          <SectionHeader
            title="Context"
            expanded={sections().context}
            onToggle={() => toggleSection("context")}
            badge={contextItems().length > 0 ? `${contextItems().length} items` : undefined}
          />
          <Show when={sections().context}>
            <div class="px-3 pb-3 space-y-1">
              <div class="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>~{props.contextTokenEstimate} tokens</span>
                <button
                  onClick={props.onOpenContextTab}
                  class="text-primary hover:underline"
                >
                  Open tab
                </button>
              </div>
              <Show
                when={contextItems().length > 0}
                fallback={
                  <p class="text-xs text-muted-foreground/80 py-2">
                    No context items
                  </p>
                }
              >
                <For each={contextItems()}>
                  {(item) => {
                    const Icon = KIND_ICON[item.kind];
                    return (
                      <div class="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/40 transition-colors">
                        <Icon class="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        <div class="flex-1 min-w-0">
                          <div class="text-xs truncate">{item.label}</div>
                          <div class="text-xs text-muted-foreground truncate">
                            ~{item.tokenEstimate} tok
                          </div>
                        </div>
                        <button
                          onClick={() => props.onRemoveContextItem(item.id)}
                          class="p-0.5 rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>
          </Show>

          {/* ── Git Status Section ──────────────────────────────────── */}
          <SectionHeader
            title="Git Status"
            expanded={sections().gitStatus}
            onToggle={() => toggleSection("gitStatus")}
          />
          <Show when={sections().gitStatus}>
            <div class="px-3 pb-3">
              <Show
                when={gitInfo()}
                fallback={
                  <p class="text-xs text-muted-foreground/80 py-2">
                    {props.repoPath ? "Loading..." : "No repository"}
                  </p>
                }
              >
                {(info) => (
                  <div class="space-y-2 text-xs">
                    <div class="flex items-center gap-1.5">
                      <GitBranch class="w-3.5 h-3.5 text-muted-foreground" />
                      <span class="font-medium">
                        {info().currentBranch ?? "(detached)"}
                      </span>
                    </div>
                    <Show when={!info().isClean}>
                      <div class="flex items-center gap-1.5 text-warning">
                        <Circle class="w-2 h-2 fill-current" />
                        <span>Uncommitted changes</span>
                      </div>
                    </Show>
                    <Show when={info().isClean}>
                      <div class="flex items-center gap-1.5 text-success">
                        <Circle class="w-2 h-2 fill-current" />
                        <span>Clean</span>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </Show>

          {/* ── Token Usage Section ─────────────────────────────────── */}
          <SectionHeader
            title="Token Usage"
            expanded={sections().tokenUsage}
            onToggle={() => toggleSection("tokenUsage")}
          />
          <Show when={sections().tokenUsage}>
            <div class="px-3 pb-3">
              <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Coins class="w-3.5 h-3.5" />
                <span>Context: ~{props.contextTokenEstimate} tokens</span>
              </div>
            </div>
          </Show>

          {/* ── Activity Section ────────────────────────────────────── */}
          <SectionHeader
            title="Activity"
            expanded={sections().activity}
            onToggle={() => toggleSection("activity")}
          />
          <Show when={sections().activity}>
            <div class="px-3 pb-3">
              <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity class="w-3.5 h-3.5" />
                <span>No recent activity</span>
              </div>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
