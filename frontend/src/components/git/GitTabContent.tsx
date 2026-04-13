import { createSignal, createResource, Show, For } from "solid-js";
import {
  GitBranch,
  GitCommit,
  FolderGit2,
  GitPullRequest,
  History,
  Columns2,
  Rows3,
  Plus,
  Minus,
  Check,
  FilePlus,
  FileMinus,
  FileText,
  FileQuestion,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { DiffViewer } from "./DiffViewer";
import { SplitDiffViewer } from "./SplitDiffViewer";
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
  const [, setSelectedFile] = createSignal<string | null>(null);
  const [diffMode, setDiffMode] = createSignal<"unified" | "split">(
    (localStorage.getItem("voidlink-diff-mode") as "unified" | "split") ?? "unified",
  );

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
  const [workingDiff, { refetch: refetchDiff }] = createResource(
    () => props.repoPath,
    (path) => gitApi.diffWorking(path),
  );

  const [fileStatus, { refetch: refetchStatus }] = createResource(
    () => props.repoPath,
    (path) => gitApi.fileStatus(path),
  );

  // Commit form state
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [commitError, setCommitError] = createSignal("");
  const [commitSuccess, setCommitSuccess] = createSignal(false);

  const stagedFiles = () => (fileStatus() ?? []).filter((f) => f.staged);
  const unstagedFiles = () => (fileStatus() ?? []).filter((f) => !f.staged);

  async function handleStageFile(path: string) {
    await gitApi.stageFiles(props.repoPath, [path]);
    refetchStatus();
    refetchDiff();
  }

  async function handleUnstageFile(path: string) {
    await gitApi.unstageFiles(props.repoPath, [path]);
    refetchStatus();
    refetchDiff();
  }

  async function handleStageAll() {
    await gitApi.stageAll(props.repoPath);
    refetchStatus();
    refetchDiff();
  }

  async function handleCommit() {
    const msg = commitMsg().trim();
    if (!msg || stagedFiles().length === 0) return;
    setCommitting(true);
    setCommitError("");
    setCommitSuccess(false);
    try {
      await gitApi.commit(props.repoPath, msg);
      setCommitMsg("");
      setCommitSuccess(true);
      setTimeout(() => setCommitSuccess(false), 2500);
      refetchStatus();
      refetchDiff();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

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
                ? "bg-primary/15 text-primary font-medium"
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
          <div class="flex-1 flex flex-col overflow-hidden">
            {/* Diff mode toggle bar */}
            <div class="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-sidebar/50">
              <span class="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 mr-auto">
                Changes
              </span>
              <button
                onClick={() => { setDiffMode("unified"); localStorage.setItem("voidlink-diff-mode", "unified"); }}
                class={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                  diffMode() === "unified"
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                }`}
                title="Unified diff"
              >
                <Rows3 class="w-3 h-3" />
                Unified
              </button>
              <button
                onClick={() => { setDiffMode("split"); localStorage.setItem("voidlink-diff-mode", "split"); }}
                class={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                  diffMode() === "split"
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                }`}
                title="Side-by-side diff"
              >
                <Columns2 class="w-3 h-3" />
                Split
              </button>
            </div>
            <div class="flex-1 flex overflow-hidden">
              {/* Left panel: commit form + staging file list */}
              <div class="w-56 flex-shrink-0 border-r border-border bg-sidebar flex flex-col overflow-hidden">
                {/* Commit message */}
                <div class="p-2 border-b border-border/50">
                  <textarea
                    placeholder="Commit message"
                    value={commitMsg()}
                    onInput={(e) => setCommitMsg(e.currentTarget.value)}
                    class="w-full rounded-md bg-muted/50 border border-border/60 px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring"
                    rows={3}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        handleCommit();
                      }
                    }}
                  />
                  <div class="flex items-center gap-1.5 mt-1.5">
                    <button
                      disabled={committing() || stagedFiles().length === 0 || !commitMsg().trim()}
                      onClick={() => void handleCommit()}
                      class="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Show when={commitSuccess()} fallback={
                        committing() ? "Committing..." : <>Commit ({stagedFiles().length})</>
                      }>
                        <Check class="w-3 h-3" /> Done
                      </Show>
                    </button>
                    <button
                      onClick={() => void handleStageAll()}
                      class="px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                      title="Stage all changes"
                    >
                      <Plus class="w-3 h-3" />
                    </button>
                  </div>
                  <Show when={commitError()}>
                    <p class="text-[10px] text-destructive mt-1 truncate" title={commitError()}>{commitError()}</p>
                  </Show>
                </div>

                {/* Staged files */}
                <Show when={stagedFiles().length > 0}>
                  <div class="border-b border-border/50">
                    <div class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-success/80">
                      Staged ({stagedFiles().length})
                    </div>
                    <div class="max-h-32 overflow-y-auto scrollbar-thin">
                      <For each={stagedFiles()}>
                        {(f) => (
                          <div class="flex items-center gap-1.5 px-2.5 py-1 text-xs hover:bg-accent/40 group">
                            <StatusIcon status={f.status} />
                            <span
                              class="flex-1 truncate cursor-pointer hover:underline"
                              onClick={() => setSelectedFile(f.path)}
                            >
                              {f.path}
                            </span>
                            <button
                              onClick={() => void handleUnstageFile(f.path)}
                              class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                              title="Unstage"
                            >
                              <Minus class="w-3 h-3 text-muted-foreground" />
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Unstaged files */}
                <div class="flex-1 overflow-y-auto scrollbar-thin">
                  <div class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
                    Changes ({unstagedFiles().length})
                  </div>
                  <Show when={unstagedFiles().length === 0 && stagedFiles().length === 0 && !fileStatus.loading}>
                    <p class="px-2.5 py-2 text-[11px] text-muted-foreground">Working tree clean</p>
                  </Show>
                  <For each={unstagedFiles()}>
                    {(f) => (
                      <div class="flex items-center gap-1.5 px-2.5 py-1 text-xs hover:bg-accent/40 group">
                        <StatusIcon status={f.status} />
                        <span
                          class="flex-1 truncate cursor-pointer hover:underline"
                          onClick={() => setSelectedFile(f.path)}
                        >
                          {f.path}
                        </span>
                        <button
                          onClick={() => void handleStageFile(f.path)}
                          class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                          title="Stage"
                        >
                          <Plus class="w-3 h-3 text-muted-foreground" />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              {/* Right panel: diff viewer */}
              <div class="flex-1 overflow-y-auto p-3">
                <Show when={workingDiff()}>
                  {(diff) => (
                    <Show
                      when={diffMode() === "split"}
                      fallback={
                        <DiffViewer diff={diff()} onFileClick={setSelectedFile} onAddToContext={props.onAddToContext} />
                      }
                    >
                      <SplitDiffViewer diff={diff()} onFileClick={setSelectedFile} onAddToContext={props.onAddToContext} />
                    </Show>
                  )}
                </Show>
                <Show when={!workingDiff() && !workingDiff.loading}>
                  <div class="flex-1 flex items-center justify-center text-sm text-muted-foreground h-full">
                    Working tree is clean
                  </div>
                </Show>
              </div>
            </div>
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

// ─── Status icon helper ──────────────────────────────────────────────────────

function StatusIcon(props: { status: string }) {
  switch (props.status) {
    case "added":
    case "untracked":
      return <FilePlus class="w-3 h-3 text-success flex-shrink-0" />;
    case "deleted":
      return <FileMinus class="w-3 h-3 text-destructive flex-shrink-0" />;
    case "modified":
      return <FileText class="w-3 h-3 text-info flex-shrink-0" />;
    case "renamed":
      return <FileText class="w-3 h-3 text-warning flex-shrink-0" />;
    default:
      return <FileQuestion class="w-3 h-3 text-muted-foreground flex-shrink-0" />;
  }
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
                <span class="text-success">↑{b.ahead}</span>
              </Show>
              <Show when={b.behind > 0}>
                <span class="text-destructive">↓{b.behind}</span>
              </Show>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
