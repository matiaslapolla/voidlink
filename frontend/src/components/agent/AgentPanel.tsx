import { Show, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { defaultAgentId, useSettings } from "@/store/settings";
import { AgentThreadView } from "@/components/agent/AgentThreadView";
import {
  SLIDE_OVER_TAB_ID,
  agentPanelOpen,
  toggleAgentPanel,
} from "@/commands/agent";

/// The right-edge slide-over, kept for quick questions.
///
/// It is now a *renderer* over the agent store rather than a second
/// implementation: everything it used to own — the bubbles, the markdown
/// pipeline, the audit disclosure, the auto-scroll, the composer — lives in
/// `AgentThreadView`, which the agent tab body mounts too. `agent.toggle` still
/// opens this; `agent.newTab` opens a thread as a pane-tree citizen.
///
/// Its thread is filed under `SLIDE_OVER_TAB_ID` in the same per-tab map as
/// every agent tab, so a question asked here and a tab opened later are the same
/// kind of thing to the store, and neither can see the other's conversation.
export function AgentPanel(props: { onOpenSettings: () => void }) {
  const { state } = useAppStore();
  const { settings } = useSettings();
  /// The slide-over is the quick-question surface and takes no roster picker:
  /// it always talks to the first entry. Choosing an agent is what opening a tab
  /// is for, and a picker here would be a second place to answer the same
  /// question.
  const agentId = createMemo(() => {
    void settings.ai.agents;
    return defaultAgentId();
  });

  return (
    <Show when={agentPanelOpen()}>
      <Portal>
        {/* §6: no border, and `shadow-lg` rather than `shadow-xl` — this is an
            unscrimmed portalled surface (exception 2), not a scrimmed modal, and
            separation otherwise comes from moving up the lightness ladder to
            `--popover`. The z-layer is named (`--z-panel`); a raw `z-40` is what
            the named scale exists to replace. */}
        <div
          class="fixed inset-y-0 right-0 z-[var(--z-panel)] w-[440px] max-w-[92vw] flex flex-col bg-popover shadow-lg"
          role="complementary"
          aria-label="Repo agent"
        >
          <AgentThreadView
            wtId={state.activeWorktreeId}
            tabId={SLIDE_OVER_TAB_ID}
            agentId={agentId()}
            onOpenSettings={props.onOpenSettings}
            headerActions={
              <button
                onClick={() => toggleAgentPanel(false)}
                title="Close"
                aria-label="Close agent panel"
                class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring outline-none transition-colors"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            }
          />
        </div>
      </Portal>
    </Show>
  );
}
