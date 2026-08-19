/// The **Files** disclosure and the tree under it, as one relocatable block.
///
/// It exists because the file explorer now has two homes. With horizontal tabs
/// it is the first section of the left sidebar, where it has always been. With
/// *vertical* tabs the left edge of the window would otherwise carry three
/// parallel navigation columns — the workspace rail, the file tree, and the
/// new tab column — so the explorer moves to the right of the window, above
/// the git panel. See the note in `App.tsx`.
///
/// Extracting it is what keeps that from being a fork: both placements render
/// this component, so the tree, its empty state and the disclosure's persisted
/// open/closed state are one implementation rather than two that drift.
///
/// Collapsing is one flag (`sidebarSections.files`) and two consequences,
/// because the two homes have different space to give back. In the left sidebar
/// the host swaps this whole panel for `FilesRail` and takes the column down to
/// `SIDEBAR_RAIL_WIDTH`, so the width goes to the workbench. In the right column
/// the width belongs to the git panel below, so collapsing gives back *vertical*
/// space and this component's own `<Show>` is what does it. The button below is
/// the control in both cases and keeps its `aria-expanded` contract either way.
///
/// It deliberately does **not** carry the repo picker that sits above it in
/// the left sidebar. That header is the sidebar's, not the explorer's, and the
/// workspace rail offers the same "open a folder" affordance — a second picker
/// in the right column would be a second control for one action (§7.6).
import { For, Show } from "solid-js";
import { ChevronDown, ChevronRight, Files, PlugZap, Server } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { FileTree } from "@/components/files/FileTree";
import { remoteRoots, type RemoteRoot } from "@/store/remoteRoots";
import { reconnectRemoteRoot } from "@/commands/remoteActions";
// The rail's one icon carries no visible label, so its tooltip is information
// rather than a restatement — the same argument that put `WorkspaceRail`'s
// three `title`s onto the real tooltip. `void tooltip` keeps the import alive:
// Solid erases a `use:` directive whose symbol is otherwise unused.
import { tooltip } from "@/components/ui/Tooltip";
void tooltip;

export function FilesPanel(props: {
  onOpenFile?: (path: string) => void;
  /// Separator from whatever sits below it, which differs per placement: a
  /// hairline under it in the left sidebar, nothing in the right column where
  /// the git panel draws its own header edge.
  class?: string;
}) {
  const { state, activeRepoPath, actions } = useAppStore();
  const filesOpen = () => state.sidebarSections.files;

  return (
    <div
      class={`flex flex-col min-h-0 ${props.class ?? ""}`}
      classList={{ "flex-1": filesOpen(), "shrink-0": !filesOpen() }}
    >
      <button
        onClick={() => actions.toggleSidebarSection("files")}
        aria-expanded={filesOpen()}
        class="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/30 transition-colors w-full"
      >
        <span class="w-3 h-3 shrink-0 text-muted-foreground">
          {filesOpen() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
        </span>
        <Files class="w-3 h-3 text-muted-foreground" />
        <span class="flex-1 tracking-wide text-body text-muted-foreground font-semibold">
          Files
        </span>
      </button>
      <Show when={filesOpen()}>
        <div class="flex-1 overflow-hidden min-h-0 flex flex-col">
          <Show
            when={activeRepoPath()}
            fallback={
              <Show
                when={remoteRoots().length === 0}
                fallback={<div class="shrink-0" />}
              >
                <div class="px-2 py-4 text-center text-ui text-muted-foreground">
                  <Files class="w-5 h-5 mx-auto mb-2 opacity-60" />
                  Open a folder to browse its files.
                </div>
              </Show>
            }
          >
            {(root) => (
              <div class="flex-1 min-h-0">
                <FileTree root={root()} onOpenFile={props.onOpenFile} />
              </div>
            )}
          </Show>
          {/* SSH hosts sit *below* the local root rather than replacing it: a
              remote root is an addition to the explorer, not a mode it enters,
              and the local repo is still where the git panel is pointed. */}
          <For each={remoteRoots()}>
            {(remote) => <RemoteRootSection remote={remote} onOpenFile={props.onOpenFile} />}
          </For>
        </div>
      </Show>
    </div>
  );
}

/// One SSH host in the explorer: a header naming it, the chip that says this is
/// not your disk, and the tree under it.
///
/// A dead session keeps its header and loses its tree. Leaving the tree mounted
/// over a session the app knows is gone would make every expand fail with a
/// transport error, one toast at a time; the reconnect button is the one action
/// that can actually resolve the state.
function RemoteRootSection(props: {
  remote: RemoteRoot;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div class="flex flex-col min-h-0" classList={{ "flex-1": !props.remote.dead }}>
      <div class="shrink-0 flex items-center gap-1.5 px-2.5 py-1 border-t border-border/40">
        <Server class="w-3 h-3 shrink-0 text-muted-foreground" />
        <span class="flex-1 truncate text-body text-muted-foreground font-semibold">
          {props.remote.alias}
        </span>
        <span class="shrink-0 px-1 py-px rounded text-micro tracking-wide bg-accent/60 text-muted-foreground">
          remote
        </span>
      </div>
      <Show
        when={!props.remote.dead}
        fallback={
          <div class="shrink-0 px-2.5 py-2 flex items-center gap-2 text-ui text-muted-foreground">
            <span class="flex-1">Connection lost.</span>
            <button
              onClick={() => void reconnectRemoteRoot(props.remote)}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-micro tracking-wide text-foreground bg-accent/60 hover:bg-accent transition-colors"
            >
              <PlugZap class="w-3 h-3" />
              Reconnect
            </button>
          </div>
        }
      >
        <div class="flex-1 min-h-0">
          <FileTree root={props.remote.root} onOpenFile={props.onOpenFile} />
        </div>
      </Show>
    </div>
  );
}

/// What the explorer collapses *to* where collapsing reclaims horizontal space:
/// a `SIDEBAR_RAIL_WIDTH` strip with the Files icon, and clicking it brings the
/// panel back at the width it had.
///
/// It is one component for the same reason `FilesPanel` is: the explorer now
/// collapses in the workbench sidebar and in the popped-out editor window, and
/// two rails would be two idioms to keep in step. The visual language is
/// `GitSidebarCollapsed`'s, deliberately — the shell already has a collapsed
/// rail and inventing a second one would say the two panels are different kinds
/// of thing.
///
/// One icon is the whole rail at this slice (the assumption list says so). It
/// becomes a real rail if the terminals section ever adopts the same collapse,
/// which is why the layout is a column with a gap rather than a single button.
export function FilesRail(props: { onExpand: () => void }) {
  return (
    <div class="flex flex-col items-center w-full h-full bg-sidebar py-2 gap-2">
      <button
        onClick={props.onExpand}
        aria-expanded={false}
        aria-label="Show the file explorer"
        use:tooltip={"Show the file explorer\nThe sidebar returns to the width you left it at"}
        class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-[background-color,color] duration-[var(--dur-tint)] ease-out"
      >
        <Files class="w-4 h-4" />
      </button>
    </div>
  );
}
