import { createMemo, For, Show } from "solid-js";
import { ChevronRight, Folder } from "lucide-solid";
import { useLayout } from "@/store/LayoutContext";
import type { TabInstance } from "@/store/layout";

interface BreadcrumbBarProps {
  workspaceId: string;
}

export function BreadcrumbBar(props: BreadcrumbBarProps) {
  const [layout] = useLayout();

  const activeTab = createMemo((): TabInstance | undefined => {
    const entry = layout.centerTabsByWorkspace[props.workspaceId];
    if (!entry) return undefined;
    return entry.tabs.find((t) => t.id === entry.activeTabId);
  });

  const crumbs = createMemo(() => {
    const tab = activeTab();
    if (!tab) return [];
    if ((tab.type === "file" || tab.type === "image" || tab.type === "svg") && tab.meta.filePath) {
      const parts = tab.meta.filePath.split("/").filter(Boolean);
      // Show last 4 parts max to avoid overflow
      return parts.length > 4 ? ["...", ...parts.slice(-4)] : parts;
    }
    return [tab.label];
  });

  return (
    <div class="flex items-center gap-0.5 px-3 py-1 text-[11px] border-b border-border/40 bg-background/30 shrink-0 min-h-[26px] overflow-hidden">
      <Folder class="w-3 h-3 text-muted-foreground/50 shrink-0 mr-1" />
      <For each={crumbs()}>
        {(crumb, idx) => (
          <>
            <Show when={idx() > 0}>
              <ChevronRight class="w-3 h-3 text-muted-foreground/30 shrink-0" />
            </Show>
            <span
              class={`truncate ${
                idx() === crumbs().length - 1
                  ? "text-foreground font-medium"
                  : "text-muted-foreground/70"
              }`}
            >
              {crumb}
            </span>
          </>
        )}
      </For>
    </div>
  );
}
