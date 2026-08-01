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
/// It deliberately does **not** carry the repo picker that sits above it in
/// the left sidebar. That header is the sidebar's, not the explorer's, and the
/// workspace rail offers the same "open a folder" affordance — a second picker
/// in the right column would be a second control for one action (§7.6).
import { Show } from "solid-js";
import { ChevronDown, ChevronRight, Files } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { FileTree } from "@/components/files/FileTree";

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
        <div class="flex-1 overflow-hidden min-h-0">
          <Show
            when={activeRepoPath()}
            fallback={
              <div class="px-2 py-4 text-center text-ui text-muted-foreground">
                <Files class="w-5 h-5 mx-auto mb-2 opacity-60" />
                Open a folder to browse its files.
              </div>
            }
          >
            {(root) => <FileTree root={root()} onOpenFile={props.onOpenFile} />}
          </Show>
        </div>
      </Show>
    </div>
  );
}
