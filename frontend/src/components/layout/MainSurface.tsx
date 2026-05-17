import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X, TerminalSquare, FileCode, GitCompare, GitBranchPlus, Layers, Plus, FilePlus2 } from "lucide-solid";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { GitDiffView } from "@/components/git/GitDiffView";
import { CompareTab as CompareTabView } from "@/components/git/compare/CompareTab";
import { StackTab as StackTabView } from "@/components/git/stack/StackTab";
import { EditorHost } from "@/components/editor/EditorHost";
import { editorController } from "@/components/editor/editorController";
import { useOpenFiles } from "@/components/editor/useOpenFiles";
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
    activeItem,
    actions,
  } = useAppStore();

  const { openFiles } = useOpenFiles();

  const activeTerminalId = () => { const a = activeItem(); return a?.type === "terminal" ? a.id : null; };
  const activeDiffId     = () => { const a = activeItem(); return a?.type === "diff"     ? a.id : null; };
  const activeFileId     = () => { const a = activeItem(); return a?.type === "file"     ? a.id : null; };
  const activeCompareId  = () => { const a = activeItem(); return a?.type === "compare"  ? a.id : null; };
  const activeStackId    = () => { const a = activeItem(); return a?.type === "stack"    ? a.id : null; };

  const showEditor = () => activeFileId() !== null;

  const nothingOpen = () =>
    activeTerminals().length === 0 &&
    activeDiffTabs().length === 0 &&
    activeOpenFiles().length === 0 &&
    activeCompareTabs().length === 0 &&
    activeStackTabs().length === 0;

  const hasAnyTab = () =>
    activeOpenFiles().length > 0 ||
    activeTerminals().length > 0 ||
    activeDiffTabs().length > 0 ||
    activeCompareTabs().length > 0 ||
    activeStackTabs().length > 0;

  const repoRoot = () => activeWorkspace()?.repoRoot ?? null;

  const [menuOpen, setMenuOpen] = createSignal(false);
  const [newFileMode, setNewFileMode] = createSignal(false);
  const [newFileName, setNewFileName] = createSignal("");
  const [newFileError, setNewFileError] = createSignal("");

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
        <div class="flex items-center border-b border-border bg-sidebar overflow-x-auto scrollbar-none shrink-0 h-9">
          {/* File tabs */}
          <For each={activeOpenFiles()}>
            {(tab) => {
              const meta = () => openFiles().find(f => f.path === tab.path);
              const isActive = () => tab.id === activeFileId();
              const fileName = () => tab.path.split("/").pop() ?? tab.path;
              return (
                <div
                  class={`group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors ${
                    isActive() ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
                  }`}
                  onClick={() => {
                    actions.selectFileTab(state.activeWorkspaceId, tab.id, tab.path);
                    editorController.setActive(tab.path);
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      editorController.closeFile(tab.path);
                      actions.closeFileTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={tab.path}
                >
                  <FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />
                  <span class="max-w-[140px] truncate">{fileName()}</span>
                  <Show when={meta()?.dirty}>
                    <span class="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                  </Show>
                  <button
                    onClick={e => { e.stopPropagation(); editorController.closeFile(tab.path); actions.closeFileTab(state.activeWorkspaceId, tab.id); }}
                    class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                    aria-label={`Close ${fileName()}`}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              );
            }}
          </For>

          {/* Terminal tabs */}
          <For each={activeTerminals()}>
            {(term) => (
              <TerminalTabItem
                term={term}
                isActive={term.id === activeTerminalId()}
                onSelect={() => actions.selectTerminal(state.activeWorkspaceId, term.id)}
                onClose={() => actions.removeTerminal(state.activeWorkspaceId, term.id)}
              />
            )}
          </For>

          {/* Diff tabs */}
          <For each={activeDiffTabs()}>
            {(tab) => {
              const isActive = () => tab.id === activeDiffId();
              const fileName = () => tab.filePath.split("/").pop() ?? tab.filePath;
              return (
                <div
                  class={`group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors ${
                    isActive() ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
                  }`}
                  onClick={() => actions.selectDiffTab(state.activeWorkspaceId, tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      actions.closeDiffTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={tab.filePath}
                >
                  <GitCompare class="w-3.5 h-3.5 shrink-0 text-info opacity-80" />
                  <span class="max-w-[140px] truncate">
                    <span class="text-muted-foreground text-[11px]">diff · </span>{fileName()}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); actions.closeDiffTab(state.activeWorkspaceId, tab.id); }}
                    class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                    aria-label={`Close diff ${fileName()}`}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              );
            }}
          </For>

          {/* Compare tabs */}
          <For each={activeCompareTabs()}>
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
                  class={`group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors ${
                    isActive() ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
                  }`}
                  onClick={() => actions.selectCompareTab(state.activeWorkspaceId, tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      actions.closeCompareTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={titleText()}
                >
                  <GitBranchPlus class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />
                  <span class="max-w-[200px] truncate font-mono text-[12px]">
                    <span class="text-muted-foreground/70 text-[11px] font-sans">compare · </span>
                    {short(tab.baseRef) || "?"}
                    <span class="text-muted-foreground/60">..</span>
                    {short(tab.headRef) || "?"}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); actions.closeCompareTab(state.activeWorkspaceId, tab.id); }}
                    class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                    aria-label={`Close compare ${titleText()}`}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              );
            }}
          </For>

          {/* Stack tabs */}
          <For each={activeStackTabs()}>
            {(tab) => {
              const isActive = () => tab.id === activeStackId();
              return (
                <div
                  class={`group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors ${
                    isActive() ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
                  }`}
                  onClick={() => actions.selectStackTab(state.activeWorkspaceId, tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      actions.closeStackTab(state.activeWorkspaceId, tab.id);
                    }
                  }}
                  title={`Stack: ${tab.topBranch} → ${tab.trunk}`}
                >
                  <Layers class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />
                  <span class="max-w-[200px] truncate font-mono text-[12px]">
                    <span class="text-muted-foreground/70 text-[11px] font-sans">stack · </span>
                    {tab.topBranch}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); actions.closeStackTab(state.activeWorkspaceId, tab.id); }}
                    class="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color]"
                    aria-label={`Close stack ${tab.topBranch}`}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              );
            }}
          </For>

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
      class={`group flex items-center gap-1.5 px-3 h-full border-r border-border shrink-0 text-[13px] cursor-pointer select-none transition-colors ${
        props.isActive ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
      }`}
      onClick={props.onSelect}
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
