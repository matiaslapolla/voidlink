import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Plus, X, FolderOpen, TerminalSquare, GitCompare } from "lucide-solid";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/LayoutContext";
import { terminalApi } from "@/api/terminal";
import type { TerminalSession } from "@/types/workspace";
import type { DiffTab } from "@/store/layout";

const POLL_MS = 1500;

export function TerminalSidebar() {
  const { state, activeWorkspace, activeTerminals, activeDiffTabs, activeItem, actions } = useAppStore();

  async function chooseRepo() {
    const ws = activeWorkspace();
    if (!ws) return;
    const selected = await open({ directory: true, multiple: false, title: "Select repository root" });
    if (!selected || Array.isArray(selected)) return;
    actions.setRepoRoot(ws.id, selected);
  }

  const activeTerminalId = () => {
    const a = activeItem();
    return a?.type === "terminal" ? a.id : null;
  };
  const activeDiffId = () => {
    const a = activeItem();
    return a?.type === "diff" ? a.id : null;
  };

  return (
    <aside class="flex flex-col w-64 border-r border-border bg-sidebar overflow-hidden">
      <div class="px-3 density-section border-b border-border">
        <Show
          when={activeWorkspace()?.repoRoot}
          fallback={
            <button
              onClick={() => void chooseRepo()}
              class="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40"
            >
              <FolderOpen class="w-3.5 h-3.5" />
              Select repository
            </button>
          }
        >
          {(repo) => (
            <button
              onClick={() => void chooseRepo()}
              class="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground truncate"
              title={repo()}
            >
              <FolderOpen class="w-3.5 h-3.5 shrink-0" />
              <span class="truncate font-medium text-foreground">
                {repo().split("/").pop()}
              </span>
            </button>
          )}
        </Show>
      </div>

      {/* Terminals */}
      <div class="flex items-center justify-between px-3 density-section border-b border-border/50">
        <span class="ui-section-label">Terminals</span>
        <button
          onClick={() => void actions.spawnTerminal(state.activeWorkspaceId)}
          disabled={!activeWorkspace()?.repoRoot}
          aria-label="New terminal"
          class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          title="New terminal"
        >
          <Plus class="w-3.5 h-3.5" />
        </button>
      </div>
      <div class="overflow-y-auto scrollbar-thin p-1.5 density-gap max-h-[40vh]">
        <Show
          when={activeTerminals().length > 0}
          fallback={
            <div class="px-2 py-4 text-center text-[11px] text-muted-foreground">
              <TerminalSquare class="w-5 h-5 mx-auto mb-2 opacity-60" />
              {activeWorkspace()?.repoRoot
                ? "No terminals. Click + to start one."
                : "Select a repository first."}
            </div>
          }
        >
          <For each={activeTerminals()}>
            {(term) => (
              <TerminalRow
                term={term}
                active={term.id === activeTerminalId()}
                onSelect={() => actions.selectTerminal(state.activeWorkspaceId, term.id)}
                onClose={() => actions.removeTerminal(state.activeWorkspaceId, term.id)}
              />
            )}
          </For>
        </Show>
      </div>

      {/* Diffs */}
      <Show when={activeDiffTabs().length > 0}>
        <div class="flex items-center justify-between px-3 density-section border-y border-border/50">
          <span class="ui-section-label">Diffs</span>
          <span class="text-[10px] text-muted-foreground tabular-nums">{activeDiffTabs().length}</span>
        </div>
        <div class="flex-1 overflow-y-auto scrollbar-thin p-1.5 density-gap">
          <For each={activeDiffTabs()}>
            {(tab) => (
              <DiffTabRow
                tab={tab}
                active={tab.id === activeDiffId()}
                onSelect={() => actions.selectDiffTab(state.activeWorkspaceId, tab.id)}
                onClose={() => actions.closeDiffTab(state.activeWorkspaceId, tab.id)}
              />
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
}

/**
 * Per-row polling in local signals — never writes to the shared store so the
 * terminal list keeps stable references and <For> never remounts xterm panes.
 */
function TerminalRow(props: {
  term: TerminalSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal<string | null>(null);
  const [cwd, setCwd] = createSignal<string | null>(null);

  onMount(() => {
    let alive = true;
    const tick = async () => {
      try {
        const info = await terminalApi.processInfo(props.term.ptyId);
        if (!alive) return;
        setBusy(info.busy);
        setName(info.name);
        setCwd(info.cwd);
      } catch {
        // pty may be gone between ticks; parent handles cleanup
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    onCleanup(() => {
      alive = false;
      clearInterval(timer);
    });
  });

  return (
    <div
      class={`group flex items-center rounded-md border transition-colors focus-within:border-border ${
        props.active
          ? "bg-accent/60 border-border text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 focus-within:text-foreground focus-within:bg-accent/30"
      }`}
    >
      <button
        onClick={props.onSelect}
        aria-label={`Terminal: ${props.term.label}`}
        class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left cursor-pointer focus-visible:outline-none"
      >
        <LedDot active={props.active} busy={busy()} />
        <div class="flex-1 min-w-0">
          <div class="text-xs truncate">
            <span>{props.term.label}</span>
            <Show when={busy() && name()}>
              <span class="text-muted-foreground"> ({name()})</span>
            </Show>
          </div>
          <Show when={cwd()}>
            {(c) => (
              <div class="text-[10px] text-muted-foreground truncate">{c()}</div>
            )}
          </Show>
        </div>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        aria-label={`Kill terminal ${props.term.label}`}
        title="Kill terminal"
        class="p-0.5 mr-1 rounded opacity-60 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
      >
        <X class="w-3 h-3" />
      </button>
    </div>
  );
}

function DiffTabRow(props: {
  tab: DiffTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      class={`group flex items-center rounded-md border transition-colors focus-within:border-border ${
        props.active
          ? "bg-accent/60 border-border text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 focus-within:text-foreground focus-within:bg-accent/30"
      }`}
    >
      <button
        onClick={props.onSelect}
        aria-label={`Diff: ${props.tab.filePath}`}
        title={props.tab.filePath}
        class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left cursor-pointer focus-visible:outline-none"
      >
        <GitCompare class="w-3.5 h-3.5 shrink-0 text-info" />
        <div class="flex-1 min-w-0 text-xs truncate">
          <span class="text-muted-foreground">diff · </span>
          {props.tab.filePath.split("/").pop()}
        </div>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        aria-label={`Close diff for ${props.tab.filePath}`}
        title="Close diff"
        class="p-0.5 mr-1 rounded opacity-60 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
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
