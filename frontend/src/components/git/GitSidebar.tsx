import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";
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
  Sparkles,
  Layers,
  X,
} from "lucide-solid";
import { StackSidebarSection } from "@/components/git/stack/StackSidebarSection";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import { scanStagedDiff, type SecretFinding } from "@/commands/secretScan";
import { SecretScanDialog } from "@/commands/SecretScanDialog";
import { pushToast } from "@/commands/toast";
import {
  AI_COMMIT_REQUEST_EVENT,
  aiCommitState,
  draftCommitMessage,
} from "@/commands/aiCommit";
import { recordBranchUse, sortBranchesByMru } from "@/commands/branchMru";
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
  const [sectionHeights, setSectionHeights] = createSignal({ changes: 200, branches: 140, stack: 160, history: 200, openedDiffs: 140 });

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

  // Palette action "Refresh git status" / cross-pane refreshes (e.g. after
  // hunk staging) fan out through a window event so callers don't need a
  // direct reference to this component.
  onMount(() => {
    const handler = () => refreshAll();
    window.addEventListener("voidlink:refresh-git", handler);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", handler));
  });

  function openUpstreamCompare() {
    const info = repoInfo();
    if (!info?.currentBranch) return;
    const base = info.upstream ?? "main";
    actions.openCompareTab(props.workspaceId, {
      baseRef: base,
      headRef: info.currentBranch,
      useMergeBase: false,
    });
  }

  // Determine which sections are open (in order) to find the last one
  const lastOpenSection = createMemo(() => {
    const order = ["changes", "branches", "stack", "history", "openedDiffs"] as const;
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
        <Show when={(repoInfo()?.ahead ?? 0) > 0 || (repoInfo()?.behind ?? 0) > 0}>
          <button
            onClick={openUpstreamCompare}
            title={
              repoInfo()?.upstream
                ? `Compare with ${repoInfo()!.upstream}`
                : "Compare with main"
            }
            aria-label="Compare with upstream"
            class="flex items-center gap-1 px-1 rounded hover:bg-accent/60 transition-colors tabular-nums"
          >
            <Show when={(repoInfo()?.ahead ?? 0) > 0}>
              <span class="text-success">↑{repoInfo()!.ahead}</span>
            </Show>
            <Show when={(repoInfo()?.behind ?? 0) > 0}>
              <span class="text-destructive">↓{repoInfo()!.behind}</span>
            </Show>
          </button>
        </Show>
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
          label="Stack"
          icon={<Layers class="w-3 h-3" />}
          open={state.gitSections.stack}
          isLast={lastOpenSection() === "stack"}
          onToggle={() => actions.toggleGitSection("stack")}
          contentHeight={sectionHeights().stack}
          onResizeStart={startSectionResize("stack")}
        >
          <StackSidebarSection repoPath={props.repoPath} workspaceId={props.workspaceId} />
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
          <HistoryPane repoPath={props.repoPath} workspaceId={props.workspaceId} />
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
  const { settings } = useSettings();
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [commitError, setCommitError] = createSignal("");
  const [commitOk, setCommitOk] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  const [pushOk, setPushOk] = createSignal(false);
  const [pendingFindings, setPendingFindings] = createSignal<SecretFinding[]>([]);

  /// True while *this* sidebar's repo is the one being drafted. We scope
  /// off the global state so switching workspaces mid-draft doesn't
  /// confuse the visual indicator on the new repo's sidebar.
  const drafting = () => {
    const s = aiCommitState();
    return s.kind === "drafting" && s.repoPath === props.repoPath;
  };
  /// Show the "Regenerate" affordance only briefly after a successful
  /// draft so the button doesn't clutter the steady state.
  const recentDraftMs = () => {
    const s = aiCommitState();
    if (s.kind !== "success" || s.repoPath !== props.repoPath) return null;
    return s.ms;
  };

  const staged = () => (props.status ?? []).filter((f) => f.staged && f.status !== "conflicted");
  const unstaged = () => (props.status ?? []).filter((f) => !f.staged && f.status !== "conflicted");
  const conflicted = () => (props.status ?? []).filter((f) => f.status === "conflicted");

  function openConflict(path: string) {
    actions.openConflictTab(props.workspaceId, path);
  }

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
  async function performCommit(msg: string) {
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
  async function commit() {
    const msg = commitMsg().trim();
    if (!msg || staged().length === 0) return;
    // Secret scan on the staged diff before any commit goes out. A finding
    // pauses the flow and lets the user inspect or commit-anyway.
    try {
      const diff = await gitApi.diffWorking(props.repoPath, true);
      const findings = scanStagedDiff(diff);
      if (findings.length > 0) {
        setPendingFindings(findings);
        return;
      }
    } catch (e) {
      // If the diff fetch fails we don't want to block committing on a
      // scanner glitch — log and continue.
      console.warn("Pre-commit secret scan failed:", e);
    }
    await performCommit(msg);
  }
  async function draftAiCommit() {
    if (staged().length === 0) {
      pushToast("Stage some changes first", "warning");
      return;
    }
    if (drafting()) return;
    const result = await draftCommitMessage(
      props.repoPath,
      settings.ai.commitCommand,
    );
    if (result.ok && result.message) {
      const current = commitMsg().trim();
      // Preserve any in-progress message by appending — drafts are
      // suggestions, not blunt overwrites.
      setCommitMsg(current ? `${current}\n\n${result.message}` : result.message);
    }
  }

  // Listen for global "draft commit" requests (palette / shortcut). The
  // sidebar is the only component that owns the textarea, so it's the
  // natural home for the actual work.
  onMount(() => {
    const handler = () => void draftAiCommit();
    window.addEventListener(AI_COMMIT_REQUEST_EVENT, handler);
    onCleanup(() => window.removeEventListener(AI_COMMIT_REQUEST_EVENT, handler));
  });
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
          placeholder={drafting() ? "Drafting commit message…" : "Commit message"}
          value={commitMsg()}
          onInput={(e) => setCommitMsg(e.currentTarget.value)}
          rows={3}
          class={`w-full rounded-md bg-muted/50 border border-border/60 px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring transition-colors ${
            drafting() ? "border-primary/40 placeholder:animate-pulse" : ""
          }`}
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
            onClick={() => void draftAiCommit()}
            disabled={drafting() || staged().length === 0}
            aria-label={recentDraftMs() !== null ? "Regenerate commit message" : "Draft commit message with AI"}
            title={
              !settings.ai.commitCommand.trim()
                ? "Configure AI command in Settings → AI"
                : recentDraftMs() !== null
                  ? `Regenerate (last draft: ${recentDraftMs()}ms)`
                  : "Draft commit message with AI (⌘⇧M)"
            }
            class={`px-2 py-1 rounded-md text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              recentDraftMs() !== null
                ? "text-primary hover:text-primary hover:bg-primary/10"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            <Sparkles class={`w-3 h-3 ${drafting() ? "animate-pulse" : ""}`} />
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

      <Show when={conflicted().length > 0}>
        <div class="border-b border-border/50">
          <div class="px-2.5 density-section ui-section-label text-warning/90 flex items-center gap-1.5">
            <GitCompare class="w-3 h-3" />
            Conflicts (<span class="tabular-nums">{conflicted().length}</span>)
          </div>
          <For each={conflicted()}>
            {(f) => (
              <button
                onClick={() => openConflict(`${props.repoPath}/${f.path}`)}
                title={`Resolve conflict in ${f.path}`}
                class="w-full flex items-center gap-2 px-2.5 density-row text-[13px] text-left text-warning hover:bg-warning/10 transition-colors"
              >
                <FileText class="w-3 h-3 shrink-0" />
                <span class="flex-1 truncate font-mono">{f.path}</span>
                <span class="text-[10px] uppercase tracking-wide opacity-70">resolve</span>
              </button>
            )}
          </For>
        </div>
      </Show>

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

      <SecretScanDialog
        findings={pendingFindings()}
        onCancel={() => setPendingFindings([])}
        onCommitAnyway={() => {
          setPendingFindings([]);
          void performCommit(commitMsg().trim());
        }}
      />
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
  const [filter, setFilter] = createSignal("");

  async function checkout(name: string) {
    setError("");
    try {
      const result = await gitApi.safeCheckout(props.repoPath, name);
      recordBranchUse(props.repoPath, name);
      if (result.autoStashed) {
        pushToast(
          `Switched to ${name}. Auto-stashed your changes — restore with \`git stash pop\`.`,
          "info",
          5000,
        );
      }
      refetch();
      props.onCheckout();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /// Fuzzy match: substring first (preferred), then in-order character
  /// subsequence as a fallback. Matches the spirit of the file/command
  /// pickers already in the app.
  function fuzzy(name: string, query: string): boolean {
    if (!query) return true;
    const n = name.toLowerCase();
    const q = query.toLowerCase();
    if (n.includes(q)) return true;
    let i = 0;
    for (const ch of q) {
      const idx = n.indexOf(ch, i);
      if (idx === -1) return false;
      i = idx + 1;
    }
    return true;
  }

  const filtered = createMemo(() => {
    const all = branches() ?? [];
    const sorted = sortBranchesByMru(all, props.repoPath);
    const q = filter().trim();
    return q ? sorted.filter((b) => fuzzy(b.name, q)) : sorted;
  });

  return (
    <div class="p-2 space-y-1">
      <input
        type="text"
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value)}
        placeholder="Filter branches…"
        class="w-full px-2 py-1 text-[12px] bg-muted/50 border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
        aria-label="Filter branches"
      />
      <Show when={error()}>
        <p class="text-xs text-destructive px-1">{error()}</p>
      </Show>
      <For each={filtered()}>
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
      <Show when={(branches()?.length ?? 0) > 0 && filtered().length === 0}>
        <p class="text-[11px] text-muted-foreground px-1 py-1">No matches.</p>
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

function CommitHoverPopover(props: { commit: GitCommitInfo; x: number; y: number }) {
  let popRef: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.x + 14, top: props.y - 8 });

  // After mount and on every move, clamp to viewport and flip horizontally
  // if there isn't room on the right. Without this, hovering near the
  // window's right/bottom edge clips the popover under the chrome.
  createEffect(() => {
    const x = props.x;
    const y = props.y;
    const el = popRef;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + 14;
    let top = y - 8;
    if (left + rect.width + pad > vw) left = x - rect.width - 14;
    if (left < pad) left = pad;
    if (top + rect.height + pad > vh) top = vh - rect.height - pad;
    if (top < pad) top = pad;
    setPos({ left, top });
  });

  return (
    <Portal>
      <div
        ref={popRef}
        class="fixed z-[9999] bg-popover border border-border rounded-lg shadow-xl p-3 text-xs max-w-xs pointer-events-none"
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
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

/// A commit + lane assignment used to render the DAG column. `preLanes`
/// is the set of "expected next commit" OIDs that exist BEFORE this
/// commit is processed; `postLanes` is the same after. `laneIndex` is
/// the column slot this commit's circle should be drawn in.
interface PositionedCommit {
  commit: GitCommitInfo;
  laneIndex: number;
  preLanes: (string | null)[];
  postLanes: (string | null)[];
}

/// Compute lane positions for a chronological commit list (newest first).
/// Algorithm: walk top-down, each lane carries the OID it's expecting
/// next. When we see a commit, we find which lane was expecting it
/// (creating one if none), then replace that lane's expectation with
/// the commit's first parent. Additional parents either reuse an
/// existing lane that was already waiting on that parent (merge) or
/// open a new lane to the right.
function layoutDag(commits: GitCommitInfo[]): {
  rows: PositionedCommit[];
  maxLanes: number;
} {
  let lanes: (string | null)[] = [];
  const rows: PositionedCommit[] = [];
  let maxLanes = 0;
  for (const c of commits) {
    const preLanes = [...lanes];

    let laneIdx = lanes.findIndex((l) => l === c.oid);
    if (laneIdx === -1) {
      laneIdx = lanes.length;
      lanes.push(c.oid);
    }

    const parents = c.parentOids;
    lanes = lanes.map((l, i) => {
      if (i === laneIdx) return parents[0] ?? null;
      // Another lane was also expecting this commit → collapse it
      // (a merge with multiple converging paths).
      if (l === c.oid) return null;
      return l;
    });

    // Additional parents land in the first available null slot or
    // open a fresh lane on the right.
    for (let i = 1; i < parents.length; i++) {
      const existing = lanes.findIndex((l) => l === parents[i]);
      if (existing !== -1) continue;
      const empty = lanes.findIndex((l) => l === null);
      if (empty !== -1) lanes[empty] = parents[i];
      else lanes.push(parents[i]);
    }

    // Trim trailing nulls to keep the column compact.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const postLanes = [...lanes];
    maxLanes = Math.max(maxLanes, preLanes.length, postLanes.length);
    rows.push({ commit: c, laneIndex: laneIdx, preLanes, postLanes });
  }
  return { rows, maxLanes };
}

const LANE_WIDTH = 12;
const LANE_X_OFFSET = 8;
const ROW_HEIGHT = 36;
const COMMIT_RADIUS = 3;

/// Color palette cycled per lane index. Keeps adjacent branches visually
/// distinct without needing a per-branch color map.
const LANE_COLORS = [
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#34d399", // emerald
  "#fbbf24", // amber
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#fb923c", // orange
];

function laneX(i: number): number {
  return LANE_X_OFFSET + i * LANE_WIDTH;
}

function laneColor(i: number): string {
  return LANE_COLORS[i % LANE_COLORS.length];
}

function HistoryPane(props: { repoPath: string; workspaceId: string }) {
  const { actions } = useAppStore();
  const [log] = createResource(
    () => props.repoPath,
    (p) => gitApi.log(p, undefined, 80),
  );

  const layout = createMemo(() => layoutDag(log() ?? []));

  const [hoveredCommit, setHoveredCommit] = createSignal<GitCommitInfo | null>(null);
  const [hoverPos, setHoverPos] = createSignal({ x: 0, y: 0 });

  function openCommitCompare(c: GitCommitInfo) {
    const base = c.parentOids[0] ?? c.oid;
    actions.openCompareTab(props.workspaceId, {
      baseRef: base,
      headRef: c.oid,
      useMergeBase: false,
    });
  }

  return (
    <div class="h-full relative">
      <div class="p-1">
        <For each={layout().rows}>
          {(row) => (
            <div
              class="flex items-stretch rounded-md hover:bg-accent/40 transition-colors cursor-pointer select-none"
              onClick={() => openCommitCompare(row.commit)}
              onMouseEnter={(e) => {
                setHoveredCommit(row.commit);
                setHoverPos({ x: e.clientX, y: e.clientY });
              }}
              onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredCommit(null)}
              title="Open commit diff"
            >
              <DagColumn row={row} maxLanes={layout().maxLanes} />
              <div class="flex-1 min-w-0 px-2 py-1.5 text-[13px]">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-muted-foreground text-xs tabular-nums shrink-0">
                    {row.commit.oid.slice(0, 7)}
                  </span>
                  <span class="truncate flex-1 text-foreground">{row.commit.summary}</span>
                </div>
                <div class="text-xs text-muted-foreground/80 truncate tabular-nums">
                  {row.commit.authorName} · {new Date(row.commit.time * 1000).toLocaleString()}
                </div>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={hoveredCommit()}>
        {(commit) => (
          <CommitHoverPopover commit={commit()} x={hoverPos().x} y={hoverPos().y} />
        )}
      </Show>
    </div>
  );
}

/// Per-row DAG cell. Renders an SVG with:
///   - vertical lines for every pre-lane that continues into post-lanes
///   - diagonals from pre-lanes that converged into THIS commit (merges)
///   - diagonals from this commit out to NEW lanes (branches)
///   - a circle at this commit's lane index
function DagColumn(props: { row: PositionedCommit; maxLanes: number }) {
  const width = () => Math.max(1, props.maxLanes) * LANE_WIDTH + LANE_X_OFFSET;
  const mid = ROW_HEIGHT / 2;
  const r = props.row;

  /// Pre-lane top-half lines: each pre-lane that survives into the post
  /// set (and isn't the lane being landed by this commit) is a straight
  /// vertical line from top to mid. Pre-lanes that *converge* on this
  /// commit are diagonals from their x to the commit's x.
  const topSegments = () => {
    const segs: Array<{ from: number; to: number; color: string }> = [];
    r.preLanes.forEach((oid, i) => {
      if (oid === null) return;
      if (oid === r.commit.oid) {
        // Merging into this commit — line slopes toward the commit lane.
        segs.push({ from: i, to: r.laneIndex, color: laneColor(i) });
      } else {
        segs.push({ from: i, to: i, color: laneColor(i) });
      }
    });
    return segs;
  };

  /// Bottom-half lines: for each post-lane that's non-null, draw from
  /// (post lane x, mid) down to (post lane x, bottom). New parent lanes
  /// (not present in preLanes at the same index OR with a different OID)
  /// slope out from this commit's circle.
  const bottomSegments = () => {
    const segs: Array<{ from: number; to: number; color: string }> = [];
    r.postLanes.forEach((oid, i) => {
      if (oid === null) return;
      const wasInPre = r.preLanes[i] === oid;
      if (wasInPre) {
        segs.push({ from: i, to: i, color: laneColor(i) });
      } else {
        // New lane created by this commit — slope out from its circle.
        segs.push({ from: r.laneIndex, to: i, color: laneColor(i) });
      }
    });
    return segs;
  };

  return (
    <svg
      width={width()}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width()} ${ROW_HEIGHT}`}
      class="shrink-0"
    >
      <For each={topSegments()}>
        {(seg) => (
          <line
            x1={laneX(seg.from)}
            y1={0}
            x2={laneX(seg.to)}
            y2={mid}
            stroke={seg.color}
            stroke-width="1.5"
            stroke-linecap="round"
          />
        )}
      </For>
      <For each={bottomSegments()}>
        {(seg) => (
          <line
            x1={laneX(seg.from)}
            y1={mid}
            x2={laneX(seg.to)}
            y2={ROW_HEIGHT}
            stroke={seg.color}
            stroke-width="1.5"
            stroke-linecap="round"
          />
        )}
      </For>
      <circle
        cx={laneX(r.laneIndex)}
        cy={mid}
        r={COMMIT_RADIUS}
        fill={laneColor(r.laneIndex)}
        stroke="var(--background)"
        stroke-width="1.5"
      />
    </svg>
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
