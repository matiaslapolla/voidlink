import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X, TerminalSquare, FileCode, GitCompare, GitBranchPlus, Layers, Plus, FilePlus2, Pin, PinOff, ChevronsRight, GitMerge } from "lucide-solid";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { GitDiffView } from "@/components/git/GitDiffView";
import { CompareTab as CompareTabView } from "@/components/git/compare/CompareTab";
import { StackTab as StackTabView } from "@/components/git/stack/StackTab";
import { ConflictTab as ConflictTabView } from "@/components/git/conflict/ConflictTab";
import { EditorHost } from "@/components/editor/EditorHost";
import { editorController } from "@/components/editor/editorController";
import { useOpenFiles } from "@/components/editor/useOpenFiles";
import { blameEnabled, clearBlameFor, refreshBlameFor } from "@/components/editor/blameOverlay";
import { useAppStore } from "@/store/LayoutContext";
import { terminalApi } from "@/api/terminal";
import { fsApi } from "@/api/fs";
import type { TerminalSession } from "@/types/workspace";

const POLL_MS = 1500;

export function MainSurface() {
  const {
    state,
    activeWorkspace,
    activeTerminals,
    activeDiffTabs,
    activeOpenFiles,
    activeCompareTabs,
    activeStackTabs,
    activeConflictTabs,
    activeItem,
    activePinnedTabs,
    actions,
  } = useAppStore();

  const isPinned = (id: string) => activePinnedTabs().includes(id);

  /// Sort pinned tabs first, preserving relative array order inside each
  /// group. We sort at render time so DnD continues to operate on the
  /// underlying array order — pinning never silently rewrites positions.
  function pinnedFirst<T extends { id: string }>(tabs: T[]): T[] {
    return [...tabs].sort((a, b) => {
      const pa = isPinned(a.id) ? 0 : 1;
      const pb = isPinned(b.id) ? 0 : 1;
      return pa - pb;
    });
  }

  const visibleFiles = createMemo(() => pinnedFirst(activeOpenFiles()));
  const visibleTerminals = createMemo(() => pinnedFirst(activeTerminals()));
  const visibleDiffs = createMemo(() => pinnedFirst(activeDiffTabs()));
  const visibleCompares = createMemo(() => pinnedFirst(activeCompareTabs()));
  const visibleStacks = createMemo(() => pinnedFirst(activeStackTabs()));
  const visibleConflicts = createMemo(() => pinnedFirst(activeConflictTabs()));

  /// Context menu state. One menu element rendered in a Portal; tabs
  /// trigger it via right-click with their own kind+id+label so the menu
  /// items can target the right action without per-tab state.
  type CtxKind = "file" | "terminal" | "diff" | "compare" | "stack";
  const [ctx, setCtx] = createSignal<{
    x: number;
    y: number;
    kind: CtxKind;
    id: string;
    label: string;
    canPin: boolean;
  } | null>(null);

  function openCtxMenu(e: MouseEvent, kind: CtxKind, id: string, label: string) {
    e.preventDefault();
    // Terminals can't be reopened (PTY is gone) so pinning them is
    // pointless — skip the menu entry for that case.
    setCtx({ x: e.clientX, y: e.clientY, kind, id, label, canPin: kind !== "terminal" });
  }

  function closeCtxMenu() {
    setCtx(null);
  }

  function closeOtherTabs(kind: CtxKind, keepId: string) {
    const wsId = state.activeWorkspaceId;
    const lists: Record<CtxKind, { ids: string[]; close: (id: string) => void }> = {
      file: {
        ids: activeOpenFiles().map((t) => t.id),
        close: (id) => {
          const tab = activeOpenFiles().find((t) => t.id === id);
          if (tab) {
            editorController.closeFile(tab.path);
            actions.closeFileTab(wsId, id);
          }
        },
      },
      terminal: {
        ids: activeTerminals().map((t) => t.id),
        close: (id) => actions.removeTerminal(wsId, id),
      },
      diff: {
        ids: activeDiffTabs().map((t) => t.id),
        close: (id) => actions.closeDiffTab(wsId, id),
      },
      compare: {
        ids: activeCompareTabs().map((t) => t.id),
        close: (id) => actions.closeCompareTab(wsId, id),
      },
      stack: {
        ids: activeStackTabs().map((t) => t.id),
        close: (id) => actions.closeStackTab(wsId, id),
      },
    };
    const { ids, close } = lists[kind];
    for (const id of ids) {
      if (id === keepId) continue;
      if (isPinned(id)) continue;
      close(id);
    }
  }

  /// Tab strip overflow detection. ResizeObserver covers width changes
  /// from window resize / sidebar collapse; an effect over the tab-count
  /// memos covers the case where adding/closing a tab pushes the strip
  /// across the overflow threshold without changing element size.
  let scrollRef: HTMLDivElement | undefined;
  const [overflowing, setOverflowing] = createSignal(false);

  function recomputeOverflow() {
    if (!scrollRef) return;
    setOverflowing(scrollRef.scrollWidth > scrollRef.clientWidth + 1);
  }

  onMount(() => {
    if (!scrollRef) return;
    recomputeOverflow();
    const ro = new ResizeObserver(() => recomputeOverflow());
    ro.observe(scrollRef);
    onCleanup(() => ro.disconnect());
  });

  createEffect(() => {
    // Touch the tab-count memos so the effect re-runs on add/close. We
    // wait a microtask so layout has settled before measuring.
    void visibleFiles().length;
    void visibleTerminals().length;
    void visibleDiffs().length;
    void visibleCompares().length;
    void visibleStacks().length;
    queueMicrotask(recomputeOverflow);
  });

  /// Drive the inline-blame overlay: whenever the active file or the
  /// blame toggle changes, refresh the overlay for the new active file
  /// and clear any previous one. Errors inside the overlay log silently.
  createEffect(() => {
    const item = activeItem();
    const repo = repoRoot();
    const wantBlame = blameEnabled();
    if (!wantBlame) {
      if (item?.type === "file") clearBlameFor(item.path);
      return;
    }
    if (item?.type !== "file" || !repo) return;
    void refreshBlameFor(repo, item.path);
  });

  function activateById(
    kind: "file" | "terminal" | "diff" | "compare" | "stack",
    id: string,
  ) {
    const wsId = state.activeWorkspaceId;
    switch (kind) {
      case "file": {
        const tab = activeOpenFiles().find((t) => t.id === id);
        if (tab) {
          actions.selectFileTab(wsId, id, tab.path);
          void editorController.setActive(tab.path);
        }
        break;
      }
      case "terminal": actions.selectTerminal(wsId, id); break;
      case "diff": actions.selectDiffTab(wsId, id); break;
      case "compare": actions.selectCompareTab(wsId, id); break;
      case "stack": actions.selectStackTab(wsId, id); break;
    }
  }

  function closeAllUnpinned() {
    const wsId = state.activeWorkspaceId;
    for (const t of [...activeOpenFiles()]) {
      if (!isPinned(t.id)) {
        editorController.closeFile(t.path);
        actions.closeFileTab(wsId, t.id);
      }
    }
    for (const t of [...activeTerminals()]) if (!isPinned(t.id)) actions.removeTerminal(wsId, t.id);
    for (const t of [...activeDiffTabs()]) if (!isPinned(t.id)) actions.closeDiffTab(wsId, t.id);
    for (const t of [...activeCompareTabs()]) if (!isPinned(t.id)) actions.closeCompareTab(wsId, t.id);
    for (const t of [...activeStackTabs()]) if (!isPinned(t.id)) actions.closeStackTab(wsId, t.id);
  }

  const { openFiles } = useOpenFiles();

  const activeTerminalId = () => { const a = activeItem(); return a?.type === "terminal" ? a.id : null; };
  const activeDiffId     = () => { const a = activeItem(); return a?.type === "diff"     ? a.id : null; };
  const activeFileId     = () => { const a = activeItem(); return a?.type === "file"     ? a.id : null; };
  const activeCompareId  = () => { const a = activeItem(); return a?.type === "compare"  ? a.id : null; };
  const activeStackId    = () => { const a = activeItem(); return a?.type === "stack"    ? a.id : null; };
  const activeConflictId = () => { const a = activeItem(); return a?.type === "conflict" ? a.id : null; };

  const showEditor = () => activeFileId() !== null;

  const nothingOpen = () =>
    activeTerminals().length === 0 &&
    activeDiffTabs().length === 0 &&
    activeOpenFiles().length === 0 &&
    activeCompareTabs().length === 0 &&
    activeStackTabs().length === 0 &&
    activeConflictTabs().length === 0;

  const hasAnyTab = () =>
    activeOpenFiles().length > 0 ||
    activeTerminals().length > 0 ||
    activeDiffTabs().length > 0 ||
    activeCompareTabs().length > 0 ||
    activeStackTabs().length > 0 ||
    activeConflictTabs().length > 0;

  const repoRoot = () => activeWorkspace()?.repoRoot ?? null;

  const [menuOpen, setMenuOpen] = createSignal(false);
  const [newFileMode, setNewFileMode] = createSignal(false);
  const [newFileName, setNewFileName] = createSignal("");
  const [newFileError, setNewFileError] = createSignal("");

  /// Drag state for the unified item tab bar. Tabs of different kinds
  /// (file/terminal/diff/compare/stack) cannot be reordered across each
  /// other — `dragKind` records the source kind so dragover handlers can
  /// reject cross-kind drops cleanly.
  type ItemKind = "file" | "terminal" | "diff" | "compare" | "stack";
  const [dragRef, setDragRef] = createSignal<{ kind: ItemKind; id: string } | null>(null);
  const [dropRef, setDropRef] = createSignal<{ kind: ItemKind; id: string } | null>(null);

  function onTabDragStart(e: DragEvent, kind: ItemKind, id: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/voidlink-item", `${kind}:${id}`);
    setDragRef({ kind, id });
  }

  function onTabDragOver(e: DragEvent, kind: ItemKind, id: string) {
    const drag = dragRef();
    if (!drag || drag.kind !== kind || drag.id === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropRef({ kind, id });
  }

  function onTabDrop(e: DragEvent, kind: ItemKind, id: string) {
    const drag = dragRef();
    if (!drag || drag.kind !== kind || drag.id === id) {
      resetTabDrag();
      return;
    }
    e.preventDefault();
    actions.reorderItemTab(state.activeWorkspaceId, kind, drag.id, id);
    resetTabDrag();
  }

  function resetTabDrag() {
    setDragRef(null);
    setDropRef(null);
  }

  function tabClasses(kind: ItemKind, id: string, isActive: boolean) {
    const base = `group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors`;
    const tone = isActive
      ? "bg-background text-foreground"
      : "text-muted-foreground hover:text-foreground hover:bg-accent/30";
    const drag = dragRef();
    const drop = dropRef();
    const dim = drag && drag.kind === kind && drag.id === id ? "opacity-50" : "";
    const indicator =
      drop && drop.kind === kind && drop.id === id
        ? "shadow-[inset_2px_0_0_0_var(--color-primary,theme(colors.primary))]"
        : "";
    return `${base} ${tone} ${dim} ${indicator}`;
  }

  function closeMenu() {
    setMenuOpen(false);
    setNewFileMode(false);
    setNewFileName("");
    setNewFileError("");
  }

  async function onNewTerminal() {
    if (!repoRoot()) return;
    await actions.spawnTerminal(state.activeWorkspaceId);
    closeMenu();
  }

  function onNewCompare() {
    if (!repoRoot()) return;
    actions.openCompareTab(state.activeWorkspaceId);
    closeMenu();
  }

  async function onCreateFile() {
    const root = repoRoot();
    if (!root) return;
    const name = newFileName().trim();
    if (!name) return;
    // Block path traversal — keep new files at the workspace root.
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      setNewFileError("Use a plain file name at the workspace root.");
      return;
    }
    const fullPath = `${root}/${name}`;
    try {
      await fsApi.createFile(fullPath);
      actions.openFileTab(state.activeWorkspaceId, fullPath);
      await editorController.openFile(fullPath);
      // A new file is invisible to the sidebar until the file tree re-lists
      // its dir and the git status re-runs (the file is untracked).
      window.dispatchEvent(new CustomEvent("voidlink:refresh-files"));
      window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
      closeMenu();
    } catch (e) {
      setNewFileError(e instanceof Error ? e.message : String(e));
    }
  }

  // Always show the tab bar when a repo is selected — the "+" button is the
  // primary entry point for opening terminals / compares / files.
  const showTabBar = () => hasAnyTab() || !!repoRoot();

  return (
    <div class="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Unified tab bar */}
      <Show when={showTabBar()}>
        <div class="flex items-center border-b border-border bg-sidebar shrink-0 h-9">
          <div
            ref={(el) => (scrollRef = el)}
            class="flex items-center overflow-x-auto scrollbar-none flex-1 min-w-0 h-full"
          >
          {/* File tabs */}
          <For each={visibleFiles()}>
            {(tab) => {
              const meta = () => openFiles().find(f => f.path === tab.path);
              const isActive = () => tab.id === activeFileId();
              const fileName = () => tab.path.split("/").pop() ?? tab.path;
              return (
                <div
                  draggable
                  onDragStart={(e) => onTabDragStart(e, "file", tab.id)}
                  onDragOver={(e) => onTabDragOver(e, "file", tab.id)}
                  onDrop={(e) => onTabDrop(e, "file", tab.id)}
                  onDragEnd={resetTabDrag}
                  class={tabClasses("file", tab.id, isActive())}
                  onClick={() => {
                    actions.selectFileTab(state.activeWorkspaceId, tab.id, tab.path);
                    editorController.setActive(tab.path);
                  }}
                  onContextMenu={(e) => openCtxMenu(e, "file", tab.id, fileName())}
                  onMouseDown={(e) => {
                    if (e.button === 1 && !isPinned(tab.id)) {
                      e.preventDefault();
                      editorController.closeFile(tab.path);
                      actions.closeFileTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={tab.path}
                >
                  <Show
                    when={isPinned(tab.id)}
                    fallback={<FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />}
                  >
                    <Pin class="w-3 h-3 shrink-0 text-primary" />
                  </Show>
                  <span class="max-w-[140px] truncate">{fileName()}</span>
                  <Show when={meta()?.dirty}>
                    <span class="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                  </Show>
                  <Show when={!isPinned(tab.id)}>
                    <button
                      onClick={e => { e.stopPropagation(); editorController.closeFile(tab.path); actions.closeFileTab(state.activeWorkspaceId, tab.id); }}
                      class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                      aria-label={`Close ${fileName()}`}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>

          {/* Terminal tabs */}
          <For each={visibleTerminals()}>
            {(term) => (
              <TerminalTabItem
                term={term}
                isActive={term.id === activeTerminalId()}
                onSelect={() => actions.selectTerminal(state.activeWorkspaceId, term.id)}
                onClose={() => actions.removeTerminal(state.activeWorkspaceId, term.id)}
                tabClass={tabClasses("terminal", term.id, term.id === activeTerminalId())}
                onDragStart={(e) => onTabDragStart(e, "terminal", term.id)}
                onDragOver={(e) => onTabDragOver(e, "terminal", term.id)}
                onDrop={(e) => onTabDrop(e, "terminal", term.id)}
                onDragEnd={resetTabDrag}
                onContextMenu={(e) => openCtxMenu(e, "terminal", term.id, term.label)}
              />
            )}
          </For>

          {/* Diff tabs */}
          <For each={visibleDiffs()}>
            {(tab) => {
              const isActive = () => tab.id === activeDiffId();
              const fileName = () => tab.filePath.split("/").pop() ?? tab.filePath;
              return (
                <div
                  draggable
                  onDragStart={(e) => onTabDragStart(e, "diff", tab.id)}
                  onDragOver={(e) => onTabDragOver(e, "diff", tab.id)}
                  onDrop={(e) => onTabDrop(e, "diff", tab.id)}
                  onDragEnd={resetTabDrag}
                  class={tabClasses("diff", tab.id, isActive())}
                  onClick={() => actions.selectDiffTab(state.activeWorkspaceId, tab.id)}
                  onContextMenu={(e) => openCtxMenu(e, "diff", tab.id, `diff · ${fileName()}`)}
                  onMouseDown={(e) => {
                    if (e.button === 1 && !isPinned(tab.id)) {
                      e.preventDefault();
                      actions.closeDiffTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={tab.filePath}
                >
                  <Show
                    when={isPinned(tab.id)}
                    fallback={<GitCompare class="w-3.5 h-3.5 shrink-0 text-info opacity-80" />}
                  >
                    <Pin class="w-3 h-3 shrink-0 text-primary" />
                  </Show>
                  <span class="max-w-[140px] truncate">
                    <span class="text-muted-foreground text-[11px]">diff · </span>{fileName()}
                  </span>
                  <Show when={!isPinned(tab.id)}>
                    <button
                      onClick={e => { e.stopPropagation(); actions.closeDiffTab(state.activeWorkspaceId, tab.id); }}
                      class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                      aria-label={`Close diff ${fileName()}`}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>

          {/* Compare tabs */}
          <For each={visibleCompares()}>
            {(tab) => {
              const isActive = () => tab.id === activeCompareId();
              // SHAs read as noise in tab labels; show the short form.
              const short = (r: string) =>
                /^[0-9a-f]{12,40}$/i.test(r) ? r.slice(0, 7) : r;
              const titleText = () => {
                const base = tab.baseRef || "?";
                const head = tab.headRef || "?";
                return `Compare: ${base}..${head}`;
              };
              return (
                <div
                  draggable
                  onDragStart={(e) => onTabDragStart(e, "compare", tab.id)}
                  onDragOver={(e) => onTabDragOver(e, "compare", tab.id)}
                  onDrop={(e) => onTabDrop(e, "compare", tab.id)}
                  onDragEnd={resetTabDrag}
                  class={tabClasses("compare", tab.id, isActive())}
                  onClick={() => actions.selectCompareTab(state.activeWorkspaceId, tab.id)}
                  onContextMenu={(e) => openCtxMenu(e, "compare", tab.id, titleText())}
                  onMouseDown={(e) => {
                    if (e.button === 1 && !isPinned(tab.id)) {
                      e.preventDefault();
                      actions.closeCompareTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={titleText()}
                >
                  <Show
                    when={isPinned(tab.id)}
                    fallback={<GitBranchPlus class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />}
                  >
                    <Pin class="w-3 h-3 shrink-0 text-primary" />
                  </Show>
                  <span class="max-w-[200px] truncate font-mono text-[12px]">
                    <span class="text-muted-foreground/70 text-[11px] font-sans">compare · </span>
                    {short(tab.baseRef) || "?"}
                    <span class="text-muted-foreground/60">..</span>
                    {short(tab.headRef) || "?"}
                  </span>
                  <Show when={!isPinned(tab.id)}>
                    <button
                      onClick={e => { e.stopPropagation(); actions.closeCompareTab(state.activeWorkspaceId, tab.id); }}
                      class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                      aria-label={`Close compare ${titleText()}`}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>

          {/* Conflict tabs — listed before stacks so unresolved merges
              keep visual priority near the active set of work. */}
          <For each={visibleConflicts()}>
            {(tab) => {
              const isActive = () => tab.id === activeConflictId();
              const fileName = () => tab.filePath.split("/").pop() ?? tab.filePath;
              return (
                <div
                  draggable
                  onDragStart={(e) => onTabDragStart(e, "diff", tab.id)}
                  onDragOver={(e) => onTabDragOver(e, "diff", tab.id)}
                  onDrop={(e) => onTabDrop(e, "diff", tab.id)}
                  onDragEnd={resetTabDrag}
                  class={tabClasses("diff", tab.id, isActive())}
                  onClick={() => actions.selectConflictTab(state.activeWorkspaceId, tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1 && !isPinned(tab.id)) {
                      e.preventDefault();
                      actions.closeConflictTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={`Conflict · ${tab.filePath}`}
                >
                  <Show
                    when={isPinned(tab.id)}
                    fallback={<GitMerge class="w-3.5 h-3.5 shrink-0 text-warning" />}
                  >
                    <Pin class="w-3 h-3 shrink-0 text-primary" />
                  </Show>
                  <span class="max-w-[160px] truncate">
                    <span class="text-warning text-[11px]">conflict · </span>{fileName()}
                  </span>
                  <Show when={!isPinned(tab.id)}>
                    <button
                      onClick={e => { e.stopPropagation(); actions.closeConflictTab(state.activeWorkspaceId, tab.id); }}
                      class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                      aria-label={`Close conflict ${fileName()}`}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>

          {/* Stack tabs */}
          <For each={visibleStacks()}>
            {(tab) => {
              const isActive = () => tab.id === activeStackId();
              return (
                <div
                  draggable
                  onDragStart={(e) => onTabDragStart(e, "stack", tab.id)}
                  onDragOver={(e) => onTabDragOver(e, "stack", tab.id)}
                  onDrop={(e) => onTabDrop(e, "stack", tab.id)}
                  onDragEnd={resetTabDrag}
                  class={tabClasses("stack", tab.id, isActive())}
                  onClick={() => actions.selectStackTab(state.activeWorkspaceId, tab.id)}
                  onContextMenu={(e) => openCtxMenu(e, "stack", tab.id, `stack · ${tab.topBranch}`)}
                  onMouseDown={(e) => {
                    if (e.button === 1 && !isPinned(tab.id)) {
                      e.preventDefault();
                      actions.closeStackTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={`Stack: ${tab.topBranch} → ${tab.trunk}`}
                >
                  <Show
                    when={isPinned(tab.id)}
                    fallback={<Layers class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />}
                  >
                    <Pin class="w-3 h-3 shrink-0 text-primary" />
                  </Show>
                  <span class="max-w-[200px] truncate font-mono text-[12px]">
                    <span class="text-muted-foreground/70 text-[11px] font-sans">stack · </span>
                    {tab.topBranch}
                  </span>
                  <Show when={!isPinned(tab.id)}>
                    <button
                      onClick={e => { e.stopPropagation(); actions.closeStackTab(state.activeWorkspaceId, tab.id); }}
                      class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                      aria-label={`Close stack ${tab.topBranch}`}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>

          </div>

          {/* Overflow chevron — only visible when the scroll region overflows */}
          <Show when={overflowing()}>
            <TabOverflowMenu
              files={visibleFiles()}
              terminals={visibleTerminals()}
              diffs={visibleDiffs()}
              compares={visibleCompares()}
              stacks={visibleStacks()}
              activeId={(() => {
                const a = activeItem();
                return a?.id ?? null;
              })()}
              onJump={(kind, id) => activateById(kind, id)}
            />
          </Show>

          {/* Right-click context menu (single instance, repositioned per click) */}
          <TabContextMenu
            ctx={ctx()}
            isPinned={(id) => isPinned(id)}
            onClose={closeCtxMenu}
            onTogglePin={(id) => {
              actions.togglePinTab(state.activeWorkspaceId, id);
              closeCtxMenu();
            }}
            onCloseTab={(kind, id) => {
              const wsId = state.activeWorkspaceId;
              switch (kind) {
                case "file": {
                  const tab = activeOpenFiles().find((t) => t.id === id);
                  if (tab) {
                    editorController.closeFile(tab.path);
                    actions.closeFileTab(wsId, id);
                  }
                  break;
                }
                case "terminal": actions.removeTerminal(wsId, id); break;
                case "diff": actions.closeDiffTab(wsId, id); break;
                case "compare": actions.closeCompareTab(wsId, id); break;
                case "stack": actions.closeStackTab(wsId, id); break;
              }
              closeCtxMenu();
            }}
            onCloseOthers={(kind, id) => {
              closeOtherTabs(kind, id);
              closeCtxMenu();
            }}
            onCloseAllUnpinned={() => {
              closeAllUnpinned();
              closeCtxMenu();
            }}
          />

          {/* New tab "+" menu */}
          <NewTabMenu
            open={menuOpen()}
            onOpen={() => setMenuOpen(true)}
            onClose={closeMenu}
            disabled={!repoRoot()}
            newFileMode={newFileMode()}
            onEnterFileMode={() => { setNewFileMode(true); setNewFileError(""); }}
            newFileName={newFileName()}
            setNewFileName={setNewFileName}
            newFileError={newFileError()}
            onCreateFile={() => void onCreateFile()}
            onNewTerminal={() => void onNewTerminal()}
            onNewCompare={onNewCompare}
          />
        </div>
      </Show>

      {/* Main content area */}
      <div class="flex-1 relative overflow-hidden">
        {/* EditorHost always mounted — init runs on app load, not on first click */}
        <div class="absolute inset-0" style={{ display: showEditor() ? "block" : "none" }}>
          <EditorHost class="w-full h-full" />
        </div>

        {/* Terminals */}
        <For each={activeTerminals()}>
          {(term) => (
            <div class="absolute inset-0" style={{ display: term.id === activeTerminalId() ? "block" : "none" }}>
              <TerminalPane
                ptyId={term.ptyId}
                active={term.id === activeTerminalId()}
                class="w-full h-full"
                onExit={() => actions.removeTerminal(state.activeWorkspaceId, term.id)}
                onOpenPath={(path, line, column) => {
                  // Resolve relative paths against the workspace root; tools
                  // print both, so accept either.
                  const root = repoRoot();
                  const full = path.startsWith("/") ? path : root ? `${root}/${path}` : path;
                  actions.openFileTab(state.activeWorkspaceId, full);
                  void editorController.openFile(full).then(() => {
                    if (line !== undefined) editorController.revealPosition(line, column);
                  });
                }}
                onOpenSha={(sha) => {
                  if (!repoRoot()) return;
                  actions.openCompareTab(state.activeWorkspaceId, {
                    baseRef: `${sha}^`,
                    headRef: sha,
                    useMergeBase: false,
                  });
                }}
              />
            </div>
          )}
        </For>

        {/* Diffs */}
        <For each={activeDiffTabs()}>
          {(tab) => (
            <Show when={activeWorkspace()?.repoRoot}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeDiffId() ? "block" : "none" }}>
                  <GitDiffView
                    repoPath={repo()}
                    filePath={tab.filePath}
                    onClose={() => actions.closeDiffTab(state.activeWorkspaceId, tab.id)}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Compare tabs */}
        <For each={activeCompareTabs()}>
          {(tab) => (
            <Show when={activeWorkspace()?.repoRoot}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeCompareId() ? "block" : "none" }}>
                  <CompareTabView
                    repoPath={repo()}
                    tab={tab}
                    workspaceId={state.activeWorkspaceId}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Stack tabs */}
        <For each={activeStackTabs()}>
          {(tab) => (
            <Show when={activeWorkspace()?.repoRoot}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeStackId() ? "block" : "none" }}>
                  <StackTabView
                    repoPath={repo()}
                    tab={tab}
                    workspaceId={state.activeWorkspaceId}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Conflict tabs */}
        <For each={activeConflictTabs()}>
          {(tab) => (
            <Show when={activeWorkspace()?.repoRoot}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeConflictId() ? "block" : "none" }}>
                  <ConflictTabView
                    repoPath={repo()}
                    filePath={tab.filePath}
                    workspaceId={state.activeWorkspaceId}
                    onResolved={() => actions.closeConflictTab(state.activeWorkspaceId, tab.id)}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Empty state overlays */}
        <Show when={!activeWorkspace()?.repoRoot}>
          <div class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-3 bg-background z-10">
            <TerminalSquare class="w-7 h-7 opacity-60" />
            <p class="text-[13px]">Select a repository in the sidebar to start working.</p>
          </div>
        </Show>
        <Show when={activeWorkspace()?.repoRoot && nothingOpen()}>
          <div class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-3 bg-background z-10">
            <TerminalSquare class="w-7 h-7 opacity-60" />
            <p class="text-[13px]">Nothing open. Use the <span class="font-mono">+</span> in the tab bar or click a file to open it.</p>
            <button
              onClick={() => actions.openCompareTab(state.activeWorkspaceId)}
              class="mt-1 flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-md border border-border hover:bg-accent/40 hover:text-foreground transition-colors"
            >
              <GitBranchPlus class="w-3.5 h-3.5" />
              Compare branches
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

function NewTabMenu(props: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  disabled: boolean;
  newFileMode: boolean;
  onEnterFileMode: () => void;
  newFileName: string;
  setNewFileName: (v: string) => void;
  newFileError: string;
  onCreateFile: () => void;
  onNewTerminal: () => void;
  onNewCompare: () => void;
}) {
  // The parent tab bar uses `overflow-x-auto`, which clips any descendant
  // absolutely-positioned dropdown. Render the menu in a Portal and anchor
  // it to the button's viewport rect so it escapes the clipping container.
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  const [pos, setPos] = createSignal({ left: 0, top: 0 });

  function reposition() {
    if (!btnRef) return;
    const r = btnRef.getBoundingClientRect();
    const width = 224; // w-56
    const pad = 8;
    let left = r.left;
    if (left + width + pad > window.innerWidth) left = window.innerWidth - width - pad;
    if (left < pad) left = pad;
    setPos({ left, top: r.bottom + 4 });
  }

  // Close on outside click / Escape, reposition on resize/scroll.
  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!props.open) return;
      const target = e.target as Node;
      if (btnRef?.contains(target)) return;
      if (panelRef?.contains(target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) props.onClose();
    };
    const onReflow = () => { if (props.open) reposition(); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    });
  });

  // Reposition whenever the menu opens or its contents (mode) change height.
  createEffect(() => {
    void props.open;
    void props.newFileMode;
    if (props.open) queueMicrotask(reposition);
  });

  // Auto-focus the filename input when we switch into file-naming mode.
  createEffect(() => {
    if (props.open && props.newFileMode) {
      queueMicrotask(() => inputRef?.focus());
    }
  });

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (props.open ? props.onClose() : props.onOpen())}
        disabled={props.disabled}
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={props.open}
        title={props.disabled ? "Select a repository first" : "New tab"}
        class={`mx-1 p-1 rounded transition-colors shrink-0 ${
          props.disabled
            ? "text-muted-foreground/40 cursor-not-allowed"
            : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
        }`}
      >
        <Plus class="w-3.5 h-3.5" />
      </button>

      <Show when={props.open}>
        <Portal>
          <div
            ref={panelRef}
            role="menu"
            class="fixed w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999] py-1 text-[13px]"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <Show
              when={!props.newFileMode}
              fallback={
                <div class="p-2 space-y-1.5">
                  <label class="block text-[11px] text-muted-foreground">
                    New file at workspace root
                  </label>
                  <input
                    ref={inputRef}
                    type="text"
                    value={props.newFileName}
                    placeholder="filename.txt"
                    onInput={(e) => props.setNewFileName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); props.onCreateFile(); }
                    }}
                    class="w-full rounded border border-border bg-muted/40 px-2 py-1 text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Show when={props.newFileError}>
                    <p class="text-[11px] text-destructive">{props.newFileError}</p>
                  </Show>
                  <div class="flex justify-end gap-1.5">
                    <button
                      onClick={props.onClose}
                      class="px-2 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={props.onCreateFile}
                      disabled={!props.newFileName.trim()}
                      class="px-2 py-0.5 rounded text-[11px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                      Create
                    </button>
                  </div>
                </div>
              }
            >
              <MenuItem onClick={props.onNewTerminal} icon={<TerminalSquare class="w-3.5 h-3.5" />}>
                New terminal
              </MenuItem>
              <MenuItem onClick={props.onNewCompare} icon={<GitBranchPlus class="w-3.5 h-3.5" />}>
                New branch compare
              </MenuItem>
              <MenuItem onClick={props.onEnterFileMode} icon={<FilePlus2 class="w-3.5 h-3.5" />}>
                New file at root…
              </MenuItem>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}

/// Overflow chevron button at the right edge of the tab strip. Opens a
/// portal popover that groups every tab by kind so the user can jump to
/// any one without scrolling.
function TabOverflowMenu(props: {
  files: { id: string; path: string }[];
  terminals: TerminalSession[];
  diffs: { id: string; filePath: string }[];
  compares: { id: string; baseRef: string; headRef: string }[];
  stacks: { id: string; trunk: string; topBranch: string }[];
  activeId: string | null;
  onJump: (kind: "file" | "terminal" | "diff" | "compare" | "stack", id: string) => void;
}) {
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });

  function reposition() {
    if (!btnRef) return;
    const r = btnRef.getBoundingClientRect();
    const width = 280;
    const pad = 6;
    let left = r.right - width;
    if (left < pad) left = pad;
    setPos({ left, top: r.bottom + 4 });
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!open()) return;
      const target = e.target as Node;
      if (btnRef?.contains(target)) return;
      if (panelRef?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

  createEffect(() => {
    if (open()) queueMicrotask(reposition);
  });

  const totalCount = () =>
    props.files.length +
    props.terminals.length +
    props.diffs.length +
    props.compares.length +
    props.stacks.length;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title={`${totalCount()} open tabs — show all`}
        aria-label="Show all tabs"
        class="px-1.5 mx-0.5 h-7 self-end mb-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors shrink-0 flex items-center gap-0.5"
      >
        <ChevronsRight class="w-3.5 h-3.5" />
        <span class="text-[10px] font-mono tabular-nums">{totalCount()}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panelRef}
            class="fixed w-[280px] max-h-[60vh] overflow-y-auto scrollbar-thin rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999] py-1 text-[13px]"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <OverflowGroup
              label="Files"
              items={props.files.map((f) => ({ id: f.id, label: f.path.split("/").pop() ?? f.path, hint: f.path }))}
              icon={<FileCode class="w-3 h-3 opacity-70" />}
              activeId={props.activeId}
              onPick={(id) => { props.onJump("file", id); setOpen(false); }}
            />
            <OverflowGroup
              label="Terminals"
              items={props.terminals.map((t) => ({ id: t.id, label: t.label, hint: t.cwd }))}
              icon={<TerminalSquare class="w-3 h-3 opacity-70" />}
              activeId={props.activeId}
              onPick={(id) => { props.onJump("terminal", id); setOpen(false); }}
            />
            <OverflowGroup
              label="Diffs"
              items={props.diffs.map((d) => ({ id: d.id, label: d.filePath.split("/").pop() ?? d.filePath, hint: d.filePath }))}
              icon={<GitCompare class="w-3 h-3 opacity-70" />}
              activeId={props.activeId}
              onPick={(id) => { props.onJump("diff", id); setOpen(false); }}
            />
            <OverflowGroup
              label="Compares"
              items={props.compares.map((c) => ({
                id: c.id,
                label: `${c.baseRef || "?"}..${c.headRef || "?"}`,
                hint: `${c.baseRef}..${c.headRef}`,
              }))}
              icon={<GitBranchPlus class="w-3 h-3 opacity-70" />}
              activeId={props.activeId}
              onPick={(id) => { props.onJump("compare", id); setOpen(false); }}
            />
            <OverflowGroup
              label="Stacks"
              items={props.stacks.map((s) => ({
                id: s.id,
                label: s.topBranch,
                hint: `${s.topBranch} → ${s.trunk}`,
              }))}
              icon={<Layers class="w-3 h-3 opacity-70" />}
              activeId={props.activeId}
              onPick={(id) => { props.onJump("stack", id); setOpen(false); }}
            />
          </div>
        </Portal>
      </Show>
    </>
  );
}

function OverflowGroup(props: {
  label: string;
  items: { id: string; label: string; hint: string }[];
  icon: JSX.Element;
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <Show when={props.items.length > 0}>
      <div class="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {props.label}
      </div>
      <For each={props.items}>
        {(item) => (
          <button
            onClick={() => props.onPick(item.id)}
            title={item.hint}
            class={`w-full flex items-center gap-2 px-3 py-1 text-left transition-colors ${
              item.id === props.activeId
                ? "bg-accent/60 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
          >
            {props.icon}
            <span class="flex-1 truncate font-mono text-[12px]">{item.label}</span>
          </button>
        )}
      </For>
    </Show>
  );
}

/// Single right-click menu rendered as a portal so it escapes the tab
/// strip's `overflow-x-auto` clipping. Targets one tab at a time — the
/// caller passes the active context (kind+id+label+canPin) on open.
function TabContextMenu(props: {
  ctx: { x: number; y: number; kind: "file" | "terminal" | "diff" | "compare" | "stack"; id: string; label: string; canPin: boolean } | null;
  isPinned: (id: string) => boolean;
  onClose: () => void;
  onTogglePin: (id: string) => void;
  onCloseTab: (kind: "file" | "terminal" | "diff" | "compare" | "stack", id: string) => void;
  onCloseOthers: (kind: "file" | "terminal" | "diff" | "compare" | "stack", id: string) => void;
  onCloseAllUnpinned: () => void;
}) {
  let panelRef: HTMLDivElement | undefined;

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!props.ctx) return;
      const target = e.target as Node;
      if (panelRef?.contains(target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (props.ctx && e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

  /// Clamp the menu inside the viewport — right-clicking near the edge
  /// of the window can otherwise push half the menu offscreen.
  const pos = () => {
    const c = props.ctx;
    if (!c) return { left: 0, top: 0 };
    const width = 200;
    const height = 160;
    const pad = 6;
    let left = c.x;
    let top = c.y;
    if (left + width + pad > window.innerWidth) left = window.innerWidth - width - pad;
    if (top + height + pad > window.innerHeight) top = window.innerHeight - height - pad;
    return { left, top };
  };

  return (
    <Show when={props.ctx}>
      {(c) => (
        <Portal>
          <div
            ref={panelRef}
            role="menu"
            class="fixed w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999] py-1 text-[13px]"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <div class="px-3 py-1 text-[11px] text-muted-foreground truncate border-b border-border/50">
              {c().label}
            </div>
            <Show when={c().canPin}>
              <MenuItem
                onClick={() => props.onTogglePin(c().id)}
                icon={
                  props.isPinned(c().id) ? <PinOff class="w-3.5 h-3.5" /> : <Pin class="w-3.5 h-3.5" />
                }
              >
                {props.isPinned(c().id) ? "Unpin tab" : "Pin tab"}
              </MenuItem>
            </Show>
            <MenuItem
              onClick={() => props.onCloseTab(c().kind, c().id)}
              icon={<X class="w-3.5 h-3.5" />}
            >
              Close tab
            </MenuItem>
            <MenuItem
              onClick={() => props.onCloseOthers(c().kind, c().id)}
              icon={<X class="w-3.5 h-3.5" />}
            >
              Close others (this kind)
            </MenuItem>
            <MenuItem
              onClick={() => props.onCloseAllUnpinned()}
              icon={<X class="w-3.5 h-3.5" />}
            >
              Close all unpinned
            </MenuItem>
          </div>
        </Portal>
      )}
    </Show>
  );
}

function MenuItem(props: { onClick: () => void; icon: JSX.Element; children: JSX.Element }) {
  return (
    <button
      role="menuitem"
      onClick={props.onClick}
      class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
    >
      <span class="text-muted-foreground/80">{props.icon}</span>
      <span class="flex-1">{props.children}</span>
    </button>
  );
}

function TerminalTabItem(props: {
  term: TerminalSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  tabClass: string;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [processName, setProcessName] = createSignal<string | null>(null);

  onMount(() => {
    let alive = true;
    const poll = async () => {
      try {
        const info = await terminalApi.processInfo(props.term.ptyId);
        if (!alive) return;
        setBusy(info.busy);
        setProcessName(info.name);
      } catch {}
    };
    void poll();
    const interval = setInterval(poll, POLL_MS);
    onCleanup(() => { alive = false; clearInterval(interval); });
  });

  return (
    <div
      draggable
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
      class={props.tabClass}
      onClick={props.onSelect}
      onContextMenu={props.onContextMenu}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); props.onClose(); } }}
      title={props.term.label}
    >
      <LedDot active={props.isActive} busy={busy()} />
      <span class="max-w-[140px] truncate">
        {props.term.label}
        <Show when={busy() && processName()}>
          <span class="text-muted-foreground text-[11px]"> ({processName()})</span>
        </Show>
      </span>
      <button
        onClick={e => { e.stopPropagation(); props.onClose(); }}
        class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
        aria-label={`Kill ${props.term.label}`}
      >
        <X class="w-3 h-3" />
      </button>
    </div>
  );
}

function LedDot(props: { active: boolean; busy: boolean }) {
  const color = () =>
    props.busy
      ? props.active
        ? "bg-warning shadow-[0_0_6px_theme(colors.warning)]"
        : "bg-warning/80"
      : props.active
        ? "bg-success shadow-[0_0_6px_theme(colors.success)]"
        : "bg-muted-foreground/60";
  return <span class={`w-2 h-2 rounded-full shrink-0 transition-colors ${color()}`} />;
}
