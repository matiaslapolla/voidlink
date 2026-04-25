import { For, Show, createMemo, createResource, createSignal, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import {
  GitBranch,
  GitCommit,
  History,
  Plus,
  Minus,
  Check,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  FilePlus,
  FileMinus,
  FileText,
  FileQuestion,
  Upload,
  RefreshCw,
  GitCompare,
  X,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import type { GitCommitInfo } from "@/types/git";

type LucideIcon = Component<{ class?: string }>;

function IconBtn(props: { label: string; onClick: () => void; children: JSX.Element; class?: string }) {
  return (
    <button
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      class={`p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  );
}

interface GitSidebarProps {
  repoPath: string;
  workspaceId: string;
}

function Section(props: {
  label: string;
  icon: JSX.Element;
  open: boolean;
  isLast: boolean;
  onToggle: () => void;
  actions?: JSX.Element;
  children: JSX.Element;
  contentHeight: number;
  onResizeStart: (e: MouseEvent) => void;
}) {
  return (
    <div
      class={`flex flex-col border-b border-border/50 last:border-b-0 ${props.isLast && props.open ? "flex-1 min-h-0" : "shrink-0"}`}
    >
      <button
        onClick={props.onToggle}
        class="flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors w-full text-left shrink-0"
      >
        <span class="w-3 h-3 shrink-0">
          {props.open ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
        </span>
        {props.icon}
        <span class="flex-1 uppercase tracking-wide text-xs">{props.label}</span>
        <span onClick={(e) => e.stopPropagation()}>{props.actions}</span>
      </button>
      <Show when={props.open}>
        <div
          class={`overflow-y-auto scrollbar-thin ${props.isLast ? "flex-1 min-h-0" : "shrink-0"}`}
          style={!props.isLast ? { height: `${props.contentHeight}px` } : undefined}
        >
          {props.children}
        </div>
        <Show when={!props.isLast}>
          <div
            class="h-1.5 cursor-row-resize shrink-0 hover:bg-primary/30 transition-colors"
            onMouseDown={props.onResizeStart}
          />
        </Show>
      </Show>
    </div>
  );
}

export function GitSidebar(props: GitSidebarProps) {
  const { state, activeDiffTabs, activeItem, actions } = useAppStore();

  const [sidebarWidth, setSidebarWidth] = createSignal(320);
  const [sectionHeights, setSectionHeights] = createSignal({ changes: 200, branches: 140, history: 200, openedDiffs: 140 });

  function startWidthResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth();
    function onMove(mv: MouseEvent) {
      setSidebarWidth(Math.max(220, Math.min(600, startW - (mv.clientX - startX))));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startSectionResize(key: keyof ReturnType<typeof sectionHeights>) {
    return (e: MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = sectionHeights()[key];
      function onMove(mv: MouseEvent) {
        setSectionHeights(h => ({ ...h, [key]: Math.max(60, startH + mv.clientY - startY) }));
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
  }

  const [repoInfo, { refetch: refetchInfo }] = createResource(
    () => props.repoPath,
    (p) => gitApi.repoInfo(p),
  );
  const [status, { refetch: refetchStatus }] = createResource(
    () => props.repoPath,
    (p) => gitApi.fileStatus(p),
  );

  const activeFilePath = createMemo(() => {
    const item = activeItem();
    if (item?.type !== "diff") return null;
    return activeDiffTabs().find((t) => t.id === item.id)?.filePath ?? null;
  });

  const activeDiffId = () => {
    const a = activeItem();
    return a?.type === "diff" ? a.id : null;
  };

  const isRefreshing = () => repoInfo.loading || status.loading;

  const refreshAll = () => {
    refetchStatus();
    refetchInfo();
  };

  // Determine which sections are open (in order) to find the last one
  const lastOpenSection = createMemo(() => {
    const order = ["changes", "branches", "history", "openedDiffs"] as const;
    const openKeys = order.filter(k => state.gitSections[k]);
    return openKeys[openKeys.length - 1] ?? null;
  });

  return (
    <aside
      class="flex flex-col border-l border-border bg-sidebar overflow-hidden relative"
      style={{ width: `${sidebarWidth()}px` }}
    >
      {/* Left resize handle */}
      <div
        class="absolute top-0 left-0 w-1 h-full cursor-col-resize z-20 hover:bg-primary/30 transition-colors"
        onMouseDown={startWidthResize}
      />

      {/* Header */}
      <div class="px-3 h-9 border-b border-border flex items-center gap-2 text-xs shrink-0">
        <GitBranch class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span class="font-medium truncate">
          {repoInfo()?.currentBranch ?? "—"}
        </span>
        <Show when={repoInfo()?.isClean === false}>
          <span class="text-warning text-xs">• changes</span>
        </Show>
        <div class="ml-auto flex items-center gap-0.5">
          <IconBtn label="Refresh" onClick={refreshAll}>
            <RefreshCw class={`w-3 h-3 ${isRefreshing() ? "animate-spin" : ""}`} />
          </IconBtn>
          <IconBtn label="Collapse git panel" onClick={() => actions.toggleGitSidebar()}>
            <ChevronRight class="w-3.5 h-3.5" />
          </IconBtn>
        </div>
      </div>

      {/* Collapsible sections */}
      <div class="flex-1 flex flex-col overflow-hidden">
        <Section
          label="Changes"
          icon={<GitCommit class="w-3 h-3" />}
          open={state.gitSections.changes}
          isLast={lastOpenSection() === "changes"}
          onToggle={() => actions.toggleGitSection("changes")}
          contentHeight={sectionHeights().changes}
          onResizeStart={startSectionResize("changes")}
        >
          <ChangesPane
            repoPath={props.repoPath}
            workspaceId={props.workspaceId}
            status={status()}
            onRefresh={refreshAll}
            selectedFile={activeFilePath()}
          />
        </Section>

        <Section
          label="Branches"
          icon={<GitBranch class="w-3 h-3" />}
          open={state.gitSections.branches}
          isLast={lastOpenSection() === "branches"}
          onToggle={() => actions.toggleGitSection("branches")}
          contentHeight={sectionHeights().branches}
          onResizeStart={startSectionResize("branches")}
        >
          <BranchesPane repoPath={props.repoPath} onCheckout={refreshAll} />
        </Section>

        <Section
          label="History"
          icon={<History class="w-3 h-3" />}
          open={state.gitSections.history}
          isLast={lastOpenSection() === "history"}
          onToggle={() => actions.toggleGitSection("history")}
          contentHeight={sectionHeights().history}
          onResizeStart={startSectionResize("history")}
        >
          <HistoryPane repoPath={props.repoPath} />
        </Section>

        <Section
          label="Opened Diffs"
          icon={<GitCompare class="w-3 h-3" />}
          open={state.gitSections.openedDiffs}
          isLast={lastOpenSection() === "openedDiffs"}
          onToggle={() => actions.toggleGitSection("openedDiffs")}
          contentHeight={sectionHeights().openedDiffs}
          onResizeStart={startSectionResize("openedDiffs")}
        >
          <OpenedDiffsPane
            workspaceId={props.workspaceId}
            tabs={activeDiffTabs()}
            activeDiffId={activeDiffId()}
            onSelect={(id) => actions.selectDiffTab(props.workspaceId, id)}
            onClose={(id) => actions.closeDiffTab(props.workspaceId, id)}
          />
        </Section>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Changes
// ─────────────────────────────────────────────────────────────────────────────

function ChangesPane(props: {
  repoPath: string;
  workspaceId: string;
  status: { path: string; status: string; staged: boolean }[] | undefined;
  selectedFile: string | null;
  onRefresh: () => void;
}) {
  const { actions } = useAppStore();
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [commitError, setCommitError] = createSignal("");
  const [commitOk, setCommitOk] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  const [pushOk, setPushOk] = createSignal(false);

  const staged = () => (props.status ?? []).filter((f) => f.staged);
  const unstaged = () => (props.status ?? []).filter((f) => !f.staged);

  async function stageFile(path: string) {
    await gitApi.stageFiles(props.repoPath, [path]);
    props.onRefresh();
  }
  async function unstageFile(path: string) {
    await gitApi.unstageFiles(props.repoPath, [path]);
    props.onRefresh();
  }
  async function stageAll() {
    await gitApi.stageAll(props.repoPath);
    props.onRefresh();
  }
  async function commit() {
    const msg = commitMsg().trim();
    if (!msg || staged().length === 0) return;
    setCommitting(true);
    setCommitError("");
    setCommitOk(false);
    try {
      await gitApi.commit(props.repoPath, msg);
      setCommitMsg("");
      setCommitOk(true);
      setTimeout(() => setCommitOk(false), 2000);
      props.onRefresh();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }
  async function push() {
    setPushing(true);
    setPushOk(false);
    try {
      await gitApi.push(props.repoPath);
      setPushOk(true);
      setTimeout(() => setPushOk(false), 2000);
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(false);
    }
  }

  const selectFile = (path: string) => {
    actions.openDiffTab(props.workspaceId, path);
  };

  return (
    <div class="flex flex-col">
      {/* Commit form */}
      <div class="p-2 border-b border-border/50 space-y-1.5">
        <label class="sr-only" for="commit-msg">Commit message</label>
        <textarea
          id="commit-msg"
          placeholder="Commit message"
          value={commitMsg()}
          onInput={(e) => setCommitMsg(e.currentTarget.value)}
          rows={3}
          class="w-full rounded-md bg-muted/50 border border-border/60 px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div class="flex items-center gap-1.5">
          <button
            disabled={committing() || staged().length === 0 || !commitMsg().trim()}
            onClick={() => void commit()}
            aria-label="Commit staged changes"
            class="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.96] transition-[background-color,color,transform,opacity]"
          >
            <Show when={commitOk()} fallback={committing() ? "Committing…" : <>Commit (<span class="tabular-nums">{staged().length}</span>)</>}>
              <Check class="w-3 h-3" /> Done
            </Show>
          </button>
          <button
            onClick={() => void stageAll()}
            aria-label="Stage all changes"
            title="Stage all"
            class="px-2 py-1 rounded-md text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <Plus class="w-3 h-3" />
          </button>
          <button
            onClick={() => void push()}
            disabled={pushing()}
            aria-label="Push to remote"
            title="Push"
            class={`px-2 py-1 rounded-md text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              pushOk()
                ? "text-success"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <Show when={pushOk()} fallback={<Upload class="w-3 h-3" />}>
              <Check class="w-3 h-3" />
            </Show>
          </button>
        </div>
        <Show when={commitError()}>
          <p class="text-xs text-destructive truncate" title={commitError()}>{commitError()}</p>
        </Show>
      </div>

      <Show when={staged().length > 0}>
        <div class="border-b border-border/50">
          <div class="px-2.5 density-section ui-section-label text-success/80">
            Staged (<span class="tabular-nums">{staged().length}</span>)
          </div>
          <For each={staged()}>
            {(f) => (
              <FileRow
                file={f.path}
                status={f.status}
                selected={props.selectedFile === f.path}
                onSelect={() => selectFile(f.path)}
                actionIcon={Minus}
                onAction={() => void unstageFile(f.path)}
                actionTitle="Unstage"
              />
            )}
          </For>
        </div>
      </Show>

      <div class="px-2.5 density-section ui-section-label">
        Changes (<span class="tabular-nums">{unstaged().length}</span>)
      </div>
      <Show when={unstaged().length === 0 && staged().length === 0}>
        <p class="px-2.5 py-2 text-[13px] text-muted-foreground">Working tree clean</p>
      </Show>
      <For each={unstaged()}>
        {(f) => (
          <FileRow
            file={f.path}
            status={f.status}
            selected={props.selectedFile === f.path}
            onSelect={() => selectFile(f.path)}
            actionIcon={Plus}
            onAction={() => void stageFile(f.path)}
            actionTitle="Stage"
          />
        )}
      </For>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branches
// ─────────────────────────────────────────────────────────────────────────────

function BranchesPane(props: { repoPath: string; onCheckout: () => void }) {
  const [branches, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listBranches(p, true),
  );
  const [error, setError] = createSignal("");

  async function checkout(name: string) {
    setError("");
    try {
      await gitApi.checkoutBranch(props.repoPath, name);
      refetch();
      props.onCheckout();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div class="p-2 space-y-1">
      <Show when={error()}>
        <p class="text-xs text-destructive px-1">{error()}</p>
      </Show>
      <For each={branches() ?? []}>
        {(b) => (
          <button
            onClick={() => void checkout(b.name)}
            disabled={b.isHead}
            aria-label={b.isHead ? `${b.name} (current branch)` : `Checkout ${b.name}`}
            class={`w-full flex items-center gap-2 rounded-md px-2 density-row text-[13px] text-left transition-colors ${
              b.isHead
                ? "bg-primary/10 text-primary cursor-default"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <GitBranch class="w-3 h-3 shrink-0" />
            <span class="truncate flex-1">{b.name}</span>
            <Show when={b.ahead > 0}>
              <span class="text-success tabular-nums">↑{b.ahead}</span>
            </Show>
            <Show when={b.behind > 0}>
              <span class="text-destructive tabular-nums">↓{b.behind}</span>
            </Show>
            <Show when={b.isHead}>
              <span class="text-xs uppercase tracking-wide text-primary/80">HEAD</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

function CommitHoverPopover(props: { commit: GitCommitInfo; x: number; y: number }) {
  return (
    <Portal>
      <div
        class="fixed z-50 bg-popover border border-border rounded-lg shadow-xl p-3 text-xs max-w-xs pointer-events-none"
        style={{ left: `${props.x + 14}px`, top: `${props.y - 8}px` }}
      >
        <div class="font-mono text-muted-foreground mb-1 text-[10px] tracking-wide">{props.commit.oid.slice(0, 12)}</div>
        <div class="font-medium text-foreground mb-1.5 leading-snug">{props.commit.summary}</div>
        <Show when={props.commit.body}>
          {(body) => (
            <div class="text-muted-foreground mb-2 whitespace-pre-wrap text-[11px] leading-relaxed line-clamp-4">{body()}</div>
          )}
        </Show>
        <div class="space-y-0.5 text-muted-foreground/80 border-t border-border/50 pt-1.5 mt-1.5">
          <div><span class="text-muted-foreground">Author:</span> {props.commit.authorName}</div>
          <div class="truncate"><span class="text-muted-foreground">Email:</span> {props.commit.authorEmail}</div>
          <div><span class="text-muted-foreground">Date:</span> {new Date(props.commit.time * 1000).toLocaleString()}</div>
        </div>
      </div>
    </Portal>
  );
}

function CommitDetailView(props: { commit: GitCommitInfo; onBack: () => void }) {
  return (
    <div class="flex flex-col h-full p-2 text-xs">
      <button
        onClick={props.onBack}
        class="flex items-center gap-1 mb-3 text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <ChevronLeft class="w-3 h-3" />
        Back to history
      </button>
      <div class="font-mono text-muted-foreground text-[10px] tracking-wide mb-1">{props.commit.oid}</div>
      <div class="font-medium text-foreground text-sm leading-snug mb-3">{props.commit.summary}</div>
      <Show when={props.commit.body}>
        {(body) => (
          <div class="text-muted-foreground mb-4 whitespace-pre-wrap leading-relaxed border-b border-border/50 pb-3">{body()}</div>
        )}
      </Show>
      <div class="space-y-2 text-muted-foreground">
        <div class="flex gap-2">
          <span class="text-muted-foreground/60 w-12 shrink-0">Author</span>
          <span class="text-foreground">{props.commit.authorName}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground/60 w-12 shrink-0">Email</span>
          <span class="text-foreground truncate">{props.commit.authorEmail}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground/60 w-12 shrink-0">Date</span>
          <span class="text-foreground">{new Date(props.commit.time * 1000).toLocaleString()}</span>
        </div>
        <Show when={props.commit.parentOids.length > 0}>
          <div class="flex gap-2">
            <span class="text-muted-foreground/60 w-12 shrink-0">Parents</span>
            <span class="font-mono text-foreground/80">{props.commit.parentOids.map(p => p.slice(0, 7)).join(", ")}</span>
          </div>
        </Show>
      </div>
    </div>
  );
}

function HistoryPane(props: { repoPath: string }) {
  const [log] = createResource(
    () => props.repoPath,
    (p) => gitApi.log(p, undefined, 50),
  );

  const [selectedCommit, setSelectedCommit] = createSignal<GitCommitInfo | null>(null);
  const [hoveredCommit, setHoveredCommit] = createSignal<GitCommitInfo | null>(null);
  const [hoverPos, setHoverPos] = createSignal({ x: 0, y: 0 });

  return (
    <div class="h-full relative">
      <Show when={selectedCommit()}>
        {(commit) => (
          <CommitDetailView commit={commit()} onBack={() => setSelectedCommit(null)} />
        )}
      </Show>
      <Show when={!selectedCommit()}>
        <div class="p-1">
          <For each={log() ?? []}>
            {(c) => (
              <div
                class="px-2 density-row rounded-md text-[13px] hover:bg-accent/40 transition-colors cursor-pointer select-none"
                onClick={() => setSelectedCommit(c)}
                onMouseEnter={(e) => { setHoveredCommit(c); setHoverPos({ x: e.clientX, y: e.clientY }); }}
                onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHoveredCommit(null)}
              >
                <div class="flex items-center gap-2">
                  <span class="font-mono text-muted-foreground text-xs tabular-nums shrink-0">
                    {c.oid.slice(0, 7)}
                  </span>
                  <span class="truncate flex-1 text-foreground">{c.summary}</span>
                </div>
                <div class="text-xs text-muted-foreground/80 truncate tabular-nums">
                  {c.authorName} · {new Date(c.time * 1000).toLocaleString()}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={hoveredCommit()}>
        {(commit) => (
          <CommitHoverPopover commit={commit()} x={hoverPos().x} y={hoverPos().y} />
        )}
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Opened Diffs
// ─────────────────────────────────────────────────────────────────────────────

function OpenedDiffsPane(props: {
  workspaceId: string;
  tabs: { id: string; filePath: string }[];
  activeDiffId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div class="p-1">
      <Show
        when={props.tabs.length > 0}
        fallback={
          <div class="px-2.5 py-3 text-[13px] text-muted-foreground">
            <GitCompare class="w-4 h-4 mx-auto mb-1.5 opacity-60" />
            <p class="text-center">No diffs open.</p>
          </div>
        }
      >
        <For each={props.tabs}>
          {(tab) => {
            const isActive = () => tab.id === props.activeDiffId;
            const fileName = () => tab.filePath.split("/").pop() ?? tab.filePath;
            return (
              <div
                class={`group flex items-center rounded-md border transition-colors ${
                  isActive()
                    ? "bg-accent/60 border-border text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30"
                }`}
              >
                <button
                  onClick={() => props.onSelect(tab.id)}
                  title={tab.filePath}
                  class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left text-[13px] cursor-pointer focus-visible:outline-none"
                >
                  <GitCompare class="w-3.5 h-3.5 shrink-0 text-info" />
                  <span class="flex-1 min-w-0 truncate">
                    <span class="text-muted-foreground text-[11px]">diff · </span>{fileName()}
                  </span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); props.onClose(tab.id); }}
                  aria-label={`Close diff ${fileName()}`}
                  title="Close diff"
                  class="p-0.5 mr-1 rounded opacity-60 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// File row
// ─────────────────────────────────────────────────────────────────────────────

function FileRow(props: {
  file: string;
  status: string;
  selected: boolean;
  onSelect: () => void;
  actionIcon: LucideIcon;
  onAction: () => void;
  actionTitle: string;
}) {
  const Icon = props.actionIcon;
  return (
    <div
      class={`group flex items-center text-xs transition-colors focus-within:bg-accent/40 ${
        props.selected ? "bg-accent/70 text-foreground" : "hover:bg-accent/40"
      }`}
    >
      <button
        onClick={props.onSelect}
        aria-label={`Open diff for ${props.file}`}
        aria-pressed={props.selected}
        class="flex-1 flex items-center gap-1.5 pl-2.5 density-row min-w-0 text-left cursor-pointer focus-visible:outline-none"
      >
        <StatusIcon status={props.status} />
        <span class="flex-1 truncate">{props.file}</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onAction();
        }}
        aria-label={`${props.actionTitle} ${props.file}`}
        title={props.actionTitle}
        class="p-0.5 mr-2 rounded opacity-60 group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100"
      >
        <Icon class="w-3 h-3 text-muted-foreground" />
      </button>
    </div>
  );
}

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

/** Collapsed rail */
export function GitSidebarCollapsed(props: { onExpand: () => void }) {
  return (
    <div class="flex flex-col items-center w-8 border-l border-border bg-sidebar py-2 gap-2">
      <button
        onClick={props.onExpand}
        aria-label="Expand git panel"
        class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        title="Expand git panel"
      >
        <ChevronLeft class="w-3.5 h-3.5" />
      </button>
      <GitBranch class="w-4 h-4 text-muted-foreground" />
    </div>
  );
}
