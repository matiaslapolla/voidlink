import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { X, TerminalSquare, FileCode, GitCompare } from "lucide-solid";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { GitDiffView } from "@/components/git/GitDiffView";
import { EditorHost } from "@/components/editor/EditorHost";
import { editorController } from "@/components/editor/editorController";
import { useOpenFiles } from "@/components/editor/useOpenFiles";
import { useAppStore } from "@/store/LayoutContext";
import { terminalApi } from "@/api/terminal";
import type { TerminalSession } from "@/types/workspace";

const POLL_MS = 1500;

export function MainSurface() {
  const {
    state,
    activeWorkspace,
    activeTerminals,
    activeDiffTabs,
    activeOpenFiles,
    activeItem,
    actions,
  } = useAppStore();

  const { openFiles } = useOpenFiles();

  const activeTerminalId = () => { const a = activeItem(); return a?.type === "terminal" ? a.id : null; };
  const activeDiffId     = () => { const a = activeItem(); return a?.type === "diff"     ? a.id : null; };
  const activeFileId     = () => { const a = activeItem(); return a?.type === "file"     ? a.id : null; };

  const showEditor = () => activeFileId() !== null;

  const nothingOpen = () =>
    activeTerminals().length === 0 &&
    activeDiffTabs().length === 0 &&
    activeOpenFiles().length === 0;

  const hasAnyTab = () =>
    activeOpenFiles().length > 0 ||
    activeTerminals().length > 0 ||
    activeDiffTabs().length > 0;

  return (
    <div class="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Unified tab bar */}
      <Show when={hasAnyTab()}>
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
            <p class="text-[13px]">Nothing open. Start a terminal with + in the sidebar, or click a file to open it.</p>
          </div>
        </Show>
      </div>
    </div>
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
