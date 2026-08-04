import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Plus, X, FolderOpen, TerminalSquare, ChevronRight, ChevronDown, GitBranchPlus } from "lucide-solid";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/LayoutContext";
import { terminalApi } from "@/api/terminal";
import type { TerminalSession } from "@/types/workspace";
import { FilesPanel } from "@/components/files/FilesPanel";
import { pickWorkspaceFolder } from "@/commands/openFolder";
import { forget as forgetTerminalHistory } from "@/commands/terminalHistory";
import { forgetPtySize } from "@/commands/terminalSize";
import { LedSlot, ledLabel, terminalSignal } from "@/components/layout/StatusLed";
import { Splitter } from "@/components/layout/Splitter";
import { PANEL_BOUNDS } from "@/store/layout";
import { tabMark } from "@/store/activity";
import { watchTerminal } from "@/store/terminalWatch";

export function TerminalSidebar(props: {
  onOpenFile?: (path: string) => void;
  /// Render the Files section. `false` under the vertical-tabs layout, where
  /// the explorer lives in the right column instead — see `FilesPanel`.
  files?: boolean;
}) {
  const { state, activeWorkspace, activeRepoPath, activeTerminals, activeItem, actions } = useAppStore();

  async function chooseRepo() {
    const ws = activeWorkspace();
    if (!ws) return;
    const picked = await pickWorkspaceFolder();
    if (picked) actions.setRepoRoot(ws.id, picked);
  }

  const activeTerminalId = () => {
    const a = activeItem();
    return a?.type === "terminal" ? a.id : null;
  };

  const terminalsOpen = () => state.sidebarSections.terminals;

  return (
    <aside
      /* Island (D1): no border — the canvas gap around it is the separator. */
      class="flex flex-col bg-sidebar overflow-hidden relative"
      style={{ width: `${state.panels.sidebar}px` }}
    >
      {/* Repo picker — h-9 to match center column tab bar */}
      <div class="h-9 px-3 border-b border-border flex items-center shrink-0">
        <Show
          when={activeRepoPath()}
          fallback={
            <button
              onClick={() => void chooseRepo()}
              title="Open a folder in this workspace"
              class="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-body text-muted-foreground hover:text-foreground hover:bg-accent/40"
            >
              <FolderOpen class="w-3.5 h-3.5" />
              Open folder
            </button>
          }
        >
          {(repo) => (
            <button
              onClick={() => void chooseRepo()}
              class="w-full flex items-center gap-2 text-body truncate"
              title={`${repo()}\nClick to open a different folder`}
            >
              <FolderOpen class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate font-medium text-foreground">
                {repo().split("/").pop()}
              </span>
            </button>
          )}
        </Show>
      </div>

      {/* Files section — fills remaining height when open.
          `props.files === false` is the vertical-tabs case: the explorer has
          moved to the right column and rendering it here as well would be two
          trees over one directory. The section is *absent*, not empty — an
          empty disclosure that never opens is worse than no disclosure. */}
      <Show when={props.files !== false}>
        <FilesPanel class="border-b border-border/50" onOpenFile={props.onOpenFile} />
      </Show>

      {/* Terminals section */}
      <div class="flex flex-col shrink-0">
        <button
          onClick={() => actions.toggleSidebarSection("terminals")}
          class="flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/30 transition-colors w-full"
        >
          <span class="w-3 h-3 shrink-0 text-muted-foreground">
            {terminalsOpen() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
          </span>
          <TerminalSquare class="w-3 h-3 text-muted-foreground" />
          <span class="flex-1 tracking-wide text-body text-muted-foreground font-semibold">Terminals</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (!activeRepoPath()) return;
              void actions.spawnTerminal(state.activeWorktreeId);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.stopPropagation();
              if (!activeRepoPath()) return;
              void actions.spawnTerminal(state.activeWorktreeId);
            }}
            aria-label="New terminal"
            class={`p-0.5 mr-0.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors ${!activeRepoPath() ? "opacity-40 pointer-events-none" : ""}`}
            title="New terminal"
          >
            <Plus class="w-3.5 h-3.5" />
          </span>
        </button>
        <Show when={terminalsOpen()}>
          <div class="overflow-y-auto scrollbar-thin p-1.5 density-gap max-h-52">
            <Show
              when={activeTerminals().length > 0}
              fallback={
                <div class="px-2 py-3 text-center text-ui text-muted-foreground">
                  <TerminalSquare class="w-4 h-4 mx-auto mb-1.5 opacity-60" />
                  {activeRepoPath()
                    ? "No terminals. Click + to start one."
                    : "Open a folder to start a shell."}
                </div>
              }
            >
              <For each={activeTerminals()}>
                {(term) => (
                  <TerminalRow
                    term={term}
                    active={term.id === activeTerminalId()}
                    onSelect={() => actions.selectTerminal(state.activeWorktreeId, term.id)}
                    onClose={() => actions.removeTerminal(state.activeWorktreeId, term.id)}
                  />
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>

      {/* Compare branches — quick action */}
      <div class="border-t border-border/50 px-2 py-1.5 shrink-0">
        <button
          onClick={() => {
            if (!activeRepoPath()) return;
            actions.openCompareTab(state.activeWorktreeId);
          }}
          disabled={!activeRepoPath()}
          class={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed transition-colors text-body ${
            activeRepoPath()
              ? "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 hover:border-border/80"
              : "border-border/40 text-muted-foreground/40 cursor-not-allowed"
          }`}
          title="Compare two branches, tags, or commits"
        >
          <GitBranchPlus class="w-3.5 h-3.5 shrink-0" />
          Compare branches
        </button>
      </div>

      <Splitter
        side="end"
        label="Files and terminals sidebar width"
        value={state.panels.sidebar}
        min={PANEL_BOUNDS.sidebar.min}
        max={PANEL_BOUNDS.sidebar.max}
        defaultValue={PANEL_BOUNDS.sidebar.default}
        onResize={(w) => actions.setPanelWidth("sidebar", w)}
      />
    </aside>
  );
}

/// One row per shell. Reads `store/activity.ts` and `store/terminalWatch.ts`; it
/// does not poll.
///
/// It used to reimplement the whole signal system: its own 1500ms `processInfo`
/// poll, its own `hasNotification` flag, an orange `<Bell>`, its own OS
/// notification, and its own copy of the LED mapping. None of it touched the
/// activity store, so "finished" existed twice with different colours and
/// different clear rules — and the two pollers sampled independently, so the row
/// and the tab could disagree about the same shell for up to 1500ms.
function TerminalRow(props: {
  term: TerminalSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const watch = watchTerminal(props.term.id, props.term.ptyId);
  const [cwd, setCwd] = createSignal<string | null>(null);

  onMount(() => {
    // The one thing the shared watcher does not carry: the foreground process's
    // working directory, which only this row shows. Sampled on the same cadence
    // the watcher polls at, off the same command — one extra `invoke` per shell
    // per interval, and no second source of truth for anything that has one.
    let alive = true;
    const tick = async () => {
      try {
        const info = await terminalApi.processInfo(props.term.ptyId);
        if (alive) setCwd(info.cwd);
      } catch {
        // pty may be gone between ticks
      }
    };
    void tick();
    const unlistenExit = listen<unknown>(`pty-exit:${props.term.ptyId}`, () => {
      forgetTerminalHistory(props.term.ptyId);
      // The size map survives pane unmounts on purpose (a remounted pane needs
      // its shell's real winsize), so a dead shell is the only thing that may
      // clear an entry.
      forgetPtySize(props.term.ptyId);
    });
    onCleanup(() => {
      alive = false;
      void unlistenExit.then((u) => u());
    });
  });

  /// Same rule as the tab strip: the running command's name takes over the
  /// row while it runs, and the tab's own label falls back in when idle.
  const displayLabel = () => (watch.busy() && watch.processName()) || props.term.label;

  /// Exactly the mark the tab wears, from exactly the same two sources: the
  /// escalating signals in `store/activity.ts` plus the focus-local `idle`.
  const mark = () =>
    tabMark(
      props.term.id,
      terminalSignal({
        working: watch.working(),
        agent: watch.agent(),
        waiting: watch.waiting(),
        focused: props.active,
      }),
    );

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
        aria-label={`Terminal: ${props.term.label}${mark() ? ` (${ledLabel(mark()!)})` : ""}`}
        class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left cursor-pointer focus-visible:outline-none"
      >
        {/* Reserved, so a signal arriving never nudges the label (§7.5.3 rule
            3). The mark itself names the state — there is no separate bell icon
            any more, because two glyphs for one fact is what made "finished"
            ambiguous in the first place. */}
        <LedSlot signal={mark()} dim={!props.active} silent />
        <div class="flex-1 min-w-0">
          <div
            class="text-body truncate flex items-center gap-1.5"
            title={displayLabel() === props.term.label ? props.term.label : `${props.term.label} — ${displayLabel()}`}
          >
            <span class="truncate">{displayLabel()}</span>
          </div>
          <Show when={cwd()}>
            {(c) => (
              <div class="text-body text-muted-foreground truncate">{c()}</div>
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

// The OS notification that used to live here ("<label> finished") moved to
// `MainSurface`, which is always mounted and holds the one reactive read of the
// activity store. Firing it from a sidebar row meant no notification at all
// whenever the sidebar was collapsed, and a second set of rules for when
// "finished" counts.
