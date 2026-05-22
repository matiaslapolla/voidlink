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
  FolderGit2,
  FolderOpen,
  Lock,
  DownloadCloud,
  ArrowDownToLine,
  Undo2,
  Trash2,
  Archive,
  Cloud,
  Tag,
  Pencil,
  GitBranchPlus,
} from "lucide-solid";
import { promptWithToggles } from "@/commands/prompt";
import type { StashEntry, RemoteInfo } from "@/types/git";
import { StackSidebarSection } from "@/components/git/stack/StackSidebarSection";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import { OperationBanner } from "@/components/git/OperationBanner";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import { scanStagedDiff, type SecretFinding } from "@/commands/secretScan";
import { SecretScanDialog } from "@/commands/SecretScanDialog";
import { pushToast } from "@/commands/toast";
import { textPrompt } from "@/commands/prompt";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
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
  const [sectionHeights, setSectionHeights] = createSignal({ changes: 200, branches: 140, worktrees: 120, stack: 160, stashes: 120, history: 200, openedDiffs: 140 });

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
    const fetchHandler = () => void doFetch();
    const pullHandler = () => void doPull();
    const remotesHandler = () => setRemotesOpen(true);
    window.addEventListener("voidlink:git-fetch", fetchHandler);
    window.addEventListener("voidlink:git-pull", pullHandler);
    window.addEventListener("voidlink:git-remotes", remotesHandler);
    onCleanup(() => {
      window.removeEventListener("voidlink:refresh-git", handler);
      window.removeEventListener("voidlink:git-fetch", fetchHandler);
      window.removeEventListener("voidlink:git-pull", pullHandler);
      window.removeEventListener("voidlink:git-remotes", remotesHandler);
    });
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

  const [syncing, setSyncing] = createSignal(false);
  const [remotesOpen, setRemotesOpen] = createSignal(false);

  async function doFetch() {
    setSyncing(true);
    try {
      await gitApi.fetch(props.repoPath);
      pushToast("Fetched from origin", "success", 2000);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    } finally {
      setSyncing(false);
      emitGitRefsChanged();
    }
  }

  async function doPull(mode: "ff-only" | "merge" | "rebase" = "ff-only") {
    setSyncing(true);
    try {
      const res = await gitApi.pull(props.repoPath, mode);
      if (res.conflicted) {
        const conflicts = await gitApi.listConflicts(props.repoPath);
        for (const c of conflicts) {
          actions.openConflictTab(props.workspaceId, `${props.repoPath}/${c}`);
        }
        pushToast("Pull stopped on conflicts — resolve them, then continue.", "warning", 6000);
      } else if (res.ok) {
        pushToast("Pulled from origin", "success", 2000);
      } else {
        pushToast(res.message || "Pull failed", "error", 7000);
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    } finally {
      setSyncing(false);
      emitGitRefsChanged();
    }
  }

  // Determine which sections are open (in order) to find the last one
  const lastOpenSection = createMemo(() => {
    const order = ["changes", "branches", "worktrees", "stack", "stashes", "history", "openedDiffs"] as const;
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
          <IconBtn label="Fetch from origin" onClick={() => void doFetch()}>
            <DownloadCloud class={`w-3 h-3 ${syncing() ? "animate-pulse" : ""}`} />
          </IconBtn>
          <button
            onClick={() => void doPull()}
            disabled={syncing()}
            aria-label="Pull from origin"
            title={
              (repoInfo()?.behind ?? 0) > 0
                ? `Pull ${repoInfo()!.behind} commit(s) from upstream`
                : "Pull from origin"
            }
            class="flex items-center gap-0.5 px-1 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-40 tabular-nums"
          >
            <ArrowDownToLine class="w-3 h-3" />
            <Show when={(repoInfo()?.behind ?? 0) > 0}>
              <span class="text-[10px] text-destructive">{repoInfo()!.behind}</span>
            </Show>
          </button>
          <IconBtn label="Manage remotes" onClick={() => setRemotesOpen(true)}>
            <Cloud class="w-3 h-3" />
          </IconBtn>
          <IconBtn label="Refresh" onClick={refreshAll}>
            <RefreshCw class={`w-3 h-3 ${isRefreshing() ? "animate-spin" : ""}`} />
          </IconBtn>
          <IconBtn label="Collapse git panel" onClick={() => actions.toggleGitSidebar()}>
            <ChevronRight class="w-3.5 h-3.5" />
          </IconBtn>
        </div>
      </div>
      <RemotesDialog repoPath={props.repoPath} open={remotesOpen()} onClose={() => setRemotesOpen(false)} />

      {/* Operation-in-progress banner (merge/rebase/cherry-pick/revert) */}
      <Show when={repoInfo()?.operation}>
        {(op) => (
          <OperationBanner
            repoPath={props.repoPath}
            workspaceId={props.workspaceId}
            operation={op()}
            hasConflicts={repoInfo()?.hasConflicts ?? false}
          />
        )}
      </Show>

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
          <BranchesPane repoPath={props.repoPath} workspaceId={props.workspaceId} onCheckout={refreshAll} />
        </Section>

        <Section
          label="Worktrees"
          icon={<FolderGit2 class="w-3 h-3" />}
          open={state.gitSections.worktrees}
          isLast={lastOpenSection() === "worktrees"}
          onToggle={() => actions.toggleGitSection("worktrees")}
          contentHeight={sectionHeights().worktrees}
          onResizeStart={startSectionResize("worktrees")}
        >
          <WorktreesPane repoPath={props.repoPath} />
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
          label="Stashes"
          icon={<Archive class="w-3 h-3" />}
          open={state.gitSections.stashes}
          isLast={lastOpenSection() === "stashes"}
          onToggle={() => actions.toggleGitSection("stashes")}
          contentHeight={sectionHeights().stashes}
          onResizeStart={startSectionResize("stashes")}
        >
          <StashesPane repoPath={props.repoPath} workspaceId={props.workspaceId} />
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
  const [amendMode, setAmendMode] = createSignal(false);

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
  async function discardFile(path: string, status: string) {
    const verb = status === "untracked" ? "Delete untracked file" : "Discard changes to";
    const ok = await dialogConfirm(`${verb} ${path}? This cannot be undone.`, {
      title: "Discard changes",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await gitApi.discardFile(props.repoPath, path);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }
  async function discardAllChanges() {
    const ok = await dialogConfirm(
      "Discard ALL changes in the working tree? Tracked files revert to HEAD. This cannot be undone.",
      { title: "Discard all changes", kind: "warning" },
    );
    if (!ok) return;
    try {
      await gitApi.discardAll(props.repoPath, false);
      pushToast("Discarded working-tree changes", "info", 2500);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }
  async function stashChanges() {
    const res = await promptWithToggles({
      title: "Stash changes",
      label: "Stash message",
      initialValue: "WIP",
      confirmLabel: "Stash",
      toggles: [
        { key: "keepIndex", label: "Keep staged changes in the index", default: false },
        { key: "includeUntracked", label: "Include untracked files", default: true },
      ],
    });
    // Empty input resolves null (treated as cancel) — the default "WIP" keeps a
    // one-click confirm working while still letting the user type a message.
    if (res === null) return;
    try {
      await gitApi.stashSave(
        props.repoPath,
        res.value || undefined,
        res.toggles.keepIndex,
        res.toggles.includeUntracked,
      );
      pushToast("Stashed changes", "success", 2500);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }
  async function performCommit(msg: string) {
    setCommitting(true);
    setCommitError("");
    setCommitOk(false);
    try {
      if (amendMode()) {
        await gitApi.amend(props.repoPath, msg || undefined);
        setAmendMode(false);
      } else {
        await gitApi.commit(props.repoPath, msg);
      }
      setCommitMsg("");
      setCommitOk(true);
      setTimeout(() => setCommitOk(false), 2000);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  /// Toggle amend mode. Turning it on pre-fills the textarea with the last
  /// commit's summary so the user edits rather than retypes.
  async function toggleAmend() {
    const next = !amendMode();
    setAmendMode(next);
    if (next && !commitMsg().trim()) {
      try {
        const recent = await gitApi.log(props.repoPath, undefined, 1);
        if (recent[0]) setCommitMsg(recent[0].summary);
      } catch {
        // Non-fatal: amend can proceed with an empty (kept) message.
      }
    }
  }

  async function undoLastCommit() {
    const ok = await dialogConfirm(
      "Undo the last commit? Its changes are kept and re-staged (soft reset to HEAD~1).",
      { title: "Undo last commit", kind: "warning" },
    );
    if (!ok) return;
    try {
      await gitApi.undoLastCommit(props.repoPath);
      pushToast("Undid last commit — changes re-staged", "info", 3000);
      emitGitRefsChanged();
      props.onRefresh();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }
  async function commit() {
    const msg = commitMsg().trim();
    // Amend can proceed with no staged files (message-only) and no message
    // (keeps the original); a normal commit needs both.
    if (!amendMode() && (!msg || staged().length === 0)) return;
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
            disabled={committing() || (!amendMode() && (staged().length === 0 || !commitMsg().trim()))}
            onClick={() => void commit()}
            aria-label={amendMode() ? "Amend last commit" : "Commit staged changes"}
            class="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.96] transition-[background-color,color,transform,opacity]"
          >
            <Show
              when={commitOk()}
              fallback={
                committing()
                  ? amendMode() ? "Amending…" : "Committing…"
                  : amendMode()
                    ? "Amend"
                    : <>Commit (<span class="tabular-nums">{staged().length}</span>)</>
              }
            >
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
            onClick={() => void stashChanges()}
            aria-label="Stash changes"
            title="Stash changes"
            class="px-2 py-1 rounded-md text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <Archive class="w-3 h-3" />
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
        <div class="flex items-center gap-2 text-[11px]">
          <label class="flex items-center gap-1 cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors">
            <input
              type="checkbox"
              checked={amendMode()}
              onChange={() => void toggleAmend()}
              class="accent-primary"
            />
            Amend last commit
          </label>
          <button
            onClick={() => void undoLastCommit()}
            title="Undo last commit (soft reset HEAD~1)"
            class="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <Undo2 class="w-3 h-3" /> Undo commit
          </button>
        </div>
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

      <div class="px-2.5 density-section ui-section-label flex items-center">
        <span class="flex-1">Changes (<span class="tabular-nums">{unstaged().length}</span>)</span>
        <Show when={unstaged().length > 0}>
          <button
            onClick={() => void discardAllChanges()}
            title="Discard all changes"
            aria-label="Discard all changes"
            class="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 class="w-3 h-3" />
          </button>
        </Show>
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
            secondaryIcon={f.status === "untracked" ? Trash2 : Undo2}
            onSecondary={() => void discardFile(f.path, f.status)}
            secondaryTitle={f.status === "untracked" ? "Delete untracked file" : "Discard changes"}
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

function BranchesPane(props: { repoPath: string; workspaceId: string; onCheckout: () => void }) {
  const { actions } = useAppStore();
  const [branches, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listBranches(p, true),
  );
  const [error, setError] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [menu, setMenu] = createSignal<{ x: number; y: number; branch: string } | null>(null);

  async function routeOpResult(res: { ok: boolean; conflicted: boolean; message: string }, label: string) {
    if (res.conflicted) {
      const conflicts = await gitApi.listConflicts(props.repoPath);
      for (const c of conflicts) actions.openConflictTab(props.workspaceId, `${props.repoPath}/${c}`);
      pushToast(`${label} stopped on conflicts — resolve them, then continue.`, "warning", 6000);
    } else if (res.ok) {
      pushToast(`${label} complete`, "success", 2500);
    } else {
      pushToast(res.message || `${label} failed`, "error", 7000);
    }
    emitGitRefsChanged();
  }

  async function mergeBranch(name: string, noFf: boolean) {
    try {
      const res = await gitApi.merge(props.repoPath, name, noFf);
      await routeOpResult(res, `Merge ${name}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    }
  }

  async function rebaseOnto(name: string) {
    try {
      const res = await gitApi.rebase(props.repoPath, name);
      await routeOpResult(res, `Rebase onto ${name}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    }
  }

  function branchMenuItems(name: string): ContextMenuItem[] {
    return [
      { label: `Merge ${name} into current`, onSelect: () => void mergeBranch(name, false) },
      { label: `Merge ${name} (--no-ff)`, onSelect: () => void mergeBranch(name, true) },
      { label: `Rebase current onto ${name}`, onSelect: () => void rebaseOnto(name), separatorBefore: true },
    ];
  }

  // Branch ahead/behind and HEAD move on most git mutations; refetch on the
  // shared ref-change pulse so the list never lags after a merge/reset/etc.
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

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

  async function newBranch() {
    const name = await textPrompt({
      title: "New branch",
      label: "Branch name (created at HEAD, no switch)",
      placeholder: "feature/my-branch",
      confirmLabel: "Create",
    });
    if (!name) return;
    try {
      await gitApi.createBranch(props.repoPath, name);
      pushToast(`Created branch ${name}`, "success", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function renameBranch(name: string) {
    const next = await textPrompt({
      title: "Rename branch",
      label: `New name for ${name}`,
      initialValue: name,
      confirmLabel: "Rename",
    });
    if (!next || next === name) return;
    try {
      await gitApi.renameBranch(props.repoPath, name, next);
      pushToast(`Renamed to ${next}`, "success", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function deleteBranch(name: string) {
    const ok = await dialogConfirm(`Delete branch ${name}?`, { title: "Delete branch", kind: "warning" });
    if (!ok) return;
    try {
      await gitApi.deleteBranch(props.repoPath, name, false);
      pushToast(`Deleted branch ${name}`, "info", 2500);
      emitGitRefsChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Backend flags the unmerged case explicitly — offer the force path.
      if (msg.includes("not fully merged")) {
        const force = await dialogConfirm(`${msg}\n\nForce-delete anyway?`, {
          title: "Force-delete branch",
          kind: "warning",
        });
        if (!force) return;
        try {
          await gitApi.deleteBranch(props.repoPath, name, true);
          pushToast(`Deleted branch ${name}`, "info", 2500);
          emitGitRefsChanged();
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        }
      } else {
        pushToast(msg, "error", 6000);
      }
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
      <div class="flex items-center gap-1">
        <input
          type="text"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter branches…"
          class="flex-1 min-w-0 px-2 py-1 text-[12px] bg-muted/50 border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
          aria-label="Filter branches"
        />
        <button
          onClick={() => void newBranch()}
          title="New branch"
          aria-label="New branch"
          class="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
        >
          <GitBranchPlus class="w-3.5 h-3.5" />
        </button>
      </div>
      <Show when={error()}>
        <p class="text-xs text-destructive px-1">{error()}</p>
      </Show>
      <For each={filtered()}>
        {(b) => (
          <div
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, branch: b.name });
            }}
            class={`group flex items-center gap-2 rounded-md px-2 density-row text-[13px] transition-colors ${
              b.isHead
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <button
              onClick={() => void checkout(b.name)}
              disabled={b.isHead}
              aria-label={b.isHead ? `${b.name} (current branch)` : `Checkout ${b.name}`}
              class="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-foreground disabled:cursor-default disabled:hover:text-primary"
            >
              <GitBranch class="w-3 h-3 shrink-0" />
              <span class="truncate flex-1">{b.name}</span>
            </button>
            <Show when={b.ahead > 0}>
              <span class="text-success tabular-nums">↑{b.ahead}</span>
            </Show>
            <Show when={b.behind > 0}>
              <span class="text-destructive tabular-nums">↓{b.behind}</span>
            </Show>
            <Show when={b.isHead}>
              <span class="text-xs uppercase tracking-wide text-primary/80">HEAD</span>
            </Show>
            <Show when={!b.isRemote}>
              <button
                onClick={() => void renameBranch(b.name)}
                title="Rename branch"
                aria-label={`Rename ${b.name}`}
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
              >
                <Pencil class="w-3 h-3" />
              </button>
              <Show when={!b.isHead}>
                <button
                  onClick={() => void deleteBranch(b.name)}
                  title="Delete branch"
                  aria-label={`Delete ${b.name}`}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
                >
                  <X class="w-3 h-3" />
                </button>
              </Show>
            </Show>
          </div>
        )}
      </For>
      <Show when={(branches()?.length ?? 0) > 0 && filtered().length === 0}>
        <p class="text-[11px] text-muted-foreground px-1 py-1">No matches.</p>
      </Show>

      <TagsPane repoPath={props.repoPath} />

      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={branchMenuItems(m().branch)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Worktrees
// ─────────────────────────────────────────────────────────────────────────────

/// Linked worktrees for the repo. Each is a separate working directory on its
/// own branch — "open" loads it as a fresh workspace (its own files, terminal,
/// git view) so you can run two branches side by side without stashing.
function WorktreesPane(props: { repoPath: string }) {
  const { actions } = useAppStore();
  const [worktrees, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listWorktrees(p),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  /// Sibling path for a new worktree: `<repoParent>/<repoName>-<branch>`,
  /// with the branch slug sanitized to filesystem-safe chars.
  function siblingPath(branch: string): string {
    const root = props.repoPath.replace(/\/+$/, "");
    const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return `${root}-${slug || "wt"}`;
  }

  async function addWorktree() {
    const branch = await textPrompt({
      title: "Add worktree",
      label: "Branch for the worktree (existing or new)",
      placeholder: "feature/my-branch",
      confirmLabel: "Create",
    });
    if (!branch) return;
    const path = siblingPath(branch);
    try {
      // Check if the branch already exists locally; if so, check it out into
      // the worktree rather than failing on "already exists".
      const existing = await gitApi.listBranches(props.repoPath, false);
      const isNew = !existing.some((b) => b.name === branch);
      const wt = await gitApi.addWorktree(props.repoPath, path, branch, isNew);
      pushToast(`Created worktree on ${branch}`, "success", 2500);
      emitGitRefsChanged();
      const open = await dialogConfirm(`Open worktree "${branch}" as a new workspace?`, {
        title: "Open worktree",
      });
      if (open) openAsWorkspace(wt.path, branch);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  function openAsWorkspace(path: string, label: string) {
    const id = actions.addWorkspace(label);
    actions.setRepoRoot(id, path);
  }

  async function remove(path: string, label: string) {
    const ok = await dialogConfirm(`Remove worktree "${label}"? Its directory will be deleted.`, {
      title: "Remove worktree",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await gitApi.removeWorktree(props.repoPath, path, false);
      pushToast(`Removed worktree ${label}`, "info", 2500);
      emitGitRefsChanged();
    } catch (e) {
      // git refuses if the worktree is dirty — offer the force path.
      const msg = e instanceof Error ? e.message : String(e);
      const force = await dialogConfirm(`${msg}\n\nForce-remove anyway (discards changes)?`, {
        title: "Force-remove worktree",
        kind: "warning",
      });
      if (force) {
        try {
          await gitApi.removeWorktree(props.repoPath, path, true);
          pushToast(`Removed worktree ${label}`, "info", 2500);
          emitGitRefsChanged();
        } catch (e2) {
          pushToast(e2 instanceof Error ? e2.message : String(e2), "error", 6000);
        }
      }
    }
  }

  return (
    <div class="p-1">
      <button
        onClick={() => void addWorktree()}
        class="w-full flex items-center justify-center gap-1.5 px-2 py-1 mb-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-accent/50 transition-colors"
      >
        <Plus class="w-3 h-3" /> New worktree
      </button>
      <Show when={(worktrees()?.length ?? 0) === 0}>
        <p class="px-2 py-1.5 text-[12px] text-muted-foreground/70">No worktrees yet.</p>
      </Show>
      <For each={worktrees() ?? []}>
        {(wt) => {
          const label = () => wt.branch ?? (wt.isDetached ? "(detached)" : wt.path);
          return (
            <div class="group w-full flex items-center gap-2 rounded-md px-2 density-row text-[13px] text-muted-foreground hover:bg-accent/30">
              <FolderGit2 class="w-3 h-3 shrink-0 opacity-70" />
              <span class="truncate flex-1" title={wt.path}>
                {label()}
              </span>
              <Show when={wt.isLocked}>
                <Lock class="w-3 h-3 text-muted-foreground/70" aria-label="locked" />
              </Show>
              <Show when={wt.isMain}>
                <span class="text-[10px] uppercase tracking-wide text-primary/70">main</span>
              </Show>
              <Show when={!wt.isMain}>
                <button
                  onClick={() => openAsWorkspace(wt.path, label())}
                  title="Open as workspace"
                  aria-label={`Open worktree ${label()} as workspace`}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
                >
                  <FolderOpen class="w-3 h-3" />
                </button>
                <button
                  onClick={() => void remove(wt.path, label())}
                  title="Remove worktree"
                  aria-label={`Remove worktree ${label()}`}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
                >
                  <X class="w-3 h-3" />
                </button>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tags
// ─────────────────────────────────────────────────────────────────────────────

/// Tags sub-section, rendered under the branch list. Create (lightweight or
/// annotated), delete, and push individual tags. Listing reuses git_list_refs.
function TagsPane(props: { repoPath: string }) {
  const [refs, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listRefs(p),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  async function createTag() {
    const res = await promptWithToggles({
      title: "Create tag",
      label: "Tag name (created at HEAD)",
      placeholder: "v1.2.0",
      confirmLabel: "Create",
      toggles: [{ key: "annotated", label: "Annotated tag (with message)", default: false }],
    });
    if (!res) return;
    let message: string | undefined;
    if (res.toggles.annotated) {
      message = (await textPrompt({
        title: "Tag message",
        label: `Annotation for ${res.value}`,
        confirmLabel: "Create tag",
      })) ?? undefined;
    }
    try {
      await gitApi.createTag(props.repoPath, res.value, undefined, message);
      pushToast(`Created tag ${res.value}`, "success", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function deleteTag(name: string) {
    const ok = await dialogConfirm(`Delete tag ${name}?`, { title: "Delete tag", kind: "warning" });
    if (!ok) return;
    try {
      await gitApi.deleteTag(props.repoPath, name);
      pushToast(`Deleted tag ${name}`, "info", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function pushTag(name: string) {
    try {
      await gitApi.pushTag(props.repoPath, name);
      pushToast(`Pushed tag ${name}`, "success", 2500);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  return (
    <div class="pt-2 mt-1 border-t border-border/50">
      <div class="flex items-center gap-1.5 px-1 pb-1">
        <Tag class="w-3 h-3 text-muted-foreground" />
        <span class="flex-1 uppercase tracking-wide text-[10px] text-muted-foreground font-semibold">
          Tags
        </span>
        <button
          onClick={() => void createTag()}
          title="Create tag"
          aria-label="Create tag"
          class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
        >
          <Plus class="w-3 h-3" />
        </button>
      </div>
      <Show when={(refs()?.tags.length ?? 0) === 0}>
        <p class="px-2 py-1 text-[11px] text-muted-foreground/70">No tags.</p>
      </Show>
      <For each={refs()?.tags ?? []}>
        {(t) => (
          <div class="group flex items-center gap-2 rounded-md px-2 density-row text-[13px] text-muted-foreground hover:bg-accent/30">
            <Tag class="w-3 h-3 shrink-0 opacity-70" />
            <span class="truncate flex-1" title={t}>{t}</span>
            <button
              onClick={() => void pushTag(t)}
              title="Push tag to origin"
              aria-label={`Push tag ${t}`}
              class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
            >
              <Upload class="w-3 h-3" />
            </button>
            <button
              onClick={() => void deleteTag(t)}
              title="Delete tag"
              aria-label={`Delete tag ${t}`}
              class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stashes
// ─────────────────────────────────────────────────────────────────────────────

function StashesPane(props: { repoPath: string; workspaceId: string }) {
  const { actions } = useAppStore();
  const [stashes, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.stashList(p),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetch())));

  async function apply(index: number, pop: boolean) {
    try {
      if (pop) await gitApi.stashPop(props.repoPath, index);
      else await gitApi.stashApply(props.repoPath, index);
      pushToast(pop ? "Popped stash" : "Applied stash", "success", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function drop(index: number, message: string) {
    const ok = await dialogConfirm(`Drop stash "${message}"? This cannot be undone.`, {
      title: "Drop stash",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await gitApi.stashDrop(props.repoPath, index);
      pushToast("Dropped stash", "info", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  function showDiff(index: number) {
    actions.openCompareTab(props.workspaceId, {
      baseRef: `stash@{${index}}^1`,
      headRef: `stash@{${index}}`,
      useMergeBase: false,
    });
  }

  return (
    <div class="p-1">
      <Show
        when={(stashes()?.length ?? 0) > 0}
        fallback={<p class="px-2.5 py-2 text-[13px] text-muted-foreground">No stashes.</p>}
      >
        <For each={stashes() ?? []}>
          {(s: StashEntry) => (
            <div class="group flex items-center gap-2 rounded-md px-2 density-row text-[13px] text-muted-foreground hover:bg-accent/30">
              <Archive class="w-3 h-3 shrink-0 opacity-70" />
              <button
                onClick={() => showDiff(s.index)}
                class="truncate flex-1 text-left hover:text-foreground"
                title={`Show diff for ${s.message}`}
              >
                <span class="text-[10px] text-muted-foreground/70 tabular-nums mr-1">{`{${s.index}}`}</span>
                {s.message}
              </button>
              <button
                onClick={() => void apply(s.index, false)}
                title="Apply (keep stash)"
                aria-label="Apply stash"
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
              >
                <Plus class="w-3 h-3" />
              </button>
              <button
                onClick={() => void apply(s.index, true)}
                title="Pop (apply and remove)"
                aria-label="Pop stash"
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent/50 transition-all"
              >
                <ArrowDownToLine class="w-3 h-3" />
              </button>
              <button
                onClick={() => void drop(s.index, s.message)}
                title="Drop stash"
                aria-label="Drop stash"
                class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
              >
                <X class="w-3 h-3" />
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Remotes (modal)
// ─────────────────────────────────────────────────────────────────────────────

function RemotesDialog(props: { repoPath: string; open: boolean; onClose: () => void }) {
  const [remotes, { refetch }] = createResource(
    () => (props.open ? props.repoPath : null),
    (p) => gitApi.listRemotes(p),
  );

  async function addRemote() {
    const name = await textPrompt({ title: "Add remote", label: "Remote name", placeholder: "origin", confirmLabel: "Next" });
    if (!name) return;
    const url = await textPrompt({ title: "Add remote", label: `URL for ${name}`, placeholder: "git@github.com:user/repo.git", confirmLabel: "Add" });
    if (!url) return;
    try {
      await gitApi.addRemote(props.repoPath, name, url);
      pushToast(`Added remote ${name}`, "success", 2500);
      refetch();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function editUrl(r: RemoteInfo) {
    const url = await textPrompt({ title: "Set remote URL", label: r.name, initialValue: r.url ?? "", confirmLabel: "Save" });
    if (!url) return;
    try {
      await gitApi.setRemoteUrl(props.repoPath, r.name, url);
      pushToast(`Updated ${r.name}`, "success", 2500);
      refetch();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function renameRemote(r: RemoteInfo) {
    const next = await textPrompt({ title: "Rename remote", label: `New name for ${r.name}`, initialValue: r.name, confirmLabel: "Rename" });
    if (!next || next === r.name) return;
    try {
      await gitApi.renameRemote(props.repoPath, r.name, next);
      pushToast(`Renamed to ${next}`, "success", 2500);
      refetch();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  async function removeRemote(r: RemoteInfo) {
    const ok = await dialogConfirm(`Remove remote "${r.name}"?`, { title: "Remove remote", kind: "warning" });
    if (!ok) return;
    try {
      await gitApi.removeRemote(props.repoPath, r.name);
      pushToast(`Removed ${r.name}`, "info", 2500);
      refetch();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-[110] flex items-start justify-center bg-black/40 pt-[18vh]" onClick={props.onClose}>
          <div class="w-[min(520px,92vw)] bg-popover border border-border rounded-lg shadow-xl p-4" onClick={(e) => e.stopPropagation()}>
            <div class="flex items-center mb-3">
              <h2 class="text-sm font-semibold flex-1">Remotes</h2>
              <button onClick={() => void addRemote()} class="flex items-center gap-1 px-2 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                <Plus class="w-3 h-3" /> Add
              </button>
            </div>
            <Show when={(remotes()?.length ?? 0) > 0} fallback={<p class="text-xs text-muted-foreground py-2">No remotes configured.</p>}>
              <div class="space-y-1.5">
                <For each={remotes() ?? []}>
                  {(r) => (
                    <div class="group flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-foreground">{r.name}</div>
                        <div class="truncate text-muted-foreground font-mono text-[11px]" title={r.url ?? ""}>{r.url ?? "—"}</div>
                      </div>
                      <button onClick={() => void editUrl(r)} title="Set URL" aria-label={`Set URL for ${r.name}`} class="p-1 rounded hover:bg-accent/60 hover:text-foreground text-muted-foreground transition-colors">
                        <Pencil class="w-3 h-3" />
                      </button>
                      <button onClick={() => void renameRemote(r)} title="Rename" aria-label={`Rename ${r.name}`} class="p-1 rounded hover:bg-accent/60 hover:text-foreground text-muted-foreground transition-colors">
                        <Tag class="w-3 h-3" />
                      </button>
                      <button onClick={() => void removeRemote(r)} title="Remove" aria-label={`Remove ${r.name}`} class="p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground transition-colors">
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex justify-end mt-4">
              <button onClick={props.onClose} class="px-3 py-1.5 rounded text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors">Close</button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
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
  const [log, { refetch: refetchLog }] = createResource(
    () => props.repoPath,
    (p) => gitApi.log(p, undefined, 80),
  );
  onMount(() => onCleanup(onGitRefsChanged(() => refetchLog())));

  const layout = createMemo(() => layoutDag(log() ?? []));

  const [hoveredCommit, setHoveredCommit] = createSignal<GitCommitInfo | null>(null);
  const [hoverPos, setHoverPos] = createSignal({ x: 0, y: 0 });
  const [menu, setMenu] = createSignal<{ x: number; y: number; commit: GitCommitInfo } | null>(null);

  function openCommitCompare(c: GitCommitInfo) {
    const base = c.parentOids[0] ?? c.oid;
    actions.openCompareTab(props.workspaceId, {
      baseRef: base,
      headRef: c.oid,
      useMergeBase: false,
    });
  }

  async function routeOpResult(res: { ok: boolean; conflicted: boolean; message: string }, label: string) {
    if (res.conflicted) {
      const conflicts = await gitApi.listConflicts(props.repoPath);
      for (const c of conflicts) actions.openConflictTab(props.workspaceId, `${props.repoPath}/${c}`);
      pushToast(`${label} stopped on conflicts — resolve them, then continue.`, "warning", 6000);
    } else if (res.ok) {
      pushToast(`${label} complete`, "success", 2500);
    } else {
      pushToast(res.message || `${label} failed`, "error", 7000);
    }
    emitGitRefsChanged();
  }

  async function cherryPick(c: GitCommitInfo) {
    try {
      await routeOpResult(await gitApi.cherryPick(props.repoPath, c.oid), `Cherry-pick ${c.oid.slice(0, 7)}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    }
  }

  async function revert(c: GitCommitInfo) {
    try {
      await routeOpResult(await gitApi.revert(props.repoPath, c.oid), `Revert ${c.oid.slice(0, 7)}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    }
  }

  async function resetTo(c: GitCommitInfo, mode: "soft" | "mixed" | "hard") {
    const short = c.oid.slice(0, 7);
    const warn =
      mode === "hard"
        ? `Hard reset to ${short}? This DISCARDS all uncommitted changes and cannot be undone.`
        : `${mode === "soft" ? "Soft" : "Mixed"} reset to ${short}?`;
    const ok = await dialogConfirm(warn, { title: `Reset (${mode})`, kind: "warning" });
    if (!ok) return;
    // Double-confirm the destructive variant.
    if (mode === "hard") {
      const sure = await dialogConfirm("Really discard all uncommitted work? Last chance.", {
        title: "Confirm hard reset",
        kind: "warning",
      });
      if (!sure) return;
    }
    try {
      await gitApi.reset(props.repoPath, c.oid, mode);
      pushToast(`Reset (${mode}) to ${short}`, "info", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    }
  }

  async function tagHere(c: GitCommitInfo) {
    const name = await textPrompt({ title: "Create tag", label: `Tag at ${c.oid.slice(0, 7)}`, placeholder: "v1.2.0", confirmLabel: "Create" });
    if (!name) return;
    try {
      await gitApi.createTag(props.repoPath, name, c.oid);
      pushToast(`Created tag ${name}`, "success", 2500);
      emitGitRefsChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    }
  }

  function commitMenuItems(c: GitCommitInfo): ContextMenuItem[] {
    return [
      { label: "Cherry-pick onto current", onSelect: () => void cherryPick(c) },
      { label: "Revert commit", onSelect: () => void revert(c) },
      { label: "Create tag here…", onSelect: () => void tagHere(c) },
      { label: "Reset (soft) to here", onSelect: () => void resetTo(c, "soft"), separatorBefore: true },
      { label: "Reset (mixed) to here", onSelect: () => void resetTo(c, "mixed") },
      { label: "Reset (hard) to here", onSelect: () => void resetTo(c, "hard"), danger: true },
    ];
  }

  return (
    <div class="h-full relative">
      <div class="p-1">
        <For each={layout().rows}>
          {(row) => (
            <div
              class="flex items-stretch rounded-md hover:bg-accent/40 transition-colors cursor-pointer select-none"
              onClick={() => openCommitCompare(row.commit)}
              onContextMenu={(e) => {
                e.preventDefault();
                setHoveredCommit(null);
                setMenu({ x: e.clientX, y: e.clientY, commit: row.commit });
              }}
              onMouseEnter={(e) => {
                setHoveredCommit(row.commit);
                setHoverPos({ x: e.clientX, y: e.clientY });
              }}
              onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredCommit(null)}
              title="Open commit diff (right-click for actions)"
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

      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={commitMenuItems(m().commit)}
            onClose={() => setMenu(null)}
          />
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
  secondaryIcon?: LucideIcon;
  onSecondary?: () => void;
  secondaryTitle?: string;
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
      <Show when={props.secondaryIcon}>
        {(SecondaryIcon) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onSecondary?.();
            }}
            aria-label={`${props.secondaryTitle} ${props.file}`}
            title={props.secondaryTitle}
            class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 transition-[opacity,background-color,color]"
          >
            {(() => {
              const I = SecondaryIcon();
              return <I class="w-3 h-3 text-muted-foreground" />;
            })()}
          </button>
        )}
      </Show>
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
