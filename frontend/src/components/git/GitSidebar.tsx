import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js";
import {
  GitBranch,
  GitCommit,
  History,
  Plus,
  Minus,
  Check,
  ChevronRight,
  ChevronLeft,
  FilePlus,
  FileMinus,
  FileText,
  FileQuestion,
  Upload,
  RefreshCw,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import type { GitTab } from "@/store/layout";

type LucideIcon = Component<{ class?: string }>;

interface GitSidebarProps {
  repoPath: string;
  workspaceId: string;
}

const TAB_DEFS: { id: GitTab; label: string; Icon: LucideIcon }[] = [
  { id: "changes", label: "Changes", Icon: GitCommit },
  { id: "branches", label: "Branches", Icon: GitBranch },
  { id: "history", label: "History", Icon: History },
];

export function GitSidebar(props: GitSidebarProps) {
  const { state, activeDiffTabs, activeItem, actions } = useAppStore();

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

  const refreshAll = () => {
    refetchStatus();
    refetchInfo();
  };

  return (
    <aside class="flex flex-col w-80 border-l border-border bg-sidebar overflow-hidden">
      {/* Header */}
      <div class="px-3 py-2 border-b border-border flex items-center gap-2 text-xs">
        <GitBranch class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span class="font-medium truncate">
          {repoInfo()?.currentBranch ?? "—"}
        </span>
        <Show when={repoInfo()?.isClean === false}>
          <span class="text-warning text-[10px]">• changes</span>
        </Show>
        <div class="ml-auto flex items-center gap-0.5">
          <button
            onClick={refreshAll}
            class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw class="w-3 h-3" />
          </button>
          <button
            onClick={() => actions.toggleGitSidebar()}
            class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse git panel"
          >
            <ChevronRight class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div class="flex border-b border-border text-[11px]">
        <For each={TAB_DEFS}>
          {({ id, label, Icon }) => (
            <button
              onClick={() => actions.setGitTab(id)}
              class={`flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors ${
                state.gitTab === id
                  ? "bg-background text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
              }`}
            >
              <Icon class="w-3 h-3" />
              {label}
            </button>
          )}
        </For>
      </div>

      <Show when={state.gitTab === "changes"}>
        <ChangesPane
          repoPath={props.repoPath}
          workspaceId={props.workspaceId}
          status={status()}
          onRefresh={refreshAll}
          selectedFile={activeFilePath()}
        />
      </Show>

      <Show when={state.gitTab === "branches"}>
        <BranchesPane repoPath={props.repoPath} onCheckout={refreshAll} />
      </Show>

      <Show when={state.gitTab === "history"}>
        <HistoryPane repoPath={props.repoPath} />
      </Show>
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
    try {
      await gitApi.push(props.repoPath);
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
    <div class="flex-1 flex flex-col overflow-hidden">
      {/* Commit form */}
      <div class="p-2 border-b border-border/50 space-y-1.5">
        <textarea
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
            class="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Show when={commitOk()} fallback={committing() ? "Committing…" : <>Commit ({staged().length})</>}>
              <Check class="w-3 h-3" /> Done
            </Show>
          </button>
          <button
            onClick={() => void stageAll()}
            title="Stage all"
            class="px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <Plus class="w-3 h-3" />
          </button>
          <button
            onClick={() => void push()}
            disabled={pushing()}
            title="Push"
            class="px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40"
          >
            <Upload class="w-3 h-3" />
          </button>
        </div>
        <Show when={commitError()}>
          <p class="text-[10px] text-destructive truncate" title={commitError()}>{commitError()}</p>
        </Show>
      </div>

      <div class="flex-1 overflow-y-auto scrollbar-thin">
        <Show when={staged().length > 0}>
          <div class="border-b border-border/50">
            <div class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-success/80">
              Staged ({staged().length})
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

        <div class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
          Changes ({unstaged().length})
        </div>
        <Show when={unstaged().length === 0 && staged().length === 0}>
          <p class="px-2.5 py-2 text-[11px] text-muted-foreground">Working tree clean</p>
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
    <div class="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
      <Show when={error()}>
        <p class="text-[10px] text-destructive px-1">{error()}</p>
      </Show>
      <For each={branches() ?? []}>
        {(b) => (
          <button
            onClick={() => void checkout(b.name)}
            disabled={b.isHead}
            class={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-left transition-colors ${
              b.isHead
                ? "bg-primary/10 text-primary cursor-default"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <GitBranch class="w-3 h-3 shrink-0" />
            <span class="truncate flex-1">{b.name}</span>
            <Show when={b.ahead > 0}>
              <span class="text-success">↑{b.ahead}</span>
            </Show>
            <Show when={b.behind > 0}>
              <span class="text-destructive">↓{b.behind}</span>
            </Show>
            <Show when={b.isHead}>
              <span class="text-[9px] uppercase tracking-wide text-primary/80">HEAD</span>
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

function HistoryPane(props: { repoPath: string }) {
  const [log] = createResource(
    () => props.repoPath,
    (p) => gitApi.log(p, undefined, 50),
  );

  return (
    <div class="flex-1 overflow-y-auto scrollbar-thin p-1">
      <For each={log() ?? []}>
        {(c) => (
          <div class="px-2 py-1.5 rounded-md text-[11px] hover:bg-accent/40 transition-colors">
            <div class="flex items-center gap-2">
              <span class="font-mono text-muted-foreground text-[10px]">
                {c.oid.slice(0, 7)}
              </span>
              <span class="truncate flex-1 text-foreground">{c.summary}</span>
            </div>
            <div class="text-[10px] text-muted-foreground/80 truncate">
              {c.authorName} · {new Date(c.time * 1000).toLocaleString()}
            </div>
          </div>
        )}
      </For>
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
      class={`flex items-center gap-1.5 px-2.5 py-1 text-xs group cursor-pointer transition-colors ${
        props.selected ? "bg-accent/70 text-foreground" : "hover:bg-accent/40"
      }`}
      onClick={props.onSelect}
    >
      <StatusIcon status={props.status} />
      <span class="flex-1 truncate">{props.file}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onAction();
        }}
        class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent"
        title={props.actionTitle}
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

/** Collapsed rail — shown when the sidebar is collapsed (just a vertical strip). */
export function GitSidebarCollapsed(props: { onExpand: () => void }) {
  return (
    <div class="flex flex-col items-center w-8 border-l border-border bg-sidebar py-2 gap-2">
      <button
        onClick={props.onExpand}
        class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        title="Expand git panel"
      >
        <ChevronLeft class="w-3.5 h-3.5" />
      </button>
      <GitBranch class="w-4 h-4 text-muted-foreground" />
    </div>
  );
}

