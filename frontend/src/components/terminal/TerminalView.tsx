import { createSignal, createEffect, For, Show, batch } from "solid-js";
import { Plus, X } from "lucide-solid";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { terminalApi } from "@/api/terminal";
import { TerminalPane } from "./TerminalPane";
import { pendingTerminalInput, consumeTerminalInput } from "@/store/terminal-bridge";

interface TerminalTab {
  id: string;
  ptyId: string;
}

interface TerminalViewProps {
  cwd: string;
}

export function TerminalView(props: TerminalViewProps) {
  const [tabs, setTabs] = createSignal<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = createSignal<string | null>(null);
  // Track titles separately so updating a title never replaces tab objects
  // (which would cause <For> to destroy and recreate the TerminalPane).
  const [tabTitles, setTabTitles] = createSignal<Record<string, string>>({});

  const addTerminal = async () => {
    try {
      const ptyId = await terminalApi.createPty(props.cwd);
      const tab: TerminalTab = { id: ptyId, ptyId };
      batch(() => {
        setTabs((prev) => [...prev, tab]);
        setTabTitles((prev) => ({ ...prev, [ptyId]: `Terminal ${tabs().length}` }));
        setActiveTab(tab.id);
      });

      // Listen for PTY exit to mark tab as closed
      listen(`pty-exit:${ptyId}`, () => {
        closeTab(tab.id);
      });
    } catch (e) {
      console.error("Failed to create terminal:", e);
    }
  };

  const closeTab = (id: string) => {
    const tab = tabs().find((t) => t.id === id);
    if (tab) {
      void terminalApi.closePty(tab.ptyId).catch(() => {});
    }
    batch(() => {
      setTabs((prev) => prev.filter((t) => t.id !== id));
      setTabTitles((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (activeTab() === id) {
        const remaining = tabs().filter((t) => t.id !== id);
        setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
      }
    });
  };

  // Consume pending terminal input and write to active PTY
  createEffect(() => {
    const input = pendingTerminalInput();
    if (!input) return;
    const active = activeTab();
    const tab = tabs().find((t) => t.id === active);
    if (tab) {
      consumeTerminalInput();
      void invoke("write_pty", { sessionId: tab.ptyId, data: input });
    } else {
      // No terminal open — create one, then write
      (async () => {
        await addTerminal();
        const newActive = activeTab();
        const newTab = tabs().find((t) => t.id === newActive);
        if (newTab) {
          consumeTerminalInput();
          void invoke("write_pty", { sessionId: newTab.ptyId, data: input });
        }
      })();
    }
  });

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div class="flex items-center border-b border-border bg-background/60 shrink-0">
        <div class="flex-1 flex items-center overflow-x-auto scrollbar-thin gap-0">
          <For each={tabs()}>
            {(tab) => (
              <div
                class={`group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border cursor-pointer transition-colors shrink-0 ${
                  activeTab() === tab.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span class="truncate max-w-32">{tabTitles()[tab.id]}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-all"
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            )}
          </For>
        </div>
        <button
          onClick={() => void addTerminal()}
          class="flex items-center gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors shrink-0 border-l border-border"
          title="New terminal"
        >
          <Plus class="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Terminal content */}
      <div class="flex-1 overflow-hidden relative">
        <Show
          when={tabs().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center h-full gap-3">
              <p class="text-sm text-muted-foreground">No terminals open</p>
              <button
                onClick={() => void addTerminal()}
                class="flex items-center gap-2 px-4 py-2 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Plus class="w-4 h-4" />
                New Terminal
              </button>
            </div>
          }
        >
          <For each={tabs()}>
            {(tab) => (
              <div
                class="absolute inset-0"
                style={{ display: activeTab() === tab.id ? "block" : "none" }}
              >
                <TerminalPane
                  ptyId={tab.ptyId}
                  class="w-full h-full"
                />
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
