import { createSignal, createResource, Show } from "solid-js";
import {
  GitBranch,
  GitCommit,
  FolderGit2,
  GitPullRequest,
  History,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { DiffViewer } from "./DiffViewer";
import { DiffFileList } from "./DiffFileList";
import { DiffExplanationPanel } from "./DiffExplanation";
import { WorktreePanel } from "./WorktreePanel";
import { PrDashboard } from "./PrDashboard";
import { PrReviewView } from "./PrReviewView";
import { AuditLog } from "./AuditLog";
import { BranchesView } from "./BranchesView";

type GitView =
  | "status"
  | "diff"
  | "log"
  | "branches"
  | "worktrees"
  | "prs"
  | "review"
  | "audit";

interface GitTabContentProps {
  repoPath: string;
  onOpenTerminal?: (worktreePath: string) => void;
  onAddToContext?: (filePath: string, content: string) => void;
  initialView?: GitView;
}

const NAV_ITEMS: { view: GitView; label: string; Icon: any }[] = [
  { view: "status", label: "Status", Icon: FolderGit2 },
  { view: "diff", label: "Diff", Icon: GitCommit },
  { view: "branches", label: "Branches", Icon: GitBranch },
  { view: "worktrees", label: "Worktrees", Icon: FolderGit2 },
  { view: "prs", label: "Pull Requests", Icon: GitPullRequest },
  { view: "audit", label: "Audit", Icon: History },
];

const GIT_SIDEBAR_KEY = "voidlink-git-sidebar-width";
const MIN_WIDTH = 40;
const COLLAPSE_THRESHOLD = 56;
const DEFAULT_WIDTH = 160;

export function GitTabContent(props: GitTabContentProps) {
  const [view, setView] = createSignal<GitView>(props.initialView ?? "status");
  const [reviewPr, setReviewPr] = createSignal<number | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);

  const stored = localStorage.getItem(GIT_SIDEBAR_KEY);
  const [sidebarWidth, setSidebarWidth] = createSignal(
    stored ? Math.max(Number(stored), MIN_WIDTH) : DEFAULT_WIDTH,
  );

  const isCollapsed = () => sidebarWidth() < COLLAPSE_THRESHOLD;

  const handleResize = (delta: number) => {
    setSidebarWidth((w) => {
      const next = Math.max(MIN_WIDTH, w + delta);
      localStorage.setItem(GIT_SIDEBAR_KEY, String(next));
      return next;
    });
  };

  // Status / diff data
  const [workingDiff] = createResource(
    () => props.repoPath,
    (path) => gitApi.diffWorking(path),
  );

  const openReview = (prNumber: number) => {
    setReviewPr(prNumber);
    setView("review");
  };

  const handleTerminal = (worktreePath: string) => {
    props.onOpenTerminal?.(worktreePath);
  };

  return (
    <div class="flex h-full overflow-hidden">
      {/* Sidebar nav */}
      <div
        class="flex-shrink-0 border-r border-border flex flex-col py-2 gap-0.5 bg-sidebar overflow-hidden"
        style={{ width: `${sidebarWidth()}px` }}
      >
        {NAV_ITEMS.map(({ view: v, label, Icon }) => (
          <button
            onClick={() => {
              setView(v);
              if (v !== "review") setReviewPr(null);
            }}
            class={`flex items-center gap-2 py-2 text-xs transition-colors text-left ${
              isCollapsed() ? "justify-center px-0" : "px-3"
            } ${
              view() === v
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title={label}
          >
            <Icon class="w-3.5 h-3.5 flex-shrink-0" />
            <Show when={!isCollapsed()}>
              <span class="truncate">{label}</span>
            </Show>
          </button>
        ))}
      </div>

      {/* Resize handle */}
      <ResizeHandle direction="vertical" onResize={handleResize} />

      {/* Main content */}
      <div class="flex-1 overflow-hidden flex flex-col">
        <Show when={view() === "status"}>
          <div class="flex-1 flex overflow-hidden">
            <Show when={workingDiff()}>
              {(diff) => (
                <>
                  <div class="w-48 flex-shrink-0">
                    <DiffFileList
                      files={diff().files}
                      selectedFile={selectedFile() ?? undefined}
                      onSelectFile={setSelectedFile}
                    />
                  </div>
                  <div class="flex-1 overflow-y-auto p-3">
                    <DiffViewer diff={diff()} onFileClick={setSelectedFile} onAddToContext={props.onAddToContext} />
                  </div>
                </>
              )}
            </Show>
            <Show when={!workingDiff() && !workingDiff.loading}>
              <div class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Working tree is clean
              </div>
            </Show>
          </div>
        </Show>

        <Show when={view() === "diff"}>
          <div class="flex-1 overflow-y-auto p-4 space-y-4">
            <DiffExplanationPanel
              repoPath={props.repoPath}
              base="HEAD~1"
              head="HEAD"
            />
            <Show when={workingDiff()}>
              {(diff) => <DiffViewer diff={diff()} onAddToContext={props.onAddToContext} />}
            </Show>
          </div>
        </Show>

        <Show when={view() === "branches"}>
          <div class="flex-1 overflow-y-auto p-4">
            <BranchesView repoPath={props.repoPath} />
          </div>
        </Show>

        <Show when={view() === "worktrees"}>
          <div class="flex-1 overflow-y-auto p-4">
            <WorktreePanel
              repoPath={props.repoPath}
              onOpenTerminal={handleTerminal}
            />
          </div>
        </Show>

        <Show when={view() === "prs"}>
          <div class="flex-1 overflow-y-auto p-4">
            <PrDashboard
              repoPath={props.repoPath}
              onOpenReview={openReview}
            />
          </div>
        </Show>

        <Show when={view() === "review" && reviewPr() !== null}>
          <div class="flex-1 overflow-hidden">
            <PrReviewView
              repoPath={props.repoPath}
              prNumber={reviewPr()!}
              onBack={() => setView("prs")}
              onMerged={() => setView("prs")}
            />
          </div>
        </Show>

        <Show when={view() === "audit"}>
          <div class="flex-1 overflow-y-auto p-4">
            <AuditLog repoPath={props.repoPath} />
          </div>
        </Show>
      </div>
    </div>
  );
}
