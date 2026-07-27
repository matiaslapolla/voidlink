import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  TerminalSquare,
  GitBranchPlus,
  Layers,
  Plus,
  FilePlus2,
  GitCommitHorizontal,
  Brain,
  Globe,
} from "lucide-solid";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { CompareTab as CompareTabView } from "@/components/git/compare/CompareTab";
import { StackTab as StackTabView } from "@/components/git/stack/StackTab";
import { CommitGraph } from "@/components/git/history/CommitGraph";
import { BrainSurface } from "@/components/brain/BrainSurface";
import { BrowserPane, browserTabLabel, normalizeUrl } from "@/components/browser/BrowserPane";
import { MenuItem, TabStrip, type TabDescriptor } from "@/components/layout/TabStrip";
import { useAppStore } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import { fsApi } from "@/api/fs";
import { gitApi } from "@/api/git";
import { recordBranchUse } from "@/commands/branchMru";
import { pushToast } from "@/commands/toast";

interface MainSurfaceProps {
  /// Hand a file to the editor window. The workbench has no editor of its own
  /// any more, so every path that used to open a Monaco tab — a terminal
  /// deep-link, a new file from the "+" menu — routes through here.
  onOpenFile: (path: string, line?: number, column?: number) => void;
}

/// The workbench's tab surface: terminals, branch compares, stacks, the commit
/// graph, brain and the embedded browser.
///
/// Files, diffs, merges and markdown previews used to live here too. They moved
/// to the editor window (`EditorApp.tsx`), which is why this component no longer
/// touches Monaco and why the tab strip it renders is the shared one in
/// `TabStrip.tsx` rather than a bespoke row.
export function MainSurface(props: MainSurfaceProps) {
  const {
    state,
    activeRepoPath,
    activeTerminals,
    activeCompareTabs,
    activeStackTabs,
    activeHistoryTabs,
    activeBrainTabs,
    activeBrowserTabs,
    activeItem,
    activePinnedTabs,
    actions,
  } = useAppStore();
  const { settings } = useSettings();

  const isPinned = (id: string) => activePinnedTabs().includes(id);

  const activeTerminalId = () => { const a = activeItem(); return a?.type === "terminal" ? a.id : null; };
  const activeCompareId  = () => { const a = activeItem(); return a?.type === "compare"  ? a.id : null; };
  const activeStackId    = () => { const a = activeItem(); return a?.type === "stack"    ? a.id : null; };
  const activeHistoryId  = () => { const a = activeItem(); return a?.type === "history"  ? a.id : null; };
  const activeBrainId    = () => { const a = activeItem(); return a?.type === "brain"    ? a.id : null; };
  const activeBrowserId  = () => { const a = activeItem(); return a?.type === "browser"  ? a.id : null; };

  const nothingOpen = () => tabs().length === 0;
  const hasAnyTab = () => tabs().length > 0;

  const repoRoot = () => activeRepoPath() ?? null;

  // ── Tab descriptors ──────────────────────────────────────────────────────
  // Flattened for the shared strip. Order here is render order there.

  /// SHAs read as noise in tab labels; show the short form.
  const short = (r: string) => (/^[0-9a-f]{12,40}$/i.test(r) ? r.slice(0, 7) : r);

  const tabs = createMemo<TabDescriptor[]>(() => {
    const out: TabDescriptor[] = [];
    for (const term of activeTerminals()) {
      out.push({
        kind: "terminal",
        id: term.id,
        label: term.label,
        icon: <TerminalSquare class="w-3.5 h-3.5 shrink-0" />,
        title: term.label,
        terminal: term,
      });
    }
    for (const tab of activeCompareTabs()) {
      out.push({
        kind: "compare",
        id: tab.id,
        label: `${short(tab.baseRef) || "?"}..${short(tab.headRef) || "?"}`,
        prefix: "compare · ",
        icon: <GitBranchPlus class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: `Compare: ${tab.baseRef || "?"}..${tab.headRef || "?"}`,
        mono: true,
        labelWidth: "max-w-[200px]",
      });
    }
    for (const tab of activeStackTabs()) {
      out.push({
        kind: "stack",
        id: tab.id,
        label: tab.topBranch,
        prefix: "stack · ",
        icon: <Layers class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: `Stack: ${tab.topBranch} → ${tab.trunk}`,
        mono: true,
        labelWidth: "max-w-[200px]",
      });
    }
    for (const tab of activeHistoryTabs()) {
      out.push({
        kind: "history",
        id: tab.id,
        label: "graph",
        icon: <GitCommitHorizontal class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: "Commit graph",
        // Repo-wide singletons: one per worktree, so there is nothing to sort
        // them against and nothing a pin would protect them from.
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeBrainTabs()) {
      out.push({
        kind: "brain",
        id: tab.id,
        label: "brain",
        icon: <Brain class="w-3.5 h-3.5 shrink-0 text-primary opacity-90" />,
        title: "Brain",
        pinnable: false,
        draggable: false,
      });
    }
    for (const tab of activeBrowserTabs()) {
      out.push({
        kind: "browser",
        id: tab.id,
        label: browserTabLabel(tab),
        icon: <Globe class="w-3.5 h-3.5 shrink-0 text-info opacity-80" />,
        title: tab.url,
        labelWidth: "max-w-[160px]",
        // The page is a child webview keyed by tab id; reordering the store
        // list would not move it, so the tab stays put too.
        pinnable: false,
        draggable: false,
      });
    }
    return out;
  });

  function selectTab(tab: TabDescriptor) {
    const wtId = state.activeWorktreeId;
    switch (tab.kind) {
      case "terminal": actions.selectTerminal(wtId, tab.id); break;
      case "compare": actions.selectCompareTab(wtId, tab.id); break;
      case "stack": actions.selectStackTab(wtId, tab.id); break;
      case "history": actions.selectHistoryTab(wtId, tab.id); break;
      case "brain": actions.selectBrainTab(wtId, tab.id); break;
      case "browser": actions.selectBrowserTab(wtId, tab.id); break;
    }
  }

  function closeTab(tab: TabDescriptor) {
    const wtId = state.activeWorktreeId;
    switch (tab.kind) {
      case "terminal": actions.removeTerminal(wtId, tab.id); break;
      case "compare": actions.closeCompareTab(wtId, tab.id); break;
      case "stack": actions.closeStackTab(wtId, tab.id); break;
      case "history": actions.closeHistoryTab(wtId, tab.id); break;
      case "brain": actions.closeBrainTab(wtId, tab.id); break;
      case "browser": actions.closeBrowserTab(wtId, tab.id); break;
    }
  }

  /// Local branch names for the active repo. Feeds the terminal's branch
  /// deep-link provider so only real branches get linkified. Refreshed on
  /// repo change and on the same `voidlink:refresh-git` pulse the sidebar
  /// uses after a checkout/commit.
  const [branchNames, setBranchNames] = createSignal<string[]>([]);
  async function refreshBranchNames() {
    const root = repoRoot();
    if (!root) {
      setBranchNames([]);
      return;
    }
    try {
      const branches = await gitApi.listBranches(root, false);
      setBranchNames(branches.map((b) => b.name));
    } catch {
      setBranchNames([]);
    }
  }
  createEffect(() => {
    // Re-fetch whenever the active repo changes.
    repoRoot();
    void refreshBranchNames();
  });
  onMount(() => {
    const handler = () => void refreshBranchNames();
    window.addEventListener("voidlink:refresh-git", handler);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", handler));
  });

  /// The ⌘K "Open commit graph" command (registered in commands/registry.ts)
  /// broadcasts this event so it can stay decoupled from the store. We open
  /// the graph tab for the active workspace when a repo is selected.
  onMount(() => {
    const handler = () => {
      if (!repoRoot()) {
        pushToast("Open a repository first", "warning");
        return;
      }
      actions.openHistoryTab(state.activeWorktreeId);
    };
    window.addEventListener("voidlink:open-commit-graph", handler);
    onCleanup(() => window.removeEventListener("voidlink:open-commit-graph", handler));
  });

  /// Switch to `branch` from a terminal deep-link. Mirrors the git sidebar's
  /// safe-checkout flow: auto-stash feedback, MRU bump, and a refresh pulse
  /// so every pane (sidebar, status bar, blame) re-reads HEAD.
  async function openBranchFromTerminal(branch: string) {
    const root = repoRoot();
    if (!root) return;
    try {
      const result = await gitApi.safeCheckout(root, branch);
      recordBranchUse(root, branch);
      if (result.autoStashed) {
        pushToast(
          `Switched to ${branch}. Auto-stashed your changes — restore with \`git stash pop\`.`,
          "info",
          5000,
        );
      } else {
        pushToast(`Switched to ${branch}.`, "info", 2500);
      }
      window.dispatchEvent(new CustomEvent("voidlink:refresh-files"));
      window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 5000);
    }
  }

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
    await actions.spawnTerminal(state.activeWorktreeId);
    closeMenu();
  }

  function onNewCompare() {
    if (!repoRoot()) return;
    actions.openCompareTab(state.activeWorktreeId);
    closeMenu();
  }

  /// Open an embedded browser tab. Starts blank-ish rather than prompting —
  /// the pane has its own address bar, and one fewer modal is one fewer thing
  /// that has to fight the child webview for the top of the stack.
  function onNewBrowser() {
    actions.openBrowserTab(state.activeWorktreeId, normalizeUrl("example.com"));
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
      // The file itself opens over in the editor window.
      props.onOpenFile(fullPath);
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
      <Show when={showTabBar()}>
        <TabStrip
          tabs={tabs()}
          activeId={activeItem()?.id ?? null}
          isPinned={isPinned}
          onSelect={selectTab}
          onClose={closeTab}
          onReorder={(kind, fromId, toId) => {
            // Only the two draggable kinds reach this; the rest are marked
            // non-draggable in their descriptors.
            if (kind !== "terminal" && kind !== "compare" && kind !== "stack") return;
            actions.reorderItemTab(state.activeWorktreeId, kind, fromId, toId);
          }}
          onTogglePin={(id) => actions.togglePinTab(state.activeWorktreeId, id)}
          trailing={
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
              onOpenBrain={() => {
                actions.openBrainTab(state.activeWorktreeId);
                closeMenu();
              }}
              onNewBrowser={onNewBrowser}
            />
          }
        />
      </Show>

      {/* Main content area */}
      <div class="flex-1 relative overflow-hidden">
        {/* Terminals */}
        <For each={activeTerminals()}>
          {(term) => (
            <div class="absolute inset-0" style={{ display: term.id === activeTerminalId() ? "block" : "none" }}>
              <TerminalPane
                ptyId={term.ptyId}
                active={term.id === activeTerminalId()}
                class="w-full h-full"
                onExit={() => actions.removeTerminal(state.activeWorktreeId, term.id)}
                onOpenPath={(path, line, column) => {
                  // Resolve relative paths against the workspace root; tools
                  // print both, so accept either.
                  const root = repoRoot();
                  const full = path.startsWith("/") ? path : root ? `${root}/${path}` : path;
                  props.onOpenFile(full, line, column);
                }}
                onOpenSha={(sha) => {
                  if (!repoRoot()) return;
                  actions.openCompareTab(state.activeWorktreeId, {
                    baseRef: `${sha}^`,
                    headRef: sha,
                    useMergeBase: false,
                  });
                }}
                branchNames={branchNames}
                onOpenBranch={(branch) => void openBranchFromTerminal(branch)}
              />
            </div>
          )}
        </For>

        {/* Compare tabs */}
        <For each={activeCompareTabs()}>
          {(tab) => (
            <Show when={activeRepoPath()}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeCompareId() ? "block" : "none" }}>
                  <CompareTabView
                    repoPath={repo()}
                    tab={tab}
                    worktreeId={state.activeWorktreeId}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Stack tabs */}
        <For each={activeStackTabs()}>
          {(tab) => (
            <Show when={activeRepoPath()}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeStackId() ? "block" : "none" }}>
                  <StackTabView
                    repoPath={repo()}
                    tab={tab}
                    worktreeId={state.activeWorktreeId}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Brain tabs */}
        <For each={activeBrainTabs()}>
          {(tab) => (
            <div class="absolute inset-0" style={{ display: tab.id === activeBrainId() ? "block" : "none" }}>
              <BrainSurface vaultPath={settings.brain.vaultPath} />
            </div>
          )}
        </For>

        {/* Browser tabs. Kept mounted so the webview isn't torn down on every
            tab switch — BrowserPane hides it instead. */}
        <For each={activeBrowserTabs()}>
          {(tab) => (
            <div class="absolute inset-0" style={{ display: tab.id === activeBrowserId() ? "block" : "none" }}>
              <BrowserPane
                tab={tab}
                active={tab.id === activeBrowserId()}
                onUrlChange={(url) => actions.setBrowserUrl(state.activeWorktreeId, tab.id, url)}
                onTitleChange={(title) => actions.setBrowserTitle(state.activeWorktreeId, tab.id, title)}
              />
            </div>
          )}
        </For>

        {/* Commit graph tabs */}
        <For each={activeHistoryTabs()}>
          {(tab) => (
            <Show when={activeRepoPath()}>
              {(repo) => (
                <div class="absolute inset-0" style={{ display: tab.id === activeHistoryId() ? "block" : "none" }}>
                  <CommitGraph
                    repoPath={repo()}
                    onOpenCommit={(oid) => {
                      // Reuse the existing commit-diff path: a compare tab of
                      // <oid>^..<oid> shows exactly what the commit changed.
                      actions.openCompareTab(state.activeWorktreeId, {
                        baseRef: `${oid}^`,
                        headRef: oid,
                        useMergeBase: false,
                      });
                    }}
                  />
                </div>
              )}
            </Show>
          )}
        </For>

        {/* Empty state overlays */}
        <Show when={!activeRepoPath()}>
          <div class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-3 bg-background z-10">
            <TerminalSquare class="w-7 h-7 opacity-60" />
            <p class="text-[13px]">Select a repository in the sidebar to start working.</p>
          </div>
        </Show>
        <Show when={activeRepoPath() && nothingOpen()}>
          <div class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-3 bg-background z-10">
            <TerminalSquare class="w-7 h-7 opacity-60" />
            <p class="text-[13px]">Nothing open. Use the <span class="font-mono">+</span> in the tab bar, or open a file to work on it in the editor window.</p>
            <button
              onClick={() => actions.openCompareTab(state.activeWorktreeId)}
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
  onOpenBrain: () => void;
  onNewBrowser: () => void;
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
              <MenuItem onClick={props.onOpenBrain} icon={<Brain class="w-3.5 h-3.5" />}>
                Brain
              </MenuItem>
              <MenuItem onClick={props.onNewBrowser} icon={<Globe class="w-3.5 h-3.5" />}>
                New browser tab
              </MenuItem>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
