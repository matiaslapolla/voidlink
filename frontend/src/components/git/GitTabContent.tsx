import { createSignal, createResource, Show } from "solid-js";
import {
  GitBranch,
  GitCommit,
  FolderGit2,
  GitPullRequest,
  History,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { DiffViewer } from "./DiffViewer";
import { DiffFileList } from "./DiffFileList";
import { DiffExplanationPanel } from "./DiffExplanation";
import { WorktreePanel } from "./WorktreePanel";
import { PrDashboard } from "./PrDashboard";
import { PrReviewView } from "./PrReviewView";
import { AuditLog } from "./AuditLog";

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

export function GitTabContent(props: GitTabContentProps) {
  const [view, setView] = createSignal<GitView>(props.initialView ?? "status");
  const [reviewPr, setReviewPr] = createSignal<number | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);

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
      <div class="w-40 flex-shrink-0 border-r border-border flex flex-col py-2 gap-0.5 bg-sidebar">
        {NAV_ITEMS.map(({ view: v, label, Icon }) => (
          <button
            onClick={() => {
              setView(v);
              if (v !== "review") setReviewPr(null);
            }}
            class={`flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left ${
              view() === v
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <Icon class="w-3.5 h-3.5 flex-shrink-0" />
            {label}
          </button>
        ))}
      </div>

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
                    <DiffViewer diff={diff()} onFileClick={setSelectedFile} />
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
              {(diff) => <DiffViewer diff={diff()} />}
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

// ─── Inline branches view ─────────────────────────────────────────────────────

function BranchesView(props: { repoPath: string }) {
  const [branches] = createResource(
    () => props.repoPath,
    (path) => gitApi.listBranches(path, true),
  );

  return (
    <div class="space-y-2">
      <h3 class="text-sm font-semibold">Branches</h3>
      <Show when={branches.loading}>
        <p class="text-xs text-muted-foreground">Loading…</p>
      </Show>
      <div class="space-y-1">
        {(branches() ?? []).map((b) => (
          <div
            class={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
              b.isHead ? "bg-primary/10 border border-primary/20" : "border border-border"
            }`}
          >
            <GitBranch class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span class={b.isHead ? "font-semibold text-primary" : ""}>{b.name}</span>
            <Show when={b.isHead}>
              <span class="text-xs text-primary/60">HEAD</span>
            </Show>
            <div class="ml-auto flex items-center gap-2 text-muted-foreground">
              <Show when={b.lastCommitSummary}>
                <span class="max-w-40 truncate">{b.lastCommitSummary}</span>
              </Show>
              <Show when={b.ahead > 0}>
                <span class="text-green-500">↑{b.ahead}</span>
              </Show>
              <Show when={b.behind > 0}>
                <span class="text-red-400">↓{b.behind}</span>
              </Show>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
