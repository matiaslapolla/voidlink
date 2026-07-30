import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Lock,
  Plus,
  X,
} from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import { onGitRefsChanged } from "@/commands/gitEvents";
import { pickWorkspaceFolder } from "@/commands/openFolder";
import { requestNewWorktree } from "@/commands/worktree";
import { removeWorktreeWithConfirm } from "@/commands/worktreeRemove";
import { pushToast } from "@/commands/toast";
import { worktreeLabel, type Workspace, type Worktree } from "@/types/workspace";
import { Splitter } from "@/components/layout/Splitter";
import { EmptyState } from "@/components/layout/EmptyState";
import { PANEL_BOUNDS } from "@/store/layout";

/// The far-left vertical rail: every workspace, and under each one its
/// worktrees. Replaces the old horizontal workspace tab bar — the tab strip in
/// MainSurface is now per-worktree, so workspaces needed somewhere else to
/// live. Drag-to-reorder and double-click-to-rename are ported verbatim from
/// the tab bar; the badges come straight off `git worktree list` (via
/// `hydrateWorktrees`) rather than being recomputed here.
export function WorkspaceRail() {
  const { state, actions } = useAppStore();
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  /// Drag state stays in component-local signals — no need to round-trip
  /// through the store. `dragId` is the workspace being dragged; `dropTarget`
  /// is the workspace it would land *before* (or "end" for the trailing slot).
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | "end" | null>(null);
  const [menu, setMenu] = createSignal<{
    x: number;
    y: number;
    workspace: Workspace;
    worktree: Worktree;
  } | null>(null);

  // Any git mutation anywhere can add or remove a worktree, or move a branch.
  // Re-hydrating on the shared refresh pulse keeps the rail's badges honest
  // without it owning a poller.
  onMount(() => onCleanup(onGitRefsChanged(() => void actions.hydrateAllWorktrees())));

  const isCollapsed = (id: string) => collapsed().has(id);
  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const startRename = (id: string, name: string) => {
    setRenaming(id);
    setDraft(name);
  };
  const commitRename = () => {
    const id = renaming();
    if (id) actions.renameWorkspace(id, draft());
    setRenaming(null);
  };

  function onDragStart(e: DragEvent, id: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    // Some browsers ignore a drag with no payload — set a benign string.
    e.dataTransfer.setData("text/voidlink-workspace", id);
    setDragId(id);
  }

  function onDragOverGroup(e: DragEvent, id: string) {
    if (!dragId() || dragId() === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  }

  function onDropOnGroup(e: DragEvent, id: string) {
    const from = dragId();
    if (!from || from === id) {
      resetDrag();
      return;
    }
    e.preventDefault();
    actions.reorderWorkspace(from, id);
    resetDrag();
  }

  function onDragOverEnd(e: DragEvent) {
    if (!dragId()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropTarget("end");
  }

  function onDropAtEnd(e: DragEvent) {
    const from = dragId();
    if (!from) return;
    e.preventDefault();
    actions.reorderWorkspace(from, null);
    resetDrag();
  }

  function resetDrag() {
    setDragId(null);
    setDropTarget(null);
  }

  /// Why the `+` might be unavailable, or null when it's fine. Never a silent
  /// no-op: the button stays visible and explains itself in its tooltip.
  function newWorktreeBlockedReason(ws: Workspace): string | null {
    if (!ws.repoRoot) return "Open a folder in this workspace first";
    if (!ws.isRepo) return "This folder isn't a git repository — worktrees need one";
    return null;
  }

  /// Point a workspace at a folder from its own header row, without having to
  /// make it active first and go via the files sidebar. Selecting it afterwards
  /// (not before) means a cancelled dialog leaves you exactly where you were,
  /// while a completed pick puts you in front of what you just opened.
  ///
  /// A workspace that already has a root is re-pointed rather than refused:
  /// `setRepoRoot` moves the main worktree, re-hydrates the list, and re-adopts
  /// the repo name if the workspace never got a manual one.
  async function onOpenFolder(ws: Workspace) {
    const picked = await pickWorkspaceFolder();
    if (!picked) return;
    actions.setRepoRoot(ws.id, picked);
    actions.selectWorkspace(ws.id);
  }

  function onNewWorktree(ws: Workspace) {
    const blocked = newWorktreeBlockedReason(ws);
    if (blocked || !ws.repoRoot) {
      pushToast(blocked ?? "Can't add a worktree here", "warning");
      return;
    }
    const active = ws.worktrees.find((wt) => wt.id === ws.activeWorktreeId);
    requestNewWorktree({
      workspaceId: ws.id,
      repoRoot: ws.repoRoot,
      sourcePath: active?.path || ws.repoRoot,
    });
  }

  /// Remove a linked worktree: git first, store second.
  ///
  /// The flow itself lives in `commands/worktreeRemove` — this version used to
  /// offer force-remove on *any* failure (a lock or a permissions error led
  /// straight to a button whose job is discarding changes) and never emitted a
  /// refresh pulse, so the sidebar kept listing a worktree the rail had already
  /// dropped.
  async function removeWorktree(ws: Workspace, wt: Worktree) {
    if (wt.isMain || !ws.repoRoot) return;
    const removed = await removeWorktreeWithConfirm({
      repoRoot: ws.repoRoot,
      path: wt.path,
      label: worktreeLabel(wt),
    });
    if (removed) actions.removeWorktree(ws.id, wt.id);
  }

  function menuItems(ws: Workspace, wt: Worktree): ContextMenuItem[] {
    return [
      {
        label: "Open in this workspace",
        onSelect: () => actions.selectWorktree(wt.id),
      },
      {
        label: "Copy path",
        onSelect: () => void navigator.clipboard.writeText(wt.path).catch(() => {}),
      },
      {
        label: "Remove worktree…",
        danger: true,
        disabled: wt.isMain,
        separatorBefore: true,
        onSelect: () => void removeWorktree(ws, wt),
      },
    ];
  }

  return (
    <nav
      aria-label="Workspaces"
      /* Island (D1): no border. The edge is the canvas gap `AppShell` puts
         around it; the radius and the clipping belong to the slot. */
      class="flex flex-col bg-sidebar overflow-hidden relative shrink-0"
      style={{ width: `${state.panels.rail}px` }}
      onDragOver={onDragOverEnd}
      onDrop={onDropAtEnd}
    >
      <div class="h-9 px-3 border-b border-border flex items-center shrink-0">
        <span class="text-xs font-semibold text-muted-foreground truncate">Workspaces</span>
      </div>

      <div class="flex-1 overflow-y-auto scrollbar-thin py-1">
        <For each={state.workspaces}>
          {(ws) => {
            const isActiveWs = () => ws.id === state.activeWorkspaceId;
            const blocked = () => newWorktreeBlockedReason(ws);
            return (
              <div
                draggable={renaming() !== ws.id}
                onDragStart={(e) => onDragStart(e, ws.id)}
                onDragEnd={resetDrag}
                onDragOver={(e) => onDragOverGroup(e, ws.id)}
                onDrop={(e) => onDropOnGroup(e, ws.id)}
                class={`mb-0.5 ${dragId() === ws.id ? "opacity-50" : ""} ${
                  dropTarget() === ws.id ? "border-t border-t-primary" : ""
                }`}
              >
                {/* Workspace header */}
                <div
                  class={`group flex items-center gap-1 pl-1 pr-1 h-7 text-xs ${
                    isActiveWs() ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <button
                    onClick={() => toggleCollapsed(ws.id)}
                    aria-label={isCollapsed(ws.id) ? `Expand ${ws.name}` : `Collapse ${ws.name}`}
                    class="p-0.5 rounded hover:bg-accent/50 shrink-0"
                  >
                    <Show
                      when={isCollapsed(ws.id)}
                      fallback={<ChevronDown class="w-3 h-3" />}
                    >
                      <ChevronRight class="w-3 h-3" />
                    </Show>
                  </button>
                  <Show
                    when={renaming() === ws.id}
                    fallback={
                      <button
                        onClick={() => actions.selectWorkspace(ws.id)}
                        onDblClick={() => startRename(ws.id, ws.name)}
                        title={`${ws.name}${ws.repoRoot ? ` — ${ws.repoRoot}` : ""}\nDouble-click to rename, drag to reorder`}
                        class="flex-1 min-w-0 text-left truncate font-medium hover:text-foreground"
                      >
                        {ws.name}
                      </button>
                    }
                  >
                    <input
                      value={draft()}
                      autofocus
                      onInput={(e) => setDraft(e.currentTarget.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Rename workspace"
                      class="flex-1 min-w-0 bg-background/60 rounded px-1 text-xs outline-none"
                    />
                  </Show>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onOpenFolder(ws);
                    }}
                    aria-label={`Open folder in ${ws.name}`}
                    title={ws.repoRoot ? `${ws.repoRoot}\nOpen a different folder…` : "Open folder…"}
                    class="p-0.5 rounded shrink-0 transition-colors opacity-60 group-hover:opacity-100 hover:bg-accent/60 hover:text-foreground"
                  >
                    <FolderOpen class="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewWorktree(ws);
                    }}
                    aria-label={`New worktree in ${ws.name}`}
                    aria-disabled={!!blocked()}
                    title={blocked() ?? "New worktree…"}
                    class={`p-0.5 rounded shrink-0 transition-colors ${
                      blocked()
                        ? "text-muted-foreground/40 cursor-not-allowed"
                        : "opacity-60 group-hover:opacity-100 hover:bg-accent/60 hover:text-foreground"
                    }`}
                  >
                    <Plus class="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.removeWorkspace(ws.id);
                    }}
                    aria-label={`Close ${ws.name} workspace`}
                    title="Close workspace"
                    class="p-0.5 rounded shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>

                {/* Worktrees */}
                <Show when={!isCollapsed(ws.id)}>
                  {/* An expanded workspace with nothing under it is otherwise
                      indistinguishable from a collapsed one — the chevron is
                      the only difference, and it is 12px. §9.7. */}
                  <Show when={ws.worktrees.length === 0}>
                    <EmptyState id="workspaceNoWorktrees" class="!py-3" />
                  </Show>
                  <For each={ws.worktrees}>
                    {(wt) => {
                      const isActive = () =>
                        isActiveWs() && wt.id === state.activeWorktreeId;
                      return (
                        <div
                          class={`group/wt flex items-center gap-1.5 pl-6 pr-1.5 density-row rounded-sm mx-1 text-[13px] cursor-pointer transition-colors ${
                            isActive()
                              ? "bg-accent/60 text-foreground"
                              : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
                          }`}
                          onClick={() => actions.selectWorktree(wt.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({ x: e.clientX, y: e.clientY, workspace: ws, worktree: wt });
                          }}
                          title={wt.path || "No folder selected"}
                        >
                          <Show
                            when={wt.isMain}
                            fallback={<GitBranch class="w-3 h-3 shrink-0 opacity-70" />}
                          >
                            <FolderGit2 class="w-3 h-3 shrink-0 opacity-70" />
                          </Show>
                          <span class="truncate flex-1">{worktreeLabel(wt)}</span>
                          <Show when={wt.isDirty}>
                            <span
                              class="text-warning shrink-0"
                              title="Uncommitted changes"
                              aria-label="uncommitted changes"
                            >
                              ●
                            </span>
                          </Show>
                          <Show when={wt.ahead > 0}>
                            <span
                              class="text-success tabular-nums shrink-0 text-[11px]"
                              title={`${wt.ahead} commit(s) ahead of upstream`}
                              aria-label={`${wt.ahead} ahead`}
                            >
                              ↑{wt.ahead}
                            </span>
                          </Show>
                          <Show when={wt.behind > 0}>
                            <span
                              class="text-destructive tabular-nums shrink-0 text-[11px]"
                              title={`${wt.behind} commit(s) behind upstream`}
                              aria-label={`${wt.behind} behind`}
                            >
                              ↓{wt.behind}
                            </span>
                          </Show>
                          <Show when={wt.statusUnknown}>
                            <span
                              class="text-muted-foreground/70 shrink-0"
                              title="Could not read this worktree's status — it may be missing or unreachable"
                              aria-label="status unknown"
                            >
                              ?
                            </span>
                          </Show>
                          <Show when={wt.isPrunable}>
                            <span
                              class="text-destructive shrink-0 text-[10px] font-mono"
                              title="This worktree's directory is gone — git would prune it"
                              aria-label="missing"
                            >
                              missing
                            </span>
                          </Show>
                          <Show when={wt.isLocked}>
                            <Lock class="w-3 h-3 shrink-0 opacity-70" aria-label="locked" />
                          </Show>
                          <Show when={!wt.isMain}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void removeWorktree(ws, wt);
                              }}
                              aria-label={`Remove worktree ${worktreeLabel(wt)}`}
                              title="Remove worktree"
                              class="p-0.5 rounded shrink-0 opacity-0 group-hover/wt:opacity-70 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                            >
                              <X class="w-3 h-3" />
                            </button>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <div
        class={`border-t border-border/50 p-1.5 shrink-0 ${
          dropTarget() === "end" ? "border-t-primary" : ""
        }`}
      >
        <button
          onClick={() => actions.addWorkspace()}
          aria-label="New workspace"
          title="New workspace"
          class="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-accent/50 transition-colors"
        >
          <Plus class="w-3 h-3" /> New workspace
        </button>
      </div>

      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={menuItems(m().workspace, m().worktree)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>

      <Splitter
        side="end"
        label="Workspace rail width"
        value={state.panels.rail}
        min={PANEL_BOUNDS.rail.min}
        max={PANEL_BOUNDS.rail.max}
        defaultValue={PANEL_BOUNDS.rail.default}
        onResize={(w) => actions.setPanelWidth("rail", w)}
      />
    </nav>
  );
}
