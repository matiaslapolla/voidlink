import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Plus, X, FolderOpen, TerminalSquare, Files, ChevronRight, ChevronDown } from "lucide-solid";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/LayoutContext";
import { terminalApi } from "@/api/terminal";
import type { TerminalSession } from "@/types/workspace";
import { FileTree } from "@/components/files/FileTree";

const POLL_MS = 1500;

export function TerminalSidebar(props: { onOpenFile?: (path: string) => void }) {
  const { state, activeWorkspace, activeTerminals, activeItem, actions } = useAppStore();
  const [sidebarWidth, setSidebarWidth] = createSignal(256);

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth();
    function onMove(mv: MouseEvent) {
      setSidebarWidth(Math.max(180, Math.min(520, startW + mv.clientX - startX)));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

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

  const filesOpen = () => state.sidebarSections.files;
  const terminalsOpen = () => state.sidebarSections.terminals;

  return (
    <aside
      class="flex flex-col border-r border-border bg-sidebar overflow-hidden relative"
      style={{ width: `${sidebarWidth()}px` }}
    >
      {/* Repo picker — h-9 to match center column tab bar */}
      <div class="h-9 px-3 border-b border-border flex items-center shrink-0">
        <Show
          when={activeWorkspace()?.repoRoot}
          fallback={
            <button
              onClick={() => void chooseRepo()}
              class="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40"
            >
              <FolderOpen class="w-3.5 h-3.5" />
              Select repository
            </button>
          }
        >
          {(repo) => (
            <button
              onClick={() => void chooseRepo()}
              class="w-full flex items-center gap-2 text-xs truncate"
              title={repo()}
            >
              <FolderOpen class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate font-medium text-foreground">
                {repo().split("/").pop()}
              </span>
            </button>
          )}
        </Show>
      </div>

      {/* Files section — fills remaining height when open */}
      <div class={`flex flex-col border-b border-border/50 min-h-0 ${filesOpen() ? "flex-1" : "shrink-0"}`}>
        <button
          onClick={() => actions.toggleSidebarSection("files")}
          class="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/30 transition-colors w-full"
        >
          <span class="w-3 h-3 shrink-0 text-muted-foreground">
            {filesOpen() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
          </span>
          <Files class="w-3 h-3 text-muted-foreground" />
          <span class="flex-1 uppercase tracking-wide text-xs text-muted-foreground font-semibold">Files</span>
        </button>
        <Show when={filesOpen()}>
          <div class="flex-1 overflow-hidden min-h-0">
            <Show
              when={activeWorkspace()?.repoRoot}
              fallback={
                <div class="px-2 py-4 text-center text-[13px] text-muted-foreground">
                  <Files class="w-5 h-5 mx-auto mb-2 opacity-60" />
                  Select a repository first.
                </div>
              }
            >
              {(root) => <FileTree root={root()} onOpenFile={props.onOpenFile} />}
            </Show>
          </div>
        </Show>
      </div>

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
          <span class="flex-1 uppercase tracking-wide text-xs text-muted-foreground font-semibold">Terminals</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (!activeWorkspace()?.repoRoot) return;
              void actions.spawnTerminal(state.activeWorkspaceId);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.stopPropagation();
              if (!activeWorkspace()?.repoRoot) return;
              void actions.spawnTerminal(state.activeWorkspaceId);
            }}
            aria-label="New terminal"
            class={`p-0.5 mr-0.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors ${!activeWorkspace()?.repoRoot ? "opacity-40 pointer-events-none" : ""}`}
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
                <div class="px-2 py-3 text-center text-[13px] text-muted-foreground">
                  <TerminalSquare class="w-4 h-4 mx-auto mb-1.5 opacity-60" />
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
        </Show>
      </div>

      {/* Resize handle on right edge */}
      <div
        class="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-primary/30 transition-colors"
        onMouseDown={startResize}
      />
    </aside>
  );
}

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
        // pty may be gone between ticks
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
              <div class="text-xs text-muted-foreground truncate">{c()}</div>
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
