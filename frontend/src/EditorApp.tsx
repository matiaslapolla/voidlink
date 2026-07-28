/// Root of the standalone editor window.
///
/// Same bundle as the workbench, different root: `main.tsx` picks between this,
/// `GitApp` and `App` on the Tauri window label. What you get here is the code
/// editor given a whole window — file tree, tab strip, Monaco, side-by-side
/// diffs, a three-way merge editor and a git panel — which is what let the
/// workbench drop its editor and become a terminal + workspace + agents surface.
///
/// This window is a *consumer* of workbench state. It does not choose the
/// repository (the workbench rail does) and it does not own its tab list: tabs
/// arrive as a broadcast snapshot and every mutation is a request sent back. See
/// `api/windows.ts` for why that is one-directional, and `createAppStore({
/// persist: false })` below for what the local store is still good for.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import {
  AlertTriangle,
  ArrowUpRight,
  Eye,
  FileCode,
  FolderTree,
  GitBranch,
  Search,
  GitCompare,
  GitMerge,
  PanelRight,
  Columns2,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { isMac } from "@/api/platform";
import {
  bridgeGitRefsAcrossWindows,
  focusMainWindow,
  onEditorTabs,
  onWindowContext,
  openGitWindow,
  requestEditorTabs,
  requestWindowContext,
  sendEditorRequest,
  type EditorRequest,
  type EditorTabsSnapshot,
  type WindowContext,
} from "@/api/windows";
import { ChangesPane } from "@/components/git/GitSidebar";
import { EditorHost } from "@/components/editor/EditorHost";
import { EditorGroupsView } from "@/components/editor/EditorGroupsView";
import {
  DEFAULT_SPLIT_FRACTION,
  SINGLE_GROUP,
  cycleFocus,
  focusGroup,
  isSplit,
  splitEditor,
  unsplit,
  type GroupId,
  type SplitLayout,
} from "@/components/editor/editorGroups";
import { editorController } from "@/components/editor/editorController";
import { editorPaletteActions } from "@/components/editor/editorActions";
import { vimInNormalMode, vimStatusLabel } from "@/components/editor/vimMode";
import { useOpenFiles } from "@/components/editor/useOpenFiles";
import {
  blameEnabled,
  clearBlameFor,
  configureBlame,
  refreshBlameFor,
  toggleBlame,
} from "@/components/editor/blameOverlay";
import { DiffTabView } from "@/components/editor/DiffTabView";
import { MergeEditor } from "@/components/editor/MergeEditor";
import { FileTree } from "@/components/files/FileTree";
import { FindPanel } from "@/components/search/FindPanel";
import { MarkdownPreview } from "@/components/preview/MarkdownPreview";
import { TabStrip, type TabDescriptor, type TabKind } from "@/components/layout/TabStrip";
import { DEV_CHROME_CLASS, DevBadge } from "@/components/layout/devChrome";
import { PromptHost } from "@/commands/PromptHost";
import { ToastViewport } from "@/commands/ToastViewport";
import { keymapBindings, useKeybindings } from "@/commands/keybindings";
import { registerActions, type Action } from "@/commands/registry";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { AppStoreContext, useAppStore } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import type { EditorReorderableKind, EditorTabKind } from "@/api/windows";

const EMPTY_SNAPSHOT: EditorTabsSnapshot = {
  worktreeId: "",
  repoPath: null,
  files: [],
  diffs: [],
  conflicts: [],
  previews: [],
  pinned: [],
  active: null,
  reveal: null,
};

export default function EditorApp() {
  // Hydrates from localStorage like the workbench, but never writes back: two
  // windows persisting the same keys would clobber each other. The store exists
  // here for the view preferences the panes read (`diffMode`,
  // `ignoreWhitespace`) and because `ChangesPane` calls `useAppStore()`.
  const store = createAppStore({ persist: false });
  const [context, setContext] = createSignal<WindowContext | null>(null);
  const [snapshot, setSnapshot] = createSignal<EditorTabsSnapshot>(EMPTY_SNAPSHOT);

  onMount(() => {
    const disposeBridge = bridgeGitRefsAcrossWindows();
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    const track = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (disposed) fn();
        else unlisteners.push(fn);
      });

    // We may have opened after the last broadcast of either, so ask for both
    // rather than waiting for the user to change something in the workbench.
    // The requests go out only once both subscriptions are live: `listen`
    // resolves asynchronously, and asking first would race the workbench's
    // reply against our own registration.
    void Promise.all([
      track(onWindowContext((ctx) => setContext(ctx))),
      track(onEditorTabs((snap) => setSnapshot(snap))),
    ]).then(() => {
      if (disposed) return;
      void requestWindowContext();
      void requestEditorTabs();
    });

    onCleanup(() => {
      disposed = true;
      disposeBridge();
      for (const fn of unlisteners) fn();
    });
  });

  return (
    <AppStoreContext.Provider value={store}>
      <EditorSurface
        context={context}
        tabs={snapshot}
        send={(req) => void sendEditorRequest(req)}
      />
      {/* The git panel asks for input through these two module-level hosts —
          commit identity, stash messages. Without them mounted here every one
          of those prompts would hang waiting on a dialog that never renders. */}
      <PromptHost />
      <ToastViewport />
    </AppStoreContext.Provider>
  );
}

/// Narrow a strip tab kind to one this window can act on. The strip's union
/// covers every kind either window shows; only these four ever reach it here,
/// and a `null` is a programming error rather than a runtime case to handle.
function asEditorKind(kind: TabKind): EditorTabKind | null {
  return kind === "file" || kind === "diff" || kind === "conflict" || kind === "preview"
    ? kind
    : null;
}

/// The editor, minus any assumption about which window it is in.
///
/// It never writes tab state: `tabs()` is the truth and `send()` is how it asks
/// for a change. `EditorApp` above supplies the cross-window pair (a broadcast
/// snapshot and an event); in stacked mode the workbench supplies its own store
/// and `applyEditorRequest`. Same component either way, which is what keeps the
/// two modes from drifting apart.
export function EditorSurface(props: {
  context: () => WindowContext | null;
  tabs: () => EditorTabsSnapshot;
  send: (req: EditorRequest) => void;
  /// True when this is a view inside the workbench window. Suppresses the drag
  /// region, the macOS traffic-light inset and the "open the git window" button
  /// (the view switcher covers it), and leaves the global chords and the ⌘W
  /// handler to the workbench, which already registers them.
  embedded?: boolean;
}) {
  const { state, actions } = useAppStore();
  const context = () => props.context();
  const snapshot = () => props.tabs();
  const [treeVisible, setTreeVisible] = createSignal(true);
  /// The left rail shows either the file tree or find-in-files, never both —
  /// two scrolling trees in a 240px column is a worse answer than a swap.
  const [searchVisible, setSearchVisible] = createSignal(false);
  const [gitVisible, setGitVisible] = createSignal(true);

  const repoPath = createMemo(() => context()?.repoPath ?? null);
  const send = (req: EditorRequest) => props.send(req);

  // ── Monaco ───────────────────────────────────────────────────────────────

  const { openFiles, groups } = useOpenFiles();
  const dirtyPaths = createMemo(
    () => new Set(openFiles().filter((f) => f.dirty).map((f) => f.path)),
  );
  /// A write in flight. The dot stays — it only changes to its pending form
  /// (§7.6), because the buffer still differs from disk until the write lands.
  const savingPaths = createMemo(
    () => new Set(openFiles().filter((f) => f.saving).map((f) => f.path)),
  );
  const reloadedPaths = createMemo(
    () => new Set(openFiles().filter((f) => f.reloaded).map((f) => f.path)),
  );
  const conflictedPaths = createMemo(
    () => new Set(openFiles().filter((f) => f.conflicted).map((f) => f.path)),
  );

  const activeItem = () => snapshot().active;
  const activeFilePath = () => {
    const item = activeItem();
    return item?.type === "file" ? item.path : null;
  };

  // ── Editor groups ────────────────────────────────────────────────────────
  //
  // Local to this window, and deliberately not part of the broadcast snapshot:
  // the tab *list* is the workbench's, but how many panes this window draws it
  // in is nobody else's business. `api/windows.ts` therefore stays exactly as
  // it was — split panes send no new requests and honour the same contract.

  const [split, setSplit] = createSignal<SplitLayout>(SINGLE_GROUP);
  const [splitFraction, setSplitFraction] = createSignal(DEFAULT_SPLIT_FRACTION);
  /// What the new pane opens on when a split is created: whatever the pane it
  /// was split off was showing. A blank second editor would make the user open
  /// the file twice to get the side-by-side they asked for.
  const [seedPath, setSeedPath] = createSignal<string | null>(null);

  /// Focus is the controller's — Monaco reports it whenever the caret lands in
  /// a pane, including routes this component never sees (the find widget, a
  /// peek, a command). Mirroring it back into the layout keeps the focus ring
  /// and the "which group gets the next file" decision reading the same value.
  createEffect(() => {
    const focused = groups().find((g) => g.focused)?.id;
    if (focused) setSplit((l) => focusGroup(l, focused));
  });

  const groupPath = (id: GroupId) => groups().find((g) => g.id === id)?.activePath ?? null;

  function doSplit(orientation: "horizontal" | "vertical") {
    setSeedPath(editorController.getActivePath());
    setSplit((l) => splitEditor(l, orientation));
  }

  function focusEditorGroup(id: GroupId) {
    setSplit((l) => focusGroup(l, id));
    editorController.focusGroup(id);
  }

  /// Fold each snapshot into Monaco's model cache. This is the only thing that
  /// opens or closes a model in this window — clicking a tab sends a request to
  /// the workbench, and the model follows once the answer comes back, so the
  /// tab strip and the editor can never show different files.
  createEffect(
    on(
      () => {
        const snap = snapshot();
        return {
          paths: snap.files.map((f) => f.path),
          active: snap.active?.type === "file" ? snap.active.path : null,
        };
      },
      ({ paths, active }) => {
        void editorController.reconcile(paths, active);
      },
    ),
  );

  /// Apply a "jump to line" ping from the workbench (a terminal deep-link, a
  /// stack trace). Keyed on `seq` so a snapshot re-sent for any other reason
  /// doesn't drag the cursor back to the last jump.
  let lastRevealSeq = -1;
  createEffect(
    on(
      () => snapshot().reveal,
      (reveal) => {
        if (!reveal || reveal.seq === lastRevealSeq) return;
        lastRevealSeq = reveal.seq;
        // The reconcile effect above may still be reading the file; queue behind
        // it so the model exists before we try to move its cursor.
        void editorController.openFile(reveal.path).then(() => {
          if (reveal.line !== undefined) {
            editorController.revealPosition(reveal.line, reveal.column);
          }
        });
      },
    ),
  );

  /// One place a failed write is reported, whether the user pressed ⌘S or an
  /// autosave timer fired. The buffer stays dirty (the controller never clears
  /// the flag on a throw), so the toast's Retry is the only thing the user has
  /// to act on — MASTER §7.5.6, never leave an optimistic clean state standing.
  function saveWithRetry(path: string): Promise<void> {
    return editorController.save(path).catch((e) => {
      pushToast(
        `Could not save ${baseName(path)}: ${e instanceof Error ? e.message : String(e)}`,
        "error",
        8000,
        { label: "Retry", run: () => void saveWithRetry(path) },
      );
    });
  }

  /// Session restore is filed per workspace, so the repo has to be known before
  /// the first file opens. This effect runs on the same `repoPath()` the tab
  /// snapshot arrives with, which is ahead of any `reconcile`.
  createEffect(() => {
    editorController.setSessionKey(repoPath());
  });

  /// A closing window gets no unmount, so the coalesced session write has to be
  /// forced here or the last few positions are lost on every quit.
  onMount(() => {
    const flush = () => editorController.persistSession();
    window.addEventListener("beforeunload", flush);
    onCleanup(() => {
      window.removeEventListener("beforeunload", flush);
      flush();
    });
  });

  onMount(() => {
    editorController.autoSaveFailed = (path) => void saveWithRetry(path);
    onCleanup(() => {
      editorController.autoSaveFailed = null;
    });
  });

  // Blame resolves a file to the worktree it belongs to. This window only ever
  // shows one worktree, so that is the whole lookup.
  configureBlame(() => repoPath());

  createEffect(() => {
    const path = activeFilePath();
    const repo = repoPath();
    if (!blameEnabled()) {
      if (path) clearBlameFor(path);
      return;
    }
    if (!path || !repo) return;
    void refreshBlameFor(repo, path);
  });

  // ── Git status, for the panel on the right ────────────────────────────────

  const [status, setStatus] = createSignal<
    { path: string; status: string; staged: boolean }[] | undefined
  >(undefined);
  const [repoInfo, setRepoInfo] = createSignal<{
    currentBranch: string | null;
    isClean: boolean;
  } | null>(null);

  async function refreshGit() {
    const path = repoPath();
    if (!path) {
      setStatus(undefined);
      setRepoInfo(null);
      return;
    }
    try {
      const [s, info] = await Promise.all([gitApi.fileStatus(path), gitApi.repoInfo(path)]);
      setStatus(s);
      setRepoInfo({ currentBranch: info.currentBranch, isClean: info.isClean });
    } catch {
      // A repo that vanished under us is not worth a toast here — the panel
      // renders its own empty state.
      setStatus(undefined);
      setRepoInfo(null);
    }
  }

  createEffect(() => {
    repoPath();
    void refreshGit();
  });
  onMount(() => onCleanup(onGitRefsChanged(() => void refreshGit())));

  /// Notice out-of-band edits under open tabs.
  ///
  /// Polled at the two moments the answer can have changed: the window
  /// regaining focus (an edit from another editor or a terminal) and a git ref
  /// change (checkout, rebase, stash). Clean buffers reload silently and wear
  /// the finished mark; dirty ones raise the inline bar below. A checkout
  /// touching 200 files therefore produces 200 silent reloads and zero
  /// interruptions, which is the point.
  onMount(() => {
    const check = () => void editorController.checkExternalChanges();
    window.addEventListener("focus", check);
    const offRefs = onGitRefsChanged(check);
    // One baseline pass so the first real poll has something to compare to.
    check();
    onCleanup(() => {
      window.removeEventListener("focus", check);
      offRefs();
    });
  });

  // ── Commands ─────────────────────────────────────────────────────────────
  // Only the handful that mean something in this window. Ids match the entries
  // in `commands/keymap.ts`, so the chords the user already knows keep working;
  // chords whose action isn't registered here simply do nothing.
  createEffect(() => {
    const list: Action[] = [
      {
        id: "file.save",
        label: "Save file",
        description: "Write the active editor tab to disk",
        group: "File",
        enabled: () => !!editorController.getActivePath(),
        run: () => {
          const path = editorController.getActivePath();
          if (path) void saveWithRetry(path);
        },
      },
      ...editorPaletteActions(() => editorController.getEditor()),
      {
        id: "editor.find-in-files",
        label: "Find in files",
        description: "Search this repository, gitignore-aware",
        group: "Editor",
        enabled: () => !!repoPath(),
        run: () => {
          setTreeVisible(true);
          setSearchVisible(true);
        },
      },
      {
        id: "editor.split-right",
        label: isSplit(split()) ? "Split editor side by side" : "Split editor right",
        description: "Show a second editor group beside this one",
        group: "Editor",
        enabled: () => !!editorController.getEditor(),
        run: () => doSplit("horizontal"),
      },
      {
        id: "editor.split-down",
        label: isSplit(split()) ? "Stack editor groups" : "Split editor down",
        description: "Show a second editor group below this one",
        group: "Editor",
        enabled: () => !!editorController.getEditor(),
        run: () => doSplit("vertical"),
      },
      {
        id: "editor.close-group",
        label: "Close the other editor group",
        description: "Return to a single editor pane",
        group: "Editor",
        enabled: () => isSplit(split()),
        run: () => setSplit((l) => unsplit(l)),
      },
      {
        id: "editor.focus-next-group",
        label: "Focus the other editor group",
        group: "Editor",
        enabled: () => isSplit(split()),
        run: () => {
          const next = cycleFocus(split());
          setSplit(next);
          editorController.focusGroupEditor(next.focused);
        },
      },
      {
        id: "view.toggle-blame",
        label: blameEnabled() ? "Disable inline blame" : "Enable inline blame",
        description: "Show per-line author + commit summary in the editor",
        group: "View",
        run: () => toggleBlame(),
      },
    ];
    // ⌘W belongs to the workbench when embedded: it knows which view is in
    // front, and two registrations of one id would leave the loser silently
    // shadowed.
    if (!props.embedded)
      list.push({
        id: "tab.close",
        label: "Close tab",
        group: "Tabs",
        run: () => {
          const item = activeItem();
          if (!item) return;
          if (snapshot().pinned.includes(item.id)) {
            pushToast("Tab is pinned — right-click to unpin", "warning");
            return;
          }
          if (
            item.type === "file" ||
            item.type === "diff" ||
            item.type === "conflict" ||
            item.type === "preview"
          ) {
            send({ kind: "close", tab: item.type, id: item.id });
          }
        },
      });
    // Same reasoning as ⌘W: the workbench already registers this one, against
    // the same store field, so embedded we would only be shadowing an identical
    // implementation.
    if (!props.embedded)
      list.push({
        id: "ui.toggle-diff-mode",
        label: "Toggle inline / split diff",
        group: "View",
        run: () => actions.setDiffMode(state.diffMode === "inline" ? "split" : "inline"),
      });
    return registerActions(list);
  });

  // Embedded, the workbench installs the global chord table; a second
  // installation would fire every binding twice.
  if (!props.embedded) {
    const bindings = keymapBindings();
    useKeybindings(() => bindings);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────

  const tabs = createMemo<TabDescriptor[]>(() => {
    const snap = snapshot();
    const out: TabDescriptor[] = [];
    for (const f of snap.files) {
      out.push({
        kind: "file",
        id: f.id,
        label: baseName(f.path),
        icon: <FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />,
        title: f.path,
        dirty: dirtyPaths().has(f.path),
        saving: savingPaths().has(f.path),
        reloaded: reloadedPaths().has(f.path),
      });
    }
    for (const d of snap.diffs) {
      out.push({
        kind: "diff",
        id: d.id,
        label: baseName(d.filePath),
        prefix: "diff · ",
        icon: <GitCompare class="w-3.5 h-3.5 shrink-0 text-info opacity-80" />,
        title: d.filePath,
      });
    }
    for (const c of snap.conflicts) {
      out.push({
        kind: "conflict",
        id: c.id,
        label: baseName(c.filePath),
        prefix: "conflict · ",
        prefixTone: "warning",
        icon: <GitMerge class="w-3.5 h-3.5 shrink-0 text-warning" />,
        title: `Conflict · ${c.filePath}`,
        labelWidth: "max-w-[160px]",
        // Conflict tabs have no list in `reorderItemTab`, and a merge in
        // progress is not something you sort.
        draggable: false,
      });
    }
    for (const p of snap.previews) {
      out.push({
        kind: "preview",
        id: p.id,
        label: baseName(p.filePath),
        prefix: "previewing ",
        icon: <Eye class="w-3.5 h-3.5 shrink-0 text-info opacity-80" />,
        title: `Previewing ${p.filePath}`,
        labelWidth: "max-w-[200px]",
      });
    }
    return out;
  });

  const isPinned = (id: string) => snapshot().pinned.includes(id);

  /// The markdown-preview button only makes sense while a `.md` file is in
  /// front — same rule the workbench used to apply.
  const activeMarkdownPath = () => {
    const path = activeFilePath();
    return path && /\.(md|markdown|mdown|mkdn|mkd)$/i.test(path) ? path : null;
  };

  const activeIdOf = (type: string) => {
    const item = activeItem();
    return item?.type === type ? item.id : null;
  };

  return (
    <div
      class="flex flex-col bg-background text-foreground overflow-hidden"
      classList={{ "h-screen w-screen": !props.embedded, "h-full w-full": props.embedded }}
    >
      {/* Title bar. macOS draws its own traffic lights over the left edge, so
          the drag region is inset to clear them — same geometry as the
          workbench's TitleBar and the git window's header. */}
      <div
        data-tauri-drag-region={props.embedded ? undefined : true}
        class={`h-9 shrink-0 flex items-center gap-2 border-b border-border px-3 text-xs select-none ${props.embedded ? "" : DEV_CHROME_CLASS}`}
        classList={{ "pl-[78px]": isMac() && !props.embedded }}
      >
        <FileCode class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <Show when={!props.embedded}>
          <DevBadge />
        </Show>
        <span class="font-medium truncate">
          {repoInfo()?.currentBranch ?? context()?.branch ?? "—"}
        </span>
        <Show when={repoInfo()?.isClean === false}>
          <span class="text-warning">• changes</span>
        </Show>
        {/* Vim's current mode. A modal editor whose mode is invisible is
            unusable, so this ships with the setting rather than waiting for the
            editor status segment. Absent entirely when Vim mode is off. */}
        <Show when={vimStatusLabel()}>
          {(label) => (
            <span
              aria-live="polite"
              class={`shrink-0 font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                vimInNormalMode()
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "bg-transparent border-border text-muted-foreground"
              }`}
            >
              {label()}
            </span>
          )}
        </Show>

        <span class="ml-auto text-muted-foreground truncate max-w-[40%]">
          {context()
            ? `${context()!.workspaceName} · ${context()!.worktreeLabel}`
            : props.embedded
              ? ""
              : "Waiting for the workbench…"}
        </span>

        <div class="flex items-stretch gap-1 shrink-0">
          <HeaderToggle
            active={treeVisible()}
            onClick={() => setTreeVisible((v) => !v)}
            title={treeVisible() ? "Hide the file tree" : "Show the file tree"}
            label={treeVisible() ? "Hide file tree" : "Show file tree"}
          >
            <FolderTree class="w-3.5 h-3.5" />
          </HeaderToggle>
          <HeaderToggle
            active={searchVisible()}
            onClick={() => {
              setSearchVisible((v) => !v);
              if (!searchVisible()) return;
              setTreeVisible(true);
            }}
            title={searchVisible() ? "Show the file tree" : "Find in files"}
            label={searchVisible() ? "Show file tree" : "Find in files"}
          >
            <Search class="w-3.5 h-3.5" />
          </HeaderToggle>
          {/* Splitting is a ⌘⌥\ / palette command; this is the pointer route
              to the same state, and it doubles as the indication that the view
              *is* split, which the seam alone reads as ambiguous next to a
              sidebar border. */}
          <HeaderToggle
            active={isSplit(split())}
            onClick={() => (isSplit(split()) ? setSplit((l) => unsplit(l)) : doSplit("horizontal"))}
            title={
              isSplit(split())
                ? "Close the second editor group"
                : "Split the editor side by side"
            }
            label={isSplit(split()) ? "Close editor group" : "Split editor"}
          >
            <Columns2 class="w-3.5 h-3.5" />
          </HeaderToggle>
          <HeaderToggle
            active={gitVisible()}
            onClick={() => setGitVisible((v) => !v)}
            title={gitVisible() ? "Hide the git panel" : "Show the git panel"}
            label={gitVisible() ? "Hide git panel" : "Show git panel"}
          >
            <PanelRight class="w-3.5 h-3.5" />
          </HeaderToggle>
          {/*
            Wider than its neighbours on purpose. The others toggle panels inside
            this window; this one leaves it, and the dashed border plus the
            up-right arrow are the two conventions that say "opens elsewhere"
            before the click rather than after. Same button as the workbench's.
            Hidden when embedded: the view switcher in the title bar already goes
            there, and nothing "opens elsewhere" in stacked mode.
          */}
          <Show when={!props.embedded}>
          <button
            onClick={() => {
              void openGitWindow().catch((e) =>
                pushToast(
                  `Could not open the git window: ${e instanceof Error ? e.message : String(e)}`,
                  "error",
                ),
              );
            }}
            aria-label="Open git window"
            title="Open the git client in its own window"
            class="self-center flex items-center gap-1 h-[22px] px-1.5 rounded border border-dashed border-border text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground hover:border-border/80 transition-colors"
          >
            <GitBranch class="w-3 h-3 shrink-0" />
            Git
            <ArrowUpRight class="w-3 h-3 shrink-0 opacity-70" />
          </button>
          </Show>
        </div>
      </div>

      <Show
        when={repoPath()}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <FileCode class="w-7 h-7 opacity-60" />
            <p class="text-[13px]">
              {props.embedded
                ? "Open a repository to start editing."
                : "Open a repository in the main voidlink window."}
            </p>
            <Show when={!props.embedded}>
              <p class="text-[11px] opacity-70">
                This window follows whichever worktree is active there.
              </p>
            </Show>
          </div>
        }
      >
        {(path) => (
          <div class="flex-1 flex min-h-0">
            {/* File tree rail */}
            <Show when={treeVisible()}>
              <aside class="w-60 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
                <Show when={searchVisible()}>
                  <FindPanel
                    root={() => repoPath()}
                    onClose={() => setSearchVisible(false)}
                    onOpen={(p, line, column) => {
                      send({ kind: "open-file", path: p });
                      // Queue behind the reconcile the request triggers, so the
                      // model exists before the cursor is moved into it.
                      void editorController.openFile(p).then(() => {
                        editorController.revealPosition(line, column);
                      });
                    }}
                  />
                </Show>
                <Show when={!searchVisible()}>
                <div class="px-3 py-1.5 text-[10px] tracking-wide text-muted-foreground/70 border-b border-border/60 shrink-0">
                  Files
                </div>
                <FileTree
                  root={path()}
                  onOpenFile={(p) => send({ kind: "open-file", path: p })}
                  actions={{
                    openDiff: (p) => send({ kind: "open-diff", filePath: p }),
                    blame: (p) => {
                      send({ kind: "open-file", path: p });
                      if (!blameEnabled()) toggleBlame();
                    },
                    compare: (req) => {
                      send({ kind: "open-compare", ...req });
                      // Compare lands in the workbench, so follow it there —
                      // otherwise the tab opens in a window nobody is looking at.
                      void focusMainWindow();
                    },
                  }}
                />
                </Show>
              </aside>
            </Show>

            {/* Tabs + surfaces */}
            <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
              <TabStrip
                tabs={tabs()}
                activeId={activeItem()?.id ?? null}
                isPinned={isPinned}
                onSelect={(tab) => {
                  const kind = asEditorKind(tab.kind);
                  if (kind) send({ kind: "activate", tab: kind, id: tab.id });
                }}
                onClose={(tab) => {
                  const kind = asEditorKind(tab.kind);
                  if (kind) send({ kind: "close", tab: kind, id: tab.id });
                }}
                onReorder={(kind, fromId, toId) => {
                  // Conflict tabs are marked non-draggable, so anything that
                  // reaches here is reorderable by construction.
                  const editorKind = asEditorKind(kind);
                  if (!editorKind || editorKind === "conflict") return;
                  send({
                    kind: "reorder",
                    tab: editorKind satisfies EditorReorderableKind,
                    fromId,
                    toId,
                  });
                }}
                onTogglePin={(id) => send({ kind: "toggle-pin", id })}
                trailing={
                  <Show when={activeMarkdownPath()}>
                    {(md) => (
                      <button
                        onClick={() => send({ kind: "open-preview", filePath: md() })}
                        title={`Preview markdown: ${baseName(md())}`}
                        aria-label="Preview markdown"
                        class="mx-0.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors shrink-0"
                      >
                        <Eye class="w-3.5 h-3.5" />
                      </button>
                    )}
                  </Show>
                }
              />

              <div class="flex-1 relative overflow-hidden">
                {/* Always mounted so Monaco initialises on window load rather
                    than on the first click. */}
                <div
                  class="absolute inset-0"
                  style={{ display: activeItem()?.type === "file" ? "block" : "none" }}
                >
                  <EditorGroupsView
                    layout={split}
                    fraction={splitFraction}
                    onFraction={setSplitFraction}
                    onFocusGroup={focusEditorGroup}
                    renderGroup={(groupId) => (
                      <>
                        {/* Per-buffer, inline, and it does not steal focus. A
                            modal here would fire once per file during a rebase;
                            a toast would scroll away before the user could
                            choose. Per *group*, because a split can have a
                            conflicted file in one pane and a clean one in the
                            other, and a bar over the wrong buffer is a lie. */}
                        <Show when={groupPath(groupId)}>
                          {(path) => (
                            <Show when={conflictedPaths().has(path())}>
                              <ExternalChangeBar
                                path={path()}
                                onKeepMine={() => editorController.keepMine(path())}
                                onTakeTheirs={() => void editorController.takeTheirs(path())}
                                onShowDiff={() => send({ kind: "open-diff", filePath: path() })}
                              />
                            </Show>
                          )}
                        </Show>
                        <EditorHost
                          class="w-full flex-1 min-h-0"
                          groupId={groupId}
                          seedPath={groupId === "primary" ? undefined : seedPath}
                        />
                      </>
                    )}
                  />
                </div>

                <For each={snapshot().diffs}>
                  {(tab) => (
                    <div
                      class="absolute inset-0"
                      style={{ display: tab.id === activeIdOf("diff") ? "block" : "none" }}
                    >
                      <DiffTabView repoPath={path()} filePath={tab.filePath} />
                    </div>
                  )}
                </For>

                <For each={snapshot().conflicts}>
                  {(tab) => (
                    <div
                      class="absolute inset-0"
                      style={{ display: tab.id === activeIdOf("conflict") ? "block" : "none" }}
                    >
                      <MergeEditor
                        repoPath={path()}
                        filePath={tab.filePath}
                        onResolved={() => send({ kind: "close", tab: "conflict", id: tab.id })}
                      />
                    </div>
                  )}
                </For>

                <For each={snapshot().previews}>
                  {(tab) => (
                    <div
                      class="absolute inset-0"
                      style={{ display: tab.id === activeIdOf("preview") ? "block" : "none" }}
                    >
                      <MarkdownPreview filePath={tab.filePath} />
                    </div>
                  )}
                </For>

                <Show when={tabs().length === 0}>
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground bg-background z-10">
                    <FileCode class="w-7 h-7 opacity-60" />
                    <p class="text-[13px]">Nothing open. Pick a file from the tree.</p>
                  </div>
                </Show>
              </div>
            </main>

            {/* Git panel */}
            <Show when={gitVisible()}>
              <aside class="w-80 shrink-0 border-l border-border bg-sidebar flex flex-col min-h-0">
                <div class="px-3 py-1.5 text-[10px] tracking-wide text-muted-foreground/70 border-b border-border/60 shrink-0">
                  Changes
                </div>
                <div class="flex-1 overflow-y-auto scrollbar-thin">
                  <ChangesPane
                    repoPath={path()}
                    worktreeId={snapshot().worktreeId || context()?.worktreeId || ""}
                    status={status()}
                    onRefresh={() => {
                      void refreshGit();
                      emitGitRefsChanged();
                    }}
                    selectedFile={activeFilePath()}
                  />
                </div>
              </aside>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

/// "This file changed on disk", inline above the buffer it is about.
///
/// Three choices, no default, and no focus steal — the user may be mid-word.
/// It stacks with nothing: only the buffer in front ever shows one.
function ExternalChangeBar(props: {
  path: string;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  onShowDiff: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      class="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-warning/40 bg-warning/10 text-[11px]"
    >
      <AlertTriangle class="w-3.5 h-3.5 text-warning shrink-0" />
      <span class="flex-1 min-w-0 truncate">
        This file changed on disk while you had unsaved edits.
      </span>
      <BarButton onClick={props.onKeepMine} label="Keep mine">Keep mine</BarButton>
      <BarButton onClick={props.onTakeTheirs} label="Take theirs">Take theirs</BarButton>
      <BarButton onClick={props.onShowDiff} label="Show diff">Show diff</BarButton>
    </div>
  );
}

function BarButton(props: { onClick: () => void; label: string; children: JSX.Element }) {
  return (
    <button
      onClick={props.onClick}
      aria-label={props.label}
      class="shrink-0 px-2 py-0.5 rounded border border-border bg-background/40 text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {props.children}
    </button>
  );
}

function HeaderToggle(props: {
  active: boolean;
  onClick: () => void;
  title: string;
  label: string;
  children: JSX.Element;
}) {
  return (
    <button
      onClick={props.onClick}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.title}
      class={`self-center w-7 h-[22px] flex items-center justify-center rounded hover:bg-accent/60 hover:text-foreground transition-colors ${
        props.active ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {props.children}
    </button>
  );
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}
